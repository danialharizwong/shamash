// AIS shipping layer: merged free feeds, coloured by ship type, with a ship card and track.

import { S } from './state.js';
import { map, setData, fc, Z_BOARD } from './map.js';
import { lamp, setTarget, showTip, hideTip, selectSat } from './ui.js';
import { el, $, fill, getJSON, postJSON, fmtPos, ago, cutDateline, debounce, toast } from './util.js';

const KINDS = [
  ['cargo', 'CARGO', '#8dffb8'], ['tanker', 'TANKER', '#ffb43b'], ['passenger', 'PASSENGER', '#9fe8ff'], ['fishing', 'FISHING', '#c4a3ff'],
  ['military', 'MIL / LAW', '#ff5545'], ['service', 'TUG / SERVICE', '#ffe08a'], ['leisure', 'LEISURE', '#ff9ecf'], ['other', 'OTHER', '#6d8f7c'],
];
const NAV = ['UNDER WAY', 'AT ANCHOR', 'NOT UNDER COMMAND', 'RESTRICTED', 'CONSTRAINED BY DRAUGHT', 'MOORED', 'AGROUND', 'FISHING', 'SAILING'];
const A = { on: false, kinds: new Set(KINDS.map((k) => k[0])), moving: false, meta: null, timer: null };

// Maritime identification digits -> flag (common registries; others shown as MID)
const MID = { 201: 'AL', 205: 'BE', 209: 'CY', 210: 'CY', 211: 'DE', 212: 'CY', 215: 'MT', 219: 'DK', 220: 'DK', 224: 'ES', 225: 'ES', 226: 'FR', 227: 'FR', 228: 'FR', 229: 'MT', 230: 'FI', 231: 'FO',
  232: 'GB', 233: 'GB', 234: 'GB', 235: 'GB', 236: 'GI', 237: 'GR', 238: 'HR', 239: 'GR', 240: 'GR', 241: 'GR', 244: 'NL', 245: 'NL', 246: 'NL', 247: 'IT', 248: 'MT', 249: 'MT', 250: 'IE', 251: 'IS',
  255: 'PT', 256: 'MT', 257: 'NO', 258: 'NO', 259: 'NO', 261: 'PL', 263: 'PT', 265: 'SE', 266: 'SE', 271: 'TR', 272: 'UA', 273: 'RU', 275: 'LV', 276: 'EE', 277: 'LT', 303: 'US', 304: 'AG', 305: 'AG',
  308: 'BS', 309: 'BS', 311: 'BS', 316: 'CA', 338: 'US', 351: 'PA', 352: 'PA', 353: 'PA', 354: 'PA', 355: 'PA', 356: 'PA', 357: 'PA', 366: 'US', 367: 'US', 368: 'US', 369: 'US', 370: 'PA', 371: 'PA',
  372: 'PA', 373: 'PA', 374: 'PA', 412: 'CN', 413: 'CN', 414: 'CN', 416: 'TW', 419: 'IN', 422: 'IR', 431: 'JP', 432: 'JP', 440: 'KR', 441: 'KR', 470: 'AE', 477: 'HK', 525: 'ID', 533: 'MY',
  538: 'MH', 548: 'PH', 563: 'SG', 564: 'SG', 565: 'SG', 566: 'SG', 574: 'VN', 636: 'LR', 637: 'LR', 667: 'SL' };
const flag = (mmsi) => { const m = Math.floor(mmsi / 1e6); return MID[m] || (m >= 200 && m < 800 ? `MID ${m}` : '—'); };

function filter() {
  const f = ['all', ['in', ['get', 'k'], ['literal', KINDS.map((k, i) => (A.kinds.has(k[0]) ? i : -1)).filter((i) => i >= 0)]]];
  if (A.moving) f.push(['==', ['get', 'v'], 1]);
  map.setFilter('ais', f);
}

async function load() {
  if (!A.on) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v, i) => Math.max(i % 2 ? -90 : -180, Math.min(i % 2 ? 90 : 180, v)).toFixed(2)).join(',');
  try {
    const [meta, data] = await Promise.all([getJSON('/api/ais/meta'), getJSON(`/api/ais?bbox=${bbox}`)]);
    if (!A.on) return;
    A.meta = meta;
    setData('ais', data);
    const live = meta.feeds.filter((f) => f.state === 'LIVE');
    lamp('ais', live.length ? 'ok' : 'busy', `AIS: ${meta.ships} ships · ${meta.feeds.map((f) => `${f.label} ${f.state}`).join(' · ')}`);
  } catch (e) { lamp('ais', 'err', `AIS: ${e.message}`); }
  paint();
}

function paint() {
  const m = A.meta;
  fill($('#ov-ais'), 
    el('div.ov-h', { class: A.on ? 'on' : '', style: { '--c': '#9fe8ff' }, onclick: () => toggle() },
      el('i.sw'), el('span.nm', null, 'AIS SHIPPING'), el('span.ct', null, A.on && m ? m.ships.toLocaleString('en') : '')),
    A.on ? el('div.ov-body', null,
      el('div.chips', null, KINDS.map(([k, l, c]) => el('button.chip', { class: A.kinds.has(k) ? 'on' : '', style: { '--c': c }, onclick: () => { if (A.kinds.has(k)) A.kinds.delete(k); else A.kinds.add(k); filter(); paint(); } }, el('i'), l)),
        el('button.chip', { class: A.moving ? 'on' : '', style: { '--c': '#fff' }, onclick: () => { A.moving = !A.moving; filter(); paint(); } }, el('i'), 'MOVING ONLY')),
      m ? m.feeds.map((f) => el('div.note', { title: f.credit }, el('span.lamp', { class: f.state === 'LIVE' ? 'ok' : f.state === 'OFFLINE' ? '' : f.state === 'RETRY' ? 'err' : 'busy' }, el('i'), f.label),
        ` ${f.state}${f.rate ? ` · ${f.rate}/S` : ''}${f.error ? ` · ${f.error}` : ''}`)) : el('div.note', null, 'LINKING FEEDS…'),
      el('div.note.dim', null, 'SHORE RECEIVERS ONLY · SELF-REPORTED · ABSENCE PROVES NOTHING')) : null);
}

export function toggle(v) {
  A.on = v ?? !A.on;
  map.setLayoutProperty('ais', 'visibility', A.on ? 'visible' : 'none');
  clearInterval(A.timer);
  if (A.on) { load(); A.timer = setInterval(load, 15000); toast('AIS LINKING · MOVING SHIPS APPEAR WITHIN SECONDS, MOORED WITHIN MINUTES'); }
  else { setData('ais', null); setData('ship-track', null); lamp('ais', '', 'AIS: off'); postJSON('/api/ais', { action: 'stop' }).catch(() => {}); }
  paint();
}

async function ship(mmsi) {
  let s;
  try { s = await getJSON(`/api/ais/ship?mmsi=${mmsi}`); } catch (e) { toast(e.message, 'err'); return; }
  selectSat(null);
  const kind = KINDS.find((k) => k[0] === s.kind) || KINDS[7];
  const card = $('#satcard');
  card.hidden = false;
  const p = [s.lon, s.lat];
  card.replaceChildren(
    el('div.phead', null, el('span.pidx', null, 'AIS'), el('span', { style: { color: kind[2] } }, s.name || `MMSI ${s.mmsi}`), el('button.x', { onclick: () => { card.hidden = true; setData('ship-track', null); } }, '✕')),
    el('div.sc-body', null,
      el('div.sc-big', null,
        el('div', null, el('small', null, 'SPEED KN'), el('span', null, s.sog != null ? s.sog.toFixed(1) : '—')),
        el('div', null, el('small', null, 'COURSE'), el('span', null, s.cog != null ? `${s.cog.toFixed(0).padStart(3, '0')}°` : '—'))),
      el('div.kv', null,
        el('span', null, 'MMSI'), el('span', null, String(s.mmsi)),
        el('span', null, 'IMO / CALL'), el('span', null, `${s.imo || '—'} / ${s.call || '—'}`),
        el('span', null, 'FLAG'), el('span', null, flag(s.mmsi)),
        el('span', null, 'TYPE'), el('span', { style: { color: kind[2] } }, `${kind[1]}${s.type ? ` (${s.type})` : ''}`),
        el('span', null, 'STATUS'), el('span', null, NAV[s.nav] || '—'),
        el('span', null, 'DESTINATION'), el('span', null, s.dest || '—'),
        el('span', null, 'SIZE'), el('span', null, s.length ? `${s.length} × ${s.beam || '?'} M · ${s.draught ? `${s.draught} M DRAUGHT` : ''}` : '—'),
        el('span', null, 'POSITION'), el('span', null, fmtPos(p, 4)),
        el('span', null, 'LAST HEARD'), el('span', null, `${ago(s.t * 1000, Date.now())} · ${s.via.join(', ').toUpperCase()}`),
        el('span', null, 'TRACK'), el('span', null, `${s.track.length} POINTS / 6 H`)),
      el('div.btn-row', { style: { 'margin-top': '10px' } },
        el('button.btn.cmd', { onclick: () => setTarget(p, s.name || `MMSI ${s.mmsi}`) }, 'DESIGNATE FOCUS'),
        el('a.btn', { href: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${s.mmsi}`, target: '_blank', rel: 'noopener', style: { 'line-height': '22px', 'text-decoration': 'none' } }, 'LOOKUP'))));
  const pts = s.track.map((t) => [t[0], t[1]]);
  pts.push(p);
  setData('ship-track', fc(cutDateline(pts).map((c) => ({ type: 'Feature', properties: { color: kind[2] }, geometry: { type: 'LineString', coordinates: c } }))));
}

export function buildAis() {
  map.addSource('ais', { type: 'geojson', data: fc([]) });
  map.addSource('ship-track', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'ship-track', type: 'line', source: 'ship-track', paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [2, 1.5] } }, Z_BOARD);
  map.addLayer({ id: 'ais', type: 'symbol', source: 'ais', layout: {
    visibility: 'none', 'icon-image': ['case', ['==', ['get', 'v'], 1], 'sh-ship', 'sh-ship-still'],
    'icon-rotate': ['get', 'h'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.45, 8, 0.85, 13, 1.15] },
  paint: { 'icon-color': ['match', ['get', 'k'], ...KINDS.flatMap((k, i) => [i, k[2]]), '#6d8f7c'], 'icon-opacity': 0.92 } }, Z_BOARD);
  map.on('mousemove', 'ais', (e) => {
    const p = e.features[0].properties;
    map.getCanvas().style.cursor = 'pointer';
    showTip(e.originalEvent, `<b>${p.n || 'MMSI ' + p.m}</b><br>${KINDS[p.k][1]} · ${p.v ? 'UNDER WAY' : 'STATIONARY'}<br><span class="dim">MMSI ${p.m} · ${flag(p.m)}</span>`);
  });
  map.on('mouseleave', 'ais', () => { map.getCanvas().style.cursor = ''; hideTip(); });
  map.on('click', 'ais', (e) => { if (S.designating) return; e.preventDefault(); ship(e.features[0].properties.m); });
  map.on('moveend', debounce(() => { if (A.on) load(); }, 500));
  window.addEventListener('beforeunload', () => { if (A.on) navigator.sendBeacon?.('/api/ais', new Blob([JSON.stringify({ action: 'stop' })], { type: 'application/json' })); });
  paint();
}
