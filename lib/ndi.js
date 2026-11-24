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

  // ---------- NDI out: one per NDI destination ----------
  /**
   * An NDI sender for one destination. Looks like a Proc to the server (start, stop, restart,
   * wanted, state, info(), 'state' events) but is two processes: FFmpeg decoding the feed, and
   * ndi-bridge publishing it. getOut() -> { name, height, fps }.
   */
  function output(id, getOut) {
    const dir = path.join(opts.runDir, 'ndi-out-' + String(id).replace(/[^\w-]/g, ''));
    const fv = path.join(dir, 'video.fifo'), fa = path.join(dir, 'audio.fifo');
    const o = new EventEmitter();
    o.connections = null;
    o.plan = null;
    const dec = new Proc({
      name: 'NDI decoder ' + id, cmd: opts.ffmpeg, progress: true, retry: false,
      args: () => F.ndiOut(getOut() || {}, opts.info(), fv, fa, opts.rtspUrl('live')).args
    });
    const bridge = new Proc({
      name: 'NDI sender ' + id, cmd: opts.bridge, env, liveAfterMs: 1500,
      args: () => {
        applyConfig();
        const out = getOut() || {};
        const pl = F.ndiOut(out, opts.info(), fv, fa, opts.rtspUrl('live'));
        const r = rational(pl.fps);
        o.plan = { width: pl.width, height: pl.height, fps: r.n / r.d, hasAudio: pl.hasAudio };
        fs.mkdirSync(dir, { recursive: true });
        mkfifo(fv); mkfifo(fa);
        o.connections = null;
        setTimeout(() => { if (bridge.wanted && bridge.child) dec.start(); }, 300);
        const name = String(out.name || 'Program').replace(/[()]/g, '').trim().slice(0, 60) || 'Program';
        return ['send', name, String(pl.width), String(pl.height), String(r.n), String(r.d), fv, pl.hasAudio ? fa : '-'];
      },
      onStdoutLine: (line) => {
        let ev; try { ev = JSON.parse(line); } catch (e) { return; }
        if (ev.event === 'status') { o.connections = ev.connections; o.emit('state', o.state, o); }
      }
    });
    bridge.on('exit', () => { if (dec.wanted) dec.stop(); });
    dec.on('state', (st) => { if (st === 'error' && bridge.wanted) { bridge.tail.push('Decoder stopped: ' + dec.error); bridge.restart(); } });
    const fwd = () => o.emit('state', o.state, o);
    bridge.on('state', fwd); dec.on('state', fwd);
    Object.defineProperty(o, 'wanted', { get: () => bridge.wanted });
    Object.defineProperty(o, 'state', { get: () => o.info().state });
    Object.defineProperty(o, 'error', { get: () => bridge.error || dec.error });
    Object.defineProperty(o, 'tail', { get: () => bridge.tail.concat(dec.tail).slice(-15) });
    Object.defineProperty(o, 'pid', { get: () => bridge.pid || null });
    o.o = { name: 'NDI ' + id };
    o.start = () => { if (!bridge.wanted) bridge.start(); };
    o.stop = () => { bridge.stop(); dec.stop(); o.connections = null; };
    o.restart = () => { if (bridge.wanted) { dec.stop(); bridge.restart(); } };
    o.procs = [bridge, dec];
    o.info = () => {
      const bi = bridge.info(), di = dec.info();
      let state = bi.state;
      if (bi.state === 'live' && di.state !== 'live') state = 'starting';
      return {
        state, error: bi.error || di.error, since: di.since || bi.since, retryIn: bi.retryIn, retries: bi.retries,
        pid: bi.pid, pids: [bi.pid, di.pid].filter(Boolean), stats: di.stats, tail: bi.tail.concat(di.tail).slice(-8),
        connections: o.connections, plan: o.plan
      };
    };
    return o;
  }

  return {
    list, ingest, output, applyConfig,
    available: () => supported !== false,
    whyNot: () => whyNot,
    checked: () => supported !== null
  };
}

module.exports = { create, rational, writeConfig };
