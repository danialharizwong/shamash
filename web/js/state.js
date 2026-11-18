// Shared board state, the simulation clock and a tiny event bus.

const subs = new Map();
export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}
export function emit(evt, data) {
  for (const fn of subs.get(evt) || []) {
    try { fn(data); } catch (e) { console.error(`[${evt}]`, e); }
  }
}

export const S = {
  catalog: null,
  fleets: new Map(),          // id -> fleet definition
  visible: new Set(),         // fleet ids drawn on the globe
  selected: null,             // selected fleet id
  sat: null,                  // selected satellite (NORAD id)
  follow: false,
  target: null,               // [lon, lat] designated focus
  targetLabel: null,
  designating: false,
  base: 'vector',             // vector | imagery | live
  liveVariant: 'geocolour',
  grid: true,
  night: true,
  crt: true,
  scan: null,                 // { fleet, aoi, records[], ... }
  record: null,               // focused footprint record
  rendered: [],               // [{ id, rec, preset, quality }]
  gibs: null,                 // { fleet, layer, date }
  cloudMax: 40,
  lookbackDays: 30,
  aheadDays: 7,
};

// ------------------------------------------------------------------ clock

export const clock = {
  base: Date.now(),           // sim time at anchor
  anchor: performance.now(),
  rate: 1,
  live: true,
  now() { return this.base + (performance.now() - this.anchor) * this.rate; },
  set(ms) {
    this.base = ms; this.anchor = performance.now();
    this.live = this.rate === 1 && Math.abs(ms - Date.now()) < 1500;
    emit('clock', { jump: true });
  },
  jump(dms) { this.set(this.now() + dms); },
  setRate(r) { this.base = this.now(); this.anchor = performance.now(); this.rate = r; this.live = r === 1 && Math.abs(this.base - Date.now()) < 1500; emit('clock', { jump: false }); },
  goLive() { this.rate = 1; this.set(Date.now()); this.live = true; emit('clock', { jump: true }); },
};

// ------------------------------------------------------------------ shareable view (address bar)

export function readHash() {
  const out = {};
  for (const part of location.hash.replace(/^#/, '').split('&')) {
    const [k, v] = part.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return out;
}

let hashTimer = null;
export function writeHash(map) {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = map.getCenter();
    const parts = [`v=${c.lng.toFixed(3)},${c.lat.toFixed(3)},${map.getZoom().toFixed(2)}`];
    if (S.selected) parts.push(`f=${S.selected}`);
    if (S.target) parts.push(`t=${S.target[0].toFixed(4)},${S.target[1].toFixed(4)}`);
    if (S.base !== 'vector') parts.push(`b=${S.base}`);
    if (!clock.live) parts.push(`at=${Math.round(clock.now() / 1000)}`);
    history.replaceState(null, '', `#${parts.join('&')}`);
  }, 400);
}
