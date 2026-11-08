/*
 * YouTube Live through the YouTube Data API v3.
 *
 * Sign-in uses Google's device flow ("TVs and Limited Input devices" OAuth client):
 * the web page shows a code, you enter it at google.com/device on any phone or computer.
 * No redirect URL is needed, so it works on a LAN address.
 *
 * Going live: one reusable stream (the RTMPS ingest address and key) is created once and
 * kept; each Go live creates a broadcast with your title, binds it to that stream and lets
 * YouTube start it automatically as soon as video arrives. It does not end on its own when the
 * feed drops for a moment (OBS restart); Stop or End completes the broadcast.
 */
'use strict';

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const OAUTH = 'https://oauth2.googleapis.com';
const API = 'https://www.googleapis.com/youtube/v3';

function errText(j, res) {
  if (j && j.error) {
    if (typeof j.error === 'string') return j.error_description || j.error;
    const reason = j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
    return (j.error.message || 'YouTube error') + (reason ? ' (' + reason + ')' : '');
  }
  return 'YouTube answered ' + (res ? res.status : 'nothing');
}

function create(opts) {
  // opts: { get: () => cfg.youtube (secrets decrypted), save: (patch) => void, fetch }
  const f = opts.fetch || fetch;
  let access = null, accessExp = 0;
  let pending = null; // { userCode, url, expires, error }

  async function form(url, params) {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    let j = null; try { j = await res.json(); } catch (e) { /* not json */ }
    return { res, j };
  }

  async function token() {
    const c = opts.get();
    if (!c.refreshToken) throw new Error('YouTube is not connected. Connect it under Settings > YouTube.');
    if (access && Date.now() < accessExp - 60000) return access;
    const { res, j } = await form(OAUTH + '/token', { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' });
    if (!res.ok || !j || !j.access_token) {
      if (j && j.error === 'invalid_grant') opts.save({ refreshToken: '', needsReconnect: true });
      throw new Error('YouTube sign-in failed: ' + errText(j, res) + '. Connect YouTube again.');
    }
    access = j.access_token; accessExp = Date.now() + (j.expires_in || 3600) * 1000;
    return access;
  }

  async function api(method, p, query, body) {
    const t = await token();
    const url = API + p + (query ? '?' + new URLSearchParams(query).toString() : '');
    const res = await f(url, { method, headers: Object.assign({ authorization: 'Bearer ' + t }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) throw new Error(errText(j, res));
    return j || {};
  }

  /** Start the device sign-in. Returns { userCode, url } to show on the page. */
  async function connectStart() {
    const c = opts.get();
    if (!c.clientId || !c.clientSecret) throw new Error('Enter the OAuth client ID and secret first.');
    const { res, j } = await form(OAUTH + '/device/code', { client_id: c.clientId, scope: SCOPE });
    if (!res.ok || !j || !j.device_code) throw new Error('Google refused the sign-in: ' + errText(j, res) + '. Is the client type "TVs and Limited Input devices"?');
    pending = { userCode: j.user_code, url: j.verification_url || j.verification_uri || 'https://www.google.com/device', expires: Date.now() + (j.expires_in || 1800) * 1000, error: '' };
    poll(j.device_code, Math.max(5, j.interval || 5), pending);
    return { userCode: pending.userCode, url: pending.url, expires: pending.expires };
  }

  async function poll(deviceCode, interval, mine) {
    while (pending === mine && Date.now() < mine.expires) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      if (pending !== mine) return;
      const c = opts.get();
      let r;
      try { r = await form(OAUTH + '/token', { client_id: c.clientId, client_secret: c.clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }); }
      catch (e) { continue; }
      const { res, j } = r;
      if (j && j.error === 'authorization_pending') continue;
      if (j && j.error === 'slow_down') { interval += 5; continue; }
      if (!res.ok || !j || !j.refresh_token) { mine.error = errText(j, res); pending = null; opts.save({ connectError: mine.error }); return; }
      access = j.access_token; accessExp = Date.now() + (j.expires_in || 3600) * 1000;
      opts.save({ refreshToken: j.refresh_token, needsReconnect: false, streamId: '', connectError: '' });
      pending = null;
      try {
        const ch = await api('GET', '/channels', { part: 'snippet', mine: 'true' });
        const it = ch.items && ch.items[0];
        opts.save({ channelId: it ? it.id : '', channelTitle: it ? it.snippet.title : '' });
      } catch (e) { opts.save({ channelTitle: '(channel name unavailable: ' + e.message + ')' }); }
      return;
    }
    if (pending === mine) { pending = null; opts.save({ connectError: 'The code expired before it was entered. Try again.' }); }
  }

  function connectCancel() { pending = null; }
  function disconnect() { pending = null; access = null; opts.save({ refreshToken: '', channelId: '', channelTitle: '', streamId: '', needsReconnect: false }); }

  /** The reusable ingest stream: { id, url, key } */
  async function ensureStream() {
    const c = opts.get();
    if (c.streamId) {
      const j = await api('GET', '/liveStreams', { part: 'cdn,status', id: c.streamId });
      const s = j.items && j.items[0];
      if (s) return streamOut(s);
    }
    const s = await api('POST', '/liveStreams', { part: 'snippet,cdn,contentDetails' }, {
      snippet: { title: 'BroadcastRelay' },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
      contentDetails: { isReusable: true }
    });
    opts.save({ streamId: s.id });
    return streamOut(s);
  }
  function streamOut(s) {
    const ii = (s.cdn && s.cdn.ingestionInfo) || {};
    return { id: s.id, url: ii.rtmpsIngestionAddress || ii.ingestionAddress, key: ii.streamName, health: s.status && s.status.healthStatus && s.status.healthStatus.status };
  }

  /** New broadcast bound to the stream; YouTube starts it when video arrives. */
  async function goLive(o) {
    const stream = await ensureStream();
    const privacy = ['public', 'unlisted', 'private'].includes(o.privacy) ? o.privacy : 'public';
    const b = await api('POST', '/liveBroadcasts', { part: 'snippet,status,contentDetails' }, {
      snippet: { title: String(o.title || 'Live').slice(0, 100), description: String(o.description || '').slice(0, 5000), scheduledStartTime: new Date().toISOString() },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: true, latencyPreference: o.latency === 'low' ? 'low' : 'normal', monitorStream: { enableMonitorStream: false } }
    });
    await api('POST', '/liveBroadcasts/bind', { id: b.id, part: 'id,contentDetails', streamId: stream.id });
    return { broadcastId: b.id, url: stream.url, key: stream.key, watchUrl: 'https://youtu.be/' + b.id };
  }

  async function end(broadcastId) {
    if (!broadcastId) return;
    try { await api('POST', '/liveBroadcasts/transition', { broadcastStatus: 'complete', id: broadcastId, part: 'status' }); }
    catch (e) { if (!/redundantTransition|invalidTransition/.test(e.message)) throw e; }
  }

  async function broadcastStatus(broadcastId) {
    const j = await api('GET', '/liveBroadcasts', { part: 'status', id: broadcastId });
    const b = j.items && j.items[0];
    return b ? b.status.lifeCycleStatus : null;
  }

  return {
    connectStart, connectCancel, disconnect, ensureStream, goLive, end, broadcastStatus,
    pending: () => (pending ? { userCode: pending.userCode, url: pending.url, expires: pending.expires } : null),
    connected: () => !!opts.get().refreshToken
  };
}

module.exports = { create, SCOPE };
