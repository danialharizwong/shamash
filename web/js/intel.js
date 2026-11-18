// INTEL: public Telegram channels placed on the map. Reports are unverified.

import { S, clock } from './state.js';
import { map, setData, fc, Z_BOARD } from './map.js';
import { lamp, setTarget, showTip, hideTip } from './ui.js';
import { el, $, fill, getJSON, postJSON, ago, dmon, hm, fmtPos, toast } from './util.js';

const CAT = {
  strike: ['STRIKE', '#ff5545', 'M8 1l1.6 4.2L14 4l-2.6 3.6L15 10l-4.4.2L11 15 8 11.6 5 15l.4-4.8L1 10l3.6-2.4L2 4l4.4 1.2z'],
  drone: ['DRONE', '#ff7a45', 'M8 2l6 11H2zM8 7v3'],
  shelling: ['SHELLING', '#ff8a5c', 'M3 12a2 2 0 1 0 0 .1M8 6a2 2 0 1 0 0 .1M13 11a2 2 0 1 0 0 .1'],
  explosion: ['EXPLOSION', '#ff9d3d', 'M8 1v4M8 11v4M1 8h4M11 8h4M3 3l3 3M10 10l3 3M13 3l-3 3M6 10l-3 3'],
  air_defence: ['AIR DEFENCE', '#9fe8ff', 'M2 14a6 6 0 0 1 12 0M8 14L12 3'],
  alert: ['ALERT', '#ffb43b', 'M8 2l7 12H1zM8 6v4M8 12v.5'],
  ground: ['GROUND', '#8dffb8', 'M3 3l10 10M13 3L3 13'],
  movement: ['MOVEMENT', '#7de8c0', 'M2 8h10M9 4l4 4-4 4'],
  naval: ['NAVAL', '#6fc8ff', 'M8 2v10M4 8a4 4 0 0 0 8 0M6 4h4'],
  raid: ['RAID', '#c9ff8a', 'M3 3h10v10H3zM6 6h4v4H6z'],
  infrastructure: ['INFRASTRUCTURE', '#ffe08a', 'M9 1L4 9h4l-1 6 5-8H8z'],
  fire: ['FIRE', '#ff8a2a', 'M8 15c-3 0-5-2-5-5 0-3 3-4 3-8 2 1 3 3 3 5 1-1 1-2 1-3 2 2 3 4 3 6 0 3-2 5-5 5z'],
  disaster: ['DISASTER', '#c4a3ff', 'M1 10c2-3 4-3 6 0s4 3 6 0M1 14c2-3 4-3 6 0s4 3 6 0'],
  unrest: ['UNREST', '#ff9ecf', 'M4 15V2M4 3h8l-2 3 2 3H4'],
  humanitarian: ['HUMANITARIAN', '#e6fff0', 'M6 2h4v4h4v4h-4v4H6v-4H2V6h4z'],
  other: ['OTHER', '#4fc47f', 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4'],
};
const glyph = (cat, size = 16) => {
  const [, c, d] = CAT[cat] || CAT.other;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', c); p.setAttribute('stroke-width', '1.4'); p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
};

const I = { on: false, rev: 0, posts: new Map(), channels: [], model: null, gaz: '', view: 'feed', group: 'ALL', placed: false, cats: new Set(Object.keys(CAT)), sel: null, timer: null, tone: false, first: true };

function visible() {
  const live = new Set(I.channels.filter((c) => c.on).map((c) => c.name));
  const groups = new Map(I.channels.map((c) => [c.name, c.group]));
  const cutoff = Date.now() / 1000 - 86400;
  return [...I.posts.values()].filter((p) => p.t > cutoff && live.has(p.ch) && (I.group === 'ALL' || groups.get(p.ch) === I.group)
    && (!I.placed || p.lon != null) && (!p.cat || I.cats.has(p.cat))).sort((a, b) => b.t - a.t);
}

function drawMap() {
  const feats = [];
  for (const p of visible()) {
    if (p.lon == null) continue;
    const props = { k: p.k, cat: p.cat || 'other', color: (CAT[p.cat] || CAT.other)[1], soft: p.prec !== 'exact' && p.prec !== 'settlement', sel: I.sel === p.k };
    feats.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
    for (const x of p.extra || []) feats.push({ type: 'Feature', properties: { ...props, soft: true, extra: true }, geometry: { type: 'Point', coordinates: [x.lon, x.lat] } });
  }
  setData('intel', fc(feats));
}

function alertFor(p) {
  const c = CAT[p.cat] || CAT.other;
  const a = el('div.alert', { onclick: () => { pick(p.k, true); a.remove(); } },
    el('div.h', null, el('span', null, `${c[0]} · @${p.ch}`), el('span', null, hm(p.t * 1000))),
    el('p', null, p.sum || p.text.slice(0, 160)));
  $('#alerts').prepend(a);
  while ($('#alerts').children.length > 3) $('#alerts').lastChild.remove();
  setTimeout(() => a.remove(), 14000);
  if (I.tone) {
    try {
      const ac = new AudioContext(), o = ac.createOscillator(), g = ac.createGain();
      o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.04;
      o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.12);
    } catch { /* audio blocked */ }
  }
}

async function poll() {
  if (!I.on) return;
  try {
    const r = await getJSON(`/api/intel?since=${I.rev}`);
    if (!I.on) return;
    for (const p of r.posts) {
      const old = I.posts.get(p.k);
      I.posts.set(p.k, p);
      if (!I.first && p.fresh && p.lon != null && (!old || old.lon == null) && I.cats.has(p.cat || 'other')) alertFor(p);
    }
    I.rev = r.rev; I.channels = r.channels; I.model = r.model; I.gaz = r.gazetteer; I.first = false;
    const live = I.channels.filter((c) => c.on).length, bad = I.channels.filter((c) => c.error).length;
    lamp('intel', bad ? 'err' : 'ok', `INTEL: ${live} channels · ${bad} unreachable`);
    $('#ct-intel').textContent = String(visible().filter((p) => p.lon != null).length);
    paint(); drawMap();
  } catch (e) { lamp('intel', 'err', `INTEL: ${e.message}`); }
}

function toggle(v) {
  I.on = v ?? !I.on;
  clearInterval(I.timer);
  map.setLayoutProperty('intel', 'visibility', I.on ? 'visible' : 'none');
  map.setLayoutProperty('intel-ring', 'visibility', I.on ? 'visible' : 'none');
  if (I.on) { I.first = true; poll(); I.timer = setInterval(poll, 20000); }
  else { setData('intel', null); $('#ct-intel').textContent = ''; }
  paint();
}

function pick(k, fly) {
  I.sel = k;
  const p = I.posts.get(k);
  if (p && p.lon != null && fly) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 7), duration: 1200 });
  paint(); drawMap();
}

function card(p) {
  const c = CAT[p.cat] || CAT.other;
  const img = p.thumb ? el('img', { src: p.thumb, alt: 'Post image (blurred, click to reveal)', referrerpolicy: 'no-referrer', onclick: (e) => e.target.classList.toggle('clear') }) : null;
  return el('div.post-card', null,
    el('div.sec-h', null, c[0], el('b', null, `@${p.ch}`)),
    p.sum ? el('div', { style: { color: 'var(--ph-hi)', 'font-size': '11px' } }, p.sum) : null,
    el('div.src', null, p.text || '(NO TEXT)'),
    img,
    el('div.kv', null,
      el('span', null, 'POSTED'), el('span', null, `${dmon(p.t * 1000)} ${hm(p.t * 1000)} · ${ago(p.t * 1000, Date.now())}`),
      el('span', null, 'PLACED'), el('span', null, p.lon != null ? `${p.place || ''} ${fmtPos([p.lon, p.lat], 3)}` : 'NOT LOCATED'),
      el('span', null, 'PRECISION'), el('span', { class: p.prec === 'exact' || p.prec === 'settlement' ? '' : 'gold' }, (p.prec || '—').toUpperCase() + (p.conf ? ` · ${p.conf.toUpperCase()} CONF` : '')),
      el('span', null, 'SOURCE'), el('a', { href: `https://t.me/${p.k}`, target: '_blank', rel: 'noopener' }, `t.me/${p.k}`)),
    el('div.btn-row', { style: { 'margin-top': '8px' } },
      p.lon != null ? el('button.btn.cmd', { onclick: () => setTarget([p.lon, p.lat], p.place || `@${p.ch}`) }, 'DESIGNATE FOCUS') : null,
      el('button.btn', { onclick: () => { clock.setRate(1); clock.set(p.t * 1000); } }, 'CLOCK TO POST'),
      el('button.btn', { onclick: () => pick(null) }, 'CLOSE')),
    el('div.note.dim', { style: { 'margin-top': '6px' } }, 'UNVERIFIED. POSITION IS WHERE THE POST SAYS SOMETHING HAPPENED, AS READ BY A MODEL.'));
}

function paint() {
  const pane = $('#pane-intel');
  const keep = pane.querySelector('.scroll')?.scrollTop || 0;
  const m = I.model;
  const top = el('div.intel-top', null,
    el('div', { style: { display: 'flex', gap: '6px', 'align-items': 'center' } },
      el('button.btn', { class: I.on ? 'on' : '', onclick: () => toggle() }, I.on ? 'MONITOR ON' : 'MONITOR OFF'),
      el('div.seg', null, ['feed', 'channels'].map((v) => el('button', { class: I.view === v ? 'on' : '', onclick: () => { I.view = v; paint(); } }, v.toUpperCase()))),
      el('button.btn', { class: I.tone ? 'on' : '', title: 'Tone on new located reports', onclick: () => { I.tone = !I.tone; paint(); } }, '♪')),
    I.on && m ? el('div.note', null, m.ready ? `PLACE EXTRACTION ${m.name.toUpperCase()} · $${m.spent.toFixed(3)} / $${m.budget.toFixed(2)} TODAY · ${m.pending} QUEUED` : (m.error || 'MODEL NOT CONFIGURED') + ' · ONLY WRITTEN COORDINATES ARE PLACED') : null,
    I.on && I.gaz !== 'ready' && I.gaz !== 'not needed' ? el('div.note.dim', null, `GAZETTEER ${I.gaz.toUpperCase()}`) : null);
  if (!I.on) {
    fill(pane, top, el('div.sec', null, el('div.note', null,
      'FOLLOWS PUBLIC TELEGRAM CHANNELS AND PLACES EACH REPORT ON THE GLOBE. NOTHING IS FETCHED UNTIL THE MONITOR IS ON. POSTS ARE SENT TO ANTHROPIC FOR PLACE EXTRACTION IF A KEY IS CONFIGURED.')));
    return;
  }
  let body;
  if (I.view === 'channels') {
    const input = el('input', { type: 'text', placeholder: '@CHANNEL OR T.ME LINK', style: { flex: 1 } });
    const grp = el('input', { type: 'text', placeholder: 'GROUP', style: { width: '80px' } });
    const budget = el('input', { type: 'number', min: 0, max: 50, step: 0.05, value: m ? m.budget : 0.5, style: { width: '80px' } });
    body = el('div.scroll', null,
      el('div.sec', null, el('div.sec-h', null, 'ADD CHANNEL'), el('div', { style: { display: 'flex', gap: '6px' } }, input, grp,
        el('button.btn', { onclick: async () => { try { await postJSON('/api/intel', { action: 'add', name: input.value, group: grp.value }); I.rev = 0; poll(); } catch (e) { toast(e.message, 'err'); } } }, 'ADD')),
      el('div.sec-h', { style: { 'margin-top': '10px' } }, 'DAILY MODEL BUDGET USD'), el('div', { style: { display: 'flex', gap: '6px' } }, budget,
        el('button.btn', { onclick: async () => { try { await postJSON('/api/intel', { action: 'budget', usd: +budget.value }); poll(); toast('BUDGET SET'); } catch (e) { toast(e.message, 'err'); } } }, 'SET'))),
      I.channels.map((c) => el('div.chan', { class: c.on ? 'on' : '' },
        el('i.sw', { onclick: async () => { await postJSON('/api/intel', { action: 'toggle', name: c.name, on: !c.on }); poll(); } }),
        el('div', null, el('div', null, c.title || c.name), el('small', null, `@${c.name} · ${c.group}`), c.error ? el('div.err', null, c.error) : null),
        el('button.x', { title: 'Remove', onclick: async () => { await postJSON('/api/intel', { action: 'remove', name: c.name }); I.rev = 0; I.posts.clear(); poll(); } }, '✕'))));
  } else {
    const groups = ['ALL', ...new Set(I.channels.map((c) => c.group))];
    const list = visible();
    const sel = I.sel && I.posts.get(I.sel);
    body = el('div.scroll', null,
      el('div.intel-top', null,
        el('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap' } },
          el('div.seg', null, groups.map((g) => el('button', { class: I.group === g ? 'on' : '', onclick: () => { I.group = g; paint(); drawMap(); } }, g))),
          el('button.btn', { class: I.placed ? 'on' : '', onclick: () => { I.placed = !I.placed; paint(); drawMap(); } }, 'PLACED')),
        el('div.intel-cats', null, Object.keys(CAT).map((k) => el('button.icat', { class: I.cats.has(k) ? '' : 'off', title: CAT[k][0], onclick: () => { if (I.cats.has(k)) I.cats.delete(k); else I.cats.add(k); paint(); drawMap(); } }, glyph(k, 13))))),
      sel ? card(sel) : null,
      list.length ? list.slice(0, 300).map((p) => el('div.post', { class: I.sel === p.k ? 'sel' : '', onclick: () => pick(p.k, true) },
        el('div.ic', null, glyph(p.cat || 'other')),
        el('div', null,
          el('div.meta', null, el('b', null, `@${p.ch}`), el('span', { class: p.fresh ? 'fresh' : '' }, ago(p.t * 1000, Date.now()))),
          el('div.txt', null, p.sum || p.text),
          el('div.loc', { class: p.lon == null ? 'none' : '' }, p.lon != null ? `◎ ${p.place || fmtPos([p.lon, p.lat], 2)}${p.prec === 'area' || p.prec === 'approx' ? ' (APPROX)' : ''}` : p.done ? 'NOT LOCATED' : I.model && I.model.ready ? 'ANALYSING…' : 'NO WRITTEN COORDINATES'))))
        : el('div.empty', null, 'NO REPORTS YET · CHANNELS ARE READ ONCE A MINUTE'));
  }
  fill(pane, top, body);
  body.scrollTop = keep;
}

export function buildIntel() {
  map.addSource('intel', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'intel-ring', type: 'circle', source: 'intel', filter: ['==', ['get', 'soft'], true], layout: { visibility: 'none' }, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 9, 22], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.5 } }, Z_BOARD);
  map.addLayer({ id: 'intel', type: 'circle', source: 'intel', layout: { visibility: 'none' }, paint: {
    'circle-radius': ['case', ['get', 'sel'], 7, ['get', 'extra'], 3, 4.5], 'circle-color': ['get', 'color'], 'circle-opacity': ['case', ['get', 'extra'], 0.5, 0.9],
    'circle-stroke-color': ['case', ['get', 'sel'], '#ffb43b', '#000'], 'circle-stroke-width': ['case', ['get', 'sel'], 2, 1] } }, Z_BOARD);
  map.on('mousemove', 'intel', (e) => {
    const p = I.posts.get(e.features[0].properties.k);
    if (!p) return;
    map.getCanvas().style.cursor = 'pointer';
    showTip(e.originalEvent, `<b>${(CAT[p.cat] || CAT.other)[0]}</b> · @${p.ch} · ${ago(p.t * 1000, Date.now())}<br>${(p.sum || p.text).slice(0, 200)}`);
  });
  map.on('mouseleave', 'intel', () => { map.getCanvas().style.cursor = ''; hideTip(); });
  map.on('click', 'intel', (e) => { if (S.designating) return; e.preventDefault(); pick(e.features[0].properties.k, false); document.getElementById('tab-intel').click(); });
  paint();
}
