// NASA FIRMS near-real-time thermal detections.

import { S } from './state.js';
import { map, setData, Z_BOARD } from './map.js';
import { lamp, setTarget, showTip, hideTip } from './ui.js';
import { el, $, fill, getJSON, dmon, hm, ago, fmtPos, toast, debounce } from './util.js';

const SATS = ['NOAA-20 VIIRS', 'NOAA-21 VIIRS', 'SUOMI NPP VIIRS', 'TERRA MODIS', 'AQUA MODIS'];
const CONF = ['LOW', 'NOMINAL', 'HIGH'];
const F = { on: false, win: '24h', src: 'all', meta: null, busy: false };
let seq = 0;

function box() {
  if (F.win !== '7d' || map.getZoom() < 3) return null;
  const b = map.getBounds();
  return [b.getWest(), Math.max(-90, b.getSouth()), b.getEast(), Math.min(90, b.getNorth())].map((v) => Math.max(-180, Math.min(180, v)).toFixed(3)).join(',');
}

async function load() {
  if (!F.on) return;
  const mine = ++seq;
  F.busy = true; paint(); lamp('firms', 'busy', 'FIRMS: loading');
  const q = new URLSearchParams({ win: F.win, src: F.src });
  const b = box();
  if (b) q.set('bbox', b);
  try {
    const [meta, data] = await Promise.all([getJSON(`/api/firms?${q}&meta=1`), getJSON(`/api/firms?${q}`)]);
    if (mine !== seq || !F.on) return;
    F.meta = meta;
    setData('firms', data);
    const bad = meta.feeds.filter((f) => f.error);
    lamp('firms', bad.length ? 'err' : 'ok', `FIRMS: ${meta.count} detections${bad.length ? ` · ${bad.map((f) => f.key).join(', ')} unavailable` : ''}`);
  } catch (e) {
    lamp('firms', 'err', `FIRMS: ${e.message}`);
    toast(`FIRMS: ${e.message}`, 'err');
  } finally {
    if (mine === seq) { F.busy = false; paint(); }
  }
}

function paint() {
  const m = F.meta;
  const seg = (opts, cur, key) => el('div.seg', null, opts.map(([v, l]) => el('button', { class: v === cur ? 'on' : '', onclick: () => { F[key] = v; load(); paint(); } }, l)));
  fill($('#ov-firms'), 
    el('div.ov-h', { class: F.on ? 'on' : '', style: { '--c': '#ff6a3d' }, onclick: () => toggle() },
      el('i.sw'), el('span.nm', null, 'FIRMS THERMAL'), el('span.ct', { class: m && F.on ? 'hot' : '' }, F.busy ? '…' : m && F.on ? `${m.count.toLocaleString('en')}${m.truncated ? '+' : ''}` : '')),
    F.on ? el('div.ov-body', null,
      el('div', { style: { display: 'flex', gap: '6px' } }, seg([['24h', '24H'], ['48h', '48H'], ['7d', '7D']], F.win, 'win'), seg([['all', 'ALL'], ['viirs', 'VIIRS'], ['modis', 'MODIS']], F.src, 'src')),
      m ? el('div.note', null, `NEWEST ${m.newest ? `${dmon(Date.parse(m.newest))} ${hm(Date.parse(m.newest))}` : '—'} · ${m.truncated ? 'STRONGEST SHOWN · ZOOM IN' : 'FRP SCALED'}`) : null) : null);
}

export function toggle(v) {
  F.on = v ?? !F.on;
  map.setLayoutProperty('firms', 'visibility', F.on ? 'visible' : 'none');
  map.setLayoutProperty('firms-glow', 'visibility', F.on ? 'visible' : 'none');
  if (F.on) load(); else { setData('firms', null); lamp('firms', '', 'FIRMS: off'); F.meta = null; }
  paint();
}

export function buildFirms() {
  map.addSource('firms', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const r = (base) => ['interpolate', ['linear'], ['zoom'], 1, ['*', base, ['interpolate', ['linear'], ['get', 'f'], 0, 0.8, 50, 1.4, 500, 2.6]], 8, ['*', base * 3, ['interpolate', ['linear'], ['get', 'f'], 0, 1, 50, 1.6, 500, 2.6]]];
  const heat = ['interpolate', ['linear'], ['get', 'f'], 0, '#ff3b2f', 15, '#ff6a2a', 60, '#ffb43b', 300, '#fff1c8'];
  map.addLayer({ id: 'firms-glow', type: 'circle', source: 'firms', layout: { visibility: 'none' }, paint: { 'circle-color': heat, 'circle-radius': r(3), 'circle-blur': 1, 'circle-opacity': 0.35 } }, Z_BOARD);
  map.addLayer({ id: 'firms', type: 'circle', source: 'firms', layout: { visibility: 'none' }, paint: {
    'circle-color': heat, 'circle-radius': r(1.1), 'circle-opacity': ['match', ['get', 'c'], 0, 0.55, 1],
    'circle-stroke-color': '#000', 'circle-stroke-width': 0.3 } }, Z_BOARD);
  map.on('mousemove', 'firms', (e) => {
    const p = e.features[0].properties, t = p.t * 60000;
    map.getCanvas().style.cursor = 'pointer';
    showTip(e.originalEvent, `<b>THERMAL DETECTION</b><br>FRP ${(+p.f).toFixed(1)} MW · ${CONF[p.c]} CONF<br>${SATS[p.s] || ''} · ${p.n ? 'NIGHT' : 'DAY'}<br><span class="dim">${dmon(t)} ${hm(t)} · ${ago(t, Date.now())}<br>${fmtPos(e.features[0].geometry.coordinates, 3)} · CLICK TO FOCUS</span>`);
  });
  map.on('mouseleave', 'firms', () => { map.getCanvas().style.cursor = ''; hideTip(); });
  map.on('click', 'firms', (e) => {
    if (S.designating) return;
    e.preventDefault();
    const c = e.features[0].geometry.coordinates;
    setTarget([c[0], c[1]], `FIRE ${(+e.features[0].properties.f).toFixed(0)} MW`);
  });
  map.on('moveend', debounce(() => { if (F.on && F.win === '7d') load(); }, 500));
  setInterval(() => { if (F.on) load(); }, 10 * 60000);
  paint();
}

export const firmsOn = () => F.on;
