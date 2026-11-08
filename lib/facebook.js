/*
 * Facebook Live on a Page, through the Graph API.
 *
 * Two ways to connect:
 *  - Facebook Login for Devices: the web page shows a code you enter at facebook.com/device.
 *    Needs a Meta app with "Login for Devices" turned on (app ID + client token).
 *    With the app secret too, the sign-in is swapped for a long-lived one, and the Page
 *    token that comes from it does not expire.
 *  - Paste a Page access token (from the Graph API Explorer) and the Page ID.
 *
 * Going live creates a live video on the Page (status LIVE_NOW) with your title, and streams
 * to the RTMPS address Facebook returns. Ending tells Facebook the video is over.
 */
'use strict';

const SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,publish_video';

function errText(j, res) {
  if (j && j.error) return (j.error.error_user_msg || j.error.message || 'Facebook error') + (j.error.code ? ' (code ' + j.error.code + ')' : '');
  return 'Facebook answered ' + (res ? res.status : 'nothing');
}

function create(opts) {
  // opts: { get: () => cfg.facebook (secrets decrypted), save: (patch) => void, fetch }
  const f = opts.fetch || fetch;
  let pending = null;
  const graph = () => 'https://graph.facebook.com/' + (/^v\d+\.\d+$/.test(opts.get().graphVersion || '') ? opts.get().graphVersion : 'v23.0');

  async function call(method, p, params) {
    const url = graph() + p;
    const body = new URLSearchParams(params || {}).toString();
    const res = method === 'GET'
      ? await f(url + (body ? '?' + body : ''))
      : await f(url, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    let j = null; try { j = await res.json(); } catch (e) { /* empty */ }
    return { res, j };
  }
  async function ok(method, p, params) {
    const { res, j } = await call(method, p, params);
    if (!res.ok || (j && j.error)) {
      if (j && j.error && (j.error.code === 190 || j.error.type === 'OAuthException') && /expired|session|validat/i.test(j.error.message || '')) opts.save({ needsReconnect: true });
      throw new Error(errText(j, res));
    }
    return j || {};
  }

  async function connectStart() {
    const c = opts.get();
    if (!c.appId || !c.clientToken) throw new Error('Enter the Meta app ID and client token first.');
    const { res, j } = await call('POST', '/device/login', { access_token: c.appId + '|' + c.clientToken, scope: SCOPES });
    if (!res.ok || !j || !j.code) throw new Error('Facebook refused the sign-in: ' + errText(j, res) + '. Is "Login for Devices" turned on for the app?');
    pending = { userCode: j.user_code, url: j.verification_uri || 'https://www.facebook.com/device', expires: Date.now() + (j.expires_in || 420) * 1000, error: '' };
    poll(j.code, Math.max(5, j.interval || 5), pending);
    return { userCode: pending.userCode, url: pending.url, expires: pending.expires };
  }

  async function poll(code, interval, mine) {
    while (pending === mine && Date.now() < mine.expires) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      if (pending !== mine) return;
      const c = opts.get();
      let r;
      try { r = await call('POST', '/device/login_status', { access_token: c.appId + '|' + c.clientToken, code }); } catch (e) { continue; }
      const { j } = r;
      if (j && j.error) {
        const sub = j.error.error_subcode;
        if (sub === 1349174 || j.error.code === 31) continue; // still waiting
        if (sub === 1349172) { interval += 5; continue; } // polling too often
        mine.error = errText(j); pending = null; opts.save({ connectError: mine.error }); return;
      }
      if (!j || !j.access_token) continue;
      pending = null;
      let user = j.access_token;
      if (c.appSecret) {
        try {
          const x = await ok('GET', '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: user });
          if (x.access_token) user = x.access_token;
        } catch (e) { /* keep the short-lived one */ }
      }
      opts.save({ userToken: user, needsReconnect: false, connectError: '' });
      try { await loadPages(); } catch (e) { opts.save({ pagesError: e.message }); }
      return;
    }
    if (pending === mine) { pending = null; opts.save({ connectError: 'The code expired before it was entered. Try again.' }); }
  }

  async function loadPages() {
    const c = opts.get();
    const j = await ok('GET', '/me/accounts', { fields: 'id,name,access_token', limit: '100', access_token: c.userToken });
    const pages = (j.data || []).map((p) => ({ id: p.id, name: p.name, token: p.access_token }));
    opts.save({ pages, pagesError: '' });
    if (pages.length === 1) choosePage(pages[0].id);
    return pages;
  }

  function choosePage(id) {
    const p = (opts.get().pages || []).find((x) => x.id === String(id));
    if (!p) throw new Error('That Page is not in the list. Connect again.');
    opts.save({ pageId: p.id, pageName: p.name, pageToken: p.token, needsReconnect: false });
  }

  /** Paste-a-token connection. */
  async function useToken(pageId, pageToken) {
    pageId = String(pageId || '').trim(); pageToken = String(pageToken || '').trim();
    if (!/^\d+$/.test(pageId) || !pageToken) throw new Error('Enter the numeric Page ID and a Page access token.');
    const j = await ok('GET', '/' + pageId, { fields: 'id,name', access_token: pageToken });
    opts.save({ pageId: j.id, pageName: j.name, pageToken, needsReconnect: false });
    return j.name;
  }

  function connectCancel() { pending = null; }
  function disconnect() { pending = null; opts.save({ userToken: '', pageToken: '', pageId: '', pageName: '', pages: [], needsReconnect: false }); }

  async function goLive(o) {
    const c = opts.get();
    if (!c.pageId || !c.pageToken) throw new Error('Facebook is not connected. Connect it under Settings > Facebook.');
    const v = await ok('POST', '/' + c.pageId + '/live_videos', {
      status: 'LIVE_NOW',
      title: String(o.title || 'Live').slice(0, 250),
      description: String(o.description || '').slice(0, 5000),
      access_token: c.pageToken
    });
    const url = v.secure_stream_url || v.stream_url;
    if (!url) throw new Error('Facebook did not return a stream address.');
    let watchUrl = '';
    try {
      const p = await ok('GET', '/' + v.id, { fields: 'permalink_url', access_token: c.pageToken });
      if (p.permalink_url) watchUrl = /^https?:/.test(p.permalink_url) ? p.permalink_url : 'https://www.facebook.com' + p.permalink_url;
    } catch (e) { /* not important */ }
    return { videoId: v.id, url, key: '', watchUrl };
  }

  async function end(videoId) {
    const c = opts.get();
    if (!videoId || !c.pageToken) return;
    await ok('POST', '/' + videoId, { end_live_video: 'true', access_token: c.pageToken });
  }

  return {
    connectStart, connectCancel, disconnect, loadPages, choosePage, useToken, goLive, end,
    pending: () => (pending ? { userCode: pending.userCode, url: pending.url, expires: pending.expires } : null),
    connected: () => !!(opts.get().pageId && opts.get().pageToken)
  };
}

module.exports = { create, SCOPES };
