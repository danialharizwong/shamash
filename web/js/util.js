// Geodesy, solar almanac, formatting and DOM helpers. Points are [lon, lat] degrees.

export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;
export const R_EARTH = 6371.0088;
export const DAY = 86400000;
export const HOUR = 3600000;
export const MIN = 60000;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const wrap180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

// ------------------------------------------------------------------ sphere

export function gcKm(a, b) {
  const f1 = a[1] * RAD, f2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  const h = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function azimuth(a, b) {
  const f1 = a[1] * RAD, f2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  return (Math.atan2(Math.sin(dl) * Math.cos(f2),
    Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * DEG + 360) % 360;
}

export function offset(p, brg, km) {
  const d = km / R_EARTH, t = brg * RAD, f1 = p[1] * RAD, l1 = p[0] * RAD;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return [wrap180(l2 * DEG), f2 * DEG];
}

/** Circle polygon ring around a point. */
export function circle(p, km, n = 72) {
  const ring = [];
  for (let i = 0; i <= n; i++) ring.push(offset(p, (i / n) * 360, km));
  return continuous(ring);
}

/** Break a polyline where it crosses the antimeridian. */
export function cutDateline(pts) {
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (cur.length) {
      const q = cur[cur.length - 1];
      const d = p[0] - q[0];
      if (Math.abs(d) > 180) {
        const s = d > 0 ? -1 : 1;
        const span = p[0] + s * 360 - q[0];
        const f = span ? (s * 180 - q[0]) / span : 0;
        const lat = q[1] + (p[1] - q[1]) * clamp(f, 0, 1);
        cur.push([s * 180, lat]);
        out.push(cur);
        cur = [[-s * 180, lat]];
      }
    }
    cur.push(p);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Make longitudes continuous so a ring survives the antimeridian. */
export function continuous(ring) {
  const out = [];
  let prev = null;
  for (const [x0, y] of ring) {
    let x = x0;
    if (prev !== null) {
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
    }
    out.push([x, y]);
    prev = x;
  }
  return out;
}

export function bbox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [w, s, e, n];
}

export function contains(geom, pt) {
  const inRing = (r, x, y) => {
    let hit = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const k of [0, -360, 360]) for (const p of polys) if (inRing(p[0], pt[0] + k, pt[1])) return true;
  return false;
}

// ------------------------------------------------------------------ sun (Shamash)

/** Sub-solar point, low-precision almanac (~0.01°). */
export function subsolar(ms) {
  const d = ms / DAY + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) * DEG;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) * DEG;
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  return [wrap180(ra - gmst * 15), dec];
}

export function sunAltitude(p, ms) {
  const [sl, sd] = subsolar(ms);
  const s = Math.sin(p[1] * RAD) * Math.sin(sd * RAD) + Math.cos(p[1] * RAD) * Math.cos(sd * RAD) * Math.cos((p[0] - sl) * RAD);
  return Math.asin(clamp(s, -1, 1)) * DEG;
}

/** Night hemisphere, optionally widened by a twilight depression angle (deg). */
export function nightRing(ms, depress = 0) {
  const [sl, sd0] = subsolar(ms);
  const sd = Math.abs(sd0) < 0.05 ? (sd0 < 0 ? -0.05 : 0.05) : sd0;
  const ring = [];
  const pole = sd > 0 ? -89.9 : 89.9;            // the pole in darkness
  for (let lon = -180; lon <= 180; lon += 2) {
    const H = (lon - sl) * RAD, d = sd * RAD;
    const term = Math.atan(-Math.cos(H) / Math.tan(d)) * DEG;
    let lat = term;
    if (depress) {
      // sin(lat)sin(d) + cos(lat)cos(d)cos(H) = sin(-depress): R cos(lat - f0) = s
      const A = Math.cos(d) * Math.cos(H), B = Math.sin(d);
      const R = Math.hypot(A, B), f0 = Math.atan2(B, A), s = Math.sin(-depress * RAD);
      if (Math.abs(s / R) <= 1) {
        const roots = [f0 + Math.acos(s / R), f0 - Math.acos(s / R)]
          .map((r) => Math.atan2(Math.sin(r), Math.cos(r)) * DEG)
          .filter((r) => r >= -90 && r <= 90);
        if (roots.length) lat = roots.reduce((a, b) => (Math.abs(a - term) < Math.abs(b - term) ? a : b));
      } else lat = -pole;
    }
    ring.push([lon, clamp(lat, -89.9, 89.9)]);
  }
  ring.push([180, pole], [-180, pole], ring[0]);
  return ring;
}

// ------------------------------------------------------------------ formatting

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function hms(ms) { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
export function hm(ms) { const d = new Date(ms); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; }
export function dmy(ms) { const d = new Date(ms); return `${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
export function dmon(ms) { const d = new Date(ms); return `${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]}`; }
export function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function isoZ(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }
/** Military date-time group: 181133ZNOV26 */
export function dtg(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
}
export function stamp(ms) { return `${dmon(ms)} ${hm(ms)}`; }

/** T-2D04H / T+00H35M relative to a reference. */
export function tminus(ms, ref) {
  const d = ms - ref, a = Math.abs(d), s = d < 0 ? '-' : '+';
  const D = Math.floor(a / DAY), H = Math.floor((a % DAY) / HOUR), M = Math.floor((a % HOUR) / MIN);
  return D > 0 ? `T${s}${D}D${pad(H)}H` : `T${s}${pad(H)}H${pad(M)}M`;
}
export function ago(ms, ref) {
  const a = Math.max(0, ref - ms);
  if (a < MIN) return 'NOW';
  if (a < HOUR) return `${Math.floor(a / MIN)}M AGO`;
  if (a < DAY) return `${Math.floor(a / HOUR)}H AGO`;
  return `${Math.floor(a / DAY)}D AGO`;
}

export const fmtLat = (y, dp = 3) => `${Math.abs(y).toFixed(dp).padStart(dp + 3, '0')}${y < 0 ? 'S' : 'N'}`;
export const fmtLon = (x, dp = 3) => { const l = wrap180(x); return `${Math.abs(l).toFixed(dp).padStart(dp + 4, '0')}${l < 0 ? 'W' : 'E'}`; };
export const fmtPos = (p, dp = 3) => `${fmtLat(p[1], dp)} ${fmtLon(p[0], dp)}`;

/** "48.5, 37.9" | "48.5N 37.9E" | "48°30'N 37°54'E" -> [lon, lat] */
export function parseLatLon(text) {
  const t = text.trim().toUpperCase().replace(/[′’']/g, "'").replace(/[″”"]/g, '"');
  const dms = t.match(/^(\d+)[°\s]+(\d+)?'?\s*(\d+(?:\.\d+)?)?"?\s*([NS])[\s,;]+(\d+)[°\s]+(\d+)?'?\s*(\d+(?:\.\d+)?)?"?\s*([EW])$/);
  if (dms) {
    let lat = +dms[1] + (+dms[2] || 0) / 60 + (+dms[3] || 0) / 3600;
    let lon = +dms[5] + (+dms[6] || 0) / 60 + (+dms[7] || 0) / 3600;
    if (dms[4] === 'S') lat = -lat;
    if (dms[8] === 'W') lon = -lon;
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
  }
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?[\s,;]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/);
  if (!m) return null;
  let lat = parseFloat(m[1]), lon = parseFloat(m[3]);
  if (m[2] === 'S') lat = -Math.abs(lat);
  if (m[4] === 'W') lon = -Math.abs(lon);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

// ------------------------------------------------------------------ DOM

export function el(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (cls.length) node.className = cls.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className += (node.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) node.style.setProperty(p, x);
      else if (k === 'data') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/** replaceChildren that skips null / false children (replaceChildren would print them). */
export function fill(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return node;
}

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function toast(msg, kind = '', ms = 3600) {
  const t = el('div.toast', { class: kind }, el('span.toast-k', null, kind === 'err' ? 'FAULT' : kind === 'warn' ? 'NOTE' : 'MSG'), msg);
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error((body && (body.error || body.detail || body.description)) || `HTTP ${r.status}`);
  return body;
}

export const postJSON = (url, data) => getJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** Debounce for UI events. */
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
