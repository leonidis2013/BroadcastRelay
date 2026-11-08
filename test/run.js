'use strict';
/* node test/run.js  -  no test framework needed. FFmpeg and gcc tests run when those are installed. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));
const F = R('lib/ffargs'), M = R('lib/meter'), MTX = R('lib/mediamtx'), Rec = R('lib/recordings'), Auth = R('lib/auth');
const Secrets = R('lib/secrets'), Ndi = R('lib/ndi'), { Proc, lastUseful } = R('lib/proc'), Demo = R('lib/demo');
const YT = R('lib/youtube'), FB = R('lib/facebook');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'br-' + p + '-'));
const has = (cmd) => spawnSync('sh', ['-c', 'command -v ' + cmd], { encoding: 'utf8' }).status === 0;
const H264 = { videoCodec: 'H264', audioCodec: 'AAC', width: 1920, height: 1080, fps: 30 };

// ---------- ffargs ----------
test('ffargs: stream key URLs', () => {
  assert.strictEqual(F.targetUrl({ type: 'youtube' }, 'abc'), 'rtmps://a.rtmps.youtube.com/live2/abc');
  assert.strictEqual(F.targetUrl({ type: 'facebook' }, 'FB-1'), 'rtmps://live-api-s.facebook.com:443/rtmp/FB-1');
  assert.strictEqual(F.targetUrl({ type: 'rtmp', url: 'rtmp://x/app/' }, '/k'), 'rtmp://x/app/k');
  assert.strictEqual(F.targetUrl({ type: 'srt', url: 'srt://h:9000?streamid=x' }, 'ignored'), 'srt://h:9000?streamid=x');
});
test('ffargs: original passes H.264 through, re-encodes other codecs', () => {
  let p = F.plan({ mode: 'original' }, { mode: 'copy' }, H264);
  assert.ok(p.copyVideo && p.copyAudio && p.reasons.length === 0);
  p = F.plan({ mode: 'original' }, { mode: 'copy' }, Object.assign({}, H264, { videoCodec: 'H265', audioCodec: 'Opus' }));
  assert.ok(!p.copyVideo && !p.copyAudio);
  assert.strictEqual(p.reasons.length, 2);
});
test('ffargs: encode never upscales and keeps the aspect ratio', () => {
  let p = F.plan({ mode: 'encode', height: 2160 }, {}, H264);
  assert.strictEqual(p.height, 1080); assert.ok(!p.scale);
  p = F.plan({ mode: 'encode', height: 720, fps: 60 }, {}, H264);
  assert.deepStrictEqual([p.width, p.height, p.fps, p.gop], [1280, 720, 30, 60]);
  p = F.plan({ mode: 'encode', height: 720 }, {}, Object.assign({}, H264, { width: 1440, height: 1080 }));
  assert.strictEqual(p.width, 960);
  assert.strictEqual(F.plan({ mode: 'encode', height: 720 }, {}, H264).bitrate, 4000);
});
test('ffargs: destination command line', () => {
  const r = F.destination({ type: 'youtube', video: { mode: 'encode', height: 720, bitrate: 4500 }, audio: { mode: 'aac', bitrate: 320 } }, 'rtmps://y/k', H264, 'rtsp://127.0.0.1:8554/live');
  const a = r.args.join(' ');
  assert.ok(a.includes('-vf scale=-2:720:flags=lanczos'));
  assert.ok(a.includes('-b:v 4500k -maxrate 4500k -bufsize 9000k'));
  assert.ok(a.includes('-g 60 -keyint_min 60 -sc_threshold 0'));
  assert.ok(a.includes('-c:a aac -b:a 320k -ar 48000 -ac 2'));
  assert.ok(a.endsWith('-f flv rtmps://y/k'));
  const s = F.destination({ type: 'srt', video: { mode: 'original' }, audio: { mode: 'copy' } }, 'srt://x:1', H264, 'rtsp://i');
  assert.ok(s.args.join(' ').includes('-c:v copy') && s.args.join(' ').endsWith('-f mpegts srt://x:1'));
  const silent = F.destination({ type: 'rtmp', video: {}, audio: {} }, 'rtmp://x', Object.assign({}, H264, { audioCodec: null }), 'rtsp://i');
  assert.ok(!silent.args.includes('-c:a'));
});
test('ffargs: web output makes HLS (AAC) and WebRTC (Opus) paths without B-frames', () => {
  const r = F.web({ mode: 'encode', height: 720 }, H264, 'rtsp://i', 'rtsp://127.0.0.1:8554');
  const a = r.args.join(' ');
  assert.ok(a.includes('-bf 0') && a.includes('libopus') && a.includes('+global_header'));
  const tee = r.args[r.args.length - 1];
  assert.ok(tee.includes("select=\\'v:0,a:0\\']rtsp://127.0.0.1:8554/web|"));
  assert.ok(tee.endsWith("select=\\'v:0,a:1\\']rtsp://127.0.0.1:8554/webrtc"));
});
test('ffargs: NDI ingest keeps PCM audio and does not over-probe', () => {
  const a = F.ndiIngest({ width: 1920, height: 1080, fpsN: 30000, fpsD: 1001 }, '/v', '/a', { ndiBitrate: 10000 }, 'rtsp://x/live').join(' ');
  assert.ok(a.includes('-framerate 30000/1001') && a.includes('-c:a pcm_s24be') && a.includes('-probesize 32') && a.includes('-g 60'));
});
test('ffargs: progress parsing and summary', () => {
  const p = F.parseProgress('frame=300\nfps=29.97\nbitrate=4501.2kbits/s\nout_time_us=10000000\ndrop_frames=2\nspeed=1.01x\nprogress=continue\n');
  assert.deepStrictEqual([p.frame, p.fps, p.kbps, p.outTime, p.drop, p.speed, p.end], [300, 29.97, 4501.2, 10, 2, 1.01, false]);
  assert.strictEqual(F.describe(F.plan({ mode: 'encode', height: 720, bitrate: 4500 }, { mode: 'aac', bitrate: 256 }, H264)), '1280×720 30fps 4.5 Mb/s · AAC 256k');
});

// ---------- meters ----------
test('meter: parses ffmpeg ebur128 lines', () => {
  const v = M.parseLine('[Parsed_ebur128_0 @ 0x55] t: 12.5  TARGET:-23 LUFS    M: -16.2 S: -17.0     I: -18.4 LUFS       LRA:   5.1 LU  FTPK: -3.2 -4.1 dBFS  TPK: -1.0 -1.5 dBFS');
  assert.deepStrictEqual([v.m, v.s, v.i, v.lra], [-16.2, -17, -18.4, 5.1]);
  assert.deepStrictEqual(v.peak, [-3.2, -4.1]); assert.deepStrictEqual(v.tpk, [-1, -1.5]);
  const q = M.parseLine('[Parsed_ebur128_0 @ 0x55] t: 0.1  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -inf -inf dBFS  TPK: -inf -inf dBFS');
  assert.deepStrictEqual(q.peak, [-120, -120]);
  assert.strictEqual(M.parseLine('Stream #0:1: Audio: aac'), null);
});
test('meter: probe output', () => {
  const p = M.parseProbe({ streams: [{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', profile: 'High' }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }] });
  assert.deepStrictEqual([p.width, p.height, p.fps, p.audioRate, p.audioChannels], [1920, 1080, 29.97, 48000, 2]);
});

// ---------- MediaMTX ----------
test('mediamtx: config', () => {
  const y = MTX.yaml({ ports: {}, input: { source: 'stream', allowFrom: ['192.168.10.0/24'] }, recording: { enabled: true, keepDays: 14, segmentMinutes: 30 } }, { recordDir: '/recordings' });
  assert.ok(y.includes('rtspAddress: "127.0.0.1:8554"') && y.includes('srtAddress: ":8890"'));
  assert.ok(y.includes('ips: ["192.168.10.0/24"]') && y.includes('path: live'));
  assert.ok(y.includes('recordDeleteAfter: 336h') && y.includes('recordPath: "/recordings/%path/%Y-%m-%d_%H-%M-%S-%f"'));
  const n = MTX.yaml({ input: { source: 'ndi' }, recording: { enabled: false, keepDays: 0 } }, { recordDir: '/r' });
  assert.ok(!n.includes('path: live'), 'no outside publishing while the input is NDI');
  assert.ok(n.includes('record: no') && n.includes('recordDeleteAfter: 0s'));
});
test('mediamtx: address ranges and API summaries', () => {
  ['10.0.0.0/8', '192.168.1.5', 'fd00::/8'].forEach((r) => assert.ok(MTX.validRange(r), r));
  ['10.0.0.0/33', '300.1.1.1', 'any', ''].forEach((r) => assert.ok(!MTX.validRange(r), r));
  const s = MTX.summarizePath({ ready: true, readyTime: '2026-11-08T15:00:00Z', source: { type: 'srtConn', id: 'x' }, tracks: ['H264', 'MPEG-4 Audio'], bytesReceived: 1000, readers: [{}, {}] });
  assert.deepStrictEqual([s.protocol, s.videoCodec, s.audioCodec, s.bytes, s.readers], ['SRT', 'H264', 'AAC', 1000, 2]);
  assert.strictEqual(MTX.summarizePath({ ready: true, tracks2: [{ codec: 'H265' }, { codec: 'Opus' }], inboundBytes: 5 }).audioCodec, 'Opus');
});

// ---------- recordings ----------
test('recordings: list, limit and safe paths', () => {
  const d = tmp('rec');
  fs.mkdirSync(path.join(d, 'live'));
  const mk = (n, size, ageMs) => { const p = path.join(d, 'live', n); fs.writeFileSync(p, Buffer.alloc(size)); const t = (Date.now() - ageMs) / 1000; fs.utimesSync(p, t, t); };
  mk('2026-11-01_10-00-00-000001.mp4', 1000, 900000);
  mk('2026-11-08_10-00-00-000001.mp4', 1000, 600000);
  fs.writeFileSync(path.join(d, 'live', 'notes.txt'), 'x');
  const l = Rec.list(d);
  assert.strictEqual(l.length, 2); assert.strictEqual(l[0].name, '2026-11-08_10-00-00-000001.mp4');
  assert.strictEqual(Rec.resolve(d, '../etc/passwd'), null);
  assert.strictEqual(Rec.resolve(d, 'live/../../x.mp4'), null);
  assert.ok(Rec.resolve(d, 'live/2026-11-01_10-00-00-000001.mp4'));
  assert.strictEqual(Rec.enforceLimit(d, 1500), 1);
  assert.strictEqual(Rec.list(d)[0].name, '2026-11-08_10-00-00-000001.mp4');
});

// ---------- auth, secrets ----------
test('auth: passwords, tokens and lockout', () => {
  const h = Auth.hashPassword('correct horse');
  assert.ok(Auth.checkPassword('correct horse', h) && !Auth.checkPassword('wrong', h));
  assert.ok(Auth.safeEqual('abc', 'abc') && !Auth.safeEqual('abc', 'abd'));
  const l = Auth.limiter({ max: 3 });
  l.fail('ip'); l.fail('ip'); assert.ok(!l.blocked('ip')); l.fail('ip'); assert.ok(l.blocked('ip'));
  const st = {}; const a = Auth.create({ state: st, saveState() {} });
  const t = a.newSession();
  assert.ok(a.sessionOk({ headers: { cookie: 'x=1; br_session=' + t } }));
  assert.ok(!a.sessionOk({ headers: { cookie: 'br_session=nope' } }));
});
test('secrets: encrypt and decrypt', () => {
  const d = tmp('sec');
  const s = Secrets.create(path.join(d, 'secret.key'));
  const e = s.enc('stream-key-123');
  assert.ok(e.startsWith('enc1:') && s.dec(e) === 'stream-key-123');
  const m = Secrets.create(path.join(d, 'secret.key'), { masterKey: 'a long master key' });
  assert.ok(m.enc('x').startsWith('enc2:'));
});

// ---------- NDI ----------
test('ndi: frame rates and config file', () => {
  assert.deepStrictEqual(Ndi.rational(29.97), { n: 30000, d: 1001 });
  assert.deepStrictEqual(Ndi.rational(59.94), { n: 60000, d: 1001 });
  assert.deepStrictEqual(Ndi.rational(25), { n: 25, d: 1 });
  const d = tmp('ndi');
  Ndi.writeConfig(d, { discoveryServer: '192.168.1.10', extraIps: '10.0.20.5, 10.0.20.6', groups: 'Church' });
  const j = JSON.parse(fs.readFileSync(path.join(d, 'ndi-config.v1.json'), 'utf8'));
  assert.deepStrictEqual(j.ndi.networks, { discovery: '192.168.1.10', ips: '10.0.20.5,10.0.20.6' });
  assert.strictEqual(j.ndi.groups.send, 'Church');
});

// ---------- process supervision ----------
test('proc: goes live, restarts with backoff after a crash, stops cleanly', async () => {
  let launches = 0;
  const fake = (cmd, args) => { launches++; const c = Demo.spawn(cmd, args); if (launches === 1) setTimeout(() => { c.exitCode = 1; c.emit('exit', 1, null); }, 700); return c; };
  const p = new Proc({ name: 't', cmd: 'x', progress: true, args: () => ['-progress', 'pipe:1'], spawn: fake });
  const states = [];
  p.on('state', (s) => states.push(s));
  p.start();
  await new Promise((r) => setTimeout(r, 4000));
  assert.ok(states.includes('live') && states.includes('retrying'), states.join(','));
  assert.strictEqual(launches, 2);
  assert.strictEqual(p.state, 'live');
  p.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(p.state, 'off');
  assert.strictEqual(lastUseful(['frame=1', '[tls @ 0x1] Connection refused', 'Conversion failed!']), 'Connection refused');
});

// ---------- platforms (fake APIs) ----------
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    for (const [re, fn] of routes) if (re.test(url)) { const [status, body] = fn(url, opts); return { ok: status < 300, status, json: async () => body }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}
test('youtube: go live creates and binds a broadcast, end completes it', async () => {
  let cfg = { clientId: 'id', clientSecret: 'sec', refreshToken: 'rt', streamId: '' };
  const f = fakeFetch([
    [/oauth2.*\/token/, () => [200, { access_token: 'at', expires_in: 3600 }]],
    [/liveStreams\?/, (u, o) => [200, { id: 'S1', cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2', streamName: 'key-1' } } }]],
    [/liveBroadcasts\/bind/, () => [200, {}]],
    [/liveBroadcasts\/transition/, () => [200, {}]],
    [/liveBroadcasts\?/, () => [200, { id: 'B1' }]]
  ]);
  const yt = YT.create({ get: () => cfg, save: (p) => { cfg = Object.assign({}, cfg, p); }, fetch: f });
  const r = await yt.goLive({ title: 'Sunday', privacy: 'unlisted' });
  assert.deepStrictEqual([r.broadcastId, r.url, r.key, r.watchUrl], ['B1', 'rtmps://a.rtmps.youtube.com/live2', 'key-1', 'https://youtu.be/B1']);
  assert.strictEqual(cfg.streamId, 'S1');
  const ins = f.calls.find((c) => /liveBroadcasts\?part/.test(c.url));
  assert.strictEqual(JSON.parse(ins.body).status.privacyStatus, 'unlisted');
  await yt.end('B1');
  assert.ok(f.calls.some((c) => /transition\?broadcastStatus=complete&id=B1/.test(c.url)));
});
test('facebook: go live on a page, end it', async () => {
  let cfg = { pageId: '123', pageToken: 'pt', graphVersion: 'v23.0' };
  const f = fakeFetch([
    [/\/123\/live_videos/, () => [200, { id: 'V9', secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-9?s=1' }]],
    [/\/V9\?fields=permalink_url/, () => [200, { permalink_url: '/church/videos/9/' }]],
    [/\/V9$/, () => [200, { success: true }]]
  ]);
  const fb = FB.create({ get: () => cfg, save: (p) => { cfg = Object.assign({}, cfg, p); }, fetch: f });
  const r = await fb.goLive({ title: 'Sunday' });
  assert.strictEqual(r.url, 'rtmps://live-api-s.facebook.com:443/rtmp/FB-9?s=1');
  assert.strictEqual(r.watchUrl, 'https://www.facebook.com/church/videos/9/');
  assert.strictEqual(F.targetUrl({ type: 'facebook', url: r.url }, r.key), r.url);
  await fb.end('V9');
  assert.ok(f.calls.some((c) => /\/V9$/.test(c.url) && /end_live_video=true/.test(c.body)));
});

// ---------- the whole app in demo mode ----------
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* text */ } resolve({ status: res.statusCode, j, b, headers: res.headers }); });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
test('app: demo mode end to end (API, destinations, Companion)', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(root, 'server.js'), '--demo'], { env: Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(port + 1) }), stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 4500));
    let r = await req(port, 'GET', '/api/state');
    assert.strictEqual(r.status, 200);
    assert.ok(r.j.status.input.ready, 'pretend OBS connected');
    r = await req(port, 'POST', '/api/destinations', { type: 'youtube', key: 'k1', video: { mode: 'encode', height: 720 } });
    assert.ok(r.j.ok);
    r = await req(port, 'POST', '/api/destinations', { type: 'rtmp', url: 'ftp://nope' });
    assert.strictEqual(r.status, 400);
    r = await req(port, 'POST', '/api/v1/golive');
    assert.ok(r.j.ok, JSON.stringify(r.j));
    await new Promise((res) => setTimeout(res, 1500));
    r = await req(port, 'GET', '/api/v1/status');
    assert.strictEqual(r.j.destinations_live, 1); assert.strictEqual(r.j.any_live, true);
    r = await req(port, 'POST', '/api/v1/destinations/1/stop');
    assert.ok(r.j.ok);
    r = await req(port, 'GET', '/api/v1/status');
    assert.strictEqual(r.j.destinations_live, 0);
    r = await req(port, 'POST', '/api/settings', { section: 'ports', values: { rtmp: 1935, webrtc: 1935 } });
    assert.strictEqual(r.status, 400);
    r = await req(port + 1, 'GET', '/player.json');
    assert.strictEqual(r.j.live, true);
    r = await req(port + 1, 'GET', '/api/state');
    assert.strictEqual(r.status, 404, 'the public port serves only the player');
    r = await req(port + 1, 'GET', '/hls/../etc/passwd');
    assert.notStrictEqual(r.status, 200);
  } finally { p.kill(); }
});
test('app: sign-in and the Companion token', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000), data = tmp('app');
  const p = spawn(process.execPath, [path.join(root, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), PUBLIC_PORT: String(port + 1), DATA_DIR: data, MEDIAMTX: '/nonexistent', NDI_BRIDGE: '/nonexistent' }), stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    let r = await req(port, 'GET', '/api/state');
    assert.strictEqual(r.status, 401); assert.ok(r.j.setup);
    r = await req(port, 'POST', '/api/login', { password: 'short' });
    assert.strictEqual(r.status, 400);
    r = await req(port, 'POST', '/api/login', { password: 'long enough' });
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    r = await req(port, 'GET', '/api/state', null, { cookie });
    assert.strictEqual(r.status, 200);
    const tok = r.j.apiToken;
    r = await req(port, 'GET', '/api/v1/status');
    assert.strictEqual(r.status, 401);
    r = await req(port, 'GET', '/api/v1/status', null, { authorization: 'Bearer ' + tok });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.j.input_live, false);
    r = await req(port, 'GET', '/api/v1/status?token=' + encodeURIComponent(tok));
    assert.strictEqual(r.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.ok(String(saved.api.token).startsWith('enc1:'), 'token stored encrypted');
    assert.ok(fs.readFileSync(path.join(data, 'mediamtx.yml'), 'utf8').includes('paths:'));
  } finally { p.kill(); }
});

// ---------- ndi-bridge (needs gcc) ----------
test('ndi-bridge: builds and runs against a pretend NDI library (gcc)', () => {
  if (!has('gcc')) return 'skipped (no gcc)';
  const d = tmp('ndib');
  let r = spawnSync('gcc', ['-O2', '-shared', '-fPIC', '-I' + path.join(root, 'test/ndi-stub'), path.join(root, 'test/fake-ndi.c'), '-o', path.join(d, 'libndi.so'), '-lm'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  r = spawnSync('gcc', ['-O2', '-Wall', '-Werror', '-I' + path.join(root, 'test/ndi-stub'), path.join(root, 'ndi/ndi-bridge.c'), '-o', path.join(d, 'ndi-bridge'), '-L' + d, '-lndi', '-lpthread', '-Wl,-rpath,' + d], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  r = spawnSync(path.join(d, 'ndi-bridge'), ['list', '0'], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(r.stdout).sources.map((s) => s.name), ['TEST (Fake)']);
  return d;
});
test('ndi-bridge + ffmpeg: NDI in produces H.264 + PCM in step (gcc, ffmpeg)', async () => {
  if (!has('gcc') || !has('ffmpeg')) return 'skipped (needs gcc and ffmpeg)';
  const d = tmp('ndif');
  spawnSync('gcc', ['-O2', '-shared', '-fPIC', '-I' + path.join(root, 'test/ndi-stub'), path.join(root, 'test/fake-ndi.c'), '-o', path.join(d, 'libndi.so'), '-lm']);
  spawnSync('gcc', ['-O2', '-I' + path.join(root, 'test/ndi-stub'), path.join(root, 'ndi/ndi-bridge.c'), '-o', path.join(d, 'ndi-bridge'), '-L' + d, '-lndi', '-lpthread', '-Wl,-rpath,' + d]);
  const v = path.join(d, 'v.fifo'), a = path.join(d, 'a.fifo'), out = path.join(d, 'out.mkv');
  spawnSync('mkfifo', [v, a]);
  const bridge = spawn(path.join(d, 'ndi-bridge'), ['recv', 'TEST (Fake)', v, a], { stdio: ['ignore', 'pipe', 'inherit'] });
  const fmt = await new Promise((resolve) => { let b = ''; bridge.stdout.on('data', (x) => { b += x; const l = b.split('\n')[0]; if (b.includes('\n')) resolve(JSON.parse(l)); }); });
  assert.deepStrictEqual([fmt.width, fmt.height, fmt.fpsN, fmt.fpsD], [640, 360, 30000, 1001]);
  const args = F.ndiIngest(fmt, v, a, { ndiBitrate: 2000, ndiPreset: 'ultrafast' }, 'rtsp://unused');
  const i = args.indexOf('-f', args.indexOf('pcm_s24be'));
  // like the app: FFmpeg runs until the bridge goes away, then sees the end of both pipes
  const ff = spawn('ffmpeg', args.slice(0, i).concat(['-y', '-f', 'matroska', out]), { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; ff.stderr.on('data', (x) => { err += x; });
  await new Promise((r) => setTimeout(r, 3500));
  bridge.kill('SIGTERM');
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { ff.kill('SIGKILL'); resolve('timeout'); }, 15000);
    ff.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  assert.strictEqual(code, 0, 'ffmpeg ' + code + ': ' + err.slice(-500));
  const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width:format=duration', '-of', 'json', out], { encoding: 'utf8' });
  const j = JSON.parse(pr.stdout);
  assert.deepStrictEqual(j.streams.map((s) => s.codec_name), ['h264', 'pcm_s24be']);
  assert.ok(Number(j.format.duration) > 2.5 && Number(j.format.duration) < 4.5, 'duration ' + j.format.duration);
});

// ---------- run ----------
(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      // no single test may hang the run (CI)
      const r = await Promise.race([t.fn(), new Promise((_, no) => setTimeout(() => no(new Error('timed out after 60 s')), 60000).unref())]);
      console.log('ok   ' + t.name + (typeof r === 'string' && r.startsWith('skipped') ? ' (' + r + ')' : ''));
    } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
