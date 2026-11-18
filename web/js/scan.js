// Footprint sources (acquired scenes, ESA tasking plans, geometric prediction)
// and the rendering presets for open imagery.

import { S, clock } from './state.js';
import { fleet, platform, platformShort, closest, accessWindows } from './orbit.js';
import { bbox, getJSON, isoZ, clamp } from './util.js';

export const PC = 'https://planetarycomputer.microsoft.com/api';
export const BOX_ZOOM = 5.5;

// ------------------------------------------------------------------ area of interest

export function aoiFor(map) {
  if (S.target) return { type: 'point', lon: S.target[0], lat: S.target[1] };
  if (map.getZoom() >= BOX_ZOOM) {
    const b = map.getBounds();
    const w = clamp(b.getWest(), -180, 180), e = clamp(b.getEast(), -180, 180);
    const s = clamp(b.getSouth(), -89, 89), n = clamp(b.getNorth(), -89, 89);
    if (e > w && n > s) return { type: 'box', bbox: [w, s, e, n].map((v) => +v.toFixed(4)) };
  }
  return { type: 'global' };
}
export function aoiCentre(aoi, map) {
  if (aoi.type === 'point') return [aoi.lon, aoi.lat];
  if (aoi.type === 'box') return [(aoi.bbox[0] + aoi.bbox[2]) / 2, (aoi.bbox[1] + aoi.bbox[3]) / 2];
  const c = map.getCenter();
  return [c.lng, c.lat];
}

// ------------------------------------------------------------------ acquired (STAC)

function scene(f, fl) {
  const p = f.properties;
  const t = Date.parse(p.start_datetime || p.datetime);
  const sub = [];
  if (fl.id === 'sentinel-2') sub.push(`T${p['s2:mgrs_tile']}`, `R${p['sat:relative_orbit']}`);
  if (fl.id === 'sentinel-1') sub.push(p['sar:instrument_mode'], (p['sar:polarizations'] || []).join('+'), (p['sat:orbit_state'] || '').slice(0, 3).toUpperCase(), `R${p['sat:relative_orbit']}`);
  if (fl.id === 'landsat') sub.push(`WRS ${p['landsat:wrs_path']}/${p['landsat:wrs_row']}`, p['landsat:collection_category']);
  const cc = p['eo:cloud_cover'];
  return {
    id: f.id, kind: 'scene', fid: fl.id, color: fl.color, collection: fl.archive.collection,
    platform: platformShort(p.platform), sat: platform(p.platform), time: t, end: p.end_datetime ? Date.parse(p.end_datetime) : t,
    geometry: f.geometry, bbox: f.bbox || bbox(f.geometry), cloud: typeof cc === 'number' ? cc : null,
    sub: sub.filter(Boolean), props: p,
  };
}

export async function searchScenes(fl, aoi, t0, t1, cloudMax, signal) {
  let body = {
    collections: [fl.archive.collection], datetime: `${isoZ(t0)}/${isoZ(t1)}`, limit: 100,
    fields: { exclude: ['links', 'assets'] }, sortby: [{ field: 'datetime', direction: 'desc' }],
  };
  if (aoi.type === 'point') body.intersects = { type: 'Point', coordinates: [aoi.lon, aoi.lat] };
  else if (aoi.type === 'box') body.bbox = aoi.bbox;
  const q = {};
  if (fl.archive.cloud && cloudMax < 100) q['eo:cloud_cover'] = { lte: cloudMax };
  if (fl.archive.platforms) q.platform = { in: fl.archive.platforms };
  if (Object.keys(q).length) body.query = q;
  const out = [];
  let truncated = false;
  for (let page = 0; page < 5 && body; page++) {
    const r = await getJSON(`${PC}/stac/v1/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    for (const f of r.features || []) out.push(scene(f, fl));
    const next = (r.links || []).find((l) => l.rel === 'next');
    body = next && next.body ? next.body : null;
    if (page === 4 && body) truncated = true;
  }
  return { records: out, truncated };
}

export const fetchItem = (rec, signal) => getJSON(`${PC}/stac/v1/collections/${rec.collection}/items/${encodeURIComponent(rec.id)}`, { signal });

// ------------------------------------------------------------------ tasking plans (ESA)

export async function fetchPlans(fl, aoi, t0, t1, map, signal) {
  const q = new URLSearchParams({ mission: fl.plan, start: Math.round(t0 / 1000), end: Math.round(t1 / 1000) });
  if (aoi.type === 'point') { q.set('lon', aoi.lon); q.set('lat', aoi.lat); }
  if (aoi.type === 'box') q.set('bbox', aoi.bbox.join(','));
  const r = await getJSON(`/api/plans?${q}`, { signal });
  const centre = aoi.type === 'global' ? null : aoiCentre(aoi, map);
  const now = clock.now();
  return {
    truncated: !!r.truncated,
    records: r.features.map((f) => {
      const p = f.properties, sat = platform(p.platform);
      const a = Date.parse(p.datetime), b = Date.parse(p.end);
      let t = a;
      if (centre && sat) { const ca = closest(sat, centre, a, b); if (ca) t = ca.t; }
      return {
        id: `plan:${p.id}:${p.datetime}`, kind: 'planned', fid: fl.id, color: fl.color, platform: platformShort(p.platform), sat,
        time: t, start: a, end: b, past: t < now, geometry: f.geometry, bbox: bbox(f.geometry), cloud: null,
        sub: [p.mode, p.pol, p.relOrbit ? `R${p.relOrbit}` : '', `${Math.max(1, Math.round((b - a) / 60000))} MIN`].filter(Boolean), props: p,
      };
    }),
  };
}

// ------------------------------------------------------------------ predicted access

export async function predict(fl, centre, t0, t1, onProgress, signal) {
  const sats = fleet.byFleet.get(fl.id) || [];
  const w = await accessWindows(sats, fl.geom, centre, t0, t1, { onProgress, signal });
  return w.filter((p) => p.geometry).map((p) => ({
    id: `pred:${p.sat.id}:${Math.round(p.time / 1000)}`, kind: 'predicted', fid: fl.id, color: fl.color,
    platform: p.sat.short, sat: p.sat, time: p.time, start: p.time - 60000, end: p.time + 60000, past: false,
    geometry: p.geometry, bbox: bbox(p.geometry), cloud: null,
    sub: [p.asc ? 'ASC' : 'DSC',
      fl.geom.mode === 'agile' ? `ONA ${p.offNadir.toFixed(0)}°${p.crossKm >= 0 ? 'R' : 'L'}` : `${Math.abs(p.crossKm).toFixed(0)}KM ${p.crossKm >= 0 ? 'R' : 'L'}`,
      `SUN ${p.sun >= 0 ? '+' : ''}${p.sun.toFixed(0)}°`],
    props: { offNadir: p.offNadir, crossKm: p.crossKm, sun: p.sun, asc: p.asc },
  }));
}

// ------------------------------------------------------------------ rendering presets
// Planetary Computer dynamic tiler queries. Tiles render server-side; we only decode PNGs.

const qs = (pairs) => new URLSearchParams(pairs).toString();
const A = (...names) => names.map((n) => ['assets', n]);
const rgb = (bands, cf) => qs([...A(...bands), ['nodata', '0'], ['color_formula', cf]]);
const ratio = (bands, expr, range, cmap) => qs([...A(...bands), ['expression', expr], ['asset_as_band', 'true'], ['rescale', range], ['colormap_name', cmap], ['nodata', '0']]);

const S2CF = 'Gamma RGB 3.7 Saturation 1.5 Sigmoidal RGB 15 0.35';
const LSCF = 'gamma RGB 2.7, saturation 1.5, sigmoidal RGB 15 0.55';

function s2(p) {
  const off = parseFloat(p['s2:processing_baseline'] || '0') >= 4 ? 2000 : 0;   // baseline 04.00 adds +1000 per band
  const nd = (a, b) => `(${a}-${b})/(${a}+${b}${off ? `-${off}` : ''})`;
  return [
    { id: 'tci', label: 'TRUE COLOUR', hint: 'Natural colour, 10 m. Fastest: one pre-rendered asset.', q: qs([['assets', 'visual'], ['asset_bidx', 'visual|1,2,3'], ['nodata', '0']]) },
    { id: 'tce', label: 'TRUE COLOUR +', hint: 'Stretched B4·B3·B2 for haze, low sun and dark scenes.', q: rgb(['B04', 'B03', 'B02'], 'Gamma RGB 3.2 Saturation 0.8 Sigmoidal RGB 25 0.35') },
    { id: 'cir', label: 'COLOUR INFRARED', hint: 'B8·B4·B3. Vegetation red; earthworks, clearing and water stand out.', q: rgb(['B08', 'B04', 'B03'], S2CF) },
    { id: 'swir', label: 'SHORTWAVE IR', hint: 'B12·B8A·B4. Sees through smoke; active fire glows, burn scars dark red.', q: rgb(['B12', 'B8A', 'B04'], S2CF) },
    { id: 'urban', label: 'URBAN / BARE', hint: 'B12·B11·B4. Built-up ground, fresh excavation, defensive lines.', q: rgb(['B12', 'B11', 'B04'], S2CF) },
    { id: 'agri', label: 'AGRICULTURE', hint: 'B11·B8·B2. Crop vigour and field state.', q: rgb(['B11', 'B08', 'B02'], S2CF) },
    { id: 'ndvi', label: 'NDVI', hint: 'Vegetation density. Green dense, red bare.', q: ratio(['B08', 'B04'], nd('B08', 'B04'), '-0.2,0.9', 'rdylgn') },
    { id: 'nbr', label: 'BURN RATIO', hint: 'NIR vs SWIR. Red marks burned or scorched ground.', q: ratio(['B08', 'B12'], nd('B08', 'B12'), '-0.5,0.8', 'rdylgn') },
    { id: 'ndwi', label: 'WATER INDEX', hint: 'Open water and flood extent in deep blue.', q: ratio(['B03', 'B08'], nd('B03', 'B08'), '-0.4,0.5', 'blues') },
    { id: 'ndmi', label: 'MOISTURE', hint: 'Canopy and soil moisture. Brown dry, teal wet.', q: ratio(['B8A', 'B11'], nd('B8A', 'B11'), '-0.5,0.6', 'brbg') },
  ];
}

function s1(p) {
  const pols = (p['sar:polarizations'] || ['VV']).map((x) => x.toLowerCase());
  const co = pols.includes('vv') ? 'vv' : pols.includes('hh') ? 'hh' : pols[0];
  const x = pols.includes('vh') ? 'vh' : pols.includes('hv') ? 'hv' : null;
  const db = (b, r) => qs([['assets', b], ['expression', `20*log10(${b})`], ['asset_as_band', 'true'], ['rescale', r], ['nodata', '0']]);
  const out = [{ id: 'co', label: `${co.toUpperCase()} dB`, hint: 'Log radar amplitude. Metal and buildings bright; calm water dark.', q: db(co, '32,56') }];
  if (x) {
    out.push(
      { id: 'dual', label: 'DUAL-POL', hint: `R ${co.toUpperCase()} · G ${x.toUpperCase()} · B ratio. Urban pink-white, vegetation green, water dark.`,
        q: qs([...A(co, x), ['expression', `${co};${x};${co}/${x}`], ['asset_as_band', 'true'], ['rescale', '0,600'], ['rescale', '0,270'], ['rescale', '0,9'], ['nodata', '0']]) },
      { id: 'cross', label: `${x.toUpperCase()} dB`, hint: 'Cross-pol. Volume scatter: vegetation, rubble, debris fields.', q: db(x, '26,48') },
    );
  }
  out.push(
    { id: 'water', label: 'WATER / FLOOD', hint: 'Low backscatter as bright blue: open water and inundation.', q: qs([['assets', co], ['rescale', '0,220'], ['colormap_name', 'blues_r'], ['nodata', '0']]) },
    { id: 'hard', label: 'HARD TARGETS', hint: 'Linear amplitude: ships, pylons, vehicles and dense cores stand out.', q: qs([['assets', co], ['rescale', '150,1500'], ['colormap_name', 'inferno'], ['nodata', '0']]) },
  );
  return out;
}

function ls() {
  const nd = (a, b) => `(${a}-${b})/(${a}+${b}-14545)`;     // L2 SR offset removed
  return [
    { id: 'tc', label: 'TRUE COLOUR', hint: 'Natural colour, 30 m.', q: rgb(['red', 'green', 'blue'], LSCF) },
    { id: 'cir', label: 'COLOUR INFRARED', hint: 'NIR·R·G. Vegetation red.', q: rgb(['nir08', 'red', 'green'], LSCF) },
    { id: 'swir', label: 'SHORTWAVE IR', hint: 'SWIR2·NIR·R. Through smoke; fire glows.', q: rgb(['swir22', 'nir08', 'red'], LSCF) },
    { id: 'ndvi', label: 'NDVI', hint: 'Vegetation density.', q: ratio(['nir08', 'red'], nd('nir08', 'red'), '-0.2,0.9', 'rdylgn') },
    { id: 'nbr', label: 'BURN RATIO', hint: 'Burn severity.', q: ratio(['nir08', 'swir22'], nd('nir08', 'swir22'), '-0.5,0.8', 'rdylgn') },
    { id: 'tir', label: 'THERMAL', hint: 'Band 10 at 250–330 K. Industry, power plants, outfalls.', q: qs([['assets', 'lwir11'], ['rescale', '29500,53000'], ['colormap_name', 'inferno'], ['nodata', '0']]) },
    { id: 'hot', label: 'HOT TARGETS', hint: 'Band 10 at 300–360 K. Fires, flares, furnaces.', q: qs([['assets', 'lwir11'], ['rescale', '44200,61700'], ['colormap_name', 'hot'], ['nodata', '0']]) },
  ];
}

export function presets(collection, props = {}) {
  if (collection === 'sentinel-2-l2a') return s2(props);
  if (collection === 'sentinel-1-grd') return s1(props);
  if (collection === 'landsat-c2-l2') return ls();
  return [];
}

export const QUALITY = {
  draft: { label: 'DRAFT', scale: 1, size: 512 },
  std: { label: 'STD', scale: 2, size: 512 },
  sharp: { label: 'SHARP', scale: 2, size: 256 },
};

export const tiles = (col, item, q, quality = 'std') =>
  `${PC}/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@${QUALITY[quality].scale}x?collection=${col}&item=${encodeURIComponent(item)}&${q}&format=png`;
export const quicklook = (col, item, q, size = 420) =>
  `${PC}/data/v1/item/preview.png?collection=${col}&item=${encodeURIComponent(item)}&${q}&max_size=${size}`;
export const exportUrl = (col, item, q, name, size = 2048) =>
  `/api/export?collection=${col}&item=${encodeURIComponent(item)}&viz=${encodeURIComponent(q)}&name=${name}&size=${size}`;
export const downloadUrl = (col, item, asset) =>
  `/api/download?collection=${col}&item=${encodeURIComponent(item)}&asset=${encodeURIComponent(asset)}`;
export const gibsTiles = (l, date) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${l.layer}/default/${date}/GoogleMapsCompatible_Level${l.level}/{z}/{y}/{x}.${l.ext}`;

export function bandsFor(collection, assets) {
  const want = {
    'sentinel-2-l2a': ['visual', 'B04', 'B03', 'B02', 'B08', 'B11', 'B12', 'SCL'],
    'sentinel-1-grd': ['vv', 'vh', 'hh', 'hv'],
    'landsat-c2-l2': ['red', 'green', 'blue', 'nir08', 'swir16', 'swir22', 'lwir11', 'qa_pixel'],
  }[collection] || [];
  const skip = new Set(['tilejson', 'rendered_preview', 'thumbnail']);
  const all = Object.keys(assets).filter((k) => !skip.has(k));
  const main = want.filter((k) => k in assets);
  return { main, rest: all.filter((k) => !main.includes(k)) };
}
