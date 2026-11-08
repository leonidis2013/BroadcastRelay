/*
 * MediaMTX does the protocol work: it takes the feed from OBS (RTMP, SRT, WHIP),
 * hands it to our FFmpeg workers over RTSP on 127.0.0.1, records it, and serves
 * the web player (HLS and WebRTC). We write its config, keep it running and read
 * its API to see what is coming in.
 *
 * Paths (the only ones MediaMTX will accept):
 *   live    the incoming feed (OBS, or our NDI ingest)   - publish from allowed encoders
 *   web     web player, H.264 + AAC  (HLS)                - written by our web worker
 *   webrtc  web player, H.264 + Opus (WebRTC)             - written by our web worker
 *
 * Only keys that have been stable across MediaMTX 1.x go in the file. Settings that were
 * renamed between versions go in as MTX_ environment variables, which MediaMTX
 * ignores when it doesn't know them.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Proc } = require('./proc.js');

const DEFAULT_PORTS = { rtmp: 1935, srt: 8890, webrtc: 8889, ice: 8189, rtsp: 8554, hls: 8888, api: 9997 };
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fd00::/8'];

const q = (s) => JSON.stringify(String(s)); // JSON strings are valid YAML

function ports(p) {
  const out = {};
  for (const k of Object.keys(DEFAULT_PORTS)) {
    const n = Number(p && p[k]);
    out[k] = Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORTS[k];
  }
  return out;
}

/** CIDR or plain address, IPv4 or IPv6. */
function validRange(s) {
  s = String(s || '').trim();
  const m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(s);
  if (!m) return false;
  const ip = m[1], bits = m[2] == null ? null : Number(m[2]);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').every((o) => Number(o) <= 255) && (bits == null || bits <= 32);
  return ip.includes(':') && (bits == null || bits <= 128);
}

function yaml(s, o) {
  const p = ports(s.ports);
  const allow = (Array.isArray(s.input && s.input.allowFrom) && s.input.allowFrom.length ? s.input.allowFrom : PRIVATE).filter(validRange);
  const rec = s.recording || {};
  const L = [];
  L.push('# Written by BroadcastRelay. Changes made here are replaced; use the web page.');
  L.push('logLevel: info');
  L.push('logDestinations: [stdout]');
  L.push('api: yes');
  L.push('apiAddress: ' + q('127.0.0.1:' + p.api));
  L.push('metrics: no');
  L.push('pprof: no');
  L.push('playback: no');
  L.push('rtsp: yes');
  L.push('rtspAddress: ' + q('127.0.0.1:' + p.rtsp));
  L.push('rtmp: yes');
  L.push('rtmpAddress: ' + q(':' + p.rtmp));
  L.push('srt: yes');
  L.push('srtAddress: ' + q(':' + p.srt));
  L.push('hls: yes');
  L.push('hlsAddress: ' + q('127.0.0.1:' + p.hls));
  L.push('webrtc: yes');
  L.push('webrtcAddress: ' + q(':' + p.webrtc));
  L.push('webrtcLocalUDPAddress: ' + q(':' + p.ice));
  const hosts = String((s.network && s.network.publicHosts) || '').split(/[\s,]+/).filter(Boolean);
  if (hosts.length) L.push('webrtcAdditionalHosts: [' + hosts.map(q).join(', ') + ']');
  L.push('authMethod: internal');
  L.push('authInternalUsers:');
  // this machine (our workers, the web player proxy): everything
  L.push('  - user: any');
  L.push('    pass: ""');
  L.push('    ips: ["127.0.0.1", "::1"]');
  L.push('    permissions:');
  ['publish', 'read', 'playback', 'api'].forEach((a) => L.push('      - action: ' + a));
  // encoders on the allowed networks may only publish the live feed, and only when the input is set to OBS
  if (allow.length && (!s.input || s.input.source !== 'ndi')) {
    L.push('  - user: any');
    L.push('    pass: ""');
    L.push('    ips: [' + allow.map(q).join(', ') + ']');
    L.push('    permissions:');
    L.push('      - action: publish');
    L.push('        path: live');
  }
  L.push('pathDefaults:');
  L.push('  record: no');
  L.push('paths:');
  L.push('  live:');
  L.push('    record: ' + (rec.enabled === false ? 'no' : 'yes'));
  L.push('    recordPath: ' + q(path.join(o.recordDir, '%path', '%Y-%m-%d_%H-%M-%S-%f')));
  L.push('    recordFormat: fmp4');
  L.push('    recordPartDuration: 1s');
  L.push('    recordSegmentDuration: ' + Math.max(1, Math.min(240, Number(rec.segmentMinutes) || 30)) + 'm');
  const days = Number(rec.keepDays);
  L.push('    recordDeleteAfter: ' + (Number.isFinite(days) && days > 0 ? Math.round(days * 24) + 'h' : '0s'));
  L.push('  web:');
  L.push('  webrtc:');
  return L.join('\n') + '\n';
}

/** Settings that were renamed between MediaMTX versions. The unknown name is ignored. */
function env() {
  return {
    MTX_RTSPTRANSPORTS: 'tcp', // RTSP over TCP only: no UDP ports to clash with
    MTX_MOQ: 'no', // newer MediaMTX also serves MoQ on 8892; not used here
    MTX_HLSALWAYSREMUX: 'no'
  };
}

/** MediaMTX track names -> short codec names. */
function codecOf(t) {
  t = String(t && (t.codec || t) || '');
  if (/^H264$/i.test(t)) return { kind: 'v', codec: 'H264' };
  if (/^(H265|HEVC)$/i.test(t)) return { kind: 'v', codec: 'H265' };
  if (/^AV1$/i.test(t)) return { kind: 'v', codec: 'AV1' };
  if (/^VP[89]$/i.test(t)) return { kind: 'v', codec: t.toUpperCase() };
  if (/MPEG-4 Audio|AAC/i.test(t)) return { kind: 'a', codec: 'AAC' };
  if (/Opus/i.test(t)) return { kind: 'a', codec: 'Opus' };
  if (/LPCM/i.test(t)) return { kind: 'a', codec: 'LPCM' };
  if (/MPEG-1\/2 Audio|MP3/i.test(t)) return { kind: 'a', codec: 'MP3' };
  if (/G711|G722|AC-?3/i.test(t)) return { kind: 'a', codec: t };
  return null;
}

const SOURCE_NAMES = { rtmpConn: 'RTMP', rtmpsConn: 'RTMPS', srtConn: 'SRT', webRTCSession: 'WHIP', rtspSession: 'RTSP', rtspsSession: 'RTSP' };

function summarizePath(p) {
  if (!p) return { ready: false };
  const tracks = (p.tracks2 || p.tracks || []).map(codecOf).filter(Boolean);
  const v = tracks.find((t) => t.kind === 'v'), a = tracks.find((t) => t.kind === 'a');
  const src = p.source || {};
  return {
    ready: !!p.ready,
    since: p.readyTime ? Date.parse(p.readyTime) : null,
    sourceType: src.type || null,
    sourceId: src.id || null,
    protocol: SOURCE_NAMES[src.type] || (src.type ? src.type.replace(/(Conn|Session|Source)$/, '').toUpperCase() : null),
    videoCodec: v ? v.codec : null,
    audioCodec: a ? a.codec : null,
    bytes: Number(p.inboundBytes != null ? p.inboundBytes : p.bytesReceived) || 0,
    readers: Array.isArray(p.readers) ? p.readers.length : 0
  };
}

function create(opts) {
  // opts: { bin, dataDir, recordDir, settings: () => settings, log }
  const file = path.join(opts.dataDir, 'mediamtx.yml');
  let lastYaml = '';
  let apiPort = ports(opts.settings().ports).api;
  const logLines = [];

  function writeConfig() {
    const s = opts.settings();
    const text = yaml(s, { recordDir: opts.recordDir });
    apiPort = ports(s.ports).api;
    if (text === lastYaml) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', text);
    fs.renameSync(file + '.tmp', file);
    lastYaml = text;
    return true;
  }

  const proc = new Proc({
    name: 'MediaMTX',
    cmd: opts.bin,
    cwd: opts.dataDir, // anything MediaMTX writes on its own stays in the data folder
    args: () => { writeConfig(); return [file]; },
    env: env(),
    liveAfterMs: 1500,
    onStdoutLine: (line) => {
      logLines.push(line.replace(/^\d{4}\/\d\d\/\d\d /, ''));
      if (logLines.length > 200) logLines.shift();
    }
  });

  /** Rewrite the config. MediaMTX watches the file and reloads itself; a port change needs a restart. */
  function apply() {
    const before = lastYaml;
    if (!writeConfig()) return;
    const portLine = (t) => t.split('\n').filter((l) => /Address:/.test(l)).join('\n');
    if (proc.wanted && portLine(before) !== portLine(lastYaml)) proc.restart();
  }

  function api(p) {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: apiPort, path: p, timeout: 2000 }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null);
          try { resolve(res.statusCode < 300 ? JSON.parse(b) : null); } catch (e) { resolve(null); }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
  }

  async function pathInfo(name) { return summarizePath(await api('/v3/paths/get/' + encodeURIComponent(name))); }

  /** Connection stats for the live feed (SRT has the useful ones: RTT, loss). */
  async function connStats(src) {
    if (!src || !src.sourceId) return null;
    const kind = { srtConn: 'srtconns', rtmpConn: 'rtmpconns', webRTCSession: 'webrtcsessions', rtspSession: 'rtspsessions' }[src.sourceType];
    if (!kind) return null;
    const c = await api('/v3/' + kind + '/get/' + encodeURIComponent(src.sourceId));
    if (!c) return null;
    return {
      remote: c.remoteAddr || null,
      rtt: c.msRTT != null ? c.msRTT : null,
      lossPct: c.packetsReceived ? Math.round(1000 * (c.packetsReceivedLoss || 0) / c.packetsReceived) / 10 : null,
      recvMbps: c.mbpsReceiveRate != null ? c.mbpsReceiveRate : null
    };
  }

  /** Drop whoever is publishing the live feed (used when switching the input to NDI). */
  async function kick(src) {
    if (!src || !src.sourceId) return;
    const kind = { srtConn: 'srtconns', rtmpConn: 'rtmpconns', webRTCSession: 'webrtcsessions', rtspSession: 'rtspsessions' }[src.sourceType];
    if (!kind) return;
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: apiPort, method: 'POST', path: '/v3/' + kind + '/kick/' + encodeURIComponent(src.sourceId), timeout: 2000 }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve); req.on('timeout', () => req.destroy()); req.end();
    });
  }

  return { proc, apply, writeConfig, pathInfo, connStats, kick, log: () => logLines.slice(-80), file };
}

module.exports = { create, yaml, env, ports, codecOf, summarizePath, validRange, DEFAULT_PORTS, PRIVATE };
