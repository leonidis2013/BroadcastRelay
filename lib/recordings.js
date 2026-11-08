/*
 * Recordings of the raw incoming feed. MediaMTX writes them (fragmented MP4, so a file
 * is playable even if the power goes out mid-recording) and deletes them after the
 * "keep" days. This module lists them, enforces the size limit and serves downloads.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const NAME = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(?:-(\d+))?\.(mp4|ts)$/;

function list(dir) {
  const out = [];
  const walk = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (rel.split('/').length < 3) walk(p, r); continue; }
      const m = NAME.exec(e.name);
      if (!m) continue;
      let st; try { st = fs.statSync(p); } catch (x) { continue; }
      const start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      out.push({ id: r, name: e.name, size: st.size, start, end: st.mtimeMs, active: Date.now() - st.mtimeMs < 5000 });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => b.start - a.start);
}

/** Resolve a recording id to a path inside dir, or null. */
function resolve(dir, id) {
  id = String(id || '');
  if (!id || id.includes('\0') || !NAME.test(path.basename(id))) return null;
  const p = path.resolve(dir, id);
  if (!p.startsWith(path.resolve(dir) + path.sep)) return null;
  try { return fs.statSync(p).isFile() ? p : null; } catch (e) { return null; }
}

function remove(dir, id) {
  const p = resolve(dir, id);
  if (!p) return false;
  fs.unlinkSync(p);
  return true;
}

/** Delete the oldest finished recordings until the folder is under maxBytes. Returns how many were deleted. */
function enforceLimit(dir, maxBytes) {
  if (!(maxBytes > 0)) return 0;
  const all = list(dir);
  let total = all.reduce((a, r) => a + r.size, 0), n = 0;
  for (const r of all.slice().reverse()) {
    if (total <= maxBytes) break;
    if (r.active) continue;
    try { fs.unlinkSync(path.join(dir, r.id)); total -= r.size; n++; } catch (e) { /* in use or gone */ }
  }
  return n;
}

function writable(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return true; } catch (e) { return false; }
}

module.exports = { list, resolve, remove, enforceLimit, writable };
