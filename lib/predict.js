/*
 * Stream info memory: what was streamed before, and a guess for the next stream.
 *
 * History entries: { id, t, day (0-6), hour (decimal), presetId, format, title, series, part, sermon, speaker, autoPart, minutes }
 * The guess looks at earlier streams on the same weekday around the same time (else the same weekday,
 * else the last stream): the usual format and speaker, the series that slot was in with its next part,
 * and, for a second service on the same day, the same part and sermon again.
 */
'use strict';

const DAY_MS = 86400000;
const sameDate = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
const low = (s) => String(s || '').trim().toLowerCase();

/** Most common value, ties go to the most recent. list is oldest first. */
function mode(list) {
  const n = new Map();
  list.forEach((v, i) => { if (v === '' || v == null) return; const k = low(v); const e = n.get(k) || { v, c: 0, last: 0 }; e.c++; e.last = i; e.v = v; n.set(k, e); });
  let best = null;
  for (const e of n.values()) if (!best || e.c > best.c || (e.c === best.c && e.last > best.last)) best = e;
  return best ? best.v : '';
}

/** Per series: name, last part, when, last sermon, usual speaker, how many streams. */
function seriesInfo(history) {
  const out = {};
  for (const h of history) {
    if (!h.series) continue;
    const k = low(h.series);
    const e = out[k] || (out[k] = { name: h.series, lastPart: 0, lastT: 0, lastSermon: '', speakers: [], count: 0, dates: new Set(), twiceADay: false });
    e.count++;
    const dk = new Date(h.t).toDateString();
    if (e.dates.has(dk)) e.twiceADay = true; // this series has had two services on one day
    e.dates.add(dk);
    if (h.t >= e.lastT) { e.lastT = h.t; e.name = h.series; e.lastSermon = h.sermon || ''; }
    if (Number(h.part) > e.lastPart) e.lastPart = Number(h.part);
    if (h.speaker) e.speakers.push(h.speaker);
  }
  for (const e of Object.values(out)) { e.speaker = mode(e.speakers.slice(-6)); delete e.speakers; delete e.dates; }
  return out;
}

/**
 * The part to use next for a series at time now: one more than last time, or the same part again later the
 * same day when this series has had two services on one day before (a second service repeats the sermon).
 */
function nextPart(info, now) {
  if (!info || !(info.lastPart > 0)) return 0;
  return info.twiceADay && sameDate(info.lastT, now) ? info.lastPart : info.lastPart + 1;
}

/**
 * Guess the details for a stream at time `now`. presetIds: formats that still exist.
 * Returns null without history, else { presetId, series, part, sermon, speaker, autoPart, basis, count }.
 */
function predict(history, now, presetIds) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const d = new Date(t), day = d.getDay(), hr = d.getHours() + d.getMinutes() / 60;
  const valid = history.filter((h) => h && h.t < t).sort((a, b) => a.t - b.t);
  if (!valid.length) return null;
  let cands = valid.filter((h) => h.day === day && Math.abs(h.hour - hr) <= 3), basis = 'time';
  if (!cands.length) { cands = valid.filter((h) => h.day === day); basis = 'day'; }
  if (!cands.length) { cands = valid.slice(-1); basis = 'last'; }
  cands = cands.slice(-6);
  const recent = cands[cands.length - 1];
  const fmt = mode(cands.map((c) => c.presetId).filter((id) => !presetIds || presetIds.includes(id)));
  // the series this slot was in, if it was recent enough to still be running
  const series = recent.series && t - recent.t < 70 * DAY_MS ? recent.series : '';
  const info = series ? seriesInfo(valid)[low(series)] : null;
  const again = info && info.twiceADay && sameDate(info.lastT, t); // second service of the day
  return {
    presetId: fmt || '',
    series: info ? info.name : '',
    part: nextPart(info, t),
    sermon: again ? info.lastSermon : '',
    speaker: (info && info.speaker) || mode(cands.map((c) => c.speaker)),
    autoPart: recent.autoPart !== false,
    basis, count: cands.length
  };
}

module.exports = { predict, seriesInfo, nextPart, mode, sameDate };
