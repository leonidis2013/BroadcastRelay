/*
 * Network information for the Network page and connection health:
 *  - interfaces: addresses, link speed and live traffic (from /sys/class/net)
 *  - listening sockets: who has each port (from /proc/net/{tcp,udp}{,6})
 *  - TCP stats of our outgoing connections (RTT, retransmits, send rate) from `ss -ti`
 *  - reachability: DNS + TCP connect time to a host:port
 * Everything degrades quietly when a source isn't available (not Linux, no ss).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns');
const { execFile } = require('child_process');

const readNum = (p) => { try { const n = Number(fs.readFileSync(p, 'utf8').trim()); return Number.isFinite(n) ? n : null; } catch (e) { return null; } };
const readStr = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; } };
const SKIP_IF = /^(lo|docker|veth|br-|kube|cni|flannel|virbr|tap|tun\d|vnet)/;

// ---------- interfaces ----------
function createIfaceMeter() {
  let last = new Map(); // name -> { rx, tx, at }
  const rates = new Map();
  function sample() {
    const now = Date.now();
    for (const name of Object.keys(os.networkInterfaces())) {
      const rx = readNum('/sys/class/net/' + name + '/statistics/rx_bytes'), tx = readNum('/sys/class/net/' + name + '/statistics/tx_bytes');
      if (rx == null || tx == null) continue;
      const p = last.get(name);
      if (p && now > p.at) rates.set(name, { rxKbps: Math.max(0, Math.round((rx - p.rx) * 8 / (now - p.at))), txKbps: Math.max(0, Math.round((tx - p.tx) * 8 / (now - p.at))) });
      last.set(name, { rx, tx, at: now });
    }
  }
  function list() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      if (SKIP_IF.test(name)) continue;
      const speed = readNum('/sys/class/net/' + name + '/speed');
      const r = rates.get(name) || {};
      out.push({
        name,
        up: (readStr('/sys/class/net/' + name + '/operstate') || 'unknown') !== 'down',
        mac: (addrs.find((a) => a.mac && a.mac !== '00:00:00:00:00:00') || {}).mac || '',
        speedMbps: speed && speed > 0 ? speed : null,
        mtu: readNum('/sys/class/net/' + name + '/mtu'),
        ipv4: addrs.filter((a) => a.family === 'IPv4').map((a) => a.cidr || a.address),
        ipv6: addrs.filter((a) => a.family === 'IPv6' && !/^fe80/i.test(a.address)).map((a) => a.cidr || a.address),
        rxKbps: r.rxKbps != null ? r.rxKbps : null,
        txKbps: r.txKbps != null ? r.txKbps : null
      });
    }
    return out.sort((a, b) => (b.ipv4.length - a.ipv4.length) || a.name.localeCompare(b.name));
  }
  return { sample, list };
}

/** Default gateway from /proc/net/route. */
function gateway() {
  const t = readStr('/proc/net/route');
  if (!t) return null;
  for (const line of t.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === '00000000' && f[2] && f[2] !== '00000000') {
      const h = f[2];
      return { iface: f[0], ip: [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join('.') };
    }
  }
  return null;
}
function nameservers() {
  const t = readStr('/etc/resolv.conf') || '';
  return t.split('\n').map((l) => /^\s*nameserver\s+(\S+)/.exec(l)).filter(Boolean).map((m) => m[1]);
}

// ---------- listening sockets ----------
/** Parse a /proc/net/{tcp,udp}{,6} table. Returns [{ port, state, inode, local }]. */
function parseProcNet(text) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [addr, portHex] = f[1].split(':');
    out.push({ local: addr, port: parseInt(portHex, 16), state: f[3], inode: f[9] });
  }
  return out;
}
/** port -> { tcp: [inodes], udp: [inodes] } for sockets that are listening (TCP) or bound (UDP). */
function listeners() {
  const map = new Map();
  const add = (proto, file, wantState) => {
    for (const s of parseProcNet(readStr('/proc/net/' + file))) {
      if (wantState && s.state !== wantState) continue;
      const e = map.get(s.port) || { tcp: [], udp: [] };
      e[proto].push(s.inode); map.set(s.port, e);
    }
  };
  add('tcp', 'tcp', '0A'); add('tcp', 'tcp6', '0A'); // 0A = LISTEN
  add('udp', 'udp', '07'); add('udp', 'udp6', '07'); // 07 = unconnected (bound)
  return map;
}
/** Socket inodes a process holds open (only works for our own processes). */
function socketInodes(pid) {
  const set = new Set();
  if (!pid) return set;
  let fds = [];
  try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch (e) { return set; }
  for (const fd of fds) {
    try { const l = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); const m = /^socket:\[(\d+)\]$/.exec(l); if (m) set.add(m[1]); } catch (e) { /* closed */ }
  }
  return set;
}

// ---------- TCP stats (ss) ----------
let ssMissing = false;
/** Parse `ss -tinpH` output. Returns [{ pid, local, peer, rtt, rttVar, retrans, bytesSent, bytesRetrans, cwnd, sendKbps, unacked }]. */
function parseSs(text) {
  const out = [];
  let cur = null;
  const rate = (v) => {
    const m = /^([\d.]+)([KMG]?)bps$/.exec(v || '');
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ '': 0.001, K: 1, M: 1000, G: 1e6 })[m[2]]);
  };
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      const f = raw.trim().split(/\s+/);
      // State Recv-Q Send-Q Local Peer [users:(...)]  (State may be missing with "state established")
      const off = /^\d+$/.test(f[0]) ? 0 : 1;
      const pm = /pid=(\d+)/.exec(raw);
      cur = { pid: pm ? Number(pm[1]) : null, local: f[off + 2], peer: f[off + 3] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const s = raw;
    const g = (re) => { const m = re.exec(s); return m ? m : null; };
    let m;
    if ((m = g(/\brtt:([\d.]+)\/([\d.]+)/))) { cur.rtt = Number(m[1]); cur.rttVar = Number(m[2]); }
    if ((m = g(/\bretrans:\d+\/(\d+)/))) cur.retrans = Number(m[1]);
    if ((m = g(/\bbytes_sent:(\d+)/))) cur.bytesSent = Number(m[1]);
    if ((m = g(/\bbytes_retrans:(\d+)/))) cur.bytesRetrans = Number(m[1]);
    if ((m = g(/\bcwnd:(\d+)/))) cur.cwnd = Number(m[1]);
    if ((m = g(/\bunacked:(\d+)/))) cur.unacked = Number(m[1]);
    if ((m = g(/\bdelivery_rate ([\d.]+[KMG]?bps)/))) cur.sendKbps = rate(m[1]);
  }
  return out;
}
function tcpStats() {
  return new Promise((resolve) => {
    if (ssMissing) return resolve(null);
    execFile('ss', ['-tinpH', 'state', 'established'], { timeout: 3000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) { if (err.code === 'ENOENT') ssMissing = true; return resolve(null); }
      resolve(parseSs(out));
    });
  });
}

// ---------- reachability ----------
/** DNS lookup + TCP connect, with times in ms. */
function reach(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    dns.lookup(host, { all: false }, (err, address) => {
      if (err) return resolve({ ok: false, host, port, error: 'Name not found (' + (err.code || err.message) + ')' });
      const t1 = Date.now();
      const sock = net.connect({ host: address, port });
      const done = (r) => { sock.destroy(); resolve(Object.assign({ host, port, address, dnsMs: t1 - t0 }, r)); };
      sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'No answer in ' + Math.round(timeoutMs / 1000) + ' s' }));
      sock.once('connect', () => done({ ok: true, connectMs: Date.now() - t1 }));
      sock.once('error', (e) => done({ ok: false, error: e.code === 'ECONNREFUSED' ? 'Refused' : (e.code || e.message) }));
    });
  });
}
/** host and port of an rtmp(s):// or srt:// URL. */
function hostPort(url) {
  try {
    const u = new URL(url);
    const def = { 'rtmp:': 1935, 'rtmps:': 443, 'srt:': 0, 'https:': 443, 'http:': 80 }[u.protocol];
    return { host: u.hostname, port: Number(u.port) || def || 0, udp: u.protocol === 'srt:' };
  } catch (e) { return null; }
}

module.exports = { createIfaceMeter, gateway, nameservers, parseProcNet, listeners, socketInodes, parseSs, tcpStats, tcpStatsAvailable: () => !ssMissing, reach, hostPort };
