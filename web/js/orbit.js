// SGP4 propagation and everything derived from it: positions, tracks, swaths, access windows.
/* global satellite */

import { DEG, R_EARTH, azimuth, offset, gcKm, cutDateline, continuous, sunAltitude, getJSON } from './util.js';

export const fleet = { sats: [], byId: new Map(), byFleet: new Map(), fetchedAt: null, stale: false };

const ABBR = [
  [/^SENTINEL-(\d)([A-D])$/, (m) => `S${m[1]}${m[2]}`],
  [/^LANDSAT (\d)$/, (m) => `L${m[1]}`],
  [/^NOAA (\d+).*$/, (m) => `N${m[1]}`],
  [/^SUOMI NPP$/, () => 'SNPP'],
  [/^WORLDVIEW-(\d).*$/, (m) => `WV${m[1]}`],
  [/^GEOEYE 1$/, () => 'GE1'],
  [/^LEGION (\d)$/, (m) => `LGN${m[1]}`],
  [/^PLEIADES NEO (\d)$/, (m) => `PNEO${m[1]}`],
  [/^PLEIADES (\w+)$/, (m) => `PHR${m[1]}`],
  [/^SPOT (\d)$/, (m) => `SPOT${m[1]}`],
  [/^COSMO-SKYMED (\d)$/, (m) => `CSK${m[1]}`],
  [/^CSG-(\d)$/, (m) => `CSG${m[1]}`],
  [/^ICEYE-(\w+)$/, (m) => `IX${m[1].replace(/^X/, '')}`],
  [/^CAPELLA-(\d+).*$/, (m) => `CAP${m[1]}`],
  [/^UMBRA-(\d+)$/, (m) => `UMB${m[1]}`],
  [/^TERRASAR-X$/, () => 'TSX'],
  [/^TANDEM-X$/, () => 'TDX'],
  [/^RADARSAT-2$/, () => 'RS2'],
  [/^SKYSAT-(\w+)$/, (m) => `SS${m[1]}`],
  [/^GAOFEN-(.+)$/, (m) => `GF${m[1].replace(/\s+/g, '-')}`],
  [/^JILIN-1 ?(.*)$/, (m) => `JL1${m[1] ? '-' + m[1].replace(/\s+/g, '') : ''}`],
  [/^QPS-SAR-(\d+).*$/, (m) => `QPS${m[1]}`],
  [/^(.+?) \(.*\)$/, (m) => m[1]],
];
const abbr = (name) => { for (const [re, f] of ABBR) { const m = name.match(re); if (m) return f(m); } return name; };

export async function loadElements() {
  const data = await getJSON('/api/tle');
  fleet.sats = []; fleet.byId.clear(); fleet.byFleet.clear();
  for (const s of data.sats) {
    let rec;
    try { rec = satellite.twoline2satrec(s.l1, s.l2); } catch { continue; }
    if (!rec || rec.error) continue;
    const yr = rec.epochyr < 57 ? 2000 + rec.epochyr : 1900 + rec.epochyr;
    const sat = {
      id: s.norad, name: s.name, short: abbr(s.name), fid: s.f, rec,
      periodMin: (2 * Math.PI) / rec.no, incl: rec.inclo * DEG,
      epoch: Date.UTC(yr, 0, 1) + (rec.epochdays - 1) * 86400000,
    };
    if (!where(sat, Date.now())) continue;
    fleet.sats.push(sat);
    fleet.byId.set(sat.id, sat);
    if (!fleet.byFleet.has(sat.fid)) fleet.byFleet.set(sat.fid, []);
    fleet.byFleet.get(sat.fid).push(sat);
  }
  for (const list of fleet.byFleet.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  fleet.fetchedAt = Date.parse(data.fetchedAt);
  fleet.stale = !!data.stale;
  return fleet;
}

/** Sub-satellite point. null when propagation fails (decayed elements). */
export function where(sat, ms) {
  const d = new Date(ms);
  const pv = satellite.propagate(sat.rec, d);
  if (!pv || !pv.position || Number.isNaN(pv.position.x)) return null;
  const g = satellite.eciToGeodetic(pv.position, satellite.gstime(d));
  const v = pv.velocity;
  return { lon: g.longitude * DEG, lat: g.latitude * DEG, alt: g.height, vel: v ? Math.hypot(v.x, v.y, v.z) : 0 };
}

export function heading(sat, ms, here) {
  const a = here || where(sat, ms), b = where(sat, ms + 2000);
  return a && b ? azimuth([a.lon, a.lat], [b.lon, b.lat]) : 0;
}

/** In sunlight: above the horizon at the sub-point or high enough to see over the limb. */
export function lit(sat, ms, here) {
  const p = here || where(sat, ms);
  if (!p) return true;
  const el = sunAltitude([p.lon, p.lat], ms);
  return el >= 0 || -el < Math.acos(R_EARTH / (R_EARTH + p.alt)) * DEG;
}

export function track(sat, t0, t1, step = 20000) {
  const pts = [];
  for (let t = t0; t <= t1; t += step) { const p = where(sat, t); if (p) pts.push([p.lon, p.lat]); }
  return cutDateline(pts);
}

/** Cross-track reach of the sensor from the current position, as [from, to] ground segments. */
export function reachBars(sat, g, ms) {
  const p = where(sat, ms);
  if (!p) return [];
  const here = [p.lon, p.lat], h = heading(sat, ms, p), R = h + 90, L = h - 90;
  if (g.mode === 'nadir') return [[offset(here, L, g.swathKm / 2), offset(here, R, g.swathKm / 2)]];
  if (g.mode === 'side') { const d = g.side === 'left' ? L : R; return [[offset(here, d, g.nearKm), offset(here, d, g.farKm)]]; }
  if (g.minKm) return [[offset(here, L, g.reachKm), offset(here, L, g.minKm)], [offset(here, R, g.minKm), offset(here, R, g.reachKm)]];
  return [[offset(here, L, g.reachKm), offset(here, R, g.reachKm)]];
}

/** Strip polygon swept by a swath [nearKm, farKm] (km right of track) between two times. */
export function strip(sat, t0, t1, near, far, step = 15000) {
  const a = [], b = [];
  for (let t = t0; t <= t1 + 1; t += step) {
    const p = where(sat, t);
    if (!p) continue;
    const here = [p.lon, p.lat], R = heading(sat, t, p) + 90;
    a.push(offset(here, R, near));
    b.push(offset(here, R, far));
  }
  if (a.length < 2) return null;
  return { type: 'Polygon', coordinates: [continuous([...a, ...b.reverse(), a[0]])] };
}

export function fixedSwath(g) {
  if (g.mode === 'nadir') return [-g.swathKm / 2, g.swathKm / 2];
  if (g.mode === 'side') return g.side === 'left' ? [-g.farKm, -g.nearKm] : [g.nearKm, g.farKm];
  return null;
}

export function closest(sat, target, t0, t1) {
  let best = null;
  const scan = (a, b, step) => {
    for (let t = a; t <= b; t += step) {
      const p = where(sat, t);
      if (!p) continue;
      const d = gcKm([p.lon, p.lat], target);
      if (!best || d < best.km) best = { t, km: d, p };
    }
  };
  scan(t0, t1, Math.max(2000, Math.min(20000, (t1 - t0) / 60)));
  if (best) scan(Math.max(t0, best.t - 20000), Math.min(t1, best.t + 20000), 1000);
  return best;
}

const idle = () => new Promise((r) => setTimeout(r));

/**
 * Every time a fleet's sensor geometry can reach the target in [t0, t1].
 * Cooperative: yields to the UI. `limit` stops each satellite after N hits.
 */
export async function accessWindows(sats, g, target, t0, t1, { onProgress, limit = Infinity, signal } = {}) {
  const out = [];
  const STEP = 60000;
  const reach = g.mode === 'nadir' ? g.swathKm / 2 : g.mode === 'side' ? g.farKm : g.reachKm;
  const gate = reach + 520;
  let done = 0;
  for (const sat of sats) {
    let t = t0, hits = 0, mark = performance.now();
    while (t <= t1 && hits < limit) {
      if (signal && signal.aborted) return out;
      const p = where(sat, t);
      if (p && gcKm([p.lon, p.lat], target) < gate) {
        const ca = closest(sat, target, t - STEP, t + Math.max(4 * STEP, (gate / 6.5) * 1000));
        if (ca && ca.t >= t0 && ca.t <= t1) {
          const sub = [ca.p.lon, ca.p.lat], h = heading(sat, ca.t, ca.p);
          const rel = ((azimuth(sub, target) - h + 540) % 360) - 180;
          const cross = ca.km * (rel >= 0 ? 1 : -1);
          const fx = fixedSwath(g);
          const ok = fx ? cross >= fx[0] && cross <= fx[1] : ca.km <= g.reachKm && ca.km >= (g.minKm || 0);
          const sun = sunAltitude(target, ca.t);
          if (ok && (!g.daylight || sun > 3)) {
            const half = g.swathKm / 2;
            const sw = fx || [cross - half, cross + half];
            const nxt = where(sat, ca.t + 10000);
            out.push({
              sat, time: ca.t, crossKm: cross, sun, km: ca.km,
              offNadir: Math.atan2(ca.km, ca.p.alt) * DEG,
              asc: nxt ? nxt.lat > ca.p.lat : false,
              geometry: strip(sat, ca.t - 60000, ca.t + 60000, sw[0], sw[1]),
            });
            hits += 1;
          }
        }
        t += 12 * STEP;
      } else t += STEP;
      if (performance.now() - mark > 20) { await idle(); mark = performance.now(); }
    }
    done += 1;
    if (onProgress) onProgress(done / sats.length);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Match a catalogue platform label (S2B, sentinel-1c, landsat-9) to a tracked satellite. */
export function platform(label) {
  if (!label) return null;
  let key = String(label).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = key.match(/^S([1-6])([A-D])$/);
  if (m) key = `SENTINEL${m[1]}${m[2]}`;
  return fleet.sats.find((s) => s.name.toUpperCase().replace(/[^A-Z0-9]/g, '') === key) || null;
}
export function platformShort(label) {
  const s = platform(label);
  return s ? s.short : String(label || '?').toUpperCase().replace(/^SENTINEL-?/, 'S').replace(/^LANDSAT-?/, 'L');
}
