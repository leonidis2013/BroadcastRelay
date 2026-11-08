/*
 * ndi-bridge: the small NDI helper BroadcastRelay runs next to FFmpeg.
 * (FFmpeg itself no longer ships NDI support.)
 *
 *   ndi-bridge list [seconds]
 *       Prints {"sources":[{"name":"...","url":"..."}]} after looking for that long.
 *
 *   ndi-bridge recv "<source name>" <video fifo> <audio fifo>
 *       Receives an NDI source and writes raw frames for FFmpeg:
 *         video: UYVY (uyvy422) at the source's frame rate
 *         audio: 48 kHz stereo float (f32le), exactly one frame's worth per video frame
 *       NDI's frame-sync keeps both at a steady pace, so FFmpeg can read them as
 *       constant-rate streams that stay in sync. If the source goes away the last
 *       frame and silence keep flowing, so the destinations stay connected.
 *       stdout gets one JSON event per line:
 *         {"event":"format","width":1920,"height":1080,"fpsN":30000,"fpsD":1001}
 *         {"event":"status","connected":1}
 *       Exits with code 3 when the source changes size or frame rate (BroadcastRelay restarts it).
 *
 *   ndi-bridge send "<name>" <width> <height> <fpsN> <fpsD> <video fifo> <audio fifo or ->
 *       Reads raw UYVY frames and f32le stereo audio from FFmpeg and publishes them as an NDI source.
 *       stdout: {"event":"status","connections":2}
 *
 * Extra discovery IPs, a Discovery Server and groups come from the NDI config file
 * that BroadcastRelay writes ($NDI_CONFIG_DIR/ndi-config.v1.json), plus NDI_EXTRA_IPS for list/recv.
 *
 * Copyright Jerod Ulicki. NDI® is a registered trademark of Vizrt NDI AB.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <Processing.NDI.Lib.h>

#define RATE 48000
#define CH 2

static volatile sig_atomic_t stop_now = 0;
static void on_signal(int s) { (void)s; stop_now = 1; }

static void json_str(FILE *f, const char *s) {
  fputc('"', f);
  for (; s && *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { fputc('\\', f); fputc(c, f); }
    else if (c < 0x20) fprintf(f, "\\u%04x", c);
    else fputc(c, f);
  }
  fputc('"', f);
}

static int64_t now_ns(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000000000LL + t.tv_nsec;
}
static void sleep_until(int64_t ns) {
  struct timespec t = { (time_t)(ns / 1000000000LL), (long)(ns % 1000000000LL) };
  while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &t, NULL) == EINTR && !stop_now) {}
}

/* write all of buf; 0 on success */
static int write_all(int fd, const void *buf, size_t n) {
  const uint8_t *p = buf;
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w < 0) { if (errno == EINTR) { if (stop_now) return -1; continue; } return -1; }
    p += w; n -= (size_t)w;
  }
  return 0;
}
/* read exactly n bytes; 0 on success */
static int read_all(int fd, void *buf, size_t n) {
  uint8_t *p = buf;
  while (n > 0) {
    ssize_t r = read(fd, p, n);
    if (r == 0) return -1;
    if (r < 0) { if (errno == EINTR) { if (stop_now) return -1; continue; } return -1; }
    p += r; n -= (size_t)r;
  }
  return 0;
}

/* Open a FIFO read-write so the open never waits for the other side (FFmpeg opens its
 * inputs and outputs one at a time), with a bigger buffer so neither side stalls while
 * FFmpeg is still probing. */
static int open_fifo(const char *path) {
  int fd = open(path, O_RDWR);
  if (fd < 0) { fprintf(stderr, "cannot open %s: %s\n", path, strerror(errno)); return -1; }
  fcntl(fd, F_SETPIPE_SZ, 1 << 20);
  return fd;
}

static NDIlib_find_instance_t make_finder(void) {
  NDIlib_find_create_t fc;
  memset(&fc, 0, sizeof fc);
  fc.show_local_sources = true;
  const char *extra = getenv("NDI_EXTRA_IPS");
  fc.p_extra_ips = (extra && *extra) ? extra : NULL;
  return NDIlib_find_create_v2(&fc);
}

/* ---------- list ---------- */
static int cmd_list(int seconds) {
  NDIlib_find_instance_t f = make_finder();
  if (!f) { fprintf(stderr, "could not start NDI discovery\n"); return 1; }
  int64_t end = now_ns() + (int64_t)seconds * 1000000000LL;
  while (now_ns() < end && !stop_now) NDIlib_find_wait_for_sources(f, 500);
  uint32_t n = 0;
  const NDIlib_source_t *s = NDIlib_find_get_current_sources(f, &n);
  printf("{\"sources\":[");
  for (uint32_t i = 0; i < n; i++) {
    if (i) putchar(',');
    printf("{\"name\":"); json_str(stdout, s[i].p_ndi_name);
    printf(",\"url\":"); json_str(stdout, s[i].p_url_address ? s[i].p_url_address : "");
    putchar('}');
  }
  printf("]}\n");
  fflush(stdout);
  NDIlib_find_destroy(f);
  return 0;
}

/* BGRA/BGRX -> UYVY (BT.709, limited range), for sources that send alpha */
static void bgra_to_uyvy(const uint8_t *src, int stride, int w, int h, uint8_t *dst) {
  for (int y = 0; y < h; y++) {
    const uint8_t *s = src + (size_t)y * stride;
    uint8_t *d = dst + (size_t)y * w * 2;
    for (int x = 0; x + 1 < w; x += 2) {
      int b0 = s[0], g0 = s[1], r0 = s[2], b1 = s[4], g1 = s[5], r1 = s[6];
      int y0 = 16 + ((47 * r0 + 157 * g0 + 16 * b0) >> 8);
      int y1 = 16 + ((47 * r1 + 157 * g1 + 16 * b1) >> 8);
      int r = (r0 + r1) / 2, g = (g0 + g1) / 2, b = (b0 + b1) / 2;
      int u = 128 + ((-26 * r - 87 * g + 112 * b) >> 8);
      int v = 128 + ((112 * r - 102 * g - 10 * b) >> 8);
      d[0] = (uint8_t)u; d[1] = (uint8_t)y0; d[2] = (uint8_t)v; d[3] = (uint8_t)y1;
      s += 8; d += 4;
    }
  }
}

/* ---------- recv ---------- */
static int cmd_recv(const char *name, const char *vpath, const char *apath) {
  NDIlib_find_instance_t f = make_finder();
  if (!f) { fprintf(stderr, "could not start NDI discovery\n"); return 1; }
  NDIlib_source_t src; memset(&src, 0, sizeof src);
  char *url = NULL, *nm = NULL;
  for (int tries = 0; tries < 60 && !stop_now && !nm; tries++) {
    NDIlib_find_wait_for_sources(f, 500);
    uint32_t n = 0;
    const NDIlib_source_t *s = NDIlib_find_get_current_sources(f, &n);
    for (uint32_t i = 0; i < n; i++) if (s[i].p_ndi_name && strcmp(s[i].p_ndi_name, name) == 0) {
      nm = strdup(s[i].p_ndi_name);
      url = s[i].p_url_address ? strdup(s[i].p_url_address) : NULL;
      break;
    }
  }
  NDIlib_find_destroy(f);
  if (stop_now) return 0;
  if (!nm) { fprintf(stderr, "NDI source not found: %s\n", name); return 2; }
  src.p_ndi_name = nm; src.p_url_address = url;

  NDIlib_recv_create_v3_t rc; memset(&rc, 0, sizeof rc);
  rc.source_to_connect_to = src;
  rc.color_format = NDIlib_recv_color_format_UYVY_BGRA;
  rc.bandwidth = NDIlib_recv_bandwidth_highest;
  rc.allow_video_fields = false;
  rc.p_ndi_recv_name = "BroadcastRelay";
  NDIlib_recv_instance_t r = NDIlib_recv_create_v3(&rc);
  if (!r) { fprintf(stderr, "could not create NDI receiver\n"); return 1; }
  NDIlib_framesync_instance_t fs = NDIlib_framesync_create(r);

  /* wait for the first picture to learn the format */
  NDIlib_video_frame_v2_t vf;
  int w = 0, h = 0, fn = 0, fd = 0;
  for (int i = 0; i < 300 && !stop_now; i++) {
    NDIlib_framesync_capture_video(fs, &vf, NDIlib_frame_format_type_progressive);
    if (vf.p_data && vf.xres > 0) { w = vf.xres; h = vf.yres; fn = vf.frame_rate_N; fd = vf.frame_rate_D; }
    NDIlib_framesync_free_video(fs, &vf);
    if (w) break;
    usleep(100000);
  }
  if (!w) { fprintf(stderr, "no video from NDI source %s\n", name); return 2; }
  if (fn <= 0 || fd <= 0) { fn = 30000; fd = 1001; }
  w &= ~1;
  printf("{\"event\":\"format\",\"width\":%d,\"height\":%d,\"fpsN\":%d,\"fpsD\":%d}\n", w, h, fn, fd);
  fflush(stdout);

  int vfd = open_fifo(vpath), afd = open_fifo(apath);
  if (vfd < 0 || afd < 0) return 1;

  size_t frame_bytes = (size_t)w * h * 2;
  uint8_t *uyvy = malloc(frame_bytes);
  memset(uyvy, 0, frame_bytes);
  for (size_t i = 0; i < frame_bytes; i += 2) uyvy[i] = 128, uyvy[i + 1] = 16; /* black until the first frame */
  float *pcm = malloc(sizeof(float) * CH * RATE);

  int64_t period = (int64_t)(1000000000.0 * fd / fn), next = now_ns();
  uint64_t frames = 0, samples = 0;
  int last_conn = -1;
  int64_t last_status = 0;
  int rc_exit = 0;

  while (!stop_now) {
    NDIlib_framesync_capture_video(fs, &vf, NDIlib_frame_format_type_progressive);
    if (vf.p_data) {
      if ((vf.xres & ~1) != w || vf.yres != h || (vf.frame_rate_N && (int64_t)vf.frame_rate_N * fd != (int64_t)fn * vf.frame_rate_D)) {
        printf("{\"event\":\"changed\",\"width\":%d,\"height\":%d,\"fpsN\":%d,\"fpsD\":%d}\n", vf.xres, vf.yres, vf.frame_rate_N, vf.frame_rate_D);
        fflush(stdout);
        NDIlib_framesync_free_video(fs, &vf);
        rc_exit = 3; break;
      }
      if (vf.FourCC == NDIlib_FourCC_video_type_UYVY || vf.FourCC == NDIlib_FourCC_video_type_UYVA) {
        int stride = vf.line_stride_in_bytes ? vf.line_stride_in_bytes : w * 2;
        for (int y = 0; y < h; y++) memcpy(uyvy + (size_t)y * w * 2, vf.p_data + (size_t)y * stride, (size_t)w * 2);
      } else if (vf.FourCC == NDIlib_FourCC_video_type_BGRA || vf.FourCC == NDIlib_FourCC_video_type_BGRX) {
        bgra_to_uyvy(vf.p_data, vf.line_stride_in_bytes ? vf.line_stride_in_bytes : w * 4, w, h, uyvy);
      }
    }
    NDIlib_framesync_free_video(fs, &vf);
    if (write_all(vfd, uyvy, frame_bytes)) break;

    /* exactly the samples that belong to this frame, so audio and video can't drift */
    frames++;
    uint64_t target = (uint64_t)((double)frames * RATE * fd / fn + 0.5);
    int ns = (int)(target - samples);
    if (ns > 0 && ns <= RATE) {
      NDIlib_audio_frame_v2_t af;
      NDIlib_framesync_capture_audio(fs, &af, RATE, CH, ns);
      if (af.p_data && af.no_channels > 0) {
        int chs = af.no_channels, stride = af.channel_stride_in_bytes / (int)sizeof(float);
        for (int i = 0; i < ns; i++) {
          float L = af.p_data[i];
          float R = chs > 1 ? af.p_data[stride + i] : L;
          pcm[2 * i] = L; pcm[2 * i + 1] = R;
        }
      } else memset(pcm, 0, sizeof(float) * CH * ns);
      NDIlib_framesync_free_audio(fs, &af);
      if (write_all(afd, pcm, sizeof(float) * CH * ns)) break;
      samples = target;
    }

    int64_t t = now_ns();
    if (t - last_status > 1000000000LL) {
      int c = NDIlib_recv_get_no_connections(r);
      if (c != last_conn) { printf("{\"event\":\"status\",\"connected\":%d}\n", c); fflush(stdout); last_conn = c; }
      last_status = t;
    }
    next += period;
    if (next < t - 10 * period) next = t; /* fell far behind (machine stalled): don't race to catch up */
    sleep_until(next);
  }
  NDIlib_framesync_destroy(fs);
  NDIlib_recv_destroy(r);
  free(uyvy); free(pcm); free(nm); free(url);
  return rc_exit;
}

/* ---------- send ---------- */
struct send_ctx {
  NDIlib_send_instance_t s;
  int vfd, afd, w, h, fn, fd;
};

static void *audio_thread(void *arg) {
  struct send_ctx *c = arg;
  const int n = 1024;
  float *in = malloc(sizeof(float) * CH * n), *planar = malloc(sizeof(float) * CH * n);
  while (!stop_now) {
    if (read_all(c->afd, in, sizeof(float) * CH * n)) break;
    for (int i = 0; i < n; i++) { planar[i] = in[2 * i]; planar[n + i] = in[2 * i + 1]; }
    NDIlib_audio_frame_v2_t af; memset(&af, 0, sizeof af);
    af.sample_rate = RATE; af.no_channels = CH; af.no_samples = n;
    af.timecode = NDIlib_send_timecode_synthesize;
    af.p_data = planar; af.channel_stride_in_bytes = (int)sizeof(float) * n;
    NDIlib_send_send_audio_v2(c->s, &af);
  }
  free(in); free(planar);
  stop_now = 1;
  return NULL;
}

static int cmd_send(const char *name, int w, int h, int fn, int fd, const char *vpath, const char *apath) {
  NDIlib_send_create_t sc; memset(&sc, 0, sizeof sc);
  sc.p_ndi_name = name;
  sc.clock_video = true;
  sc.clock_audio = false;
  NDIlib_send_instance_t s = NDIlib_send_create(&sc);
  if (!s) { fprintf(stderr, "could not create NDI sender %s\n", name); return 1; }
  struct send_ctx c = { s, -1, -1, w, h, fn, fd };
  c.vfd = open_fifo(vpath);
  if (c.vfd < 0) return 1;
  pthread_t at;
  int have_audio = apath && strcmp(apath, "-") != 0;
  if (have_audio) {
    c.afd = open_fifo(apath);
    if (c.afd < 0) return 1;
    pthread_create(&at, NULL, audio_thread, &c);
  }
  size_t frame_bytes = (size_t)w * h * 2;
  uint8_t *buf[2] = { malloc(frame_bytes), malloc(frame_bytes) };
  int cur = 0, last_conn = -1;
  int64_t last_status = 0;
  while (!stop_now) {
    if (read_all(c.vfd, buf[cur], frame_bytes)) break;
    NDIlib_video_frame_v2_t vf; memset(&vf, 0, sizeof vf);
    vf.xres = w; vf.yres = h;
    vf.FourCC = NDIlib_FourCC_video_type_UYVY;
    vf.frame_rate_N = fn; vf.frame_rate_D = fd;
    vf.picture_aspect_ratio = (float)w / (float)h;
    vf.frame_format_type = NDIlib_frame_format_type_progressive;
    vf.timecode = NDIlib_send_timecode_synthesize;
    vf.p_data = buf[cur];
    vf.line_stride_in_bytes = w * 2;
    NDIlib_send_send_video_async_v2(s, &vf); /* async: the buffer must stay valid until the next call */
    cur ^= 1;
    int64_t t = now_ns();
    if (t - last_status > 1000000000LL) {
      int n = NDIlib_send_get_no_connections(s, 0);
      if (n != last_conn) { printf("{\"event\":\"status\",\"connections\":%d}\n", n); fflush(stdout); last_conn = n; }
      last_status = t;
    }
  }
  stop_now = 1;
  NDIlib_send_send_video_async_v2(s, NULL); /* flush */
  if (have_audio) { close(c.afd); pthread_cancel(at); pthread_join(at, NULL); }
  NDIlib_send_destroy(s);
  free(buf[0]); free(buf[1]);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: ndi-bridge list [seconds] | recv <name> <video fifo> <audio fifo> | send <name> <w> <h> <fpsN> <fpsD> <video fifo> <audio fifo|->\n");
    return 64;
  }
  struct sigaction sa; memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_signal;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
  if (!NDIlib_initialize()) { fprintf(stderr, "NDI is not supported on this CPU\n"); return 1; }
  int rc = 64;
  if (strcmp(argv[1], "list") == 0) rc = cmd_list(argc > 2 ? atoi(argv[2]) : 3);
  else if (strcmp(argv[1], "recv") == 0 && argc >= 5) rc = cmd_recv(argv[2], argv[3], argv[4]);
  else if (strcmp(argv[1], "send") == 0 && argc >= 9) {
    int w = atoi(argv[3]) & ~1, h = atoi(argv[4]), fn = atoi(argv[5]), fd = atoi(argv[6]);
    if (w < 2 || h < 2 || fn <= 0 || fd <= 0) { fprintf(stderr, "bad format\n"); rc = 64; }
    else rc = cmd_send(argv[2], w, h, fn, fd, argv[7], argv[8]);
  } else fprintf(stderr, "unknown command\n");
  NDIlib_destroy();
  return rc;
}
