#!/usr/bin/env node
/*
 * BroadcastRelay
 * Takes the program feed from OBS (SRT, RTMP or WHIP) or from an NDI source and sends it
 * everywhere it needs to go: YouTube and Facebook (through their APIs or a stream key),
 * any other RTMP/SRT service, a web player (WebRTC on the LAN, HLS for the public) and
 * back out as an NDI source. Each destination gets its own encode. The raw input is recorded
 * for troubleshooting. Everything is set up and run from the web page, or from Bitfocus
 * Companion through the API.
 *
 * Pieces: MediaMTX (protocols, recording, player), FFmpeg (one per destination, meters),
 * ndi-bridge (NDI in and out). No npm packages: Node 22 or newer.
 *
 * Copyright Jerod Ulicki.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const F = require('./lib/ffargs.js');
const { Proc } = require('./lib/proc.js');
const MediaMTX = require('./lib/mediamtx.js');
const Meter = require('./lib/meter.js');
const Ndi = require('./lib/ndi.js');
const YouTube = require('./lib/youtube.js');
const CATEGORY_IDS = YouTube.CATEGORIES.map((c) => c[0]);
const Facebook = require('./lib/facebook.js');
const Rec = require('./lib/recordings.js');
const Auth = require('./lib/auth.js');
const Secrets = require('./lib/secrets.js');
const Sys = require('./lib/sys.js');
const Demo = require('./lib/demo.js');
const Net = require('./lib/netinfo.js');
const Est = require('./lib/estimate.js');
const Predict = require('./lib/predict.js');
const pkg = require('./package.json');

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const DATA = path.resolve(process.env.DATA_DIR || (DEMO ? fs.mkdtempSync(path.join(os.tmpdir(), 'br-demo-')) : path.join(__dirname, 'data')));
const RECORD_DIR = path.resolve(process.env.RECORD_DIR || path.join(DATA, 'recordings'));
const RUN_DIR = path.resolve(process.env.RUN_DIR || path.join(os.tmpdir(), 'broadcastrelay-' + process.pid));
const PORT = Number(process.env.PORT || 9180);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 9181);
const BIND = process.env.BIND || '0.0.0.0';
const BIN = {
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  ffprobe: process.env.FFPROBE || 'ffprobe',
  mediamtx: process.env.MEDIAMTX || 'mediamtx',
  bridge: process.env.NDI_BRIDGE || '/usr/local/bin/ndi-bridge'
};
const spawnFn = DEMO ? Demo.spawn : undefined;
const cfgPath = path.join(DATA, 'config.json');
const statePath = path.join(DATA, 'state.json');

// ---------- settings ----------
const DEFAULTS = {
  input: { source: 'stream', ndiSource: '', ndiBitrate: 12000, ndiPreset: 'veryfast', allowFrom: MediaMTX.PRIVATE.slice() },
  ports: Object.assign({}, MediaMTX.DEFAULT_PORTS),
  network: { publicHosts: '', publicUrl: '' },
  // your internet upload speed in Mb/s (0 = not set), to compare the estimated upload with
  resources: { uploadMbps: 0 },
  // what the stream is called, shared by every destination (one can use its own instead)
  stream: { title: '{weekday} Service - {date}', sermon: '', speaker: '', speakers: [], series: '', seriesList: [], part: 0, autoPart: true, description: '', privacy: 'public', category: '', presets: [], presetId: '', profiles: [], history: [] },
  destinations: [],
  web: { enabled: true, mode: 'encode', height: 720, fps: 0, bitrate: 0, preset: 'veryfast', audioBitrate: 160, title: 'Live', offlineText: 'The stream will start soon.' },
  ndi: { discoveryServer: '', extraIps: '', groups: '' },
  recording: { enabled: true, segmentMinutes: 30, keepDays: 14, maxGB: 0 },
  youtube: { clientId: '', clientSecret: '', refreshToken: '', channelId: '', channelTitle: '', streamId: '', needsReconnect: false, connectError: '' },
  facebook: { appId: '', clientToken: '', appSecret: '', userToken: '', pageId: '', pageName: '', pageToken: '', pages: [], graphVersion: 'v23.0', needsReconnect: false, connectError: '', pagesError: '' },
  api: { token: '' },
  auth: { passwordHash: '' }
};
const SECRET = { youtube: ['clientSecret', 'refreshToken'], facebook: ['clientToken', 'appSecret', 'userToken', 'pageToken'] };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; console.error(file + ' could not be read: ' + e.message); process.exit(1); }
}
function writeJson(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const clone = (o) => JSON.parse(JSON.stringify(o));

let cfg = clone(DEFAULTS);
{
  const saved = readJson(cfgPath, {});
  for (const k of Object.keys(DEFAULTS)) {
    if (Array.isArray(DEFAULTS[k])) cfg[k] = Array.isArray(saved[k]) ? saved[k] : [];
    else if (saved[k] && typeof saved[k] === 'object') cfg[k] = Object.assign({}, DEFAULTS[k], saved[k]);
  }
  cfg.ports = MediaMTX.ports(cfg.ports);
  // 0.2.0: titles moved from each destination to one shared "stream" section.
  // Seed it from the first account destination, and let destinations that matched it use it.
  if (!saved.stream) {
    const src = cfg.destinations.find((d) => d.connect === 'api' && d.title) || cfg.destinations.find((d) => d.title);
    if (src) Object.assign(cfg.stream, { title: src.title, description: src.description || '', privacy: src.privacy || 'public' });
    else if (cfg.web.title && cfg.web.title !== 'Live') cfg.stream.title = cfg.web.title;
    for (const d of cfg.destinations) {
      d.useShared = !d.title || (d.title === cfg.stream.title && (d.description || '') === cfg.stream.description && (d.privacy || 'public') === cfg.stream.privacy);
    }
  }
  if (!Array.isArray(cfg.stream.presets)) cfg.stream.presets = [];
  if (!Array.isArray(cfg.stream.speakers)) cfg.stream.speakers = [];
  if (!Array.isArray(cfg.stream.seriesList)) cfg.stream.seriesList = [];
  if (!Array.isArray(cfg.stream.profiles)) cfg.stream.profiles = [];
  if (!Array.isArray(cfg.stream.history)) cfg.stream.history = [];
  // 0.5.0: presets became title formats, and one is always selected
  if (!cfg.stream.presets.length) cfg.stream.presets.push({ id: crypto.randomBytes(4).toString('hex'), name: 'Service', title: cfg.stream.title, description: cfg.stream.description, privacy: cfg.stream.privacy, category: cfg.stream.category });
  if (!cfg.stream.presets.some((p) => p.id === cfg.stream.presetId)) {
    const same = cfg.stream.presets.find((p) => p.title === cfg.stream.title);
    cfg.stream.presetId = (same || cfg.stream.presets[0]).id;
    if (!same) cfg.stream.title = cfg.stream.presets[0].title;
  }
  // npm run demo: eight weeks of Sunday morning and Wednesday evening streams, so suggestions can be tried
  if (DEMO && args.includes('--demo-history') && !cfg.stream.history.length) {
    const sun = cfg.stream.presets[0];
    let wed = cfg.stream.presets.find((p) => p.name === 'Wednesday Night');
    if (!wed) { wed = { id: crypto.randomBytes(4).toString('hex'), name: 'Wednesday Night', title: 'Wednesday Night - {series}, {part}', description: '', privacy: 'public', category: '' }; cfg.stream.presets.push(wed); }
    const sermons = ['Called to Be Saints', 'Not Ashamed', 'All Have Sinned', 'Justified by Faith', 'Peace with God', 'Dead to Sin', 'The Law and Grace', 'No Condemnation'];
    const psalms = ['The Blessed Man', 'Why Do the Nations Rage', 'A Shield About Me', 'In Peace I Lie Down', 'Lead Me, Lord', 'Lord, Heal Me', 'My Refuge', 'How Majestic'];
    const at = (weeksAgo, day, h, m) => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() - day + 7) % 7 || 7) - 7 * weeksAgo); d.setHours(h, m, 0, 0); return d; };
    const add = (d, f, series, part, sermon, speaker) => cfg.stream.history.push({ id: crypto.randomBytes(4).toString('hex'), t: d.getTime(), day: d.getDay(), hour: d.getHours() + d.getMinutes() / 60, presetId: f.id, format: f.name,
      title: f.name, series, part, sermon, speaker, autoPart: true, minutes: 75 });
    for (let w = 7; w >= 0; w--) {
      add(at(w, 0, 10, 30), sun, 'Romans', 8 - w, sermons[7 - w], w === 3 ? 'Pastor Dave Miller' : 'Pastor John Smith');
      add(at(w, 3, 19, 0), wed, 'Psalms', 8 - w, psalms[7 - w], 'Pastor Mike Lee');
    }
    cfg.stream.history.sort((a, b) => a.t - b.t);
    cfg.stream.profiles = [{ id: crypto.randomBytes(4).toString('hex'), name: 'Sunday Morning', presetId: sun.id, series: 'Romans', speaker: 'Pastor John Smith', description: '', autoPart: true },
      { id: crypto.randomBytes(4).toString('hex'), name: 'Wednesday Night', presetId: wed.id, series: 'Psalms', speaker: 'Pastor Mike Lee', description: '', autoPart: true }];
  }
  // 0.3.0: the fixed NDI output became a destination type
  if (saved.ndiOut && (saved.ndiOut.enabled || (saved.ndiOut.name && saved.ndiOut.name !== 'Program')) && !cfg.destinations.some((d) => d.type === 'ndi')) {
    cfg.destinations.push({ id: crypto.randomBytes(4).toString('hex'), name: String(saved.ndiOut.name || 'Program').replace(/[()]/g, '') || 'Program', type: 'ndi', armed: true, connect: 'key', url: '', key: '', useShared: true, title: '', description: '', privacy: 'public',
      video: { mode: 'encode', height: Number(saved.ndiOut.height) || 0, fps: Number(saved.ndiOut.fps) || 0, bitrate: 0, preset: 'veryfast' }, audio: { mode: 'copy', bitrate: 256 } });
  }
}
const secrets = Secrets.create(path.join(DATA, 'secret.key'), { masterKey: process.env.BROADCASTRELAY_MASTER_KEY });
if (!cfg.api.token) cfg.api.token = secrets.enc(crypto.randomBytes(18).toString('base64url'));

function saveCfg() { if (!DEMO) writeJson(cfgPath, cfg); }
try { fs.mkdirSync(DATA, { recursive: true }); saveCfg(); } catch (e) { console.error('Cannot write to ' + DATA + ': ' + e.message); }

const state = DEMO ? {} : readJson(statePath, {});
let stateTimer = null;
function saveState() {
  if (DEMO) return;
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { try { writeJson(statePath, state); } catch (e) { console.error('Could not save state: ' + e.message); } }, 300);
}

/** Platform settings with the secret fields decrypted. */
function plain(section) {
  const o = Object.assign({}, cfg[section]);
  for (const k of SECRET[section] || []) o[k] = secrets.dec(o[k]);
  if (section === 'facebook') o.pages = (o.pages || []).map((p) => Object.assign({}, p, { token: secrets.dec(p.token) }));
  return o;
}
/** Save platform settings, encrypting secret fields. */
function savePlatform(section, patch) {
  const next = Object.assign({}, cfg[section]);
  for (const [k, v] of Object.entries(patch || {})) {
    if ((SECRET[section] || []).includes(k)) next[k] = v ? secrets.enc(v) : '';
    else if (section === 'facebook' && k === 'pages') next.pages = (v || []).map((p) => ({ id: p.id, name: p.name, token: secrets.enc(p.token) }));
    else next[k] = v;
  }
  cfg[section] = next;
  saveCfg();
  pushState();
}

// ---------- helpers ----------
const str = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const int = (v, min, max, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const rid = () => crypto.randomBytes(4).toString('hex');
const rtsp = (p) => 'rtsp://127.0.0.1:' + cfg.ports.rtsp + '/' + p;
const dest = (id) => cfg.destinations.find((d) => d.id === id);

/** "Part 3", or nothing when there is no part number. */
function partText() { const n = Number(cfg.stream && cfg.stream.part) || 0; return n > 0 ? 'Part ' + n : ''; }
/** "Series, Part 3" for the web player. */
function seriesLine() { return [cfg.stream.series, partText()].filter(Boolean).join(', '); }

function formatTitle(t, vals) {
  const v = vals || cfg.stream || {};
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  return String(t || '').replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{weekday\}/g, weekday)
    .replace(/\{sermon\}/g, v.sermon || '').replace(/\{speaker\}/g, v.speaker || '')
    .replace(/\{series\}/g, v.series || '').replace(/\{part\}/g, Number(v.part) > 0 ? 'Part ' + Number(v.part) : '')
    // tidy what an empty {sermon} or {speaker} leaves behind: "A -  - B", "A -", "- B", "A with"
    .replace(/\s+(with|by|featuring|feat\.)\s*$/i, ' ')
    .replace(/(\s*[-–—|·:]\s*)(?:[-–—|·:]\s*)+/g, '$1')
    .replace(/^\s*[-–—|·:]\s*/, '').replace(/\s*[-–—|·:]\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|veth|br-|lo|kube|cni|flannel|tailscale|virbr)/.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---------- the feed ----------
const sys = Sys.create();

// ---------- resource estimates ----------
const benchPath = path.join(DATA, 'benchmark.json');
const est = Est.create({ get: () => readJson(benchPath, null), set: (o) => { try { fs.writeFileSync(benchPath, JSON.stringify(o, null, 2)); } catch (e) { /* read-only */ } } });
// demo: numbers like a 6-core desktop CPU, so the page shows something real-looking
if (DEMO) est.setCal({ at: Date.now(), dec: 0.0016, enc: 0.0105, rss1080: 230, cores1080: 0.75, wallFps: 160 });
// demo: a typical TrueNAS app with limits set, instead of whatever machine the demo runs on
const appLimits = DEMO ? () => Object.assign(Est.limits(), { cores: 6, coresFrom: 'the app\'s CPU limit', hostCores: 12, memMB: 8192, memFrom: 'the app\'s memory limit', hostMemMB: 65536, memUsedMB: 910, cpuModel: 'AMD Ryzen 5 5600G with Radeon Graphics' }) : Est.limits;
function estInput() {
  const i = feed.info || {};
  return { width: i.width || 1920, height: i.height || 1080, fps: i.fps || 30, kbps: feed.ready ? feed.kbps : null, audioKbps: i.audioKbps || null, assumed: !feed.info };
}
/** Estimate for one destination's settings (saved or still being edited). */
function estimateDest(d) {
  const info = feed.info || { width: 1920, height: 1080, fps: 30, videoCodec: 'H264', audioCodec: 'AAC' };
  const plan = d.type === 'ndi' ? F.plan({ mode: 'encode', height: d.video && d.video.height, fps: d.video && d.video.fps }, {}, info)
    : F.plan(d.video, d.audio, info, { type: d.type });
  return Object.assign(est.forPlan(plan, estInput(), d.type), { bitrate: plan.copyVideo ? null : plan.bitrate, audioBitrate: plan.copyAudio ? null : plan.audioBitrate, height: plan.height, reasons: plan.reasons });
}
function estimateWeb() {
  if (!cfg.web.enabled) return null;
  const info = feed.info || { width: 1920, height: 1080, fps: 30, videoCodec: 'H264', audioCodec: 'AAC' };
  const p = F.plan({ mode: cfg.web.mode, height: cfg.web.height, fps: cfg.web.fps, bitrate: cfg.web.bitrate, preset: cfg.web.preset }, { mode: 'aac', bitrate: cfg.web.audioBitrate || 160 }, info);
  const e = est.forPlan(p, estInput(), 'web', { noBframes: true, opus: true });
  e.perViewerKbps = e.upKbps; e.upKbps = 0;
  return e;
}
/** The whole picture: limits, the fixed parts, every destination, and totals. */
function resources(destStates) {
  const lim = appLimits();
  const items = est.fixed(estInput(), cfg.input.source === 'ndi' ? { preset: cfg.input.ndiPreset } : null).map((x) => Object.assign({ kind: 'fixed' }, x));
  const w = estimateWeb();
  if (w) items.push(Object.assign({ kind: 'web', name: 'Web player', id: 'web' }, w));
  cfg.destinations.forEach((d, i) => {
    const e = estimateDest(d), st = destStates && destStates[i];
    items.push(Object.assign({ kind: 'dest', name: d.name, id: d.id, armed: d.armed, running: !!(st && st.state !== 'off' && st.state !== 'error'), measured: st && st.state === 'live' ? st.cpu : null }, e));
  });
  const sum = (list, k) => list.reduce((a, x) => a + (x[k] || 0), 0);
  const golive = items.filter((x) => x.kind !== 'dest' || x.armed);
  const run = items.filter((x) => x.kind !== 'dest' || x.running);
  const total = (list) => ({ cpu: sum(list, 'cpu'), memMB: sum(list, 'memMB'), upKbps: sum(list, 'upKbps'), lanKbps: sum(list, 'lanKbps') });
  return {
    limits: lim, bench: est.info(), input: estInput(), uploadMbps: cfg.resources.uploadMbps || 0,
    items, all: total(items), golive: total(golive), running: total(run),
    measuredCpu: sys.totalPct() != null ? Math.round(sys.totalPct() * lim.hostCores) : null
  };
}
async function benchmarkNow() {
  if (DEMO) { await new Promise((r) => setTimeout(r, 1500)); return est.info(); }
  await est.benchmark(BIN.ffmpeg, os.tmpdir());
  logEvent('info', 'Resources', 'Measured this CPU: 1080p30 needs about ' + est.info().cores1080 + ' cores');
  pushState();
  return est.info();
}
// measure the CPU once, soon after the first start, when nothing is streaming
setTimeout(function autoBench() {
  if (DEMO || est.info().measured) return;
  if ([...runs.values()].some((r) => r.want)) return setTimeout(autoBench, 10 * 60e3);
  benchmarkNow().catch((e) => console.warn('benchmark:', e.message));
}, 20e3).unref();
const feed = { ready: false, sourceId: null, path: { ready: false }, info: null, probing: false, gen: 0, lastBytes: null, lastAt: 0, kbps: null, conn: null, since: null };

const mtx = MediaMTX.create({ bin: BIN.mediamtx, dataDir: DATA, recordDir: RECORD_DIR, settings: () => cfg });
if (DEMO) { mtx.proc.o.spawn = spawnFn; mtx.pathInfo = async (n) => Demo.pathInfo(n, cfg.input.source === 'ndi' && ndi.ingest.info().state === 'live'); mtx.connStats = async () => Demo.connStats(); }

// ---------- event log: connects, drops, reconnects, errors (newest last, last 300) ----------
const events = [];
function logEvent(level, who, what) {
  const e = { t: Date.now(), level, who, what: String(what || '').slice(0, 300) };
  events.push(e);
  if (events.length > 300) events.shift();
  broadcast('log', e);
}

let lastLevels = null, levelsSentAt = 0;

// ---------- loudness history: one point per second, the last hour ----------
const HISTORY_SECONDS = 3600;
const history = [];
const r1 = (x) => (x == null || x <= -120 ? null : Math.round(x * 10) / 10);
function addHistory(v) {
  const t = Math.floor(Date.now() / 1000);
  const tp = v.tpk && v.tpk.length ? Math.max.apply(null, v.tpk) : null;
  const last = history[history.length - 1];
  if (last && last.t === t) {
    last.m = Math.max(last.m, v.m); last.s = v.s; last.i = v.i;
    if (tp != null) last.tp = last.tp == null ? tp : Math.max(last.tp, tp);
  } else {
    history.push({ t, m: v.m, s: v.s, i: v.i, tp });
    while (history.length && history[0].t <= t - HISTORY_SECONDS) history.shift();
  }
}
/** [[unix second, momentary max, short-term, true peak max], ...] for the last `seconds`. */
function historySince(seconds) {
  const from = Math.floor(Date.now() / 1000) - seconds;
  return history.filter((h) => h.t > from).map((h) => [h.t, r1(h.m), r1(h.s), r1(h.tp)]);
}
const meter = Meter.create({
  ffmpeg: BIN.ffmpeg,
  inputUrl: () => rtsp('live'),
  onLevels: (v) => {
    lastLevels = v;
    addHistory(v);
    const now = Date.now();
    if (now - levelsSentAt >= 90) { levelsSentAt = now; broadcast('levels', v); }
  }
});
if (DEMO) meter.proc.o.spawn = spawnFn;

const ndi = Ndi.create({ bridge: BIN.bridge, ffmpeg: BIN.ffmpeg, dataDir: DATA, runDir: RUN_DIR, settings: () => cfg, rtspUrl: rtsp, info: () => feed.info || {} });
if (DEMO) { for (const p of ndi.ingest.procs) p.o.spawn = spawnFn; }
if (DEMO) ndi.available = () => true; // pretend NDI works in demo mode
ndi.ingest.on('change', pushStatusSoon);

const webProc = new Proc({
  name: 'Web player', cmd: BIN.ffmpeg, progress: true, spawn: spawnFn,
  args: () => F.web(cfg.web, feed.info, rtsp('live'), 'rtsp://127.0.0.1:' + cfg.ports.rtsp).args
});

// ---------- platforms ----------
const yt = YouTube.create({ get: () => plain('youtube'), save: (p) => savePlatform('youtube', p) });
const fb = Facebook.create({ get: () => plain('facebook'), save: (p) => savePlatform('facebook', p) });
const platform = (type) => (type === 'youtube' ? yt : type === 'facebook' ? fb : null);

// ---------- destinations ----------
const runs = new Map();
function run(id) {
  let r = runs.get(id);
  if (!r) {
    r = { want: false, session: null, phase: '', error: '' };
    const d0 = dest(id);
    if (d0 && d0.type === 'ndi') {
      r.proc = ndi.output(id, () => { const d = dest(id) || {}; return { name: d.name, height: (d.video || {}).height, fps: (d.video || {}).fps }; });
      if (DEMO) for (const x of r.proc.procs) x.o.spawn = spawnFn;
    } else r.proc = new Proc({ name: 'Destination ' + id, cmd: BIN.ffmpeg, progress: true, spawn: spawnFn, args: () => destArgs(id) });
    r.proc.on('state', pushStatusSoon);
    r.drops = 0; r.lastState = 'off';
    r.proc.on('state', (st) => {
      if (st === r.lastState) return;
      const d = dest(id), name = d ? d.name : id, was = r.lastState;
      r.lastState = st;
      if (st === 'live') logEvent('ok', name, was === 'retrying' ? 'Reconnected' : 'Connected');
      else if (st === 'retrying') { r.drops++; logEvent('bad', name, 'Dropped: ' + (r.proc.error || 'connection lost') + ' — retrying'); }
      else if (st === 'error') logEvent('bad', name, 'Stopped: ' + (r.proc.error || 'error'));
    });
    runs.set(id, r);
  }
  return r;
}
function destUrl(d, r) {
  if (d.connect === 'api') {
    if (!r.session) throw new Error('No broadcast was created on ' + d.type);
    return F.targetUrl({ type: d.type, url: r.session.url }, r.session.key);
  }
  const key = secrets.dec(d.key);
  const url = F.targetUrl(d, key);
  if (!url || (!key && (d.type === 'youtube' || d.type === 'facebook'))) throw new Error('Enter the stream key for ' + d.name);
  return url;
}
function destArgs(id) {
  const d = dest(id);
  if (!d) return null;
  return F.destination(d, destUrl(d, run(id)), feed.info, rtsp('live')).args;
}

/** Title, description, privacy and category a destination goes live with (shared unless it has its own). */
function infoFor(d) {
  const base = d.useShared === false ? { title: d.title, description: d.description, privacy: d.privacy } : cfg.stream;
  return {
    title: formatTitle(base.title || cfg.stream.title || 'Live'),
    description: formatTitle(base.description || ''),
    privacy: base.privacy || 'public',
    category: cfg.stream.category || ''
  };
}

/** Send the current info to every running YouTube/Facebook broadcast (only shared ones when onlyShared). */
async function pushInfo(onlyShared, onlyId) {
  const jobs = [];
  for (const d of cfg.destinations) {
    const r = runs.get(d.id);
    if (!r || !r.session || d.connect !== 'api') continue;
    if (onlyId && d.id !== onlyId) continue;
    if (onlyShared && d.useShared === false) continue;
    const pf = platform(d.type);
    jobs.push(pf.update(r.session.broadcastId || r.session.videoId, infoFor(d))
      .then(() => { r.infoError = ''; return { name: d.name, ok: true }; })
      .catch((e) => { r.infoError = 'Could not update the title on ' + (d.type === 'youtube' ? 'YouTube' : 'Facebook') + ': ' + e.message; return { name: d.name, ok: false, error: e.message }; }));
  }
  const res = await Promise.all(jobs);
  pushStatus();
  return res;
}

async function startDest(id) {
  const d = dest(id);
  if (!d) return { ok: false, error: 'Unknown destination' };
  const r = run(id);
  if (r.want || r.phase) return { ok: true };
  r.error = '';
  if (d.connect === 'api') {
    const pf = platform(d.type);
    if (!pf || !pf.connected()) { r.error = (d.type === 'youtube' ? 'YouTube' : 'Facebook') + ' is not connected. Connect it in Settings or switch this destination to a stream key.'; pushStatus(); return { ok: false, error: r.error }; }
    r.want = true; r.phase = 'creating'; pushStatus();
    try {
      r.session = await pf.goLive(infoFor(d));
      r.infoError = r.session.warning || '';
    } catch (e) {
      r.want = false; r.phase = ''; r.error = 'Could not create the broadcast: ' + e.message; pushStatus();
      return { ok: false, error: r.error };
    }
    r.phase = '';
    if (!r.want) { endBroadcast(d, r); return { ok: true }; }
  } else if (d.type === 'ndi') {
    if (!ndi.available()) { r.error = 'NDI is not available in this container: ' + ndi.whyNot(); pushStatus(); return { ok: false, error: r.error }; }
    r.want = true;
  } else {
    try { destUrl(d, r); } catch (e) { r.error = e.message; pushStatus(); return { ok: false, error: e.message }; }
    r.want = true;
  }
  if (feed.ready && feed.info) r.proc.start();
  logEvent('info', d.name, feed.ready ? 'Started' : 'Started, waiting for the input');
  pushStatus();
  return { ok: true };
}
async function endBroadcast(d, r) {
  const s = r.session;
  if (!s) return;
  r.session = null;
  r.phase = 'ending'; pushStatus();
  try { await platform(d.type).end(s.broadcastId || s.videoId); }
  catch (e) { r.error = 'The stream stopped, but ending the broadcast on ' + d.type + ' failed: ' + e.message; }
  r.phase = ''; pushStatus();
}
async function stopDest(id) {
  const d = dest(id), r = runs.get(id);
  if (!r) return { ok: true };
  if (r.want && d) logEvent('info', d.name, 'Stopped');
  r.want = false;
  r.proc.stop();
  if (d && r.session) await endBroadcast(d, r);
  pushStatus();
  return { ok: true };
}
function destState(d) {
  const r = run(d.id);
  const p = r.proc.info();
  let st = r.phase || (r.want ? (feed.ready && feed.info ? p.state : 'waiting') : (r.error ? 'error' : 'off'));
  if (st === 'off' && r.want) st = 'waiting';
  let plan = null, desc = '';
  if (d.type === 'ndi') {
    const pl = p.plan || (feed.info ? F.plan({ mode: 'encode', height: d.video.height, fps: d.video.fps }, {}, feed.info) : null);
    desc = 'NDI · ' + os.hostname().toUpperCase() + ' (' + d.name + ')' + (pl ? ' · ' + pl.width + '×' + pl.height + ' ' + Math.round(pl.fps * 100) / 100 + 'fps' : '');
  } else {
    try { plan = F.plan(d.video, d.audio, feed.info || {}, { type: d.type }); desc = F.describe(plan); } catch (e) { /* none */ }
  }
  const pids = p.pids || (p.pid ? [p.pid] : []);
  return {
    state: st, error: r.error || (r.want ? p.error : ''), since: p.since, retryIn: p.retryIn,
    drops: r.drops || 0, tcp: st === 'live' ? r.tcp || null : null,
    stats: p.stats, cpu: pids.length ? pids.reduce((a, x) => a + (sys.pidPct(x) || 0), 0) : null, tail: p.tail,
    receivers: d.type === 'ndi' ? p.connections : undefined,
    desc, reasons: plan ? plan.reasons : [],
    watchUrl: r.session ? r.session.watchUrl : '', live: st === 'live',
    infoError: r.infoError || '', ownInfo: d.useShared === false
  };
}

// ---------- input up / down ----------
async function onInputUp() {
  const gen = ++feed.gen;
  feed.probing = true;
  pushStatus();
  const pr = DEMO ? Demo.probe() : await Meter.probe(BIN.ffprobe, rtsp('live'));
  if (gen !== feed.gen || !feed.ready) return;
  feed.probing = false;
  feed.info = Object.assign({ videoCodec: feed.path.videoCodec, audioCodec: feed.path.audioCodec }, pr || {});
  if (!feed.path.audioCodec) feed.info.audioCodec = null;
  const all = [meter.proc, webProc];
  for (const r of runs.values()) all.push(r.proc);
  // a new source (OBS reconnected, maybe with other settings): start everything fresh
  for (const p of all) if (p.wanted) p.restart();
  startFeedConsumers();
  pushStatus();
}
function startFeedConsumers() {
  if (!feed.ready || !feed.info) return;
  if (feed.info.audioCodec && !meter.proc.wanted) meter.proc.start();
  if (cfg.web.enabled && !webProc.wanted) webProc.start();
  for (const d of cfg.destinations) { const r = runs.get(d.id); if (r && r.want && !r.phase && !r.proc.wanted) r.proc.start(); }
}
function onInputDown() {
  feed.gen++;
  feed.info = null; feed.probing = false; feed.kbps = null; feed.conn = null;
  meter.proc.stop(); meter.clear(); lastLevels = null;
  broadcast('levels', null);
  webProc.stop();
  for (const r of runs.values()) r.proc.stop(); // r.want stays: they come back with the feed
  pushStatus();
}

function applyInputSource() {
  if (cfg.input.source === 'ndi' && cfg.input.ndiSource && ndi.available()) {
    if (feed.ready && feed.path.sourceType && feed.path.sourceType !== 'rtspSession') mtx.kick(feed.path);
    ndi.ingest.start(cfg.input.ndiSource);
  } else ndi.ingest.stop();
}

// ---------- status loop ----------
let recCache = { at: 0, list: [] };
function recordings(force) {
  if (force || Date.now() - recCache.at > 10000) {
    recCache = { at: Date.now(), list: Rec.list(RECORD_DIR) };
    const maxGB = Number(cfg.recording.maxGB);
    if (maxGB > 0 && Rec.enforceLimit(RECORD_DIR, maxGB * 1e9)) recCache = { at: Date.now(), list: Rec.list(RECORD_DIR) };
  }
  return recCache.list;
}

// ---------- web player viewers ----------
// WebRTC: each viewer is a MediaMTX session; we tag it (?br=<id>) when proxying the WHEP request,
// so the list can show who it is. HLS: each viewer (address + browser) is counted from its requests.
// Every viewer gets its own connection, but they all share the one web encode.
const webrtcViewers = new Map(); // id -> { id, ip, ua, since, mtxId, bytes, kbps, lastBytes, lastAt, seenAt }
const hlsViewers = new Map();    // ip|ua -> { id, ip, ua, since, last, bytes, kbps, win: [[time, bytes]] }

function deviceOf(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
    : /CrOS/.test(ua) ? 'Chromebook' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|Roku|AppleTV|AFT\w/.test(ua) ? 'TV' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /VLC|Lavf|ffmpeg/i.test(ua) ? 'Media player' : '';
  return [os, br].filter(Boolean).join(' · ') || 'Unknown device';
}
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$|fd|fe80|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i.test(String(ip).replace(/^::ffff:/, ''));

function noteHls(req, bytes) {
  const ip = clientIp(req), ua = String(req.headers['user-agent'] || '').slice(0, 300), key = ip + '|' + ua, now = Date.now();
  let v = hlsViewers.get(key);
  if (!v) { v = { id: 'h' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10), ip, ua, since: now, last: now, bytes: 0, win: [] }; hlsViewers.set(key, v); }
  v.last = now; v.bytes += bytes;
  v.win.push([now, bytes]);
  while (v.win.length && v.win[0][0] < now - 12000) v.win.shift();
}
async function refreshWebrtc() {
  const now = Date.now();
  const list = await mtx.api('/v3/webrtcsessions/list?itemsPerPage=1000');
  if (!list) return;
  const byTag = new Map();
  for (const it of list.items || []) {
    const m = /(?:^|&)br=([\w-]+)/.exec(it.query || '');
    if (m) byTag.set(m[1], it);
  }
  for (const [id, v] of webrtcViewers) {
    const it = byTag.get(id);
    if (!it) { if (now - v.since > 15000) webrtcViewers.delete(id); continue; }
    v.mtxId = it.id; v.state = it.state || (it.peerConnectionEstablished ? 'read' : '');
    const cand = /(?:udp|tcp)\/([0-9a-f.:]+)\//i.exec(it.remoteCandidate || '');
    if (cand) v.mediaIp = cand[1];
    const bytes = Number(it.bytesSent) || 0;
    if (v.lastAt && now > v.lastAt) v.kbps = Math.max(0, Math.round((bytes - v.lastBytes) * 8 / (now - v.lastAt)));
    v.lastBytes = bytes; v.lastAt = now; v.bytes = bytes; v.seenAt = now;
  }
}
function viewerList() {
  const now = Date.now();
  for (const [k, v] of hlsViewers) if (now - v.last > 20000) hlsViewers.delete(k);
  const out = [];
  for (const v of webrtcViewers.values()) {
    if (!v.mtxId) continue;
    out.push({ id: v.id, kind: 'WebRTC', ip: v.ip, lan: isPrivate(v.ip), device: deviceOf(v.ua), since: v.since, kbps: v.kbps || 0, bytes: v.bytes || 0, canKick: true });
  }
  for (const v of hlsViewers.values()) {
    const span = v.win.length ? Math.max(4000, now - v.win[0][0]) : 0;
    const kbps = span ? Math.round(v.win.reduce((a, w) => a + w[1], 0) * 8 / span) : 0;
    out.push({ id: v.id, kind: 'HLS', ip: v.ip, lan: isPrivate(v.ip), device: deviceOf(v.ua), since: v.since, kbps, bytes: v.bytes, canKick: false });
  }
  return out.sort((a, b) => a.since - b.since);
}
function viewers(webrtcReaders) {
  const l = viewerList();
  const w = l.filter((v) => v.kind === 'WebRTC').length || webrtcReaders, h = l.filter((v) => v.kind === 'HLS').length;
  return { webrtc: w, hls: h, total: w + h, kbps: l.reduce((a, v) => a + v.kbps, 0) };
}

let webrtcPath = { readers: 0 }, webPath = { ready: false };
async function tick() {
  sys.sample();
  if (mtx.proc.state !== 'live') {
    if (feed.ready) { feed.ready = false; feed.sourceId = null; onInputDown(); }
  } else {
    const p = await mtx.pathInfo('live');
    feed.path = p;
    if (p.ready && (!feed.ready || p.sourceId !== feed.sourceId)) {
      if (feed.everUp) feed.reconnects = (feed.reconnects || 0) + 1;
      feed.everUp = true;
      feed.ready = true; feed.sourceId = p.sourceId; feed.since = p.since || Date.now();
      feed.lastBytes = null;
      logEvent('ok', 'Input', 'Connected' + (p.protocol ? ' (' + (cfg.input.source === 'ndi' && p.sourceType === 'rtspSession' ? 'NDI' : p.protocol) + ')' : ''));
      onInputUp();
    } else if (!p.ready && feed.ready) {
      feed.ready = false; feed.sourceId = null; feed.lastDrop = Date.now();
      logEvent('bad', 'Input', 'Disconnected');
      onInputDown();
    }
    if (feed.ready) {
      const now = Date.now();
      if (feed.lastBytes != null && now > feed.lastAt) feed.kbps = Math.max(0, Math.round((p.bytes - feed.lastBytes) * 8 / (now - feed.lastAt)));
      feed.lastBytes = p.bytes; feed.lastAt = now;
      feed.conn = await mtx.connStats(p);
    }
    [webPath, webrtcPath] = await Promise.all([mtx.pathInfo('web'), mtx.pathInfo('webrtc')]);
    if (webrtcViewers.size) await refreshWebrtc();
  }
  ifaces.sample();
  if (++tickN % 2 === 0) await refreshTcp();
  addBitrate();
  checkSession();
  pushStatus();
}

// ---------- TCP health of outgoing RTMP connections (from ss) ----------
let tickN = 0;
const ifaces = Net.createIfaceMeter();
async function refreshTcp() {
  const live = [...runs.entries()].filter(([, r]) => r.proc.pid && r.proc.state === 'live' && !r.proc.procs);
  if (!live.length) return;
  const socks = DEMO ? Demo.tcp(live.map(([, r]) => r.proc.pid)) : await Net.tcpStats();
  if (!socks) return;
  for (const [, r] of live) {
    // the connection that carries the stream is the one that has sent the most
    const s = socks.filter((x) => x.pid === r.proc.pid).sort((a, b) => (b.bytesSent || 0) - (a.bytesSent || 0))[0];
    if (!s) { r.tcp = null; continue; }
    const prev = r.tcpPrev;
    let retransPct = null;
    if (prev && s.bytesSent > prev.bytesSent) retransPct = Math.round(1000 * Math.max(0, (s.bytesRetrans || 0) - (prev.bytesRetrans || 0)) / (s.bytesSent - prev.bytesSent)) / 10;
    r.tcpPrev = { bytesSent: s.bytesSent || 0, bytesRetrans: s.bytesRetrans || 0 };
    r.tcp = { peer: s.peer, rtt: s.rtt != null ? Math.round(s.rtt) : null, jitter: s.rttVar != null ? Math.round(s.rttVar) : null, retransPct, retrans: s.retrans || 0, sendKbps: s.sendKbps, cwnd: s.cwnd };
  }
}

// ---------- bitrate history: one point per second, the last hour ----------
const bitrates = [];
function addBitrate() {
  const t = Math.floor(Date.now() / 1000);
  if (bitrates.length && bitrates[bitrates.length - 1][0] === t) return;
  const d = {};
  for (const x of cfg.destinations) {
    if (x.type === 'ndi') continue; // NDI stays on the local network
    const r = runs.get(x.id);
    if (r && r.proc.state === 'live' && r.proc.stats && r.proc.stats.kbps != null) d[x.id] = Math.round(r.proc.stats.kbps);
  }
  const w = viewers(webrtcPath.readers || 0).kbps;
  bitrates.push([t, feed.ready && feed.kbps != null ? feed.kbps : null, w || 0, d]);
  while (bitrates.length && bitrates[0][0] <= t - HISTORY_SECONDS) bitrates.shift();
}

// ---------- the part number counts up after each stream ----------
const session = { since: null };
// how long a stream must run before the part counts up (BR_MIN_SESSION_MS is for the tests)
const MIN_SESSION_MS = Number(process.env.BR_MIN_SESSION_MS) || 10 * 60e3;
/** What is being streamed now, as a history entry. */
function historyEntry(t) {
  const d = new Date(t), st = cfg.stream, f = st.presets.find((p) => p.id === st.presetId);
  return { t, day: d.getDay(), hour: Math.round((d.getHours() + d.getMinutes() / 60) * 100) / 100, presetId: st.presetId, format: f ? f.name : '', title: formatTitle(st.title),
    series: st.series || '', part: Number(st.part) || 0, sermon: st.sermon || '', speaker: st.speaker || '', autoPart: st.autoPart !== false };
}
/** Keep the history entry of the stream in progress up to date when the info changes during it. */
function touchHistory() {
  if (!session.hid) return;
  const h = cfg.stream.history.find((x) => x.id === session.hid);
  if (h) Object.assign(h, historyEntry(h.t), { id: h.id });
}
function checkSession() {
  const anyLive = [...runs.values()].some((r) => r.want && r.proc.state === 'live');
  if (anyLive && !session.since) {
    session.since = Date.now();
    // remember what is streamed, for suggestions and the Past streams list
    session.hid = crypto.randomBytes(4).toString('hex');
    cfg.stream.history.push(Object.assign({ id: session.hid, minutes: 0 }, historyEntry(session.since)));
    cfg.stream.history = cfg.stream.history.slice(-150);
    saveCfg();
  }
  const anyWanted = [...runs.values()].some((r) => r.want || r.phase);
  if (!anyWanted && session.since) {
    const long = Date.now() - session.since > MIN_SESSION_MS; // a real service, not a quick test
    const h = cfg.stream.history.find((x) => x.id === session.hid);
    // quick tests don't teach the suggestions
    if (h && long) h.minutes = Math.round((Date.now() - session.since) / 60000);
    else if (h) cfg.stream.history = cfg.stream.history.filter((x) => x !== h);
    session.since = null; session.hid = null;
    saveCfg();
    if (long && cfg.stream.autoPart !== false && cfg.stream.series && Number(cfg.stream.part) > 0) {
      cfg.stream.part = Number(cfg.stream.part) + 1;
      saveCfg(); pushState();
      logEvent('info', 'Stream info', cfg.stream.series + ': next time is Part ' + cfg.stream.part);
    }
  }
}

function status() {
  const recs = recordings();
  const used = recs.reduce((a, r) => a + r.size, 0);
  const inf = feed.info || {};
  const procCpu = (p) => (p && p.pid ? sys.pidPct(p.pid) : null);
  const w = webProc.info();
  let webPlan = null;
  try { webPlan = feed.info ? F.plan({ mode: cfg.web.mode, height: cfg.web.height, fps: cfg.web.fps, bitrate: cfg.web.bitrate }, { mode: 'aac', bitrate: cfg.web.audioBitrate }, feed.info) : null; } catch (e) { /* none */ }
  const ndiIn = ndi.ingest.info();
  const dests = cfg.destinations.map((d) => Object.assign({ id: d.id }, destState(d)));
  const resv = resources(dests);
  // estimates follow what the encodes really use
  resv.items.forEach((x) => { const st = x.kind === 'dest' && dests.find((d) => d.id === x.id); if (st && st.state === 'live' && st.stats && st.stats.speed >= 0.95 && st.stats.speed <= 1.05 && !/original/.test(x.parts) && cfg.destinations.find((d) => d.id === x.id).type !== 'ndi') est.learn(x.cpu, st.cpu); });
  est.flush();
  return {
    now: Date.now(),
    resources: resv,
    cpu: { total: sys.totalPct(), cores: sys.cores() },
    mediamtx: { state: mtx.proc.state, error: mtx.proc.error },
    input: {
      source: cfg.input.source,
      ready: feed.ready, probing: feed.probing, since: feed.ready ? feed.since : null,
      protocol: cfg.input.source === 'ndi' && feed.path.sourceType === 'rtspSession' ? 'NDI' : feed.path.protocol || null,
      remote: feed.conn ? feed.conn.remote : null, rtt: feed.conn ? feed.conn.rtt : null, lossPct: feed.conn ? feed.conn.lossPct : null,
      link: feed.conn ? { retrans: feed.conn.retrans, lost: feed.conn.lost, dropped: feed.conn.dropped, packets: feed.conn.packets, linkMbps: feed.conn.linkMbps, bufMs: feed.conn.bufMs } : null,
      reconnects: feed.reconnects || 0, lastDrop: feed.lastDrop || null,
      kbps: feed.kbps,
      video: feed.ready ? { codec: inf.videoCodec || feed.path.videoCodec, width: inf.width, height: inf.height, fps: inf.fps, profile: inf.videoProfile } : null,
      audio: feed.ready && (inf.audioCodec || feed.path.audioCodec) ? { codec: inf.audioCodec || feed.path.audioCodec, rate: inf.audioRate, channels: inf.audioChannels, kbps: inf.audioKbps } : null,
      meters: meter.proc.state,
      ndi: cfg.input.source === 'ndi' ? Object.assign({}, ndiIn, { cpu: ndiIn.pids.reduce((a, p) => a + (sys.pidPct(p) || 0), 0) }) : null
    },
    recording: { enabled: cfg.recording.enabled, active: !!(cfg.recording.enabled && feed.ready), writable: Rec.writable(RECORD_DIR), dir: RECORD_DIR, disk: sys.disk(RECORD_DIR), used, count: recs.length },
    web: { enabled: cfg.web.enabled, state: cfg.web.enabled ? (feed.ready ? w.state : 'waiting') : 'off', error: w.error, stats: w.stats, cpu: procCpu(webProc), desc: webPlan ? F.describe(webPlan) : '', viewers: viewers(webrtcPath.readers || 0), hlsReady: !!webPath.ready, retryIn: w.retryIn },
    destinations: dests,
    stream: { title: infoFor({}).title, description: infoFor({}).description, broadcasts: cfg.destinations.filter((d) => d.connect === 'api' && runs.get(d.id) && runs.get(d.id).session).length },
    platforms: {
      youtube: { connected: yt.connected(), channelTitle: cfg.youtube.channelTitle, pending: yt.pending(), needsReconnect: cfg.youtube.needsReconnect, connectError: cfg.youtube.connectError },
      facebook: { connected: fb.connected(), pageName: cfg.facebook.pageName, pending: fb.pending(), needsReconnect: cfg.facebook.needsReconnect, connectError: cfg.facebook.connectError, pagesError: cfg.facebook.pagesError, pages: (cfg.facebook.pages || []).map((p) => ({ id: p.id, name: p.name })), userConnected: !!cfg.facebook.userToken }
    }
  };
}

// ---------- settings sent to the page (no secrets) ----------
function publicCfg() {
  const c = clone(cfg);
  delete c.auth; delete c.api;
  c.destinations = c.destinations.map((d) => Object.assign({}, d, { key: undefined, hasKey: !!d.key }));
  c.youtube = { clientId: cfg.youtube.clientId, hasSecret: !!cfg.youtube.clientSecret };
  c.facebook = { appId: cfg.facebook.appId, hasClientToken: !!cfg.facebook.clientToken, hasAppSecret: !!cfg.facebook.appSecret, graphVersion: cfg.facebook.graphVersion, pageId: cfg.facebook.pageId };
  return c;
}
/** The guess for a stream now, and per-series memory, for the Stream info card. */
function suggestion(now = Date.now()) {
  const g = Predict.predict(cfg.stream.history, now, cfg.stream.presets.map((p) => p.id));
  if (g) {
    const f = cfg.stream.presets.find((p) => p.id === g.presetId) || cfg.stream.presets.find((p) => p.id === cfg.stream.presetId);
    g.presetId = f ? f.id : cfg.stream.presetId;
    g.title = f ? formatTitle(f.title, g) : '';
  }
  return g;
}
function streamMemory() {
  const info = Predict.seriesInfo(cfg.stream.history);
  const now = Date.now();
  for (const e of Object.values(info)) e.next = Predict.nextPart(e, now);
  const sermons = [];
  for (const h of cfg.stream.history.slice().reverse()) if (h.sermon && !sermons.some((x) => x.toLowerCase() === h.sermon.toLowerCase())) sermons.push(h.sermon);
  return { suggest: suggestion(now), series: info, sermons: sermons.slice(0, 25) };
}
/** Fill in a profile: its format, series (with the next part), speaker and description. */
function applyProfile(pr) {
  const v = { series: pr.series || '', speaker: pr.speaker || '', autoPart: pr.autoPart !== false };
  if (pr.series) v.part = Predict.nextPart(Predict.seriesInfo(cfg.stream.history)[pr.series.toLowerCase()], Date.now()) || Number(cfg.stream.part) || 0;
  if (pr.sermon !== undefined) v.sermon = pr.sermon;
  if (pr.description) v.description = pr.description;
  return setStreamInfo(v, cfg.stream.presets.some((p) => p.id === pr.presetId) ? pr.presetId : undefined);
}
function findProfile(key) {
  const list = cfg.stream.profiles, k = String(key).toLowerCase();
  return list.find((p) => p.id === key) || list.find((p) => p.name.toLowerCase() === k) || (/^\d+$/.test(k) ? list[Number(k) - 1] : null);
}

function appState() {
  return {
    version: pkg.version, demo: DEMO,
    settings: publicCfg(),
    apiToken: secrets.dec(cfg.api.token),
    lan: lanAddresses(),
    hostname: os.hostname(),
    ports: { control: PORT, public: PUBLIC_PORT },
    ndi: { available: ndi.available(), why: ndi.whyNot() },
    cpuModel: sys.cpuModel(),
    categories: YouTube.CATEGORIES,
    status: status(),
    memory: streamMemory(),
    events: events.slice(-100)
  };
}

// ---------- server-sent events ----------
const clients = new Set();
function broadcast(event, data) {
  if (!clients.size) return;
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
}
let statusTimer = null;
function pushStatus() { clearTimeout(statusTimer); statusTimer = null; broadcast('status', status()); }
function pushStatusSoon() { if (!statusTimer) statusTimer = setTimeout(pushStatus, 150); }
function pushState() { broadcast('state', appState()); }

// ---------- settings changes ----------
const PRESETS = F.PRESETS;
const HEIGHTS = [0, 360, 480, 540, 720, 900, 1080, 1440, 2160];
const FPSES = [0, 24, 25, 30, 50, 60];

function normDest(d, old) {
  d = d || {}; old = old || {};
  const type = oneOf(d.type, ['youtube', 'facebook', 'rtmp', 'srt', 'ndi'], old.type || 'rtmp');
  const v = d.video || {}, a = d.audio || {};
  let key = old.key || '';
  if (typeof d.key === 'string' && d.key.trim()) key = secrets.enc(d.key.trim());
  if (d.clearKey) key = '';
  const names = { youtube: 'YouTube', facebook: 'Facebook', rtmp: 'RTMP', srt: 'SRT', ndi: 'Program' };
  return {
    id: old.id || rid(),
    // an NDI destination's name is its NDI source name, which can't contain brackets
    name: (type === 'ndi' ? str(d.name, 40).replace(/[()]/g, '').trim() : str(d.name, 40)) || names[type],
    type,
    armed: d.armed !== false,
    connect: type === 'youtube' || type === 'facebook' ? oneOf(d.connect, ['api', 'key'], 'key') : 'key',
    url: str(d.url, 600),
    key,
    useShared: d.useShared !== undefined ? d.useShared !== false : old.useShared !== false,
    title: d.title !== undefined ? str(d.title, 100) : old.title || '',
    description: d.description !== undefined ? str(d.description, 5000) : old.description || '',
    privacy: oneOf(d.privacy, ['public', 'unlisted', 'private'], old.privacy || 'public'),
    video: { mode: type === 'ndi' ? 'encode' : oneOf(v.mode, ['original', 'encode'], 'encode'), height: oneOf(Number(v.height), HEIGHTS, 720), fps: oneOf(Number(v.fps), FPSES, 0), bitrate: int(v.bitrate, 0, 60000, 0), preset: oneOf(v.preset, PRESETS, 'veryfast') },
    audio: { mode: oneOf(a.mode, ['copy', 'aac'], 'copy'), bitrate: oneOf(Number(a.bitrate), [96, 128, 160, 192, 256, 320], 256) }
  };
}

function saveSection(section, v) {
  v = v || {};
  switch (section) {
    case 'input': {
      const allow = (Array.isArray(v.allowFrom) ? v.allowFrom : String(v.allowFrom || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
      const bad = allow.find((a) => !MediaMTX.validRange(a));
      if (bad) return 'Not an address or range: ' + bad;
      cfg.input = {
        source: oneOf(v.source, ['stream', 'ndi'], cfg.input.source),
        ndiSource: v.ndiSource !== undefined ? str(v.ndiSource, 200) : cfg.input.ndiSource,
        ndiBitrate: int(v.ndiBitrate, 2000, 60000, cfg.input.ndiBitrate),
        ndiPreset: oneOf(v.ndiPreset, PRESETS, cfg.input.ndiPreset),
        allowFrom: v.allowFrom !== undefined ? allow : cfg.input.allowFrom
      };
      if (cfg.input.source === 'ndi' && !ndi.available()) return 'NDI is not available in this container: ' + ndi.whyNot();
      return null;
    }
    case 'ports': {
      const p = {};
      for (const k of Object.keys(MediaMTX.DEFAULT_PORTS)) p[k] = int(v[k], 1, 65535, cfg.ports[k]);
      // TCP and UDP ports may share numbers; within each they must be different
      const tcp = [p.rtmp, p.webrtc, p.rtsp, p.hls, p.api, PORT, PUBLIC_PORT], udp = [p.srt, p.ice];
      if (new Set(tcp).size !== tcp.length) return 'Each TCP port must be different (and not ' + PORT + ' or ' + PUBLIC_PORT + ', used by the web pages)';
      if (p.srt === p.ice) return 'SRT and WebRTC media need different UDP ports';
      cfg.ports = p;
      return null;
    }
    case 'resources': { const u = Number(v.uploadMbps); cfg.resources = { uploadMbps: Number.isFinite(u) && u > 0 ? Math.min(100000, Math.round(u * 10) / 10) : 0 }; return null; }
    case 'network': cfg.network = { publicHosts: str(v.publicHosts, 300), publicUrl: str(v.publicUrl, 300) }; return null;
    case 'web': cfg.web = {
      enabled: v.enabled !== undefined ? !!v.enabled : cfg.web.enabled,
      mode: oneOf(v.mode, ['original', 'encode'], cfg.web.mode),
      height: oneOf(Number(v.height), HEIGHTS, cfg.web.height),
      fps: oneOf(Number(v.fps), FPSES, cfg.web.fps),
      bitrate: int(v.bitrate, 0, 30000, cfg.web.bitrate),
      preset: oneOf(v.preset, PRESETS, cfg.web.preset),
      audioBitrate: oneOf(Number(v.audioBitrate), [96, 128, 160, 192, 256], cfg.web.audioBitrate),
      title: v.title !== undefined ? str(v.title, 100) : cfg.web.title,
      offlineText: v.offlineText !== undefined ? str(v.offlineText, 300) : cfg.web.offlineText
    }; return null;
    case 'ndi': cfg.ndi = { discoveryServer: str(v.discoveryServer, 200), extraIps: str(v.extraIps, 500), groups: str(v.groups, 200) }; return null;
    case 'recording': cfg.recording = {
      enabled: v.enabled !== undefined ? !!v.enabled : cfg.recording.enabled,
      segmentMinutes: int(v.segmentMinutes, 1, 240, cfg.recording.segmentMinutes),
      keepDays: int(v.keepDays, 0, 3650, cfg.recording.keepDays),
      maxGB: int(v.maxGB, 0, 100000, cfg.recording.maxGB)
    }; return null;
    case 'youtube': {
      const p = { clientId: v.clientId !== undefined ? str(v.clientId, 300) : cfg.youtube.clientId };
      if (typeof v.clientSecret === 'string' && v.clientSecret.trim()) p.clientSecret = v.clientSecret.trim();
      cfg.youtube = Object.assign({}, cfg.youtube, { clientId: p.clientId });
      if (p.clientSecret) cfg.youtube.clientSecret = secrets.enc(p.clientSecret);
      return null;
    }
    case 'facebook': {
      cfg.facebook = Object.assign({}, cfg.facebook, {
        appId: v.appId !== undefined ? str(v.appId, 40).replace(/\D/g, '') : cfg.facebook.appId,
        graphVersion: /^v\d+\.\d+$/.test(v.graphVersion || '') ? v.graphVersion : cfg.facebook.graphVersion
      });
      if (typeof v.clientToken === 'string' && v.clientToken.trim()) cfg.facebook.clientToken = secrets.enc(v.clientToken.trim());
      if (typeof v.appSecret === 'string' && v.appSecret.trim()) cfg.facebook.appSecret = secrets.enc(v.appSecret.trim());
      return null;
    }
    default: return 'Unknown settings section';
  }
}

function afterSave(section, before) {
  if (['input', 'ports', 'network', 'recording'].includes(section)) mtx.apply();
  if (section === 'input') {
    if (before.input.source !== cfg.input.source || before.input.ndiSource !== cfg.input.ndiSource) applyInputSource();
    else if (cfg.input.source === 'ndi' && (before.input.ndiBitrate !== cfg.input.ndiBitrate || before.input.ndiPreset !== cfg.input.ndiPreset)) ndi.ingest.procs[1].restart();
  }
  if (section === 'web') {
    if (!cfg.web.enabled) webProc.stop();
    else if (!webProc.wanted) startFeedConsumers();
    else if (JSON.stringify(before.web) !== JSON.stringify(cfg.web)) webProc.restart();
  }
  if (section === 'ndi') { ndi.applyConfig(); }
}

// ---------- stream info and presets ----------
const PRIV = ['public', 'unlisted', 'private'];
function normInfo(v, base) {
  v = v || {}; base = base || {};
  return {
    title: v.title !== undefined ? str(v.title, 100) : base.title || '',
    description: v.description !== undefined ? String(v.description == null ? '' : v.description).replace(/\r/g, '').slice(0, 5000) : base.description || '',
    privacy: oneOf(v.privacy, PRIV, base.privacy || 'public'),
    category: v.category !== undefined ? oneOf(String(v.category), CATEGORY_IDS, '') : base.category || ''
  };
}
function findPreset(ref) {
  ref = decodeURIComponent(String(ref || ''));
  const ps = cfg.stream.presets;
  return ps.find((p) => p.id === ref) || ps.find((p) => p.name.toLowerCase() === ref.toLowerCase()) || (/^\d+$/.test(ref) ? ps[Number(ref) - 1] : null);
}
/** Change the shared info (and which preset it came from), save, and update live broadcasts. */
async function setStreamInfo(v, presetId) {
  v = Object.assign({}, v || {});
  // choosing a format fills in its title, privacy and category (and description unless one is given)
  const fmt = presetId ? cfg.stream.presets.find((p) => p.id === presetId) : null;
  if (fmt) {
    Object.assign(v, { title: fmt.title, privacy: fmt.privacy, category: fmt.category });
    if (v.description === undefined) v.description = fmt.description || '';
  }
  const next = normInfo(v, cfg.stream);
  if (!next.title) return { ok: false, error: 'The title can\'t be empty' };
  const sermon = v && v.sermon !== undefined ? str(v.sermon, 120) : cfg.stream.sermon || '';
  const speaker = v && v.speaker !== undefined ? str(v.speaker, 80) : cfg.stream.speaker || '';
  const series = v.series !== undefined ? str(v.series, 80) : cfg.stream.series || '';
  const part = v.part !== undefined ? int(v.part, 0, 999, 0) : Number(cfg.stream.part) || 0;
  const autoPart = v.autoPart !== undefined ? !!v.autoPart : cfg.stream.autoPart !== false;
  const sermonChanged = sermon !== (cfg.stream.sermon || '') || speaker !== (cfg.stream.speaker || '') || series !== (cfg.stream.series || '') || part !== (Number(cfg.stream.part) || 0);
  if (series) cfg.stream.seriesList = [series].concat((cfg.stream.seriesList || []).filter((x) => x.toLowerCase() !== series.toLowerCase())).slice(0, 25);
  // remember the speakers used, newest first, for the pick list
  if (speaker) cfg.stream.speakers = [speaker].concat((cfg.stream.speakers || []).filter((x) => x.toLowerCase() !== speaker.toLowerCase())).slice(0, 25);
  const changed = ['title', 'description', 'privacy', 'category'].some((k) => next[k] !== cfg.stream[k]);
  Object.assign(cfg.stream, next, { sermon, speaker, series, part, autoPart });
  if (fmt) cfg.stream.presetId = fmt.id;
  touchHistory();
  saveCfg(); pushState();
  // a new sermon or speaker only matters to YouTube/Facebook when the title or description uses it
  const usesSermon = /\{(sermon|speaker|series|part)\}/.test(cfg.stream.title + cfg.stream.description);
  if (!changed && !(sermonChanged && usesSermon)) return { ok: true, updated: [] };
  const res = await pushInfo(true);
  const bad = res.filter((x) => !x.ok);
  return bad.length ? { ok: false, error: bad.map((x) => x.name + ': ' + x.error).join(' · '), updated: res } : { ok: true, updated: res.map((x) => x.name) };
}
function savePreset(b) {
  const name = str(b.name, 40);
  if (!name) return { ok: false, error: 'Give the format a name' };
  const info = normInfo(b.info || cfg.stream, {});
  if (!info.title) return { ok: false, error: 'The title can\'t be empty' };
  let p = b.id ? cfg.stream.presets.find((x) => x.id === b.id) : null;
  if (b.id && !p) return { ok: false, error: 'Unknown preset' };
  const clash = cfg.stream.presets.find((x) => x.name.toLowerCase() === name.toLowerCase() && x !== p);
  if (clash) return { ok: false, error: 'There is already a format called ' + clash.name };
  if (!p) { if (cfg.stream.presets.length >= 50) return { ok: false, error: 'At most 50 formats' }; p = { id: rid() }; cfg.stream.presets.push(p); }
  const oldDesc = p.description;
  Object.assign(p, { name }, info);
  if (cfg.stream.presetId === p.id) {
    // the format in use changed: take its title, privacy and category; keep a description typed for this week
    const keepDesc = cfg.stream.description !== (oldDesc || '');
    setStreamInfo({ description: keepDesc ? cfg.stream.description : p.description }, p.id);
  } else { saveCfg(); pushState(); }
  return { ok: true, id: p.id };
}
function deletePreset(id) {
  if (cfg.stream.presets.length <= 1) return { ok: false, error: 'Keep at least one format' };
  const before = cfg.stream.presets.length;
  cfg.stream.presets = cfg.stream.presets.filter((p) => p.id !== id);
  if (cfg.stream.presets.length === before) return { ok: false, error: 'Unknown format' };
  if (cfg.stream.presetId === id) setStreamInfo({}, cfg.stream.presets[0].id);
  else { saveCfg(); pushState(); }
  return { ok: true };
}
function movePreset(id, dir) {
  const ps = cfg.stream.presets, i = ps.findIndex((p) => p.id === id), j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= ps.length) return { ok: true };
  [ps[i], ps[j]] = [ps[j], ps[i]];
  saveCfg(); pushState();
  return { ok: true };
}

// ---------- actions (shared by the page and the Companion API) ----------
function findDest(ref) {
  ref = decodeURIComponent(String(ref || ''));
  return cfg.destinations.find((d) => d.id === ref) || cfg.destinations.find((d) => d.name.toLowerCase() === ref.toLowerCase())
    || (/^\d+$/.test(ref) ? cfg.destinations[Number(ref) - 1] : null);
}
async function goLive() {
  const res = await Promise.all(cfg.destinations.filter((d) => d.armed).map((d) => startDest(d.id).then((r) => Object.assign({ name: d.name }, r))));
  if (!cfg.web.enabled) toggleSetting('web', true);
  const failed = res.filter((r) => !r.ok);
  return failed.length ? { ok: false, error: failed.map((f) => f.name + ': ' + f.error).join(' · ') } : { ok: true };
}
async function endAll() {
  await Promise.all(cfg.destinations.map((d) => stopDest(d.id)));
  return { ok: true };
}
function toggleSetting(section, on) {
  const before = clone(cfg);
  const err = saveSection(section, { enabled: on });
  if (err) { cfg = before; return { ok: false, error: err }; }
  saveCfg(); afterSave(section, before); pushState(); pushStatus();
  return { ok: true };
}

/** /api/v1/... : what Companion (and the page's buttons) call. */
async function action(parts, method, body) {
  const [a, b, c] = parts;
  body = body || {};
  if (a === 'status' && !b) return { ok: true, data: compactStatus() };
  if (method !== 'POST') return { status: 405, ok: false, error: 'Use POST' };
  if (a === 'golive') return goLive();
  // POST /stream {title, description, privacy, category}: change the shared stream info
  if (a === 'stream' && !b) {
    // {"format": "<name, id or number>"} switches format too
    if (body.format !== undefined) { const f = findPreset(String(body.format)); if (!f) return { status: 404, ok: false, error: 'No format "' + body.format + '"' }; return setStreamInfo(body, f.id); }
    return setStreamInfo(body);
  }
  // POST /stream/suggest: fill in the guess for now (format, series and next part, speaker)
  if (a === 'stream' && b === 'suggest') {
    const g = suggestion();
    if (!g) return { status: 404, ok: false, error: 'Nothing streamed yet to suggest from' };
    return setStreamInfo({ series: g.series, part: g.part, speaker: g.speaker, sermon: g.sermon || undefined, autoPart: g.autoPart }, g.presetId);
  }
  // POST /stream/profile/<name, id or number>: fill in a profile
  if (a === 'stream' && b === 'profile' && c) {
    const pr = findProfile(c);
    if (!pr) return { status: 404, ok: false, error: 'No profile "' + c + '"' };
    return applyProfile(pr);
  }
  // POST /stream/preset/<name, id or number>: load a preset
  if (a === 'stream' && b === 'preset' && c) {
    const p = findPreset(c);
    if (!p) return { status: 404, ok: false, error: 'No preset "' + c + '"' };
    return setStreamInfo(p, p.id);
  }
  if (a === 'end') return endAll();
  if (a === 'destinations' && b) {
    const d = findDest(b);
    if (!d) return { status: 404, ok: false, error: 'No destination "' + b + '"' };
    const r = runs.get(d.id);
    const on = !!(r && (r.want || r.phase === 'creating'));
    if (c === 'start') return startDest(d.id);
    if (c === 'stop') return stopDest(d.id);
    if (c === 'toggle') return on ? stopDest(d.id) : startDest(d.id);
    if (c === 'arm' || c === 'disarm') { d.armed = c === 'arm'; saveCfg(); pushState(); return { ok: true }; }
  }
  const toggles = { web: 'web', recording: 'recording' };
  if (toggles[a] && ['start', 'stop', 'toggle', 'on', 'off'].includes(b)) {
    const cur = cfg[toggles[a]].enabled;
    return toggleSetting(toggles[a], b === 'toggle' ? !cur : b === 'start' || b === 'on');
  }
  if (a === 'input' && b === 'source' && ['stream', 'ndi'].includes(c)) {
    const before = clone(cfg);
    const err = saveSection('input', { source: c });
    if (err) { cfg = before; return { ok: false, error: err }; }
    saveCfg(); afterSave('input', before); pushState();
    return { ok: true };
  }
  return { status: 404, ok: false, error: 'Unknown action' };
}

/** Small, flat status for Companion button feedback and variables. */
function compactStatus() {
  const s = status();
  const live = s.destinations.filter((d) => d.state === 'live').length;
  const out = {
    input_live: s.input.ready, input_protocol: s.input.protocol || '', input_kbps: s.input.kbps || 0,
    input_resolution: s.input.video && s.input.video.height ? s.input.video.width + 'x' + s.input.video.height : '',
    input_fps: s.input.video ? s.input.video.fps || 0 : 0,
    loudness_short: lastLevels ? Math.round(lastLevels.s * 10) / 10 : null,
    loudness_integrated: lastLevels ? Math.round(lastLevels.i * 10) / 10 : null,
    recording: s.recording.active,
    web_state: s.web.state, web_viewers: s.web.viewers.total,
    destinations_live: live, destinations_total: s.destinations.length,
    any_live: live > 0,
    stream_title: infoFor({}).title,
    stream_preset: (cfg.stream.presets.find((p) => p.id === cfg.stream.presetId) || {}).name || '',
    stream_sermon: cfg.stream.sermon || '',
    stream_speaker: cfg.stream.speaker || '',
    stream_series: cfg.stream.series || '',
    stream_part: Number(cfg.stream.part) || 0,
    cpu: s.cpu.total,
    destinations: {}
  };
  cfg.destinations.forEach((d, i) => {
    const st = s.destinations[i];
    out.destinations[d.id] = { name: d.name, index: i + 1, state: st.state, live: st.state === 'live', kbps: st.stats && st.stats.kbps ? Math.round(st.stats.kbps) : 0, error: st.error || '' };
  });
  return out;
}

// ---------- network page ----------
const PORT_INFO = [
  ['control', 'tcp', 'Control page', 'This page'], ['public', 'tcp', 'Web player', 'Viewers (publish this one)'],
  ['srt', 'udp', 'SRT in', 'OBS'], ['rtmp', 'tcp', 'RTMP in', 'OBS'], ['webrtc', 'tcp', 'WHIP / WebRTC signaling', 'OBS (WHIP), web player'],
  ['ice', 'udp', 'WebRTC media', 'Web player (LAN)'], ['rtsp', 'tcp', 'Internal RTSP', 'This server only'], ['hls', 'tcp', 'Internal HLS', 'This server only'], ['api', 'tcp', 'Internal API', 'This server only']
];
function networkInfo() {
  const L = Net.listeners();
  const ours = new Set([...Net.socketInodes(process.pid), ...Net.socketInodes(mtx.proc.pid)]);
  const portOf = (k) => (k === 'control' ? PORT : k === 'public' ? PUBLIC_PORT : cfg.ports[k]);
  const ports = PORT_INFO.map(([k, proto, name, who]) => {
    const port = portOf(k), e = L.get(port), inodes = e ? e[proto] : [];
    let state = 'closed';
    if (DEMO) state = 'ok';
    else if (inodes.some((i) => ours.has(i))) state = 'ok';
    else if (inodes.length) state = 'other';
    return { key: k, port, proto, name, who, state, editable: !['control', 'public'].includes(k) };
  });
  const inUse = /address already in use|bind: /i.test(mtx.proc.error || '') ? mtx.proc.error : '';
  return { interfaces: ifaces.list(), gateway: Net.gateway(), dns: Net.nameservers(), hostname: os.hostname(), ports, mediamtx: { state: mtx.proc.state, error: mtx.proc.error, portProblem: inUse }, publicHosts: cfg.network.publicHosts, tcpStats: !DEMO && Net.tcpStatsAvailable ? Net.tcpStatsAvailable() : true };
}
async function reachTest() {
  const targets = [];
  const seen = new Set();
  const add = (label, url, note) => {
    const hp = Net.hostPort(url);
    if (!hp || !hp.host) return;
    const key = hp.host + ':' + hp.port;
    if (seen.has(key)) return;
    seen.add(key); targets.push({ label, url, hp, note });
  };
  for (const d of cfg.destinations) {
    if (d.type === 'ndi') continue;
    const r = runs.get(d.id);
    const url = d.connect === 'api' ? (r && r.session ? r.session.url : F.PLATFORM_URLS[d.type]) : (String(d.url || '').trim() || F.PLATFORM_URLS[d.type]);
    if (url) add(d.name, url);
  }
  if (cfg.youtube.refreshToken) add('YouTube API', 'https://www.googleapis.com/');
  if (cfg.facebook.pageToken) add('Facebook API', 'https://graph.facebook.com/');
  if (!targets.length) add('Internet', 'https://www.google.com/');
  return Promise.all(targets.map(async (x) => {
    if (DEMO) return { label: x.label, host: x.hp.host, port: x.hp.port, ok: true, dnsMs: 4, connectMs: 18 + Math.round(Math.random() * 10) };
    if (x.hp.udp) {
      // SRT is UDP: nothing to connect to without sending a stream, so only check the name
      const r = await Net.reach(x.hp.host, 1, 1500).catch(() => null);
      const dnsOk = r && (r.address || r.ok);
      return { label: x.label, host: x.hp.host, port: x.hp.port, ok: !!dnsOk, udp: true, dnsMs: r && r.dnsMs, error: dnsOk ? '' : (r && r.error) || 'Name not found', note: 'SRT (UDP): name checked only' };
    }
    const r = await Net.reach(x.hp.host, x.hp.port);
    return Object.assign({ label: x.label }, r);
  }));
}

// ---------- HTTP ----------
const auth = Auth.create({ state, saveState });

function send(res, code, body, headers) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'content-type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store' }, headers || {}));
  res.end(data);
}
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let b = '', n = 0;
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('Too large')); req.destroy(); } else b += d; });
    req.on('end', () => { if (!b) return resolve({}); try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('Not JSON')); } });
    req.on('error', reject);
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveFile(res, file, extra) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, Object.assign({ 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }, extra || {}));
    res.end(data);
  });
}
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();

/** Forward a request to MediaMTX (HLS or WHEP), optionally rewriting the WHEP session Location. */
function proxy(req, res, port, target, rewrite, cookies, onDone) {
  const headers = {};
  for (const h of ['content-type', 'accept', 'if-match', 'range'].concat(cookies ? ['cookie'] : [])) if (req.headers[h]) headers[h] = req.headers[h];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: target, headers, timeout: 15000 }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (/^(connection|transfer-encoding|keep-alive|access-control-.*|server)$/i.test(k)) continue;
      if (k === 'set-cookie' && !cookies) continue;
      out[k] = k === 'location' && rewrite ? rewrite(v) : v;
    }
    out['cache-control'] = out['cache-control'] || 'no-cache';
    res.writeHead(r.statusCode, out);
    if (onDone) { let n = 0; r.on('data', (d) => { n += d.length; }); r.on('end', () => onDone(r.statusCode, n, r.headers)); }
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => { if (!res.headersSent) send(res, 502, 'The player is not available right now'); else res.end(); });
  req.pipe(up);
}
// relative Locations, so the pages also work behind a reverse proxy under a sub-path
const whepRewrite = () => (loc) => { const m = /\/whep\/([^/?#]+)/.exec(String(loc)); return m ? 'whep/' + m[1] : loc; };

/** Routes both servers share: the watch page, HLS and WebRTC playback of the web output. */
function playerRoutes(req, res, u, isPublic) {
  const p = u.pathname;
  if (req.method === 'GET' && ((isPublic && p === '/') || p === '/watch' || p === '/embed')) return serveFile(res, path.join(__dirname, 'public', 'watch.html'), p === '/embed' ? {} : { 'x-frame-options': 'SAMEORIGIN' }), true;
  if (req.method === 'GET' && p === '/player.json') {
    send(res, 200, { title: infoFor({}).title, sermon: cfg.stream.sermon || '', speaker: cfg.stream.speaker || '', series: seriesLine(), offlineText: cfg.web.offlineText, live: !!(cfg.web.enabled && webPath.ready), webrtc: !!(cfg.web.enabled && webrtcPath.ready) });
    return true;
  }
  if (req.method === 'GET' && p.startsWith('/vendor/') && /^\/vendor\/[\w.-]+\.js$/.test(p)) return serveFile(res, path.join(__dirname, 'public', p)), true;
  if (req.method === 'GET' && p === '/whep.js') return serveFile(res, path.join(__dirname, 'public', 'whep.js')), true;
  if (req.method === 'GET' && p.startsWith('/hls/')) {
    const rest = p.slice(5);
    if (!/^[\w.\-/]+$/.test(rest) || rest.includes('..')) return send(res, 400, 'Bad path'), true;
    // MediaMTX first redirects to ?cookieCheck=1 to see whether the player keeps cookies
    proxy(req, res, cfg.ports.hls, '/web/' + rest + (u.search || ''), (loc) => { const m = /^\/web\/(.*)$/.exec(String(loc)); return m ? m[1].split('/').pop() : loc; }, true,
      (code, n) => { if (code < 300) noteHls(req, n); });
    return true;
  }
  if (p === '/whep' || p.startsWith('/whep/')) {
    if (!['POST', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return send(res, 405, 'Method not allowed'), true;
    const rest = p.slice(5);
    if (rest && !/^\/[\w-]+$/.test(rest)) return send(res, 400, 'Bad path'), true;
    if (req.method === 'POST' && !rest) {
      // a new WebRTC viewer: tag the session so the viewer list can tell who it is
      const vid = rid() + rid();
      proxy(req, res, cfg.ports.webrtc, '/webrtc/whep?br=' + vid, whepRewrite('/whep'), false, (code) => {
        if (code === 201) webrtcViewers.set(vid, { id: vid, ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 300), since: Date.now() });
      });
    } else proxy(req, res, cfg.ports.webrtc, '/webrtc/whep' + rest, whepRewrite('/whep'));
    return true;
  }
  return false;
}

function companionAuth(req, u) {
  const h = String(req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : (u.searchParams.get('token') || '');
  if (!t) return false;
  const ip = clientIp(req);
  if (auth.limit.blocked('t:' + ip)) return false;
  const good = Auth.safeEqual(t, secrets.dec(cfg.api.token));
  if (good) auth.limit.ok('t:' + ip); else auth.limit.fail('t:' + ip);
  return good;
}

async function controlHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (playerRoutes(req, res, u)) return;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(__dirname, 'public', 'index.html'), { 'x-frame-options': 'DENY' });
    if (req.method === 'GET' && p === '/favicon.svg') return serveFile(res, path.join(__dirname, 'public', 'favicon.svg'));

    // ---- login ----
    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (auth.limit.blocked(ip)) return send(res, 429, { ok: false, error: 'Too many tries. Wait 10 minutes.' });
      const b = await readBody(req);
      if (!cfg.auth.passwordHash) {
        if (String(b.password || '').length < 8) return send(res, 400, { ok: false, error: 'Use at least 8 characters.' });
        cfg.auth.passwordHash = Auth.hashPassword(b.password); saveCfg();
      } else if (!Auth.checkPassword(b.password, cfg.auth.passwordHash)) {
        auth.limit.fail(ip);
        return send(res, 401, { ok: false, error: 'Wrong password' });
      }
      auth.limit.ok(ip);
      return send(res, 200, { ok: true }, { 'set-cookie': auth.cookie(auth.newSession(), req.headers['x-forwarded-proto'] === 'https') });
    }
    if (p === '/api/logout' && req.method === 'POST') { auth.endSession(req); return send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() }); }

    // ---- Companion API (token or a logged-in page) ----
    if (p.startsWith('/api/v1/')) {
      if (!companionAuth(req, u) && !(cfg.auth.passwordHash && auth.sessionOk(req)) && !DEMO) return send(res, 401, { ok: false, error: 'Send the API token as "Authorization: Bearer <token>" or ?token=' });
      const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
      const r = await action(p.slice(8).split('/').filter(Boolean), req.method, body);
      const code = typeof r.status === 'number' ? r.status : r.ok ? 200 : 400;
      delete r.status;
      return send(res, code, r.data || r);
    }

    if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
    const loggedIn = DEMO || (cfg.auth.passwordHash && auth.sessionOk(req));
    if (!loggedIn) return send(res, 401, { ok: false, login: true, setup: !cfg.auth.passwordHash });

    if (p === '/api/state' && req.method === 'GET') return send(res, 200, appState());
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      res.write('event: state\ndata: ' + JSON.stringify(appState()) + '\n\n');
      if (lastLevels) res.write('event: levels\ndata: ' + JSON.stringify(lastLevels) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const before = clone(cfg);
      const err = saveSection(b.section, b.values);
      if (err) { cfg = before; return send(res, 400, { ok: false, error: err }); }
      saveCfg(); afterSave(b.section, before); pushState(); pushStatus();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/destinations' && req.method === 'POST') {
      const b = await readBody(req);
      const old = b.id ? dest(b.id) : null;
      if (b.id && !old) return send(res, 404, { ok: false, error: 'Unknown destination' });
      const d = normDest(b, old);
      if (d.type === 'srt' && !/^srt:\/\//.test(d.url)) return send(res, 400, { ok: false, error: 'An SRT address starts with srt://' });
      if (d.type === 'ndi' && cfg.destinations.some((x) => x.type === 'ndi' && x.id !== d.id && x.name.toLowerCase() === d.name.toLowerCase())) return send(res, 400, { ok: false, error: 'Another NDI output is already called ' + d.name });
      if (old && old.type !== d.type && runs.get(d.id)) { await stopDest(d.id); runs.delete(d.id); }
      if (d.type === 'rtmp' && !/^rtmps?:\/\//.test(d.url)) return send(res, 400, { ok: false, error: 'An RTMP address starts with rtmp:// or rtmps://' });
      if (old) {
        cfg.destinations[cfg.destinations.indexOf(old)] = d;
        const r = runs.get(d.id);
        const INFO = { title: 0, description: 0, privacy: 0, useShared: 0, name: 0, armed: 0 };
        if (r && r.proc.wanted && JSON.stringify(Object.assign({}, old, INFO)) !== JSON.stringify(Object.assign({}, d, INFO))) r.proc.restart();
        const infoKeys = (x) => JSON.stringify([x.useShared, x.title, x.description, x.privacy]);
        if (r && r.session && infoKeys(old) !== infoKeys(d)) pushInfo(false, d.id);
      } else cfg.destinations.push(d);
      saveCfg(); pushState(); pushStatus();
      return send(res, 200, { ok: true, id: d.id });
    }
    let m;
    if ((m = /^\/api\/destinations\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') {
      const d = dest(m[1]);
      if (!d) return send(res, 404, { ok: false, error: 'Unknown destination' });
      await stopDest(d.id);
      runs.delete(d.id);
      cfg.destinations = cfg.destinations.filter((x) => x.id !== d.id);
      saveCfg(); pushState(); pushStatus();
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/destinations\/([\w-]+)\/move$/.exec(p)) && req.method === 'POST') {
      const b = await readBody(req);
      const i = cfg.destinations.findIndex((d) => d.id === m[1]), j = i + (b.dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= cfg.destinations.length) return send(res, 200, { ok: true });
      [cfg.destinations[i], cfg.destinations[j]] = [cfg.destinations[j], cfg.destinations[i]];
      saveCfg(); pushState(); pushStatus();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stream' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await setStreamInfo(b, b.presetId !== undefined ? (findPreset(b.presetId) ? b.presetId : '') : undefined);
      return send(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/stream/speakers/forget' && req.method === 'POST') {
      const b = await readBody(req), n = String(b.name || '').toLowerCase();
      cfg.stream.speakers = (cfg.stream.speakers || []).filter((x) => x.toLowerCase() !== n);
      saveCfg(); pushState();
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/stream\/presets\/([\w-]+)\/move$/.exec(p)) && req.method === 'POST') { const b = await readBody(req); return send(res, 200, movePreset(m[1], Number(b.dir))); }
    if (p === '/api/stream/memory' && req.method === 'GET') return send(res, 200, Object.assign({ ok: true }, streamMemory()));
    if (p === '/api/stream/profiles' && req.method === 'POST') {
      const b = await readBody(req), name = str(b.name, 40);
      if (!name) return send(res, 400, { ok: false, error: 'Give the profile a name' });
      const v = b.values || {};
      const prof = { id: b.id && cfg.stream.profiles.some((x) => x.id === b.id) ? b.id : crypto.randomBytes(4).toString('hex'), name,
        presetId: cfg.stream.presets.some((x) => x.id === v.presetId) ? v.presetId : cfg.stream.presetId,
        series: str(v.series || '', 80), speaker: str(v.speaker || '', 80), description: str(v.description || '', 5000), autoPart: v.autoPart !== false };
      if (cfg.stream.profiles.some((x) => x.id !== prof.id && x.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { ok: false, error: 'There is already a profile called ' + name });
      const i = cfg.stream.profiles.findIndex((x) => x.id === prof.id);
      if (i >= 0) cfg.stream.profiles[i] = prof; else cfg.stream.profiles.push(prof);
      saveCfg(); pushState();
      return send(res, 200, { ok: true, id: prof.id });
    }
    m = /^\/api\/stream\/profiles\/([\w-]+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      cfg.stream.profiles = cfg.stream.profiles.filter((x) => x.id !== m[1]);
      saveCfg(); pushState();
      return send(res, 200, { ok: true });
    }
    if (m && req.method === 'POST') {
      const pr = findProfile(m[1]);
      if (!pr) return send(res, 404, { ok: false, error: 'No such profile' });
      return send(res, 200, await applyProfile(pr));
    }
    m = /^\/api\/stream\/history\/([\w-]+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      cfg.stream.history = cfg.stream.history.filter((x) => x.id !== m[1]);
      saveCfg(); pushState();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stream/series/forget' && req.method === 'POST') {
      const b = await readBody(req), n = String(b.name || '').toLowerCase();
      cfg.stream.seriesList = (cfg.stream.seriesList || []).filter((x) => x.toLowerCase() !== n);
      saveCfg(); pushState();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/bitrate/history' && req.method === 'GET') {
      const from = Math.floor(Date.now() / 1000) - int(u.searchParams.get('seconds'), 10, HISTORY_SECONDS, 600);
      return send(res, 200, { ok: true, points: bitrates.filter((b) => b[0] > from) });
    }
    if (p === '/api/events/log' && req.method === 'GET') return send(res, 200, { ok: true, events });
    if (p === '/api/network' && req.method === 'GET') return send(res, 200, Object.assign({ ok: true }, networkInfo()));
    if (p === '/api/estimate' && req.method === 'POST') {
      const b = await readBody(req);
      const d = { type: oneOf(b.type, ['youtube', 'facebook', 'rtmp', 'srt', 'ndi'], 'rtmp'), video: b.video || {}, audio: b.audio || {} };
      return send(res, 200, { ok: true, estimate: estimateDest(d) });
    }
    if (p === '/api/resources/benchmark' && req.method === 'POST') {
      if ([...runs.values()].some((r) => r.want)) return send(res, 409, { ok: false, error: 'Stop the destinations first: measuring uses every core for a few seconds and would disturb the streams.' });
      try { return send(res, 200, { ok: true, bench: await benchmarkNow() }); } catch (e) { return send(res, 500, { ok: false, error: 'Measuring failed: ' + e.message }); }
    }
    if (p === '/api/network/test' && req.method === 'POST') return send(res, 200, { ok: true, results: await reachTest() });
    if (p === '/api/stream/presets' && req.method === 'POST') {
      const r = savePreset(await readBody(req));
      return send(res, r.ok ? 200 : 400, r);
    }
    if ((m = /^\/api\/stream\/presets\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') { const r = deletePreset(m[1]); return send(res, r.ok ? 200 : 400, r); }
    if (p === '/api/levels/history' && req.method === 'GET') return send(res, 200, { ok: true, now: Math.floor(Date.now() / 1000), points: historySince(int(u.searchParams.get('seconds'), 10, HISTORY_SECONDS, 600)) });
    if (p === '/api/viewers' && req.method === 'GET') {
      const list = viewerList();
      return send(res, 200, { ok: true, viewers: list, kbps: list.reduce((a, v) => a + v.kbps, 0) });
    }
    if ((m = /^\/api\/viewers\/([\w-]+)\/disconnect$/.exec(p)) && req.method === 'POST') {
      const v = webrtcViewers.get(m[1]);
      if (!v || !v.mtxId) return send(res, 404, { ok: false, error: 'That viewer is not connected' });
      await mtx.kick({ sourceType: 'webRTCSession', sourceId: v.mtxId });
      webrtcViewers.delete(m[1]);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ndi/sources' && req.method === 'GET') {
      const r = DEMO ? { ok: true, sources: [{ name: 'FOH-MAC (OBS Program)', url: '192.168.10.21:5961' }, { name: 'PTZ-1 (Channel 1)', url: '192.168.20.31:5961' }] } : await ndi.list(int(u.searchParams.get('seconds'), 1, 15, 4));
      return send(res, 200, r);
    }
    if ((m = /^\/api\/(youtube|facebook)\/(connect|cancel|disconnect|page|token|pages)$/.exec(p)) && req.method === 'POST') {
      const pf = m[1] === 'youtube' ? yt : fb;
      const b = await readBody(req);
      try {
        if (m[2] === 'connect') { const r = await pf.connectStart(); savePlatform(m[1], { connectError: '' }); pushStatus(); return send(res, 200, Object.assign({ ok: true }, r)); }
        if (m[2] === 'cancel') pf.connectCancel();
        if (m[2] === 'disconnect') pf.disconnect();
        if (m[2] === 'page') fb.choosePage(b.pageId);
        if (m[2] === 'pages') await fb.loadPages();
        if (m[2] === 'token') await fb.useToken(b.pageId, b.pageToken);
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      pushState(); pushStatus();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/recordings' && req.method === 'GET') return send(res, 200, { ok: true, dir: RECORD_DIR, recordings: recordings(true) });
    if (p === '/api/recordings/file' && req.method === 'GET') {
      const f = Rec.resolve(RECORD_DIR, u.searchParams.get('id'));
      if (!f) return send(res, 404, 'Not found');
      const st = fs.statSync(f);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': st.size, 'content-disposition': 'attachment; filename="' + path.basename(f) + '"' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/recordings' && req.method === 'DELETE') {
      const ok = Rec.remove(RECORD_DIR, u.searchParams.get('id'));
      recordings(true); pushStatus();
      return send(res, ok ? 200 : 404, { ok });
    }
    if (p === '/api/apitoken' && req.method === 'POST') {
      cfg.api.token = secrets.enc(crypto.randomBytes(18).toString('base64url'));
      saveCfg(); pushState();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (!Auth.checkPassword(b.current, cfg.auth.passwordHash)) return send(res, 400, { ok: false, error: 'The current password is wrong' });
      if (String(b.password || '').length < 8) return send(res, 400, { ok: false, error: 'Use at least 8 characters.' });
      cfg.auth.passwordHash = Auth.hashPassword(b.password); saveCfg();
      auth.endAll();
      return send(res, 200, { ok: true }, { 'set-cookie': auth.cookie(auth.newSession(), req.headers['x-forwarded-proto'] === 'https') });
    }
    if (p === '/api/log' && req.method === 'GET') {
      const procs = [['MediaMTX', mtx.proc], ['Meters', meter.proc], ['Web player', webProc]]
        .concat(ndi.ingest.procs.map((x) => [x.o.name, x]))
        .concat(cfg.destinations.map((d) => [d.name, run(d.id).proc]));
      // an NDI destination is two processes; list both
      return send(res, 200, { ok: true, mediamtx: mtx.log(), procs: procs.map(([n, x]) => ({ name: n, state: x.state, error: x.error, tail: x.tail.slice(-15) })) });
    }
    // the input preview on the control page (WebRTC from the live path)
    if (p === '/api/preview/whep' || p.startsWith('/api/preview/whep/')) {
      const rest = p.slice('/api/preview/whep'.length);
      if (rest && !/^\/[\w-]+$/.test(rest)) return send(res, 400, 'Bad path');
      return proxy(req, res, cfg.ports.webrtc, '/live/whep' + rest, whepRewrite('/api/preview/whep'));
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
  }
}

function publicHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  try {
    if (playerRoutes(req, res, u, true)) return;
    send(res, 404, 'Not found');
  } catch (e) { if (!res.headersSent) send(res, 500, 'Error'); }
}

// ---------- start ----------
function listen(server, port, name) {
  server.on('error', (e) => { console.error(name + ' could not listen on port ' + port + ': ' + e.message); process.exit(1); });
  server.listen(port, BIND, () => console.log(name + ' on http://' + (BIND === '0.0.0.0' ? (lanAddresses()[0] || 'localhost') : BIND) + ':' + port));
}

if (require.main === module) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  try { fs.mkdirSync(RECORD_DIR, { recursive: true }); } catch (e) { console.error('Recordings folder ' + RECORD_DIR + ' is not writable: ' + e.message); }
  if (!fs.existsSync(RECORD_DIR) || !Rec.writable(RECORD_DIR)) console.error('Warning: cannot write recordings to ' + RECORD_DIR);
  mtx.proc.on('state', (s) => { console.log('MediaMTX: ' + s + (mtx.proc.error ? ' (' + mtx.proc.error + ')' : '')); pushStatusSoon(); });
  mtx.proc.start();
  webProc.on('state', pushStatusSoon);
  meter.proc.on('state', pushStatusSoon);
  if (!DEMO) ndi.list(1).then(() => pushState());
  applyInputSource();
  if (DEMO) {
    // pretend viewers so the viewer list has something to show
    const now = Date.now();
    webrtcViewers.set('d1', { id: 'd1', ip: '192.168.30.41', ua: 'Mozilla/5.0 (Linux; Tizen 6.0) SMART-TV Chrome/85', since: now - 1260e3, mtxId: 'x1', kbps: 4180, bytes: 655e6 });
    webrtcViewers.set('d2', { id: 'd2', ip: '192.168.30.57', ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/605.1', since: now - 300e3, mtxId: 'x2', kbps: 4210, bytes: 158e6 });
    const fake = [['73.92.14.201', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile Safari/604.1'], ['24.120.8.66', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36']];
    setInterval(() => { for (const [ip, ua] of fake) noteHls({ headers: { 'user-agent': ua, 'x-forwarded-for': ip }, socket: {} }, 2700000); }, 6000).unref();
  }
  setInterval(() => { tick().catch((e) => console.error('status: ' + e.message)); }, 1000);
  listen(http.createServer(controlHandler), PORT, 'BroadcastRelay ' + pkg.version + (DEMO ? ' (demo)' : '') + ' control page');
  if (PUBLIC_PORT !== PORT) listen(http.createServer(publicHandler), PUBLIC_PORT, 'Web player');
  const bye = () => {
    for (const p of [mtx.proc, meter.proc, webProc].concat(ndi.ingest.procs, [...runs.values()].map((r) => r.proc))) p.stop();
    try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) { /* fine */ }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

module.exports = { normDest, saveSection, formatTitle, compactStatus, action };
