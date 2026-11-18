// LIVE basemap: the newest full-disc frames from the geostationary weather ring,
// draped on the globe and refreshed as new frames land.

import { S, on } from './state.js';
import { map } from './map.js';
import { lamp } from './ui.js';
import { el, $, getJSON, hm } from './util.js';

const EUM = 'https://view.eumetsat.int/geoserver/ows';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

const SRC = {
  ir: { kind: 'eum', layer: 'mumi:worldcloudmap_ir108', fmt: 'image/jpeg', label: 'GEO RING IR 10.8', every: '3 H' },
  nat: { kind: 'eum', layer: 'mumi:wideareacoverage_rgb_natural', fmt: 'image/jpeg', label: 'GEO RING NATURAL', every: '3 H' },
  mtg: { kind: 'eum', layer: 'mtg_fd:rgb_geocolour', fmt: 'image/png', label: 'METEOSAT-12 0°', every: '10 MIN' },
  hw: { kind: 'gibs', layer: 'Himawari_AHI_Band13_Clean_Infrared', level: 6, label: 'HIMAWARI 140.7°E IR', every: '10 MIN', bounds: [[60, -81, 180, 81], [-180, -81, -140, 81]] },
  gw: { kind: 'gibs', layer: 'GOES-West_ABI_GeoColor', level: 7, label: 'GOES-WEST 137°W', every: '10 MIN', bounds: [[-180, -81, -57, 81], [143, -81, 180, 81]] },
  ge: { kind: 'gibs', layer: 'GOES-East_ABI_GeoColor', level: 7, label: 'GOES-EAST 75°W', every: '10 MIN', bounds: [[-155, -81, 5, 81]] },
};

export const VARIANTS = {
  geocolour: { label: 'GEOCOLOUR', stack: ['ir', 'hw', 'gw', 'ge', 'mtg'], clock: ['hw', 'gw', 'ge', 'mtg'],
    note: 'True colour by day, IR by night over the Americas, Atlantic, Europe and Africa; 10-minute Himawari IR over Asia-Pacific.' },
  natural: { label: 'NATURAL', stack: ['nat'], clock: ['nat'], note: 'Daylight colour from the whole ring. Ice cloud cyan, vegetation green; night side black.' },
  infrared: { label: 'INFRARED', stack: ['ir', 'hw'], clock: ['ir', 'hw'], note: 'Thermal IR from the whole ring, day and night. Cold cloud tops bright.' },
};

let times = {}, current = null, timer = null, token = 0;

function tilesFor(key, t) {
  const d = SRC[key];
  if (d.kind === 'gibs') return [`${GIBS}/${d.layer}/default/default/GoogleMapsCompatible_Level${d.level}/{z}/{y}/{x}.png?f=${encodeURIComponent(t || Math.floor(Date.now() / 600000))}`];
  const q = `service=WMS&request=GetMap&version=1.3.0&layers=${d.layer}&styles=&format=${d.fmt}&transparent=true&crs=EPSG:3857&width=512&height=512`;
  return [`${EUM}?${q}&bbox={bbox-epsg-3857}${t ? `&time=${encodeURIComponent(t)}` : `&f=${Math.floor(Date.now() / 600000)}`}`];
}
const ids = (k) => (SRC[k].bounds || [null]).map((_, i) => `live-${k}${i ? `-${i}` : ''}`);

function clear() {
  for (const k of Object.keys(SRC)) for (const id of ids(k)) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
}
function add(v) {
  for (const k of VARIANTS[v].stack) {
    const d = SRC[k];
    ids(k).forEach((id, i) => {
      const s = { type: 'raster', tiles: tilesFor(k, times[k]), tileSize: d.kind === 'gibs' ? 256 : 512, maxzoom: d.kind === 'gibs' ? d.level : 6, attribution: d.kind === 'gibs' ? 'NOAA · JMA · NASA GIBS' : 'EUMETSAT' };
      if (d.bounds) s.bounds = d.bounds[i];
      map.addSource(id, s);
      map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-fade-duration': 300, 'raster-saturation': -0.15 } }, 'water');
    });
  }
}

async function refresh() {
  const mine = token;
  let res;
  try { res = await getJSON('/api/geo'); lamp('geo', 'ok', `GEO: checked ${hm(Date.parse(res.checkedAt))}`); } catch (e) { lamp('geo', 'err', `GEO: ${e.message}`); return; }
  if (mine !== token || !current) return;
  for (const k of VARIANTS[current].stack) {
    const t = (SRC[k].kind === 'gibs' ? res.gibs : res.eumetview)[SRC[k].layer];
    if (t && t !== times[k]) {
      times[k] = t;
      for (const id of ids(k)) map.getSource(id)?.setTiles(tilesFor(k, t));
    }
  }
  status();
}

function status() {
  if (!current) return;
  const v = VARIANTS[current];
  const stamps = v.clock.map((k) => times[k]).filter(Boolean).map(Date.parse);
  $('#ro-base').textContent = `LIVE ${v.label}${stamps.length ? ` · ${hm(Math.max(...stamps))}` : ''}`;
  $('#ro-base').title = v.stack.map((k) => `${SRC[k].label}: ${times[k] ? hm(Date.parse(times[k])) : 'LATEST'} (EVERY ${SRC[k].every})`).join('\n') + `\n\n${v.note}`;
}

export async function enable(v) {
  const mine = ++token;
  current = v;
  clear(); add(v); status();
  clearInterval(timer);
  timer = setInterval(refresh, 5 * 60000);
  if (mine === token) await refresh();
}
export function disable() { token += 1; current = null; clearInterval(timer); clear(); }

export function buildLive() {
  const sel = $('#live-variant');
  sel.replaceChildren(...Object.entries(VARIANTS).map(([k, v]) => el('option', { value: k, title: v.note }, v.label)));
  sel.value = S.liveVariant;
  sel.addEventListener('change', () => { S.liveVariant = sel.value; if (S.base === 'live') enable(sel.value); });
  on('base', (m) => { if (m === 'live') enable(S.liveVariant); else disable(); });
}
