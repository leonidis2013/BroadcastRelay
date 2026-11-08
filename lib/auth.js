/*
 * Login for the control page (one password, set on first visit) and the token
 * Bitfocus Companion uses for the API. Sessions last 30 days and survive restarts.
 */
'use strict';
const crypto = require('crypto');

const DAY = 86400e3;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split(':');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
  return h.length === b.length && crypto.timingSafeEqual(h, b);
}
function safeEqual(a, b) {
  const x = Buffer.from(sha(a)), y = Buffer.from(sha(b));
  return crypto.timingSafeEqual(x, y) && String(a) === String(b);
}

/** Simple failure limiter: max attempts per window per key, then locked out for lockMs. */
function limiter({ max = 5, windowMs = 10 * 60e3, lockMs = 10 * 60e3 } = {}) {
  const m = new Map();
  return {
    blocked(key) { const e = m.get(key); return !!(e && e.lockUntil > Date.now()); },
    fail(key) {
      const now = Date.now();
      let e = m.get(key);
      if (!e || now - e.first > windowMs) e = { first: now, n: 0, lockUntil: 0 };
      e.n++;
      if (e.n >= max) e.lockUntil = now + lockMs;
      m.set(key, e);
      if (m.size > 5000) m.clear();
    },
    ok(key) { m.delete(key); }
  };
}

function parseCookies(h) {
  const out = {};
  String(h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

function create(opts) {
  // opts: { state: object persisted by the caller (state.sessions), saveState() }
  const st = opts.state;
  if (!st.sessions || typeof st.sessions !== 'object') st.sessions = {};
  const limit = limiter();
  const COOKIE = 'br_session';

  function prune() {
    const now = Date.now();
    for (const [k, v] of Object.entries(st.sessions)) if (v.exp < now) delete st.sessions[k];
  }
  function newSession() {
    prune();
    const t = crypto.randomBytes(32).toString('base64url');
    st.sessions[sha(t)] = { exp: Date.now() + 30 * DAY, at: Date.now() };
    opts.saveState();
    return t;
  }
  function sessionOk(req) {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (!t) return false;
    const s = st.sessions[sha(t)];
    if (!s || s.exp < Date.now()) return false;
    if (s.exp - Date.now() < 29 * DAY) { s.exp = Date.now() + 30 * DAY; opts.saveState(); }
    return true;
  }
  function endSession(req) {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t) { delete st.sessions[sha(t)]; opts.saveState(); }
  }
  function endAll() { st.sessions = {}; opts.saveState(); }
  const cookie = (t, secure) => COOKIE + '=' + encodeURIComponent(t) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (30 * 86400) + (secure ? '; Secure' : '');
  const clearCookie = () => COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

  return { newSession, sessionOk, endSession, endAll, cookie, clearCookie, limit };
}

module.exports = { create, hashPassword, checkPassword, safeEqual, limiter, parseCookies };
