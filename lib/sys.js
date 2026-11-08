/*
 * CPU, memory and disk numbers for the status bar, read straight from /proc (Linux).
 * CPU is reported like `top`: 100% = one core. totalPct is for the whole machine, 0-100%.
 */
'use strict';
const fs = require('fs');
const os = require('os');

const TICK = 100; // USER_HZ on every Linux we care about

function readStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = line[3] + (line[4] || 0);
    const total = line.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch (e) { return null; }
}
function pidTicks(pid) {
  try {
    const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]); // utime + stime
  } catch (e) { return null; }
}

function create() {
  let last = readStat(), lastAt = Date.now();
  const pidLast = new Map();
  let totalPct = null;

  /** Call about once a second. */
  function sample() {
    const now = readStat();
    if (now && last) {
      const dt = now.total - last.total, di = now.idle - last.idle;
      totalPct = dt > 0 ? Math.max(0, Math.min(100, Math.round(1000 * (1 - di / dt)) / 10)) : totalPct;
    }
    last = now; lastAt = Date.now();
    return totalPct;
  }
  /** % of one core used by a process since the last call for that pid. */
  function pidPct(pid) {
    if (!pid) return null;
    const t = pidTicks(pid), at = Date.now();
    if (t == null) { pidLast.delete(pid); return null; }
    const prev = pidLast.get(pid);
    pidLast.set(pid, { t, at });
    if (!prev || at <= prev.at) return null;
    return Math.round((1000 * (t - prev.t) / TICK) / ((at - prev.at) / 1000)) / 10;
  }
  function disk(dir) {
    try {
      const s = fs.statfsSync(dir);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch (e) { return null; }
  }
  return {
    sample, pidPct, disk,
    cores: () => os.cpus().length,
    cpuModel: () => (os.cpus()[0] || {}).model || '',
    totalPct: () => totalPct,
    mem: () => ({ total: os.totalmem(), free: os.freemem() }),
    lastAt: () => lastAt
  };
}

module.exports = { create };
