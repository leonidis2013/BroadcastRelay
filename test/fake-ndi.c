/* A pretend libndi for tests: one source, "TEST (Fake)", sending 640x360 at 29.97 fps with a
 * 1 kHz tone; senders count what they get. Build: gcc -shared -fPIC -Itest/ndi-stub test/fake-ndi.c -o libndi.so */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <Processing.NDI.Lib.h>

static NDIlib_source_t src = { "TEST (Fake)", { "127.0.0.1:5961" } };
static long vframes = 0, aframes = 0, sent_v = 0, sent_a = 0;

bool NDIlib_initialize(void) { return true; }
void NDIlib_destroy(void) { if (sent_v) fprintf(stderr, "fake-ndi: sent %ld video frames, %ld audio frames\n", sent_v, sent_a); }
NDIlib_find_instance_t NDIlib_find_create_v2(const NDIlib_find_create_t *c) { (void)c; return (void *)1; }
void NDIlib_find_destroy(NDIlib_find_instance_t f) { (void)f; }
bool NDIlib_find_wait_for_sources(NDIlib_find_instance_t f, uint32_t t) { (void)f; (void)t; return true; }
const NDIlib_source_t *NDIlib_find_get_current_sources(NDIlib_find_instance_t f, uint32_t *n) { (void)f; *n = 1; return &src; }
NDIlib_recv_instance_t NDIlib_recv_create_v3(const NDIlib_recv_create_v3_t *c) { (void)c; return (void *)2; }
void NDIlib_recv_destroy(NDIlib_recv_instance_t r) { (void)r; }
int NDIlib_recv_get_no_connections(NDIlib_recv_instance_t r) { (void)r; return 1; }
NDIlib_framesync_instance_t NDIlib_framesync_create(NDIlib_recv_instance_t r) { (void)r; return (void *)3; }
void NDIlib_framesync_destroy(NDIlib_framesync_instance_t f) { (void)f; }
void NDIlib_framesync_capture_video(NDIlib_framesync_instance_t f, NDIlib_video_frame_v2_t *v, NDIlib_frame_format_type_e t) {
  (void)f; (void)t;
  memset(v, 0, sizeof *v);
  v->xres = 640; v->yres = 360; v->FourCC = NDIlib_FourCC_video_type_UYVY; v->frame_rate_N = 30000; v->frame_rate_D = 1001;
  v->line_stride_in_bytes = 640 * 2;
  v->p_data = malloc(640 * 360 * 2);
  for (int y = 0; y < 360; y++) for (int x = 0; x < 640; x += 2) {
    uint8_t *p = v->p_data + y * 1280 + x * 2;
    p[0] = (uint8_t)(x / 3); p[1] = (uint8_t)(((x + vframes * 4) % 640) < 40 ? 235 : 60); p[2] = (uint8_t)(y / 2); p[3] = p[1];
  }
  vframes++;
}
void NDIlib_framesync_free_video(NDIlib_framesync_instance_t f, NDIlib_video_frame_v2_t *v) { (void)f; free(v->p_data); v->p_data = NULL; }
void NDIlib_framesync_capture_audio(NDIlib_framesync_instance_t f, NDIlib_audio_frame_v2_t *a, int rate, int ch, int n) {
  (void)f;
  memset(a, 0, sizeof *a);
  a->sample_rate = rate; a->no_channels = ch; a->no_samples = n; a->channel_stride_in_bytes = n * 4;
  a->p_data = malloc(sizeof(float) * ch * n);
  for (int c = 0; c < ch; c++) for (int i = 0; i < n; i++) a->p_data[c * n + i] = 0.25f * sinf(2 * 3.14159265f * 1000.0f * (float)(aframes + i) / rate);
  aframes += n;
}
void NDIlib_framesync_free_audio(NDIlib_framesync_instance_t f, NDIlib_audio_frame_v2_t *a) { (void)f; free(a->p_data); a->p_data = NULL; }
NDIlib_send_instance_t NDIlib_send_create(const NDIlib_send_create_t *c) { fprintf(stderr, "fake-ndi: sender %s\n", c->p_ndi_name); return (void *)4; }
void NDIlib_send_destroy(NDIlib_send_instance_t s) { (void)s; }
void NDIlib_send_send_video_async_v2(NDIlib_send_instance_t s, const NDIlib_video_frame_v2_t *v) { (void)s; if (v) sent_v++; }
void NDIlib_send_send_audio_v2(NDIlib_send_instance_t s, const NDIlib_audio_frame_v2_t *a) { (void)s; (void)a; sent_a++; }
int NDIlib_send_get_no_connections(NDIlib_send_instance_t s, uint32_t t) { (void)s; (void)t; return (int)(sent_v > 0); }
