/*
 * Resource estimates: how much CPU, memory and upload each destination (and the fixed parts) will use.
 *
 * How it works:
 *  - limits(): what this container may use: CPU and memory limits from its cgroup (the TrueNAS app's
 *    resource limits), else the whole machine.
 *  - A short benchmark on this CPU (FFmpeg decodes and encodes 8 s of 1080p test video) measures how many
 *    core-seconds one megapixel costs to decode and to encode with x264 "veryfast", and how much memory the
 *    encoder needs. Without a benchmark, typical numbers for a modern x86 core are used.
 *  - Every destination's plan (resolution, fps, preset, copy or encode) is turned into pixels per second
 *    and priced with those numbers. Each destination is its own FFmpeg, so each one decodes the input too.
 *  - While destinations run, the measured CPU is compared with the estimate and the estimates slowly
 *    follow what this server really does ("learned").
 *
 * CPU numbers are "% of one core" (like top): 100 = one full core.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// x264 preset cost relative to veryfast (rough, from x264 preset benchmarks)
const PRESET_COST = { ultrafast: 0.4, superfast: 0.55, veryfast: 1, faster: 1.55, fast: 1.95, medium: 2.4 };
const LOOKAHEAD = { ultrafast: 0, superfast: 0, veryfast: 10, faster: 20, fast: 30, medium: 40 };
// typical modern x86 core (e.g. a recent Ryzen / Xeon): 1080p30 veryfast ≈ 1.3 cores, H.264 decode ≈ 0.12 cores
const TYPICAL = { enc: 0.021, dec: 0.0019, rss1080: 210 };

const readStr = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; } };

/** Count the CPUs in a cpuset list like "0-3,6,8-9". */
function cpusetCount(s) {
  if (!s) return null;
  let n = 0;
  for (const part of s.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    n += m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1;
  }
  return n || null;
}
/** Parse cgroup v2 cpu.max ("max 100000" or "200000 100000") into cores, or null for no limit. */
function cpuMaxCores(s) {
  const m = /^(\S+)\s+(\d+)/.exec(s || '');
  if (!m || m[1] === 'max') return null;
  const q = Number(m[1]), p = Number(m[2]);
  return q > 0 && p > 0 ? Math.round(q / p * 100) / 100 : null;
}

/** CPU and memory this container may use. root lets the tests point it at a fake /sys/fs/cgroup. */
function limits(root = '/sys/fs/cgroup') {
  const hostCores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const hostMem = os.totalmem();
  let cores = hostCores, coresFrom = 'the server';
  // cgroup v2, then v1
  const quota = cpuMaxCores(readStr(path.join(root, 'cpu.max'))) ||
    (() => { const q = Number(readStr(path.join(root, 'cpu/cpu.cfs_quota_us'))), p = Number(readStr(path.join(root, 'cpu/cpu.cfs_period_us'))); return q > 0 && p > 0 ? Math.round(q / p * 100) / 100 : null; })();
  const set = cpusetCount(readStr(path.join(root, 'cpuset.cpus.effective')) || readStr(path.join(root, 'cpuset/cpuset.effective_cpus')));
  if (set && set < cores) { cores = set; coresFrom = 'the app\'s CPU set'; }
  if (quota && quota < cores) { cores = quota; coresFrom = 'the app\'s CPU limit'; }
  let mem = hostMem, memFrom = 'the server';
  const mv = readStr(path.join(root, 'memory.max')) || readStr(path.join(root, 'memory/memory.limit_in_bytes'));
  if (mv && /^\d+$/.test(mv) && Number(mv) < hostMem) { mem = Number(mv); memFrom = 'the app\'s memory limit'; }
  const cur = readStr(path.join(root, 'memory.current')) || readStr(path.join(root, 'memory/memory.usage_in_bytes'));
  return {
    cores, coresFrom, hostCores,
    memMB: Math.round(mem / 1048576), memFrom, hostMemMB: Math.round(hostMem / 1048576),
    memUsedMB: cur && /^\d+$/.test(cur) ? Math.round(Number(cur) / 1048576) : null,
    cpuModel: ((os.cpus()[0] || {}).model || '').replace(/\s+/g, ' ').trim()
  };
}

// ---------- benchmark ----------
function bench(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-nostdin', '-benchmark', ...args], { timeout: 120000, maxBuffer: 8 << 20 }, (err, out, errText) => {
      if (err) return reject(new Error(String(errText || err.message).trim().split('\n').pop()));
      const t = /utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/.exec(errText);
      const rss = /maxrss=(\d+)\s*(?:KiB|kB)/i.exec(errText);
      if (!t) return reject(new Error('FFmpeg gave no timing'));
      resolve({ cpu: Number(t[1]) + Number(t[2]), wall: Number(t[3]), rssMB: rss ? Math.round(Number(rss[1]) / 1024) : null });
    });
  });
}
/** Measure this CPU: 8 s of 1080p30 test video, decoded, then decoded + encoded with x264 veryfast. */
async function runBenchmark(ffmpeg, tmpDir) {
  const W = 1920, H = 1080, FRAMES = 240, mpix = W * H * FRAMES / 1e6;
  const file = path.join(tmpDir, 'br-bench-' + process.pid + '.ts');
  try {
    // a fair source: moving test pattern with noise, stored nearly lossless so decoding it is like a real feed
    await bench(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=' + W + 'x' + H + ':rate=30,noise=alls=12:allf=t', '-frames:v', String(FRAMES),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '20000k', '-g', '60', '-f', 'mpegts', file]);
    const dec = await bench(ffmpeg, ['-i', file, '-f', 'null', '-']);
    const enc = await bench(ffmpeg, ['-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
      '-g', '60', '-bf', '2', '-f', 'null', '-']);
    const decPer = dec.cpu / mpix, encPer = Math.max(0.002, (enc.cpu - dec.cpu) / mpix);
    return {
      at: Date.now(),
      cpuModel: limits().cpuModel,
      dec: Math.round(decPer * 1e6) / 1e6,
      enc: Math.round(encPer * 1e6) / 1e6,
      rss1080: enc.rssMB,
      // how fast the whole thing ran, for the page: 1080p30 veryfast realtime needs this many cores
      cores1080: Math.round((encPer + decPer) * W * H * 30 / 1e6 * 100) / 100,
      wallFps: Math.round(FRAMES / enc.wall)
    };
  } finally { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
}

// ---------- the model ----------
/**
 * Create an estimator. store: { get(): saved calibration or null, set(obj) } so the benchmark and what was
 * learned survive restarts.
 */
function create(store) {
  let cal = store.get() || null;
  if (cal && cal.cpuModel && cal.cpuModel !== limits().cpuModel) cal = { learn: 1 }; // moved to another server
  const k = () => ({
    enc: (cal && cal.enc) || TYPICAL.enc,
    dec: (cal && cal.dec) || TYPICAL.dec,
    rss1080: (cal && cal.rss1080) || TYPICAL.rss1080,
    learn: (cal && cal.learn) || 1
  });
  const threads = () => Math.min(16, Math.max(1, Math.round(limits().cores * 1.5)));

  /** Memory of one x264 encoder, scaled from the 1080p veryfast measurement. */
  function encMem(w, h, preset) {
    const frameMB = w * h * 1.5 / 1048576;
    const frames = (p) => (LOOKAHEAD[p] || 10) + threads() * 1.5 + 8;
    const model = (fw, fh, p) => 40 + (fw * fh * 1.5 / 1048576) * frames(p);
    const scale = k().rss1080 / model(1920, 1080, 'veryfast');
    return Math.round(Math.max(30, model(w, h, preset) * Math.min(2.5, Math.max(0.4, scale))));
  }
  const pps = (w, h, fps) => w * h * fps / 1e6; // megapixels per second

  /**
   * Estimate for one destination.
   * p: the plan from ffargs.plan(); input: { width, height, fps, kbps, audioKbps }; type: destination type.
   * Returns { cpu (% of one core), memMB, upKbps (internet), lanKbps (NDI, on the local network), parts }.
   */
  function forPlan(p, input, type, opts = {}) {
    const K = k();
    const inPps = pps(input.width || 1920, input.height || 1080, input.fps || 30);
    if (type === 'ndi') {
      // decode the feed, scale and convert, then the NDI SDK compresses it (SpeedHQ) on the CPU
      const outPps = pps(p.width, p.height, p.fps);
      const cpu = (K.dec * inPps + K.dec * 1.6 * outPps) * 100 * K.learn + 3;
      return { cpu: Math.round(cpu), memMB: Math.round(90 + p.width * p.height * 2 / 1048576 * 12), upKbps: 0, lanKbps: Math.round(outPps * 2000), parts: 'decode + NDI compression' };
    }
    const audio = p.hasAudio === false ? 0 : p.copyAudio ? (input.audioKbps || 256) : p.audioBitrate;
    if (p.copyVideo) {
      const v = input.kbps ? Math.max(0, input.kbps - (input.audioKbps || 0)) : p.bitrate;
      return { cpu: p.copyAudio ? 2 : 4, memMB: 35, upKbps: Math.round((v + audio) * 1.04), lanKbps: 0, parts: 'original video, no encoding' };
    }
    const outPps = pps(p.width, p.height, p.fps);
    const enc = K.enc * outPps * (PRESET_COST[p.preset] || 1) * (opts.noBframes ? 0.92 : 1);
    const dec = K.dec * inPps;
    const scale = p.scale || p.fpsChange ? K.dec * 0.35 * inPps : 0;
    const aud = p.copyAudio ? 0.3 : 1.2 + (opts.opus ? 1.2 : 0);
    const cpu = (enc + dec + scale) * 100 * K.learn + aud;
    return {
      cpu: Math.round(cpu),
      memMB: encMem(p.width, p.height, p.preset) + 25,
      upKbps: Math.round((p.bitrate + audio) * 1.04),
      lanKbps: 0,
      parts: 'decode ' + Math.round(dec * 100 * K.learn) + '% + encode ' + Math.round(enc * 100 * K.learn) + '%'
    };
  }

  /** Fixed parts: MediaMTX, the meters, the app, and the NDI input encode when NDI is the input. */
  function fixed(input, ndiIn) {
    const K = k(), out = [];
    out.push({ name: 'Relay, meters and this page', cpu: 6 + Math.round((input.kbps || 6000) / 10000 * 1.5), memMB: 160, upKbps: 0 });
    if (ndiIn) {
      const inPps = pps(input.width || 1920, input.height || 1080, input.fps || 30);
      const cpu = (K.dec * 1.6 * inPps + K.enc * inPps * (PRESET_COST[ndiIn.preset] || 1) + K.dec * 0.3 * inPps) * 100 * K.learn;
      out.push({ name: 'NDI input (receive and encode)', cpu: Math.round(cpu), memMB: encMem(input.width || 1920, input.height || 1080, ndiIn.preset) + 80, upKbps: 0 });
    }
    return out;
  }

  /** Follow what the server really does: measured vs estimated CPU of running encodes. */
  function learn(estimated, measured) {
    if (!(estimated > 20) || !(measured > 0)) return;
    const K = k(), ratio = Math.min(2.5, Math.max(0.4, measured / (estimated / K.learn)));
    cal = Object.assign({}, cal || {}, { learn: Math.round((K.learn * 0.995 + ratio * 0.005) * 1000) / 1000 });
    learnDirty = true;
  }
  let learnDirty = false;
  function flush() { if (learnDirty) { learnDirty = false; store.set(cal); } }

  let running = null;
  async function benchmark(ffmpeg, tmp) {
    if (running) return running;
    running = runBenchmark(ffmpeg, tmp).then((b) => { cal = Object.assign(b, { learn: 1 }); store.set(cal); return b; }).finally(() => { running = null; });
    return running;
  }
  function setCal(b) { cal = Object.assign({}, b, { learn: 1 }); store.set(cal); }
  function info() {
    const K = k();
    return {
      measured: !!(cal && cal.enc), at: cal && cal.at, running: !!running,
      cores1080: Math.round((K.enc + K.dec) * pps(1920, 1080, 30) * K.learn * 100) / 100,
      learn: K.learn, wallFps: cal && cal.wallFps
    };
  }
  return { forPlan, fixed, learn, flush, benchmark, setCal, info, limits };
}

module.exports = { create, limits, cpusetCount, cpuMaxCores, runBenchmark, PRESET_COST, TYPICAL };
