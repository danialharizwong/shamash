// Header, link lamps, locator, roster, satellite card, focus designation, readout, keys.
/* global maplibregl */

import { S, clock, on, emit, writeHash } from './state.js';
import { map, applyBase, show, drawRings, drawSun } from './map.js';
import { fleet, where, lit, heading } from './orbit.js';
import { pos, refreshNow, drawTracks } from './board.js';
import { el, $, $$, hms, dmy, dtg, fmtPos, fmtLat, fmtLon, parseLatLon, sunAltitude, getJSON, toast, ago } from './util.js';

// ------------------------------------------------------------------ lamps

const LAMPS = [['orbit', 'ORBIT'], ['stac', 'STAC'], ['esa', 'ESA'], ['firms', 'FIRMS'], ['geo', 'GEO'], ['ais', 'AIS'], ['intel', 'INTEL']];
export function buildLamps() {
  $('#lamps').replaceChildren(...LAMPS.map(([id, label]) => el('span.lamp', { id: `lamp-${id}`, title: `${label}: standby` }, el('i'), label)));
}
export function lamp(id, state, title) {
  const n = $(`#lamp-${id}`);
  if (!n) return;
  n.className = `lamp ${state || ''}`;
  if (title) n.title = title;
}

// ------------------------------------------------------------------ clock + time controls

export function buildClock() {
  $$('[data-jump]').forEach((b) => b.addEventListener('click', () => clock.jump(+b.dataset.jump * 1000)));
  $$('[data-rate]').forEach((b) => b.addEventListener('click', () => clock.setRate(+b.dataset.rate)));
  $('#btn-live').addEventListener('click', () => clock.goLive());
  on('clock', ({ jump }) => {
    $$('[data-rate]').forEach((b) => b.classList.toggle('on', +b.dataset.rate === clock.rate));
    $('#btn-live').classList.toggle('on', clock.live);
    document.body.classList.toggle('sim', !clock.live);
    const m = $('#clock-mode');
    m.textContent = clock.live ? 'LIVE' : clock.rate !== 1 ? `SIM ${clock.rate}×` : 'SIM';
    m.className = `tag ${clock.live ? '' : 'sim'}`;
    if (jump) { refreshNow(); drawSun(clock.now(), S.night); }
    writeHash(map);
  });
  const tickClock = () => {
    const t = clock.now();
    $('#clock-time').textContent = hms(t);
    $('#clock-date').textContent = dmy(t);
    $('#cb-dtg').textContent = dtg(Date.now());
    if (S.target) $('#ro-sun').textContent = `${sunAltitude(S.target, t).toFixed(1)}° AT FOCUS`;
    else { const c = map.getCenter(); $('#ro-sun').textContent = `${sunAltitude([c.lng, c.lat], t).toFixed(1)}° AT CENTRE`; }
  };
  tickClock();
  setInterval(tickClock, 250);
}

// ------------------------------------------------------------------ basemap + display

export function setBase(mode) {
  S.base = mode;
  ['vector', 'imagery', 'live'].forEach((m) => $(`#base-${m}`).classList.toggle('on', m === mode));
  $('#live-variant').hidden = mode !== 'live';
  applyBase(map, mode);
  emit('base', mode);
  $('#ro-base').textContent = mode === 'vector' ? 'PHOSPHOR VECTOR' : mode === 'imagery' ? 'ESRI WORLD IMAGERY' : 'GEOSTATIONARY LIVE';
  writeHash(map);
}

export function buildDisplay() {
  ['vector', 'imagery', 'live'].forEach((m) => $(`#base-${m}`).addEventListener('click', () => setBase(m)));
  const tg = (id, key, fn) => $(id).addEventListener('click', () => { S[key] = !S[key]; $(id).classList.toggle('on', S[key]); fn(S[key]); });
  tg('#tg-grid', 'grid', (v) => show('grid', v));
  tg('#tg-night', 'night', (v) => drawSun(clock.now(), v));
  tg('#tg-crt', 'crt', (v) => document.body.classList.toggle('crt-on', v));
}

// ------------------------------------------------------------------ focus designation

let reticle = null;
export function initReticle() {
  const node = $('#reticle');
  node.hidden = false;
  reticle = new maplibregl.Marker({ element: node, anchor: 'center' }).setLngLat([0, 0]);
  node.style.display = 'none';
}

export function setTarget(p, label) {
  S.target = p;
  S.targetLabel = label || null;
  const node = $('#reticle');
  if (p) {
    reticle.setLngLat(p).addTo(map);
    node.style.display = '';
    $('#reticle-tag').replaceChildren(label ? label.toUpperCase().slice(0, 40) : 'FOCUS', el('small', null, fmtPos(p, 4)));
    $('#ro-focus').textContent = fmtPos(p, 3);
  } else {
    reticle.remove();
    $('#ro-focus').textContent = 'NONE';
  }
  drawRings(p);
  emit('target', p);
  writeHash(map);
}

export function designate(onOff) {
  S.designating = onOff ?? !S.designating;
  document.body.classList.toggle('designating', S.designating);
  emit('designating', S.designating);
}

// ------------------------------------------------------------------ locator

let hits = [], hl = -1;
export function buildLocate() {
  const input = $('#locate-in'), out = $('#locate-out');
  const close = () => { out.hidden = true; hits = []; hl = -1; };
  const pick = (h) => {
    close(); input.value = ''; input.blur();
    if (h.sat) { selectSat(h.sat.id, true); return; }
    setTarget(h.p, h.label);
    map.flyTo({ center: h.p, zoom: Math.max(map.getZoom(), h.zoom || 8), duration: 1600 });
  };
  const render = () => {
    out.replaceChildren(...hits.map((h, i) => el('button', { class: i === hl ? 'hl' : '', onclick: () => pick(h) }, h.label, el('small', null, h.sub))));
    out.hidden = !hits.length;
  };
  $('#locate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (hl >= 0 && hits[hl]) return pick(hits[hl]);
    const ll = parseLatLon(q);
    if (ll) return pick({ p: ll, label: fmtPos(ll, 3), zoom: 8 });
    const up = q.toUpperCase();
    const sats = fleet.sats.filter((s) => String(s.id) === q || s.name.includes(up) || s.short === up).slice(0, 6)
      .map((s) => ({ sat: s, label: `${s.name}`, sub: `NORAD ${s.id} · ${S.fleets.get(s.fid).name}` }));
    hits = sats;
    render();
    try {
      const res = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
      hits = [...sats, ...res.map((r) => ({ p: [+r.lon, +r.lat], label: r.name || r.display_name.split(',')[0], sub: r.display_name, zoom: r.type === 'country' ? 5 : r.type === 'city' ? 10 : 8 }))];
      if (!hits.length) toast('NO MATCH FOR ' + up, 'warn');
      hl = hits.length ? 0 : -1;
      render();
    } catch {
      if (!hits.length) toast('PLACE SEARCH UNAVAILABLE', 'err');
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && hits.length) { hl = (hl + 1) % hits.length; render(); e.preventDefault(); }
    if (e.key === 'ArrowUp' && hits.length) { hl = (hl - 1 + hits.length) % hits.length; render(); e.preventDefault(); }
    if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('input', () => { hl = -1; });
  document.addEventListener('click', (e) => { if (!$('#locate').contains(e.target)) close(); });
}

// ------------------------------------------------------------------ roster

export function buildRoster() {
  const root = $('#roster');
  const groups = S.catalog.groups.map((g) => {
    const items = S.catalog.fleets.filter((f) => f.group === g.id);
    return el('div.grp', null,
      el('div.grp-h', null, el('span', null, g.label), el('span', null, String(items.reduce((n, f) => n + (fleet.byFleet.get(f.id) || []).length, 0)).padStart(3, '0'))),
      items.map((f) => {
        const n = (fleet.byFleet.get(f.id) || []).length;
        const row = el('div.fleet', { data: { id: f.id }, style: { '--c': f.color }, title: `${f.name} · ${f.instrument}` },
          el('button.sw', { title: 'Show / hide on the globe', onclick: (e) => { e.stopPropagation(); toggleFleet(f.id); } }, el('i')),
          el('span.nm', null, f.name),
          el('span.n', { class: n ? '' : 'zero' }, String(n).padStart(2, '0')));
        row.addEventListener('click', () => selectFleet(S.selected === f.id ? null : f.id));
        return row;
      }));
  });
  root.replaceChildren(...groups);
  syncRoster();
  $('#ct-assets').textContent = fleet.sats.length;
}

export function syncRoster() {
  $$('.fleet').forEach((r) => {
    r.classList.toggle('on', S.visible.has(r.dataset.id));
    r.classList.toggle('sel', S.selected === r.dataset.id);
  });
}

export function toggleFleet(id, v) {
  const want = v ?? !S.visible.has(id);
  if (want) S.visible.add(id); else S.visible.delete(id);
  syncRoster();
  refreshNow();
  emit('visible');
}

export function selectFleet(id) {
  S.selected = id;
  if (id) S.visible.add(id);
  if (S.sat && fleet.byId.get(S.sat)?.fid !== id) selectSat(null);
  syncRoster();
  drawTracks();
  refreshNow();
  emit('fleet', id);
  writeHash(map);
}

// ------------------------------------------------------------------ satellite card

export function selectSat(id, fly = false) {
  S.sat = id;
  const card = $('#satcard');
  if (!id) { card.hidden = true; S.follow = false; drawTracks(); return; }
  const sat = fleet.byId.get(id);
  if (!sat) return;
  S.visible.add(sat.fid);
  syncRoster();
  const fl = S.fleets.get(sat.fid);
  card.style.setProperty('--c', fl.color);
  card.hidden = false;
  card.replaceChildren(
    el('div.phead', null, el('span.pidx', null, 'SAT'), el('span', { style: { color: fl.color } }, sat.name), el('button.x', { title: 'Close', onclick: () => selectSat(null) }, '✕')),
    el('div.sc-body', null,
      el('div.sc-big', null,
        el('div', null, el('small', null, 'LATITUDE'), el('span', { id: 'sc-lat' }, '—')),
        el('div', null, el('small', null, 'LONGITUDE'), el('span', { id: 'sc-lon' }, '—')),
        el('div', null, el('small', null, 'ALTITUDE KM'), el('span', { id: 'sc-alt' }, '—')),
        el('div', null, el('small', null, 'VELOCITY KM/S'), el('span', { id: 'sc-vel' }, '—')),
        el('div', null, el('small', null, 'HEADING'), el('span', { id: 'sc-hdg' }, '—')),
        el('div', null, el('small', null, 'ILLUMINATION'), el('span', { id: 'sc-lit' }, '—'))),
      el('div.kv', null,
        el('span', null, 'NORAD'), el('span', null, String(sat.id)),
        el('span', null, 'FLEET'), el('span', null, fl.name),
        el('span', null, 'INCLINATION'), el('span', null, `${sat.incl.toFixed(2)}°`),
        el('span', null, 'PERIOD'), el('span', null, `${sat.periodMin.toFixed(1)} MIN`),
        el('span', null, 'ELEMENT AGE'), el('span', { class: Date.now() - sat.epoch > 5 * 864e5 ? 'gold' : '' }, ago(sat.epoch, Date.now()))),
      el('div.btn-row', { style: { 'margin-top': '10px' } },
        el('button.btn', { id: 'sc-follow', onclick: () => toggleFollow() }, 'FOLLOW'),
        el('button.btn', { onclick: () => { const p = pos(id) || where(sat, clock.now()); if (p) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(3, map.getZoom()), duration: 1200 }); } }, 'CENTRE'),
        el('button.btn', { onclick: () => selectFleet(sat.fid) }, 'FLEET'))));
  drawTracks();
  updateSatCard();
  if (fly) { const p = where(sat, clock.now()); if (p) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(2.5, map.getZoom()), duration: 1400 }); }
}

export function toggleFollow(v) {
  S.follow = v ?? !S.follow;
  const b = $('#sc-follow');
  if (b) b.classList.toggle('on', S.follow);
  if (S.follow) toast('FOLLOWING ' + (fleet.byId.get(S.sat)?.short || ''));
}

function updateSatCard() {
  if (!S.sat) return;
  const sat = fleet.byId.get(S.sat);
  const t = clock.now(), p = where(sat, t);
  if (!p || !$('#sc-lat')) return;
  $('#sc-lat').textContent = fmtLat(p.lat, 3);
  $('#sc-lon').textContent = fmtLon(p.lon, 3);
  $('#sc-alt').textContent = p.alt.toFixed(1);
  $('#sc-vel').textContent = p.vel.toFixed(3);
  $('#sc-hdg').textContent = `${heading(sat, t, p).toFixed(1).padStart(5, '0')}°`;
  const l = lit(sat, t, p), s = $('#sc-lit');
  s.textContent = l ? 'SUNLIT' : 'ECLIPSE';
  s.className = l ? 'lit' : '';
}

// ------------------------------------------------------------------ hover + pointer

const tip = () => $('#tip');
export function showTip(e, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const x = Math.min(window.innerWidth - t.offsetWidth - 12, e.clientX + 14);
  const y = Math.min(window.innerHeight - t.offsetHeight - 12, e.clientY + 14);
  t.style.left = `${x}px`; t.style.top = `${y}px`;
}
export const hideTip = () => { tip().hidden = true; };

export function buildPointer() {
  map.on('mousemove', (e) => {
    $('#ro-cursor').textContent = fmtPos([e.lngLat.lng, e.lngLat.lat], 3);
  });
  map.on('mousemove', 'sat-core', (e) => {
    const f = e.features[0];
    const sat = fleet.byId.get(f.properties.id);
    const p = pos(sat.id);
    map.getCanvas().style.cursor = 'pointer';
    showTip(e.originalEvent, `<b>${sat.name}</b><br>${S.fleets.get(sat.fid).name}<br><span class="dim">ALT ${p ? p.alt.toFixed(0) : '—'} KM · ${p && p.lit ? 'SUNLIT' : 'ECLIPSE'}</span>`);
  });
  map.on('mouseleave', 'sat-core', () => { map.getCanvas().style.cursor = ''; hideTip(); });
  map.on('click', 'sat-core', (e) => {
    if (S.designating) return;
    e.preventDefault();
    selectSat(e.features[0].properties.id);
  });
  map.on('click', (e) => {
    if (!S.designating) return;
    designate(false);
    setTarget([e.lngLat.lng, e.lngLat.lat]);
  });
  map.on('dragstart', () => { if (S.follow) toggleFollow(false); });
  map.on('moveend', () => writeHash(map));
  on('tick', () => {
    updateSatCard();
    let n = 0;
    const b = map.getBounds();
    for (const p of [...fleet.sats].map((s) => pos(s.id)).filter(Boolean)) if (b.contains([p.lon, p.lat])) n++;
    $('#ro-sats').textContent = String(n);
  });
}

// ------------------------------------------------------------------ keyboard

const KEYS = [['D', 'Designate focus point'], ['ESC', 'Cancel / close'], ['L', 'Return clock to live'], ['[ ]', 'Slower / faster clock'],
  ['F', 'Follow selected satellite'], ['/', 'Locate place, coords or NORAD'], ['G N C', 'Grid · night · CRT'], ['1 2 3', 'Assets · watch · intel tabs'], ['?', 'This card']];

export function buildKeys(handlers) {
  $('#keys').replaceChildren(el('div.phead', null, el('span.pidx', null, 'KEY'), el('span', null, 'KEYBOARD'), el('button.x', { onclick: () => { $('#keys').hidden = true; } }, '✕')),
    el('div.kv', null, KEYS.flatMap(([k, d]) => [el('span', null, el('kbd', null, k)), el('span', null, d)])));
  const rates = [1, 60, 600, 3600];
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === '/') { e.preventDefault(); $('#locate-in').focus(); }
    else if (k === 'd' || k === 'D') designate();
    else if (k === 'Escape') {
      if (!$('#keys').hidden) $('#keys').hidden = true;
      else if (S.designating) designate(false);
      else if (S.sat) selectSat(null);
      else if (S.record) handlers.clearRecord();
      else if (S.selected) selectFleet(null);
    }
    else if (k === 'l' || k === 'L') clock.goLive();
    else if (k === 'f' || k === 'F') { if (S.sat) toggleFollow(); }
    else if (k === ']') { const i = rates.indexOf(clock.rate); clock.setRate(rates[Math.min(rates.length - 1, i + 1)]); }
    else if (k === '[') { const i = rates.indexOf(clock.rate); clock.setRate(rates[Math.max(0, i - 1)]); }
    else if (k === 'g') $('#tg-grid').click();
    else if (k === 'n') $('#tg-night').click();
    else if (k === 'c') $('#tg-crt').click();
    else if (k === '1' || k === '2' || k === '3') handlers.tab(['assets', 'watch', 'intel'][+k - 1]);
    else if (k === '?') $('#keys').hidden = !$('#keys').hidden;
  });
}

export function buildTabs() {
  const tab = (name) => {
    $$('#left .tabs button').forEach((b) => b.classList.toggle('on', b.id === `tab-${name}`));
    $$('#left .pane').forEach((p) => { p.hidden = p.id !== `pane-${name}`; });
    emit('tab', name);
  };
  $$('#left .tabs button').forEach((b) => b.addEventListener('click', () => tab(b.id.slice(4))));
  return tab;
}
