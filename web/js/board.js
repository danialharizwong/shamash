// Per-frame plotting: satellite positions, phosphor persistence trails, tracks, swaths.

import { S, clock, emit } from './state.js';
import { map, setData, fc, drawSun } from './map.js';
import { fleet, where, lit, track, reachBars, strip, fixedSwath } from './orbit.js';
import { cutDateline, MIN } from './util.js';

const TRAIL_MIN = 9;          // minutes of afterglow behind each satellite
const TRAIL_SEG = 6;

let lastSlow = 0, lastSun = 0, lastFast = 0;
let positions = new Map();    // norad -> {lon, lat, alt, vel, lit}

export const pos = (id) => positions.get(id);

/** Fast tick (~5 Hz): sat dots, reach bars, lock marker. */
function fast(now) {
  const feats = [], next = new Map();
  for (const sat of fleet.sats) {
    if (!S.visible.has(sat.fid)) continue;
    const p = where(sat, now);
    if (!p) continue;
    p.lit = lit(sat, now, p);
    next.set(sat.id, p);
    const fl = S.fleets.get(sat.fid);
    feats.push({ type: 'Feature', id: sat.id, properties: { id: sat.id, fid: sat.fid, short: sat.short, color: fl.color, sel: sat.fid === S.selected || sat.id === S.sat, lit: p.lit },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
  }
  positions = next;
  setData('sats', fc(feats));

  const bars = [];
  const fl = S.selected && S.fleets.get(S.selected);
  if (fl && fl.geom) {
    for (const sat of fleet.byFleet.get(fl.id) || []) {
      for (const [a, b] of reachBars(sat, fl.geom, now)) {
        for (const seg of cutDateline([a, b])) bars.push({ type: 'Feature', properties: { color: fl.color }, geometry: { type: 'LineString', coordinates: seg } });
      }
    }
  }
  setData('reach', fc(bars));

  const s = S.sat && fleet.byId.get(S.sat);
  const p = s && positions.get(s.id);
  setData('lock', p ? fc([{ type: 'Feature', properties: { label: s.short }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }]) : null);
  if (p && S.follow && !map.isMoving()) map.easeTo({ center: [p.lon, p.lat], duration: 250, easing: (t) => t });
  emit('tick', now);
}

/** Slow tick (~1 Hz): afterglow trails. Each trail is cut in segments that fade with age. */
function trails(now) {
  const feats = [];
  const step = (TRAIL_MIN * MIN) / TRAIL_SEG;
  for (const sat of fleet.sats) {
    if (!S.visible.has(sat.fid)) continue;
    const fl = S.fleets.get(sat.fid), sel = sat.fid === S.selected || sat.id === S.sat;
    for (let i = 0; i < TRAIL_SEG; i++) {
      const t1 = now - i * step, t0 = t1 - step;
      const pts = [];
      for (let t = t0; t <= t1 + 1; t += step / 4) { const p = where(sat, t); if (p) pts.push([p.lon, p.lat]); }
      const a = (sel ? 0.85 : 0.5) * (1 - i / TRAIL_SEG) ** 1.6;
      for (const seg of cutDateline(pts)) feats.push({ type: 'Feature', properties: { color: fl.color, a, sel }, geometry: { type: 'LineString', coordinates: seg } });
    }
  }
  setData('trails', fc(feats));
}

/** Selected fleet: ground tracks (past half orbit, next orbit) and the next 20 minutes of swath. */
export function drawTracks() {
  const now = clock.now(), feats = [], sw = [];
  const fl = S.selected && S.fleets.get(S.selected);
  const sats = new Set(fl ? fleet.byFleet.get(fl.id) || [] : []);
  if (S.sat && fleet.byId.get(S.sat)) sats.add(fleet.byId.get(S.sat));
  const many = sats.size > 12;
  for (const sat of sats) {
    const color = S.fleets.get(sat.fid).color, per = sat.periodMin * MIN;
    const focus = sat.id === S.sat || !many;
    if (!focus && !many) continue;
    const fwd = focus ? per : per * 0.25;
    for (const c of track(sat, now - per * 0.5 * (focus ? 1 : 0.2), now)) feats.push({ type: 'Feature', properties: { p: 1, color }, geometry: { type: 'LineString', coordinates: c } });
    for (const c of track(sat, now, now + fwd)) feats.push({ type: 'Feature', properties: { p: 0, color }, geometry: { type: 'LineString', coordinates: c } });
    const g = S.fleets.get(sat.fid).geom, fx = g && fixedSwath(g);
    if (fx && focus) {
      for (let k = 0; k < 4; k++) {                    // 4 x 5-minute strips keep polygons small and dateline-safe
        const geom = strip(sat, now + k * 5 * MIN, now + (k + 1) * 5 * MIN, fx[0], fx[1], 20000);
        if (geom) sw.push({ type: 'Feature', properties: { color }, geometry: geom });
      }
    }
  }
  setData('tracks', fc(feats));
  setData('swath', fc(sw));
}

export function frame() {
  const now = clock.now(), t = performance.now();
  if (t - lastFast > 200) { lastFast = t; fast(now); }
  if (t - lastSlow > 1000 * Math.max(0.25, 1 / Math.sqrt(clock.rate))) { lastSlow = t; trails(now); }
  if (t - lastSun > (clock.rate > 1 ? 1000 : 20000)) { lastSun = t; drawSun(now, S.night); }
  requestAnimationFrame(frame);
}

export function refreshNow() { lastFast = lastSlow = lastSun = 0; drawTracks(); }

let trackTimer = null;
export function startTracks() {
  clearInterval(trackTimer);
  drawTracks();
  trackTimer = setInterval(drawTracks, 15000);
}
