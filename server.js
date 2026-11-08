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
const Facebook = require('./lib/facebook.js');
const Rec = require('./lib/recordings.js');
const Auth = require('./lib/auth.js');
const Secrets = require('./lib/secrets.js');
const Sys = require('./lib/sys.js');
const Demo = require('./lib/demo.js');
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
  destinations: [],
  web: { enabled: true, mode: 'encode', height: 720, fps: 0, bitrate: 0, preset: 'veryfast', audioBitrate: 160, title: 'Live', offlineText: 'The stream will start soon.' },
  ndi: { discoveryServer: '', extraIps: '', groups: '' },
  ndiOut: { enabled: false, name: 'Program', height: 0, fps: 0 },
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

function formatTitle(t) {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  return String(t || '').replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{weekday\}/g, weekday);
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
const feed = { ready: false, sourceId: null, path: { ready: false }, info: null, probing: false, gen: 0, lastBytes: null, lastAt: 0, kbps: null, conn: null, since: null };

const mtx = MediaMTX.create({ bin: BIN.mediamtx, dataDir: DATA, recordDir: RECORD_DIR, settings: () => cfg });
if (DEMO) { mtx.proc.o.spawn = spawnFn; mtx.pathInfo = async (n) => Demo.pathInfo(n, cfg.input.source === 'ndi' && ndi.ingest.info().state === 'live'); mtx.connStats = async () => Demo.connStats(); }

let lastLevels = null, levelsSentAt = 0;
const meter = Meter.create({
  ffmpeg: BIN.ffmpeg,
  inputUrl: () => rtsp('live'),
  onLevels: (v) => {
    lastLevels = v;
    const now = Date.now();
    if (now - levelsSentAt >= 90) { levelsSentAt = now; broadcast('levels', v); }
  }
});
if (DEMO) meter.proc.o.spawn = spawnFn;

const ndi = Ndi.create({ bridge: BIN.bridge, ffmpeg: BIN.ffmpeg, dataDir: DATA, runDir: RUN_DIR, settings: () => cfg, rtspUrl: rtsp, info: () => feed.info || {} });
if (DEMO) { for (const p of ndi.ingest.procs.concat(ndi.output.procs)) p.o.spawn = spawnFn; }
ndi.ingest.on('change', pushStatusSoon);
ndi.output.on('change', pushStatusSoon);

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
    r.proc = new Proc({ name: 'Destination ' + id, cmd: BIN.ffmpeg, progress: true, spawn: spawnFn, args: () => destArgs(id) });
    r.proc.on('state', pushStatusSoon);
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
      r.session = await pf.goLive({ title: formatTitle(d.title || cfg.web.title || 'Live'), description: formatTitle(d.description || ''), privacy: d.privacy });
    } catch (e) {
      r.want = false; r.phase = ''; r.error = 'Could not create the broadcast: ' + e.message; pushStatus();
      return { ok: false, error: r.error };
    }
    r.phase = '';
    if (!r.want) { endBroadcast(d, r); return { ok: true }; }
  } else {
    try { destUrl(d, r); } catch (e) { r.error = e.message; pushStatus(); return { ok: false, error: e.message }; }
    r.want = true;
  }
  if (feed.ready && feed.info) r.proc.start();
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
  let plan = null;
  try { plan = F.plan(d.video, d.audio, feed.info || {}); } catch (e) { /* none */ }
  return {
    state: st, error: r.error || (r.want ? p.error : ''), since: p.since, retryIn: p.retryIn,
    stats: p.stats, cpu: p.pid ? sys.pidPct(p.pid) : null, tail: p.tail,
    desc: plan ? F.describe(plan) : '', reasons: plan ? plan.reasons : [],
    watchUrl: r.session ? r.session.watchUrl : '', live: st === 'live'
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
  const all = [meter.proc, webProc].concat(ndi.output.procs);
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
  if (cfg.ndiOut.enabled && ndi.available()) ndi.output.start();
  for (const d of cfg.destinations) { const r = runs.get(d.id); if (r && r.want && !r.phase && !r.proc.wanted) r.proc.start(); }
}
function onInputDown() {
  feed.gen++;
  feed.info = null; feed.probing = false; feed.kbps = null; feed.conn = null;
  meter.proc.stop(); meter.clear(); lastLevels = null;
  broadcast('levels', null);
  webProc.stop();
  ndi.output.stop();
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

const hlsClients = new Map();
function viewers(webrtcReaders) {
  const cut = Date.now() - 20000;
  for (const [k, t] of hlsClients) if (t < cut) hlsClients.delete(k);
  return { webrtc: webrtcReaders, hls: hlsClients.size, total: webrtcReaders + hlsClients.size };
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
      feed.ready = true; feed.sourceId = p.sourceId; feed.since = p.since || Date.now();
      feed.lastBytes = null;
      onInputUp();
    } else if (!p.ready && feed.ready) {
      feed.ready = false; feed.sourceId = null;
      onInputDown();
    }
    if (feed.ready) {
      const now = Date.now();
      if (feed.lastBytes != null && now > feed.lastAt) feed.kbps = Math.max(0, Math.round((p.bytes - feed.lastBytes) * 8 / (now - feed.lastAt)));
      feed.lastBytes = p.bytes; feed.lastAt = now;
      feed.conn = await mtx.connStats(p);
    }
    [webPath, webrtcPath] = await Promise.all([mtx.pathInfo('web'), mtx.pathInfo('webrtc')]);
  }
  pushStatus();
}

function status() {
  const recs = recordings();
  const used = recs.reduce((a, r) => a + r.size, 0);
  const inf = feed.info || {};
  const procCpu = (p) => (p && p.pid ? sys.pidPct(p.pid) : null);
  const w = webProc.info();
  let webPlan = null;
  try { webPlan = feed.info ? F.plan({ mode: cfg.web.mode, height: cfg.web.height, fps: cfg.web.fps, bitrate: cfg.web.bitrate }, { mode: 'aac', bitrate: cfg.web.audioBitrate }, feed.info) : null; } catch (e) { /* none */ }
  const ndiIn = ndi.ingest.info(), ndiOut = ndi.output.info();
  return {
    now: Date.now(),
    cpu: { total: sys.totalPct(), cores: sys.cores() },
    mediamtx: { state: mtx.proc.state, error: mtx.proc.error },
    input: {
      source: cfg.input.source,
      ready: feed.ready, probing: feed.probing, since: feed.ready ? feed.since : null,
      protocol: cfg.input.source === 'ndi' && feed.path.sourceType === 'rtspSession' ? 'NDI' : feed.path.protocol || null,
      remote: feed.conn ? feed.conn.remote : null, rtt: feed.conn ? feed.conn.rtt : null, lossPct: feed.conn ? feed.conn.lossPct : null,
      kbps: feed.kbps,
      video: feed.ready ? { codec: inf.videoCodec || feed.path.videoCodec, width: inf.width, height: inf.height, fps: inf.fps, profile: inf.videoProfile } : null,
      audio: feed.ready && (inf.audioCodec || feed.path.audioCodec) ? { codec: inf.audioCodec || feed.path.audioCodec, rate: inf.audioRate, channels: inf.audioChannels, kbps: inf.audioKbps } : null,
      meters: meter.proc.state,
      ndi: cfg.input.source === 'ndi' ? Object.assign({}, ndiIn, { cpu: ndiIn.pids.reduce((a, p) => a + (sys.pidPct(p) || 0), 0) }) : null
    },
    recording: { enabled: cfg.recording.enabled, active: !!(cfg.recording.enabled && feed.ready), writable: Rec.writable(RECORD_DIR), dir: RECORD_DIR, disk: sys.disk(RECORD_DIR), used, count: recs.length },
    web: { enabled: cfg.web.enabled, state: cfg.web.enabled ? (feed.ready ? w.state : 'waiting') : 'off', error: w.error, stats: w.stats, cpu: procCpu(webProc), desc: webPlan ? F.describe(webPlan) : '', viewers: viewers(webrtcPath.readers || 0), hlsReady: !!webPath.ready, retryIn: w.retryIn },
    ndiOut: { enabled: cfg.ndiOut.enabled, available: ndi.available(), state: cfg.ndiOut.enabled ? (feed.ready ? ndiOut.state : 'waiting') : 'off', error: ndiOut.error, connections: ndiOut.connections, plan: ndiOut.plan, cpu: ndiOut.pids.reduce((a, p) => a + (sys.pidPct(p) || 0), 0) },
    destinations: cfg.destinations.map((d) => Object.assign({ id: d.id }, destState(d))),
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
    status: status()
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
  const type = oneOf(d.type, ['youtube', 'facebook', 'rtmp', 'srt'], old.type || 'rtmp');
  const v = d.video || {}, a = d.audio || {};
  let key = old.key || '';
  if (typeof d.key === 'string' && d.key.trim()) key = secrets.enc(d.key.trim());
  if (d.clearKey) key = '';
  const names = { youtube: 'YouTube', facebook: 'Facebook', rtmp: 'RTMP', srt: 'SRT' };
  return {
    id: old.id || rid(),
    name: str(d.name, 40) || names[type],
    type,
    armed: d.armed !== false,
    connect: type === 'youtube' || type === 'facebook' ? oneOf(d.connect, ['api', 'key'], 'key') : 'key',
    url: str(d.url, 600),
    key,
    title: str(d.title, 100),
    description: str(d.description, 5000),
    privacy: oneOf(d.privacy, ['public', 'unlisted', 'private'], 'public'),
    video: { mode: oneOf(v.mode, ['original', 'encode'], 'encode'), height: oneOf(Number(v.height), HEIGHTS, 720), fps: oneOf(Number(v.fps), FPSES, 0), bitrate: int(v.bitrate, 0, 60000, 0), preset: oneOf(v.preset, PRESETS, 'veryfast') },
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
    case 'ndiOut': cfg.ndiOut = {
      enabled: v.enabled !== undefined ? !!v.enabled : cfg.ndiOut.enabled,
      name: (v.name !== undefined ? str(v.name, 60).replace(/[()]/g, '') : cfg.ndiOut.name) || 'Program',
      height: oneOf(Number(v.height), HEIGHTS, cfg.ndiOut.height),
      fps: oneOf(Number(v.fps), FPSES, cfg.ndiOut.fps)
    };
      if (cfg.ndiOut.enabled && !ndi.available()) return 'NDI is not available in this container: ' + ndi.whyNot();
      return null;
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
  if (section === 'ndiOut') {
    if (!cfg.ndiOut.enabled) ndi.output.stop();
    else if (feed.ready) { if (JSON.stringify(before.ndiOut) !== JSON.stringify(cfg.ndiOut)) ndi.output.restart(); ndi.output.start(); }
  }
  if (section === 'ndi') { ndi.applyConfig(); }
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
async function action(parts, method) {
  const [a, b, c] = parts;
  if (a === 'status' && !b) return { ok: true, data: compactStatus() };
  if (method !== 'POST') return { status: 405, ok: false, error: 'Use POST' };
  if (a === 'golive') return goLive();
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
  const toggles = { web: 'web', 'ndi-out': 'ndiOut', recording: 'recording' };
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
    ndi_out_state: s.ndiOut.state,
    destinations_live: live, destinations_total: s.destinations.length,
    any_live: live > 0,
    cpu: s.cpu.total,
    destinations: {}
  };
  cfg.destinations.forEach((d, i) => {
    const st = s.destinations[i];
    out.destinations[d.id] = { name: d.name, index: i + 1, state: st.state, live: st.state === 'live', kbps: st.stats && st.stats.kbps ? Math.round(st.stats.kbps) : 0, error: st.error || '' };
  });
  return out;
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
function proxy(req, res, port, target, rewrite, cookies) {
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
    send(res, 200, { title: cfg.web.title, offlineText: cfg.web.offlineText, live: !!(cfg.web.enabled && webPath.ready), webrtc: !!(cfg.web.enabled && webrtcPath.ready) });
    return true;
  }
  if (req.method === 'GET' && p.startsWith('/vendor/') && /^\/vendor\/[\w.-]+\.js$/.test(p)) return serveFile(res, path.join(__dirname, 'public', p)), true;
  if (req.method === 'GET' && p === '/whep.js') return serveFile(res, path.join(__dirname, 'public', 'whep.js')), true;
  if (req.method === 'GET' && p.startsWith('/hls/')) {
    const rest = p.slice(5);
    if (!/^[\w.\-/]+$/.test(rest) || rest.includes('..')) return send(res, 400, 'Bad path'), true;
    if (/\.m3u8$/.test(rest)) hlsClients.set(clientIp(req), Date.now());
    // MediaMTX first redirects to ?cookieCheck=1 to see whether the player keeps cookies
    proxy(req, res, cfg.ports.hls, '/web/' + rest + (u.search || ''), (loc) => { const m = /^\/web\/(.*)$/.exec(String(loc)); return m ? m[1].split('/').pop() : loc; }, true);
    return true;
  }
  if (p === '/whep' || p.startsWith('/whep/')) {
    if (!['POST', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return send(res, 405, 'Method not allowed'), true;
    const rest = p.slice(5);
    if (rest && !/^\/[\w-]+$/.test(rest)) return send(res, 400, 'Bad path'), true;
    proxy(req, res, cfg.ports.webrtc, '/webrtc/whep' + rest, whepRewrite('/whep'));
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
      if (req.method === 'POST') await readBody(req).catch(() => ({}));
      const r = await action(p.slice(8).split('/').filter(Boolean), req.method);
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
      if (d.type === 'rtmp' && !/^rtmps?:\/\//.test(d.url)) return send(res, 400, { ok: false, error: 'An RTMP address starts with rtmp:// or rtmps://' });
      if (old) {
        cfg.destinations[cfg.destinations.indexOf(old)] = d;
        const r = runs.get(d.id);
        if (r && r.proc.wanted && JSON.stringify(Object.assign({}, old, { title: 0, description: 0, privacy: 0, name: 0, armed: 0 })) !== JSON.stringify(Object.assign({}, d, { title: 0, description: 0, privacy: 0, name: 0, armed: 0 }))) r.proc.restart();
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
        .concat(ndi.ingest.procs.map((x) => [x.o.name, x]), ndi.output.procs.map((x) => [x.o.name, x]))
        .concat(cfg.destinations.map((d) => [d.name, run(d.id).proc]));
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
  setInterval(() => { tick().catch((e) => console.error('status: ' + e.message)); }, 1000);
  listen(http.createServer(controlHandler), PORT, 'BroadcastRelay ' + pkg.version + (DEMO ? ' (demo)' : '') + ' control page');
  if (PUBLIC_PORT !== PORT) listen(http.createServer(publicHandler), PUBLIC_PORT, 'Web player');
  const bye = () => {
    for (const p of [mtx.proc, meter.proc, webProc].concat(ndi.ingest.procs, ndi.output.procs, [...runs.values()].map((r) => r.proc))) p.stop();
    try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) { /* fine */ }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

module.exports = { normDest, saveSection, formatTitle, compactStatus, action };
