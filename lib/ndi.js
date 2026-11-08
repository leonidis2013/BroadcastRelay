/*
 * NDI in and out, through ndi-bridge (ndi/ndi-bridge.c) and FFmpeg joined by two pipes (FIFOs).
 *
 *   NDI in:   ndi-bridge recv  ->  video.fifo + audio.fifo  ->  ffmpeg (H.264 + PCM)  ->  rtsp .../live
 *   NDI out:  rtsp .../live  ->  ffmpeg (raw)  ->  video.fifo + audio.fifo  ->  ndi-bridge send
 *
 * Each side is two processes that live and die together: when one stops, the other is
 * restarted with it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const EventEmitter = require('events');
const { Proc } = require('./proc.js');
const F = require('./ffargs.js');

function mkfifo(p) {
  try { fs.unlinkSync(p); } catch (e) { /* none */ }
  execFileSync('mkfifo', ['-m', '600', p]);
}

/** 29.97 -> 30000/1001, 25 -> 25/1 */
function rational(fps) {
  fps = Number(fps) || 30;
  for (const base of [24, 30, 48, 60, 120]) {
    if (Math.abs(fps - base * 1000 / 1001) < 0.02) return { n: base * 1000, d: 1001 };
  }
  return { n: Math.max(1, Math.round(fps)), d: 1 };
}

/** NDI config file (Discovery Server, groups, extra IPs) in its own folder. */
function writeConfig(dir, ndi) {
  ndi = ndi || {};
  const conf = { ndi: { networks: {}, groups: {} } };
  if (ndi.discoveryServer) conf.ndi.networks.discovery = String(ndi.discoveryServer).trim();
  if (ndi.extraIps) conf.ndi.networks.ips = String(ndi.extraIps).split(/[\s,]+/).filter(Boolean).join(',');
  if (ndi.groups) { conf.ndi.groups.send = String(ndi.groups).trim(); conf.ndi.groups.recv = String(ndi.groups).trim(); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ndi-config.v1.json'), JSON.stringify(conf, null, 2) + '\n');
}

function create(opts) {
  // opts: { bridge, ffmpeg, dataDir, runDir, settings: () => settings, rtspUrl: (path) => url, info: () => feed info }
  const confDir = path.join(opts.dataDir, 'ndi');
  const env = () => {
    const n = opts.settings().ndi || {};
    return { NDI_CONFIG_DIR: confDir, NDI_EXTRA_IPS: String(n.extraIps || '').split(/[\s,]+/).filter(Boolean).join(',') };
  };
  const exists = fs.existsSync(opts.bridge);
  let supported = exists ? null : false; // null = not checked yet
  let whyNot = exists ? '' : 'This image was built without NDI.';

  function applyConfig() { try { writeConfig(confDir, opts.settings().ndi); } catch (e) { /* folder not writable: defaults */ } }

  /** Look for NDI sources: [{ name, url }] */
  function list(seconds = 3) {
    applyConfig();
    return new Promise((resolve) => {
      if (supported === false) return resolve({ ok: false, error: whyNot, sources: [] });
      execFile(opts.bridge, ['list', String(seconds)], { env: Object.assign({}, process.env, env()), timeout: (seconds + 10) * 1000 }, (err, out, errOut) => {
        if (err) {
          const msg = String(errOut || err.message).trim().split('\n').pop();
          if (/libndi|cannot open shared object|not supported/i.test(msg)) { supported = false; whyNot = msg; }
          return resolve({ ok: false, error: msg || 'NDI discovery failed', sources: [] });
        }
        supported = true;
        try { const j = JSON.parse(out); resolve({ ok: true, sources: (j.sources || []).sort((a, b) => a.name.localeCompare(b.name)) }); }
        catch (e) { resolve({ ok: false, error: 'Unexpected answer from ndi-bridge', sources: [] }); }
      });
    });
  }

  // ---------- NDI in ----------
  const inDir = path.join(opts.runDir, 'ndi-in');
  const inV = path.join(inDir, 'video.fifo'), inA = path.join(inDir, 'audio.fifo');
  const ingest = new EventEmitter();
  ingest.format = null;
  ingest.connected = null;
  let inSource = '';

  const inEnc = new Proc({
    name: 'NDI encoder',
    cmd: opts.ffmpeg,
    progress: true,
    retry: false,
    args: () => F.ndiIngest(ingest.format, inV, inA, opts.settings().input || {}, opts.rtspUrl('live'))
  });
  const inBridge = new Proc({
    name: 'NDI receiver',
    cmd: opts.bridge,
    env,
    liveAfterMs: 60000, // live once the format is known
    args: () => {
      applyConfig();
      fs.mkdirSync(inDir, { recursive: true });
      mkfifo(inV); mkfifo(inA);
      ingest.format = null; ingest.connected = null;
      return ['recv', inSource, inV, inA];
    },
    onStdoutLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev.event === 'format') {
        ingest.format = ev;
        inBridge.goLive();
        inEnc.start();
        ingest.emit('change');
      } else if (ev.event === 'status') { ingest.connected = ev.connected; ingest.emit('change'); }
      else if (ev.event === 'changed') { inBridge.tail.push('The NDI source changed to ' + ev.width + '×' + ev.height + ', restarting'); }
    }
  });
  inBridge.on('exit', () => { if (inEnc.wanted) inEnc.stop(); });
  inEnc.on('state', (st) => { if (st === 'error' && inBridge.wanted) { inBridge.tail.push('Encoder stopped: ' + inEnc.error); inBridge.restart(); } });

  ingest.start = (name) => {
    if (!name) return;
    if (inBridge.wanted && name === inSource) return;
    inSource = name;
    if (inBridge.wanted) inBridge.restart(); else inBridge.start();
  };
  ingest.stop = () => { inBridge.stop(); inEnc.stop(); ingest.format = null; ingest.connected = null; };
  ingest.procs = [inBridge, inEnc];
  ingest.source = () => inSource;
  ingest.info = () => {
    const b = inBridge.info(), e = inEnc.info();
    let state = b.state;
    if (b.state === 'live' && e.state !== 'live') state = e.state === 'error' ? 'retrying' : 'starting';
    return { state, error: b.error || e.error, source: inSource, format: ingest.format, connected: ingest.connected, encoder: e.stats, tail: b.tail.concat(e.tail).slice(-8), pids: [b.pid, e.pid].filter(Boolean) };
  };

  // ---------- NDI out ----------
  const outDir = path.join(opts.runDir, 'ndi-out');
  const outV = path.join(outDir, 'video.fifo'), outA = path.join(outDir, 'audio.fifo');
  const output = new EventEmitter();
  output.connections = null;
  let outPlan = null;

  const outDec = new Proc({
    name: 'NDI output decoder',
    cmd: opts.ffmpeg,
    progress: true,
    retry: false,
    args: () => F.ndiOut(opts.settings().ndiOut || {}, opts.info(), outV, outA, opts.rtspUrl('live')).args
  });
  const outBridge = new Proc({
    name: 'NDI sender',
    cmd: opts.bridge,
    env,
    liveAfterMs: 1500,
    args: () => {
      applyConfig();
      const o = opts.settings().ndiOut || {};
      const pl = F.ndiOut(o, opts.info(), outV, outA, opts.rtspUrl('live'));
      const r = rational(pl.fps);
      outPlan = { width: pl.width, height: pl.height, fps: r.n / r.d, hasAudio: pl.hasAudio };
      fs.mkdirSync(outDir, { recursive: true });
      mkfifo(outV); mkfifo(outA);
      output.connections = null;
      setTimeout(() => { if (outBridge.wanted && outBridge.child) outDec.start(); }, 300);
      return ['send', String(o.name || 'Program').slice(0, 60), String(pl.width), String(pl.height), String(r.n), String(r.d), outV, pl.hasAudio ? outA : '-'];
    },
    onStdoutLine: (line) => {
      let ev; try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev.event === 'status') { output.connections = ev.connections; output.emit('change'); }
    }
  });
  outBridge.on('exit', () => { if (outDec.wanted) outDec.stop(); });
  outDec.on('state', (st) => { if (st === 'error' && outBridge.wanted) outBridge.restart(); });

  output.start = () => { if (!outBridge.wanted) outBridge.start(); };
  output.stop = () => { outBridge.stop(); outDec.stop(); output.connections = null; };
  output.restart = () => { if (outBridge.wanted) { outDec.stop(); outBridge.restart(); } };
  output.procs = [outBridge, outDec];
  output.info = () => {
    const b = outBridge.info(), d = outDec.info();
    let state = b.state;
    if (b.state === 'live' && d.state !== 'live') state = 'starting';
    return { state, error: b.error || d.error, connections: output.connections, plan: outPlan, stats: d.stats, tail: b.tail.concat(d.tail).slice(-8), pids: [b.pid, d.pid].filter(Boolean) };
  };

  return {
    list, ingest, output, applyConfig,
    available: () => supported !== false,
    whyNot: () => whyNot,
    checked: () => supported !== null
  };
}

module.exports = { create, rational, writeConfig };
