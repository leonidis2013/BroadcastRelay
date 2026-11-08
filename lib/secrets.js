/*
 * Stream keys, platform tokens and the Companion API token are stored encrypted (AES-256-GCM).
 *
 * Where the key lives:
 *  - By default in the data folder (secret.key). That keeps tokens out of casual view
 *    (backups, screenshots of the file), but anyone with the whole data folder can
 *    decrypt them.
 *  - If BROADCASTRELAY_MASTER_KEY is set (in the app's environment, not on the volume), the
 *    key is derived from it with scrypt. Then a copy of the data folder alone is useless.
 *    Values saved with the old file key are re-encrypted and secret.key is deleted.
 *
 * enc1: = file key, enc2: = master key.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHECK = 'broadcastrelay-key-check';

function create(keyFile, opts = {}) {
  const master = String(opts.masterKey || '').trim();
  let fileKey = null, envKey = null;

  function loadFileKey(createIfMissing) {
    if (fileKey) return fileKey;
    try { fileKey = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); } catch (e) { fileKey = null; }
    if ((!fileKey || fileKey.length !== 32) && createIfMissing) {
      fileKey = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, fileKey.toString('hex') + '\n', { mode: 0o600 });
    }
    return fileKey && fileKey.length === 32 ? fileKey : null;
  }
  function loadEnvKey() {
    if (envKey || !master) return envKey;
    const saltFile = keyFile + '.salt';
    let salt;
    try { salt = Buffer.from(fs.readFileSync(saltFile, 'utf8').trim(), 'hex'); } catch (e) { salt = null; }
    if (!salt || salt.length !== 16) {
      salt = crypto.randomBytes(16);
      fs.mkdirSync(path.dirname(saltFile), { recursive: true });
      fs.writeFileSync(saltFile, salt.toString('hex') + '\n', { mode: 0o600 });
    }
    envKey = crypto.scryptSync(master, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return envKey;
  }

  function seal(key, prefix, text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return prefix + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  function open(key, blob) {
    const raw = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  function enc(text) {
    if (text == null || text === '') return '';
    return master ? seal(loadEnvKey(), 'enc2:', text) : seal(loadFileKey(true), 'enc1:', text);
  }
  function dec(blob) {
    if (!blob) return '';
    blob = String(blob);
    try {
      if (blob.startsWith('enc2:')) { const k = loadEnvKey(); return k ? open(k, blob.slice(5)) : ''; }
      if (blob.startsWith('enc1:')) { const k = loadFileKey(false); return k ? open(k, blob.slice(5)) : ''; }
    } catch (e) { return ''; }
    return blob; // plain text typed into the file by hand
  }

  /** A value that proves later that the same key is in use. */
  const makeCheck = () => enc(CHECK);
  const checkOk = (blob) => !blob || dec(blob) === CHECK;

  /** With a master key: re-encrypt file-key values, then delete secret.key. Returns the new values. */
  function migrate(values) {
    if (!master) return null;
    const out = {};
    let changed = false;
    for (const [k, v] of Object.entries(values)) {
      if (v && String(v).startsWith('enc1:')) { const plain = dec(v); out[k] = plain ? enc(plain) : ''; changed = true; }
      else out[k] = v;
    }
    return changed ? out : null;
  }
  function dropFileKey() { try { fs.unlinkSync(keyFile); fileKey = null; return true; } catch (e) { return false; } }

  return { enc, dec, makeCheck, checkOk, migrate, dropFileKey, where: () => (master ? 'master' : 'file'), hasFileKey: () => fs.existsSync(keyFile) };
}

module.exports = { create };
