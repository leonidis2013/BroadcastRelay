/*
 * Audio meters for the incoming feed (EBU R128 via FFmpeg's ebur128 filter) and
 * a one-shot ffprobe of the feed to learn its resolution, frame rate and audio format.
 */
'use strict';
const { execFile } = require('child_process');
const { Proc } = require('./proc.js');
const F = require('./ffargs.js');

const n = (s) => (s == null || /inf/i.test(s) ? -120 : Math.max(-120, parseFloat(s)));

/** One ebur128 frame log line -> { m, s, i, lra, peak:[L,R], tpk:[L,R] } or null. */
function parseLine(line) {
  if (!/\bt:\s*[\d.]+/.test(line) || !/\bM:/.test(line)) return null;
  const g = (re) => { const m = re.exec(line); return m ? m[1] : null; };
  const pk = (label) => {
    const m = new RegExp('\\b' + label + ':\\s*((?:-?(?:[\\d.]+|inf)\\s+)+)dBFS').exec(line);
    return m ? m[1].trim().split(/\s+/).map(n) : null;
  };
  return {
    m: n(g(/\bM:\s*(-?[\d.]+|-?inf)/)),
    s: n(g(/\bS:\s*(-?[\d.]+|-?inf)/)),
    i: n(g(/\bI:\s*(-?[\d.]+|-?inf)/)),
    lra: Math.max(0, parseFloat(g(/\bLRA:\s*(-?[\d.]+)/)) || 0),
    peak: pk('FTPK') || pk('SPK') || [],
    tpk: pk('TPK') || []
  };
}

function create(opts) {
  // opts: { ffmpeg, inputUrl: () => url, onLevels(levels) }
  let last = null, lastAt = 0;
  const proc = new Proc({
    name: 'Meters',
    cmd: opts.ffmpeg,
    args: () => F.meter(opts.inputUrl()),
    liveAfterMs: 2000,
    onStderrLine: (line) => {
      const v = parseLine(line);
      if (!v) return true;
      last = v; lastAt = Date.now();
      if (opts.onLevels) opts.onLevels(v);
      return false; // keep meter lines out of the error tail
    }
  });
  return {
    proc,
    levels: () => (last && Date.now() - lastAt < 1500 ? last : null),
    clear: () => { last = null; }
  };
}

/** ffprobe the feed: { width, height, fps, videoProfile, audioRate, audioChannels, audioCodecName } */
function probe(ffprobe, url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(ffprobe, ['-v', 'error', '-rtsp_transport', 'tcp', '-rw_timeout', String(timeoutMs * 1000), '-show_streams', '-of', 'json', url],
      { timeout: timeoutMs + 2000, maxBuffer: 1 << 20 }, (err, out) => {
        if (err) return resolve(null);
        try { resolve(parseProbe(JSON.parse(out))); } catch (e) { resolve(null); }
      });
  });
}
function parseProbe(j) {
  const ss = (j && j.streams) || [];
  const v = ss.find((s) => s.codec_type === 'video'), a = ss.find((s) => s.codec_type === 'audio');
  const rate = (r) => { const [x, y] = String(r || '0/1').split('/').map(Number); return y ? x / y : x || 0; };
  const fps = v ? (rate(v.avg_frame_rate) > 0 && rate(v.avg_frame_rate) < 300 ? rate(v.avg_frame_rate) : rate(v.r_frame_rate)) : 0;
  return {
    width: v ? v.width : null,
    height: v ? v.height : null,
    fps: fps ? Math.round(fps * 100) / 100 : null,
    videoProfile: v ? v.profile || null : null,
    audioCodecName: a ? a.codec_name : null,
    audioRate: a ? Number(a.sample_rate) || null : null,
    audioChannels: a ? a.channels || null : null,
    audioKbps: a && a.bit_rate ? Math.round(Number(a.bit_rate) / 1000) : null
  };
}

module.exports = { create, probe, parseLine, parseProbe };
