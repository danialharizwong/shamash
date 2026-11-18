// The globe and every board layer drawn on it.
/* global maplibregl */

import { boardStyle, applyBase, Z_BOARD, Z_IMAGE, INK } from './style.js';
import { nightRing, subsolar, circle, cutDateline } from './util.js';

export let map = null;
const EMPTY = { type: 'FeatureCollection', features: [] };

// ------------------------------------------------------------------ icons (drawn, not shipped)

function icon(size, draw, sdf = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  return { img: g.getImageData(0, 0, size, size), sdf };
}

/** The star of Shamash: a disc with four straight and four wavy rays. */
export function drawShamash(g, s, color = '#ffb43b') {
  const c = s / 2, R = s * 0.47, r = s * 0.13;
  g.save();
  g.translate(c, c);
  g.fillStyle = color; g.strokeStyle = color;
  for (let i = 0; i < 4; i++) {           // straight rays
    g.save(); g.rotate((i * Math.PI) / 2);
    g.beginPath(); g.moveTo(-r * 0.7, -r * 0.6); g.lineTo(0, -R); g.lineTo(r * 0.7, -r * 0.6); g.closePath(); g.fill();
    g.restore();
  }
  g.lineWidth = Math.max(1, s * 0.035); g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {           // wavy rays on the diagonals
    g.save(); g.rotate(Math.PI / 4 + (i * Math.PI) / 2);
    g.beginPath(); g.moveTo(0, -r);
    const L = R * 0.92, n = 3;
    for (let k = 1; k <= n * 2; k++) g.quadraticCurveTo((k % 2 ? 1 : -1) * s * 0.06, -r - ((k - 0.5) / (n * 2)) * (L - r), 0, -r - (k / (n * 2)) * (L - r));
    g.stroke(); g.restore();
  }
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.restore();
}

function addIcons() {
  const set = (id, i) => { if (!map.hasImage(id)) map.addImage(id, i.img, { sdf: i.sdf, pixelRatio: 2 }); };
  set('sh-pip', icon(12, (g) => { g.fillStyle = '#fff'; g.fillRect(3, 3, 6, 6); g.clearRect(5, 5, 2, 2); }));
  set('sh-sun', icon(64, (g, s) => drawShamash(g, s), false));
  set('sh-lock', icon(48, (g, s) => {
    g.strokeStyle = '#fff'; g.lineWidth = 3; const a = 4, b = s - 4, k = 12;
    g.beginPath();
    g.moveTo(a, a + k); g.lineTo(a, a); g.lineTo(a + k, a);
    g.moveTo(b - k, a); g.lineTo(b, a); g.lineTo(b, a + k);
    g.moveTo(b, b - k); g.lineTo(b, b); g.lineTo(b - k, b);
    g.moveTo(a + k, b); g.lineTo(a, b); g.lineTo(a, b - k);
    g.stroke();
  }));
  set('sh-ship', icon(28, (g, s) => {
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(s / 2, 2); g.lineTo(s - 7, s - 4); g.lineTo(s / 2, s - 9); g.lineTo(7, s - 4); g.closePath(); g.fill();
  }));
  set('sh-ship-still', icon(20, (g, s) => { g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 3, 0, Math.PI * 2); g.stroke(); }));
  set('sh-fire', icon(20, (g, s) => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(s / 2, 1); g.lineTo(s - 2, s / 2); g.lineTo(s / 2, s - 1); g.lineTo(2, s / 2); g.closePath(); g.fill(); }));
}

// ------------------------------------------------------------------ graticule

function graticule() {
  const f = [];
  for (let lat = -80; lat <= 80; lat += 10) {
    const pts = []; for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, lat]);
    f.push({ type: 'Feature', properties: { major: lat === 0 ? 2 : lat % 30 === 0 ? 1 : 0 }, geometry: { type: 'LineString', coordinates: pts } });
  }
  for (let lon = -180; lon < 180; lon += 10) {
    const pts = []; for (let lat = -85; lat <= 85; lat += 2) pts.push([lon, lat]);
    f.push({ type: 'Feature', properties: { major: lon === 0 ? 2 : lon % 30 === 0 ? 1 : 0 }, geometry: { type: 'LineString', coordinates: pts } });
  }
  for (const lat of [23.44, -23.44, 66.56, -66.56]) {
    const pts = []; for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, lat]);
    f.push({ type: 'Feature', properties: { major: 3 }, geometry: { type: 'LineString', coordinates: pts } });
  }
  return { type: 'FeatureCollection', features: f };
}

// ------------------------------------------------------------------ setup

export function createMap(view) {
  map = new maplibregl.Map({
    container: 'globe', style: boardStyle(),
    center: view ? [view[0], view[1]] : [30, 25], zoom: view ? view[2] : 1.55,
    attributionControl: false, maxPitch: 60, renderWorldCopies: false,
    fadeDuration: 0, canvasContextAttributes: { antialias: true },
  });
  map.on('styleimagemissing', () => addIcons());
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  // Resolve once the style is parsed, not when every first-view tile has arrived (that can take many seconds).
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (done) return; done = true; addIcons(); addBoard(); resolve(map); };
    map.once('style.load', go);
    map.once('load', go);
  });
}

const before = (layer, z = Z_BOARD) => map.addLayer(layer, z);

function addBoard() {
  const src = (id, extra = {}) => map.addSource(id, { type: 'geojson', data: EMPTY, ...extra });

  src('grid', { data: graticule() });
  before({ id: 'grid', type: 'line', source: 'grid', paint: {
    'line-color': ['match', ['get', 'major'], 3, INK.sun, 2, '#2c8a58', 1, '#164c31', INK.grid],
    'line-opacity': ['match', ['get', 'major'], 3, 0.28, 1],
    'line-width': ['match', ['get', 'major'], 2, 0.9, 0.6],
    'line-dasharray': ['match', ['get', 'major'], 3, ['literal', [2, 4]], ['literal', [1, 0]]],
  } });

  src('night');
  before({ id: 'night', type: 'fill', source: 'night', paint: { 'fill-color': '#000201', 'fill-opacity': ['get', 'a'] } });
  src('terminator');
  before({ id: 'terminator', type: 'line', source: 'terminator', paint: { 'line-color': INK.sun, 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [3, 3] } });

  src('gibs-bounds');
  src('footprints');
  before({ id: 'fp-fill', type: 'fill', source: 'footprints', paint: {
    'fill-color': ['get', 'color'],
    'fill-opacity': ['case', ['boolean', ['get', 'sel'], false], 0.07, ['==', ['get', 'kind'], 'scene'], 0.018, 0.03],
  } });
  before({ id: 'fp-line', type: 'line', source: 'footprints', filter: ['==', ['get', 'kind'], 'scene'], paint: {
    'line-color': ['get', 'color'], 'line-opacity': ['case', ['boolean', ['get', 'sel'], false], 1, 0.55],
    'line-width': ['case', ['boolean', ['get', 'sel'], false], 2, 0.8],
  } });
  before({ id: 'fp-line-future', type: 'line', source: 'footprints', filter: ['!=', ['get', 'kind'], 'scene'], paint: {
    'line-color': ['get', 'color'], 'line-opacity': ['case', ['boolean', ['get', 'sel'], false], 1, 0.6],
    'line-width': ['case', ['boolean', ['get', 'sel'], false], 2, 0.9], 'line-dasharray': [3, 2],
  } });

  src('swath');
  before({ id: 'swath', type: 'fill', source: 'swath', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.07 } });
  before({ id: 'swath-edge', type: 'line', source: 'swath', paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.35, 'line-width': 0.6 } });

  src('tracks');
  before({ id: 'track-past', type: 'line', source: 'tracks', filter: ['==', ['get', 'p'], 1], paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.35, 'line-width': 1 } });
  before({ id: 'track-next', type: 'line', source: 'tracks', filter: ['==', ['get', 'p'], 0], paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.75, 'line-width': 1.1, 'line-dasharray': [2, 2] } });

  src('reach');
  before({ id: 'reach', type: 'line', source: 'reach', paint: { 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-opacity': 0.9 } });

  src('rings');
  before({ id: 'rings', type: 'line', source: 'rings', paint: { 'line-color': INK.sun, 'line-opacity': ['get', 'a'], 'line-width': 0.8, 'line-dasharray': [4, 3] } });
  before({ id: 'rings-label', type: 'symbol', source: 'rings', layout: {
    'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 9, 'text-letter-spacing': 0.2,
    'symbol-spacing': 400, 'text-keep-upright': true }, paint: { 'text-color': INK.sun, 'text-opacity': 0.7, 'text-halo-color': INK.halo, 'text-halo-width': 1 } });

  src('trails');
  before({ id: 'trails', type: 'line', source: 'trails', layout: { 'line-cap': 'round' }, paint: {
    'line-color': ['get', 'color'], 'line-opacity': ['get', 'a'], 'line-width': ['case', ['boolean', ['get', 'sel'], false], 2, 1.2] } });

  src('sats');
  before({ id: 'sat-halo', type: 'circle', source: 'sats', paint: {
    'circle-color': ['get', 'color'], 'circle-blur': 1,
    'circle-radius': ['case', ['boolean', ['get', 'sel'], false], 10, 6], 'circle-opacity': ['case', ['boolean', ['get', 'lit'], true], 0.35, 0.12] } });
  before({ id: 'sat-core', type: 'circle', source: 'sats', paint: {
    'circle-color': ['case', ['boolean', ['get', 'lit'], true], ['get', 'color'], '#020805'],
    'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['case', ['boolean', ['get', 'lit'], true], 0, 1.2],
    'circle-radius': ['case', ['boolean', ['get', 'sel'], false], 3.6, 2.4] } });
  before({ id: 'sat-label', type: 'symbol', source: 'sats', filter: ['boolean', ['get', 'sel'], false], layout: {
    'text-field': ['get', 'short'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-letter-spacing': 0.12,
    'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-allow-overlap': false },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': INK.halo, 'text-halo-width': 1.6 } });
  src('lock');
  before({ id: 'lock', type: 'symbol', source: 'lock', layout: { 'icon-image': 'sh-lock', 'icon-size': 0.75, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-anchor': 'top-left', 'text-offset': [1.4, 0.6], 'text-letter-spacing': 0.1, 'text-allow-overlap': true },
    paint: { 'icon-color': INK.sun, 'text-color': INK.sun, 'text-halo-color': INK.halo, 'text-halo-width': 1.6 } });

  src('sun');
  map.addLayer({ id: 'sun', type: 'symbol', source: 'sun', layout: { 'icon-image': 'sh-sun', 'icon-size': 0.55, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    'text-field': 'SUBSOLAR', 'text-font': ['Noto Sans Regular'], 'text-size': 8.5, 'text-letter-spacing': 0.35, 'text-offset': [0, 1.9], 'text-allow-overlap': true },
    paint: { 'icon-opacity': 0.95, 'text-color': INK.sun, 'text-opacity': 0.7, 'text-halo-color': INK.halo, 'text-halo-width': 1 } });
}

// ------------------------------------------------------------------ helpers for other modules

export function setData(id, data) {
  const s = map && map.getSource(id);
  if (s) s.setData(data || EMPTY);
}
export const fc = (features) => ({ type: 'FeatureCollection', features });
export const show = (ids, on) => [].concat(ids).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
export { Z_BOARD, Z_IMAGE, applyBase };

export function drawSun(ms, night) {
  setData('sun', fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: subsolar(ms) } }]));
  if (!night) { setData('night', null); setData('terminator', null); return; }
  const band = (d, a) => ({ type: 'Feature', properties: { a }, geometry: { type: 'Polygon', coordinates: [nightRing(ms, d)] } });
  setData('night', fc([band(0, 0.28), band(6, 0.14), band(12, 0.14)]));
  const ring = nightRing(ms, 0).slice(0, -3);
  setData('terminator', fc(cutDateline(ring).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }))));
}

export function drawRings(target) {
  if (!target) return setData('rings', null);
  setData('rings', fc([50, 150, 500].map((km, i) => ({
    type: 'Feature', properties: { a: 0.55 - i * 0.14, label: `${km} KM` },
    geometry: { type: 'LineString', coordinates: circle(target, km, 96) },
  }))));
}

// ------------------------------------------------------------------ raster overlays

export function addRaster(id, tiles, opts = {}) {
  removeRaster(id);
  map.addSource(id, { type: 'raster', tiles: [tiles], tileSize: opts.tileSize || 256, minzoom: opts.minzoom || 0, maxzoom: opts.maxzoom || 14, bounds: opts.bounds, attribution: opts.attribution });
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-fade-duration': 200, 'raster-opacity': opts.opacity ?? 1 } }, opts.before || Z_IMAGE);
}
export function removeRaster(id) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}
