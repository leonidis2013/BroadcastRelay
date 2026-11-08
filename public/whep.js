/*
 * Minimal WHEP player (WebRTC playback from MediaMTX), shared by the control page preview
 * and the watch page. whepPlay(video, url, onState) -> { stop() }
 * onState: 'connecting' | 'playing' | 'failed' | 'closed'
 */
(function () {
  function waitIce(pc, ms) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
    });
  }
  window.whepPlay = function (video, url, onState) {
    onState = onState || function () {};
    var pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    var session = null, closed = false, played = false;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    var stream = new MediaStream();
    pc.ontrack = function (e) {
      stream.addTrack(e.track);
      if (video.srcObject !== stream) video.srcObject = stream;
      var p = video.play(); if (p && p.catch) p.catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if (closed) return;
      if (pc.connectionState === 'connected' && !played) { played = true; onState('playing'); }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') { onState('failed'); stop(); }
    };
    onState('connecting');
    pc.createOffer()
      .then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { return waitIce(pc, 1500); })
      .then(function () { return fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp, credentials: 'same-origin' }); })
      .then(function (r) {
        if (r.status !== 201) throw new Error('HTTP ' + r.status);
        var loc = r.headers.get('location');
        if (loc) session = new URL(loc, location.href).href;
        return r.text();
      })
      .then(function (sdp) { if (!closed) return pc.setRemoteDescription({ type: 'answer', sdp: sdp }); })
      .catch(function () { if (!closed) { onState('failed'); stop(); } });
    // no media within 8 s (UDP blocked, e.g. through a tunnel): give up so the caller can fall back
    setTimeout(function () { if (!closed && !played) { onState('failed'); stop(); } }, 8000);
    function stop() {
      if (closed) return;
      closed = true;
      try { pc.close(); } catch (e) {}
      if (session) fetch(session, { method: 'DELETE', credentials: 'same-origin' }).catch(function () {});
      try { video.srcObject = null; } catch (e) {}
      onState('closed');
    }
    return { stop: stop };
  };
})();
