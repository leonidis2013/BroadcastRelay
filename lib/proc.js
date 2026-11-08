/*
 * A supervised child process (ffmpeg, MediaMTX, ndi-bridge).
 *
 * States: off -> starting -> live -> (exits) -> retrying -> starting ...
 *                                            -> error (gave up, or not allowed to retry)
 * While it is wanted, a process that exits is restarted after 2, 4, 8 ... 30 seconds.
 * After a minute of running cleanly the wait goes back to 2 seconds.
 */
'use strict';
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { parseProgress } = require('./ffargs.js');

class Proc extends EventEmitter {
  /**
   * opts: { name, cmd, args: () => array (built fresh each start), env, progress: bool (ffmpeg -progress pipe:1),
   *         liveAfterMs: when no progress output, how long until it counts as live (default 3000),
   *         retry: bool (default true), maxRetries: Infinity, onStderrLine(line), onStdoutLine(line), spawn (tests) }
   */
  constructor(opts) {
    super();
    this.o = Object.assign({ retry: true, maxRetries: Infinity, liveAfterMs: 3000 }, opts);
    this.state = 'off';
    this.wanted = false;
    this.child = null;
    this.tail = [];
    this.stats = {};
    this.error = '';
    this.retries = 0;
    this.startedAt = null;
    this.liveAt = null;
    this.timer = null;
    this.backoff = 2000;
  }

  set(state, error) {
    if (error !== undefined) this.error = error;
    if (this.state === state && error === undefined) return;
    this.state = state;
    this.emit('state', state, this);
  }

  start() {
    this.wanted = true;
    this.retries = 0;
    this.backoff = 2000;
    this.error = '';
    if (!this.child) this.launch();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer); this.timer = null;
    const c = this.child;
    this.child = null; this.pid = null;
    clearTimeout(this.liveTimer);
    if (c) {
      try { c.kill('SIGTERM'); } catch (e) { /* gone */ }
      setTimeout(() => { if (c.exitCode === null && c.signalCode === null) try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 4000).unref();
    }
    this.set('off', '');
    this.stats = {};
  }

  /** Stop and start with fresh arguments (settings changed). */
  restart() {
    if (!this.wanted) return;
    const c = this.child;
    if (!c) return this.launch();
    this.restarting = true;
    try { c.kill('SIGTERM'); } catch (e) { /* gone */ }
  }

  launch() {
    clearTimeout(this.timer); this.timer = null;
    let args;
    try { args = this.o.args(); } catch (e) { this.wanted = false; this.set('error', e.message); return; }
    if (!args) { this.wanted = false; this.set('error', 'Nothing to run'); return; }
    this.tail = [];
    this.stats = {};
    this.startedAt = Date.now();
    this.liveAt = null;
    this.set('starting');
    const sp = this.o.spawn || spawn;
    let child;
    try { child = sp(this.o.cmd, args, { env: Object.assign({}, process.env, (typeof this.o.env === 'function' ? this.o.env() : this.o.env) || {}), stdio: ['ignore', 'pipe', 'pipe'], cwd: this.o.cwd || undefined }); }
    catch (e) { this.onExit(null, e.message); return; }
    this.child = child;
    this.pid = child.pid;
    this.emit('spawn', child, args);

    let outBuf = '', errBuf = '';
    child.stdout.on('data', (d) => {
      outBuf += d;
      if (this.o.progress) {
        let i;
        while ((i = outBuf.search(/progress=(continue|end)\n/)) >= 0) {
          const end = outBuf.indexOf('\n', i) + 1;
          const p = parseProgress(outBuf.slice(0, end));
          outBuf = outBuf.slice(end);
          this.stats = Object.assign(this.stats, p);
          if (!this.liveAt && (p.frame > 0 || p.outTime > 0)) this.goLive();
        }
        if (outBuf.length > 65536) outBuf = '';
      } else {
        let i;
        while ((i = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
          if (this.o.onStdoutLine) this.o.onStdoutLine(line, this);
        }
      }
    });
    child.stderr.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.search(/[\r\n]/)) >= 0) {
        const line = errBuf.slice(0, i); errBuf = errBuf.slice(i + 1);
        if (!line.trim()) continue;
        if (this.o.onStderrLine && this.o.onStderrLine(line, this) === false) continue;
        this.tail.push(line);
        if (this.tail.length > 30) this.tail.shift();
      }
      if (errBuf.length > 65536) errBuf = '';
    });
    child.on('error', (e) => { this.tail.push(e.message); });
    child.on('exit', (code, sig) => { if (this.child === child) this.onExit(code, sig); else this.emit('exit', code, sig, this); });
    if (!this.o.progress) {
      this.liveTimer = setTimeout(() => { if (this.child === child && !this.liveAt) this.goLive(); }, this.o.liveAfterMs);
      this.liveTimer.unref && this.liveTimer.unref();
    }
  }

  goLive() {
    this.liveAt = Date.now();
    this.set('live', '');
  }

  onExit(code, sig) {
    clearTimeout(this.liveTimer);
    const ranFor = this.startedAt ? Date.now() - this.startedAt : 0;
    this.child = null;
    this.pid = null;
    this.stats = {};
    this.emit('exit', code, sig, this);
    if (this.restarting) { this.restarting = false; if (this.wanted) return this.launch(); }
    if (!this.wanted) { this.set('off'); return; }
    const why = lastUseful(this.tail) || ('stopped (' + (sig || 'exit code ' + code) + ')');
    if (!this.o.retry || this.retries >= this.o.maxRetries) { this.wanted = false; this.set('error', why); return; }
    if (ranFor > 60000) { this.backoff = 2000; this.retries = 0; }
    this.retries++;
    this.error = why;
    this.set('retrying', why);
    this.retryAt = Date.now() + this.backoff;
    this.timer = setTimeout(() => { this.timer = null; if (this.wanted) this.launch(); }, this.backoff);
    this.timer.unref && this.timer.unref();
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  info() {
    return {
      state: this.state, error: this.error, retries: this.retries,
      retryIn: this.state === 'retrying' && this.retryAt ? Math.max(0, Math.round((this.retryAt - Date.now()) / 1000)) : null,
      since: this.liveAt, pid: this.pid || null, stats: this.stats, tail: this.tail.slice(-8)
    };
  }
}

/** The most useful line of an ffmpeg error tail. */
function lastUseful(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^\[[^\]]+\]\s*/, '').trim();
    if (!l || /^(Exiting normally|Conversion failed!|frame=|size=)/.test(l)) continue;
    return l.length > 220 ? l.slice(0, 220) + '…' : l;
  }
  return '';
}

module.exports = { Proc, lastUseful };
