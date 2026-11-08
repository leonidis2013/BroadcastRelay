/*
 * Demo mode (npm run demo): the whole app runs with pretend processes, so the web page
 * can be tried without MediaMTX, FFmpeg or a feed. A pretend OBS connects 3 seconds after start.
 */
'use strict';
const EventEmitter = require('events');
const { PassThrough } = require('stream');

let n = 1000;
/** A stand-in for child_process.spawn that behaves like ffmpeg / mediamtx / ndi-bridge. */
function spawn(cmd, args) {
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.pid = ++n; c.exitCode = null; c.signalCode = null;
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(fn, ms));
  const a = args.join(' ');
  let frame = 0;
  if (/progress/.test(a)) {
    const kbps = Number((/-b:v (\d+)k/.exec(a) || [])[1]) || 6000;
    every(500, () => {
      frame += 15;
      c.stdout.write(`frame=${frame}\nfps=30.0\nbitrate=${(kbps * (0.95 + Math.random() * 0.1)).toFixed(1)}kbits/s\nout_time_us=${frame * 33333}\ndrop_frames=0\ndup_frames=0\nspeed=1.00x\nprogress=continue\n`);
    });
  } else if (/ebur128/.test(a)) {
    let t = 0;
    every(100, () => {
      t += 0.1;
      const m = -18 + Math.sin(t) * 5 + Math.random() * 2, pk = m + 8 + Math.random() * 3;
      c.stderr.write(`[Parsed_ebur128_0 @ 0x0] t: ${t.toFixed(1)}  TARGET:-23 LUFS    M:${m.toFixed(1)} S:${(m + 1).toFixed(1)}     I: -16.8 LUFS       LRA:   4.2 LU  FTPK: ${pk.toFixed(1)} ${(pk - 1).toFixed(1)} dBFS  TPK: -2.1 -2.4 dBFS\n`);
    });
  } else if (/^list/.test(a)) {
    setTimeout(() => { c.stdout.write('{"sources":[{"name":"FOH-MAC (OBS Program)","url":"192.168.10.21:5961"},{"name":"PTZ-1 (Channel 1)","url":"192.168.20.31:5961"}]}\n'); c.exitCode = 0; c.emit('exit', 0, null); }, 800);
  } else if (/^recv/.test(a)) {
    setTimeout(() => { c.stdout.write('{"event":"format","width":1920,"height":1080,"fpsN":30000,"fpsD":1001}\n{"event":"status","connected":1}\n'); }, 1000);
  } else if (/^send/.test(a)) {
    setTimeout(() => c.stdout.write('{"event":"status","connections":1}\n'), 2000);
  } else {
    setTimeout(() => c.stdout.write('INF MediaMTX demo\n'), 100);
  }
  c.kill = () => {
    timers.forEach(clearInterval);
    if (c.exitCode !== null || c.signalCode) return true;
    c.signalCode = 'SIGTERM';
    setTimeout(() => c.emit('exit', null, 'SIGTERM'), 50);
    return true;
  };
  return c;
}

const started = Date.now();
let bytes = 0;
/** Pretend MediaMTX API answers. */
function pathInfo(name, ndiLive) {
  const up = Date.now() - started > 3000;
  if (name === 'live') {
    bytes += 780000;
    return up || ndiLive ? { ready: true, since: started + 3000, sourceType: ndiLive ? 'rtspSession' : 'srtConn', sourceId: ndiLive ? 'ndi' : 'demo-1', protocol: ndiLive ? 'RTSP' : 'SRT', videoCodec: 'H264', audioCodec: ndiLive ? 'LPCM' : 'AAC', bytes, readers: 3 } : { ready: false };
  }
  return { ready: up, readers: up ? 2 : 0 };
}
const probe = () => ({ width: 1920, height: 1080, fps: 30, videoProfile: 'High', audioCodecName: 'aac', audioRate: 48000, audioChannels: 2, audioKbps: 320 });
const connStats = () => ({ remote: '192.168.10.21:53122', rtt: 1.2, lossPct: 0, recvMbps: 6.3 });

module.exports = { spawn, pathInfo, probe, connStats };
