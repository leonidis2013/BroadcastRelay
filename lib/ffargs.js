/*
 * FFmpeg command lines. Everything here is pure (settings in, argument arrays out),
 * so it is easy to test and easy to read when a destination misbehaves.
 *
 * "info" is what we know about the incoming feed:
 *   { videoCodec:'H264', audioCodec:'AAC'|'Opus'|'LPCM'|null, width, height, fps }
 */
'use strict';

const RES = { 2160: '4K', 1440: '1440p', 1080: '1080p', 900: '900p', 720: '720p', 540: '540p', 480: '480p', 360: '360p' };
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Ingest URLs the platforms publish (stream-key mode). */
const PLATFORM_URLS = {
  youtube: 'rtmps://a.rtmps.youtube.com/live2',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp'
};

/** Where a destination sends to: base URL plus stream key. */
function targetUrl(dest, key) {
  key = String(key || '').trim();
  if (dest.type === 'srt') return String(dest.url || '').trim();
  let base = String(dest.url || '').trim() || PLATFORM_URLS[dest.type] || '';
  if (!key) return base;
  return base.replace(/\/+$/, '') + '/' + key.replace(/^\/+/, '');
}

/** The settings a destination will actually run with, after filling defaults from the input. */
function plan(v, a, info, opts = {}) {
  info = info || {};
  v = v || {}; a = a || {};
  const inH = num(info.height, 1080), inW = num(info.width, Math.round(inH * 16 / 9)), inFps = num(info.fps, 30);
  const h264 = info.videoCodec === 'H264';
  const copyVideo = v.mode === 'original' && h264 && !opts.forceEncode;
  const height = copyVideo ? inH : Math.min(num(v.height, inH), inH);
  const width = copyVideo ? inW : even(height * inW / inH);
  const fps = copyVideo ? inFps : Math.min(num(v.fps, inFps), Math.max(inFps, 1));
  const copyAudio = a.mode === 'copy' && info.audioCodec === 'AAC' && !opts.forceAudio;
  const reasons = [];
  if (v.mode === 'original' && !copyVideo) reasons.push(info.videoCodec ? info.videoCodec + ' input has to be re-encoded to H.264' : 'encoding until the input is known');
  if (a.mode === 'copy' && !copyAudio && info.audioCodec) reasons.push(info.audioCodec + ' audio has to be re-encoded to AAC');
  return {
    copyVideo, copyAudio, width, height, fps,
    gop: Math.max(1, Math.round(fps * 2)),
    bitrate: num(v.bitrate, defaultBitrate(height, fps)),
    preset: PRESETS.includes(v.preset) ? v.preset : 'veryfast',
    audioBitrate: Math.min(num(a.bitrate, 256), 512),
    scale: !copyVideo && height !== inH,
    fpsChange: !copyVideo && fps !== inFps,
    hasAudio: info.audioCodec !== null,
    reasons
  };
}

function defaultBitrate(h, fps) {
  const hi = fps > 40;
  if (h >= 2160) return hi ? 30000 : 20000;
  if (h >= 1440) return hi ? 15000 : 10000;
  if (h >= 1080) return hi ? 9000 : 6000;
  if (h >= 720) return hi ? 6000 : 4000;
  if (h >= 540) return 2500;
  return 1500;
}

function inputArgs(url) {
  return ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-i', url];
}

function x264(p, bframes) {
  const k = p.bitrate;
  return ['-c:v', 'libx264', '-preset', p.preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-b:v', k + 'k', '-maxrate', k + 'k', '-bufsize', (k * 2) + 'k',
    '-g', String(p.gop), '-keyint_min', String(p.gop), '-sc_threshold', '0', '-bf', String(bframes),
    '-x264-params', 'nal-hrd=cbr:force-cfr=1'];
}
function videoFilter(p) {
  const f = [];
  if (p.scale) f.push('scale=-2:' + p.height + ':flags=lanczos');
  if (p.fpsChange) f.push('fps=' + p.fps);
  return f.length ? ['-vf', f.join(',')] : [];
}
function aac(p) { return ['-c:a', 'aac', '-b:a', p.audioBitrate + 'k', '-ar', '48000', '-ac', '2']; }

/** One platform or RTMP/SRT destination. */
function destination(dest, url, info, inputUrl) {
  const p = plan(dest.video, dest.audio, info);
  const args = inputArgs(inputUrl);
  args.push('-map', '0:v:0');
  if (p.hasAudio) args.push('-map', '0:a:0?');
  if (p.copyVideo) args.push('-c:v', 'copy'); else args.push(...videoFilter(p), ...x264(p, 2));
  if (p.hasAudio) args.push(...(p.copyAudio ? ['-c:a', 'copy'] : aac(p)));
  if (dest.type === 'srt') args.push('-f', 'mpegts', url);
  else args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', url);
  return { args, plan: p };
}

/**
 * The web player. One encode, two internal paths:
 *   web     H.264 + AAC   -> HLS for the public
 *   webrtc  H.264 + Opus  -> WebRTC for the LAN (browsers can't play AAC over WebRTC)
 * No B-frames: WebRTC players stutter on them.
 */
function web(cfg, info, inputUrl, rtspBase) {
  const p = plan({ mode: cfg.mode, height: cfg.height, fps: cfg.fps, bitrate: cfg.bitrate, preset: cfg.preset },
    { mode: 'aac', bitrate: cfg.audioBitrate || 192 }, info);
  const args = inputArgs(inputUrl);
  args.push('-map', '0:v:0');
  if (p.hasAudio) args.push('-map', '0:a:0', '-map', '0:a:0');
  if (p.copyVideo) args.push('-c:v', 'copy'); else args.push(...videoFilter(p), ...x264(p, 0));
  if (p.hasAudio) {
    args.push('-c:a:0', 'aac', '-b:a:0', p.audioBitrate + 'k', '-ar:a:0', '48000', '-ac:a:0', '2');
    args.push('-c:a:1', 'libopus', '-b:a:1', Math.min(p.audioBitrate, 256) + 'k', '-ar:a:1', '48000', '-ac:a:1', '2');
  }
  const sel = (a) => (p.hasAudio ? "select=\\'v:0," + a + "\\'" : "select=\\'v:0\\'");
  const slave = (path, a) => '[f=rtsp:rtsp_transport=tcp:' + sel(a) + ']' + rtspBase + '/' + path;
  // tee doesn't pass the RTSP muxer's need for global headers on to the encoders, so ask for them
  args.push('-flags', '+global_header', '-f', 'tee', slave('web', 'a:0') + '|' + slave('webrtc', 'a:1'));
  return { args, plan: p };
}

/**
 * NDI in: raw frames from ndi-bridge arrive on two pipes; encode them into the internal "live" path,
 * so everything after this point is the same as an OBS feed. Audio stays uncompressed (24-bit PCM)
 * so the only lossy audio step is the encode each destination does.
 */
function ndiIngest(fmt, fifoV, fifoA, cfg, rtspUrl) {
  const fps = fmt.fpsN + '/' + fmt.fpsD;
  const fpsNum = fmt.fpsN / fmt.fpsD;
  const p = { bitrate: num(cfg.ndiBitrate, 12000), preset: PRESETS.includes(cfg.ndiPreset) ? cfg.ndiPreset : 'veryfast', gop: Math.max(1, Math.round(fpsNum * 2)) };
  return ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1',
    // the formats are fully known: don't let FFmpeg probe seconds of video before it opens the audio pipe
    '-f', 'rawvideo', '-pix_fmt', 'uyvy422', '-video_size', fmt.width + 'x' + fmt.height, '-framerate', fps, '-probesize', '32', '-analyzeduration', '0', '-thread_queue_size', '64', '-i', fifoV,
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-probesize', '32', '-analyzeduration', '0', '-thread_queue_size', '256', '-i', fifoA,
    '-map', '0:v', '-map', '1:a',
    ...x264(p, 0), '-c:a', 'pcm_s24be',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl];
}

/** NDI out: decode the live feed into raw frames for ndi-bridge to send. */
function ndiOut(o, info, fifoV, fifoA, inputUrl) {
  const p = plan({ mode: 'encode', height: o.height, fps: o.fps }, {}, info);
  const fps = p.fps;
  const args = ['-hide_banner', '-y', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-i', inputUrl,
    '-map', '0:v:0', '-vf', 'scale=' + p.width + ':' + p.height + ':flags=bicubic,fps=' + fps + ',format=uyvy422',
    '-f', 'rawvideo', fifoV];
  if (p.hasAudio) args.push('-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 'f32le', fifoA);
  return { args, width: p.width, height: p.height, fps, hasAudio: p.hasAudio };
}

/** Audio meters: EBU R128 momentary/short/integrated loudness and true peak, 10 times a second. */
function meter(inputUrl) {
  return ['-hide_banner', '-nostats', '-loglevel', 'info', '-rtsp_transport', 'tcp', '-i', inputUrl,
    '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=info', '-f', 'null', '-'];
}

/** Human summary for a destination card, e.g. "1280×720 30fps 4.5 Mb/s · AAC 256k". */
function describe(p) {
  const v = p.copyVideo ? 'Original video' : p.width + '×' + p.height + ' ' + round1(p.fps) + 'fps ' + mbps(p.bitrate);
  const a = !p.hasAudio ? 'no audio' : p.copyAudio ? 'original audio' : 'AAC ' + p.audioBitrate + 'k';
  return v + ' · ' + a;
}
const round1 = (n) => Math.round(n * 10) / 10;
const mbps = (k) => (k >= 1000 ? round1(k / 1000) + ' Mb/s' : k + ' kb/s');

/** ffmpeg -progress blocks -> { fps, kbps, speed, drop, dup, outTime } */
function parseProgress(block) {
  const kv = {};
  for (const line of String(block).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const f = (k) => { const n = parseFloat(kv[k]); return Number.isFinite(n) ? n : null; };
  return {
    frame: f('frame'), fps: f('fps'),
    kbps: f('bitrate'),
    speed: f('speed'),
    drop: f('drop_frames'), dup: f('dup_frames'),
    outTime: kv.out_time_us && kv.out_time_us !== 'N/A' ? Number(kv.out_time_us) / 1e6 : null,
    end: kv.progress === 'end'
  };
}

module.exports = { RES, PRESETS, PLATFORM_URLS, targetUrl, plan, defaultBitrate, destination, web, ndiIngest, ndiOut, meter, describe, parseProgress };
