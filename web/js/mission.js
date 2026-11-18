// Right-hand panel: the selected fleet, the scan controller, results, and one footprint in detail.

import { S, clock, on, emit } from './state.js';
import { map, setData, fc, addRaster, removeRaster } from './map.js';
import { fleet } from './orbit.js';
import { lamp, selectSat, designate, setTarget } from './ui.js';
import { aoiFor, searchScenes, fetchPlans, predict, fetchItem, presets, tiles, quicklook, exportUrl, downloadUrl, gibsTiles, bandsFor, QUALITY, BOX_ZOOM } from './scan.js';
import { el, $, fill, $$, DAY, stamp, tminus, dmon, hm, fmtPos, isoDate, toast } from './util.js';

const MAX_ON_BOARD = 6;
let ctl = null;                    // AbortController for the scan in flight
let view = 'acquired';             // results sub-tab
let progress = 0;

const fl = () => S.selected && S.fleets.get(S.selected);

// ------------------------------------------------------------------ panel

export function renderMission() {
  const f = fl();
  const right = $('#right');
  right.hidden = !f;
  document.body.classList.toggle('no-right', !f);
  if (!f) return;
  right.style.setProperty('--c', f.color);
  $('#right-title').textContent = f.name;
  const sats = fleet.byFleet.get(f.id) || [];
  fill($('#mission'), 
    el('div.m-hero', { style: { '--c': f.color } },
      el('div.op', null, f.operator),
      el('h2', null, f.name),
      el('div.kv', null,
        el('span', null, 'SENSOR'), el('span', null, f.sensor === 'sar' ? 'SYNTHETIC APERTURE RADAR' : f.sensor === 'optical' ? 'OPTICAL' : 'MIXED'),
        el('span', null, 'INSTRUMENT'), el('span', null, f.instrument),
        el('span', null, 'GSD'), el('span', null, f.gsd),
        el('span', null, 'REVISIT'), el('span', null, f.revisit),
        el('span', null, 'GEOMETRY'), el('span', null, geomText(f.geom))),
      el('div.access', null, f.access)),
    el('div.sec', null, el('div.sec-h', null, 'ASSETS ', el('b', null, String(sats.length))),
      sats.length ? el('div.sats-list', null, sats.map((s) => el('button', { class: S.sat === s.id ? 'on' : '', title: `${s.name} · NORAD ${s.id}`, onclick: () => selectSat(s.id, true) }, s.short)))
        : el('div.note', null, 'NO CURRENT ELEMENTS FOR THIS FLEET.')),
    f.gibs ? gibsSection(f) : null,
    scanSection(f),
    resultsSection(f),
    onBoardSection(),
    f.links && f.links.length ? el('div.sec.links', null, el('div.sec-h', null, 'EXTERNAL'), f.links.map((l) => el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label))) : null,
  );
}

function geomText(g) {
  if (!g) return '—';
  if (g.mode === 'nadir') return `NADIR · ${g.swathKm} KM SWATH`;
  if (g.mode === 'side') return `${g.side.toUpperCase()}-LOOKING · ${g.nearKm}–${g.farKm} KM`;
  return `AGILE · ${g.minKm ? `${g.minKm}–` : '±'}${g.reachKm} KM REACH`;
}

// ------------------------------------------------------------------ daily mosaics (GIBS)

function gibsSection(f) {
  const cur = S.gibs && S.gibs.fid === f.id ? S.gibs : null;
  const sel = el('select', { 'aria-label': 'Mosaic product' }, f.gibs.map((g) => el('option', { value: g.id, selected: cur && cur.layer.id === g.id }, g.label)));
  const date = el('input', { type: 'date', value: cur ? cur.date : isoDate(clock.now() - (new Date(clock.now()).getUTCHours() < 14 ? DAY : 0)), max: isoDate(Date.now()) });
  const hint = el('div.hint', null, (cur ? cur.layer : f.gibs[0]).hint);
  const apply = () => {
    const layer = f.gibs.find((g) => g.id === sel.value);
    hint.textContent = layer.hint;
    if (S.gibs) { S.gibs = { fid: f.id, layer, date: date.value }; drawGibs(); }
  };
  sel.addEventListener('change', apply);
  date.addEventListener('change', apply);
  return el('div.sec', null, el('div.sec-h', null, 'DAILY GLOBAL MOSAIC'),
    el('div.ctl-grid', null, el('span', null, 'PRODUCT'), sel, el('span', null, 'DATE (UTC)'), date), hint,
    el('button.btn.cmd.wide', { class: cur ? 'on' : '', onclick: () => {
      if (S.gibs) { S.gibs = null; removeRaster('gibs'); }
      else { S.gibs = { fid: f.id, layer: f.gibs.find((g) => g.id === sel.value), date: date.value }; drawGibs(); }
      renderMission();
    } }, cur ? 'REMOVE MOSAIC' : 'DRAPE MOSAIC ON BOARD'));
}

function drawGibs() {
  const g = S.gibs;
  if (!g) return removeRaster('gibs');
  addRaster('gibs', gibsTiles(g.layer, g.date), { maxzoom: g.layer.level, attribution: 'NASA GIBS', opacity: 0.92 });
  toast(`${g.layer.label} · ${g.date}`);
}

// ------------------------------------------------------------------ scan controller

function aoiDescription() {
  const aoi = aoiFor(map);
  if (aoi.type === 'point') return { cls: '', title: S.targetLabel ? S.targetLabel.toUpperCase() : 'DESIGNATED FOCUS', sub: fmtPos([aoi.lon, aoi.lat], 4) };
  if (aoi.type === 'box') return { cls: 'box', title: 'CURRENT VIEW', sub: `${aoi.bbox.map((v) => v.toFixed(2)).join(' · ')}` };
  return { cls: 'global', title: 'NO AREA', sub: `DESIGNATE A FOCUS OR ZOOM PAST ${BOX_ZOOM}` };
}

function seg(options, value, onPick) {
  return el('div.seg', null, options.map(([v, label]) => el('button', { class: v === value ? 'on' : '', onclick: () => onPick(v) }, label)));
}

function scanSection(f) {
  const a = aoiDescription();
  const canArchive = !!f.archive, canFuture = !!(f.plan || f.geom);
  const rows = [];
  if (canArchive) {
    rows.push(el('span', null, 'LOOK BACK'), seg([[7, '7D'], [30, '30D'], [90, '90D'], [365, '1Y']], S.lookbackDays, (v) => { S.lookbackDays = v; renderMission(); }));
    if (f.archive.cloud) {
      const val = el('span.val', null, `${S.cloudMax}%`);
      const r = el('input', { type: 'range', min: 0, max: 100, step: 5, value: S.cloudMax, 'aria-label': 'Maximum cloud cover' });
      r.addEventListener('input', () => { S.cloudMax = +r.value; val.textContent = `${S.cloudMax}%`; });
      rows.push(el('span', null, 'CLOUD ≤'), el('div.range-row', null, r, val));
    }
  }
  if (canFuture) rows.push(el('span', null, 'LOOK AHEAD'), seg([[1, '24H'], [3, '3D'], [7, '7D']], S.aheadDays, (v) => { S.aheadDays = v; renderMission(); }));
  const busy = S.scan && S.scan.busy;
  return el('div.sec', null,
    el('div.sec-h', null, 'SCAN'),
    el('div.aoi-box', null, el('div.ico', { class: a.cls }), el('div.t', null, el('b', null, a.title), el('span', null, a.sub)),
      el('button.btn', { title: 'Click the globe to set a focus (D)', onclick: () => designate(true) }, 'DESIGNATE'),
      S.target ? el('button.btn', { title: 'Clear focus', onclick: () => setTarget(null) }, '✕') : null),
    el('div.ctl-grid', null, rows),
    el('button.btn.cmd.wide', { id: 'scan-go', disabled: busy, onclick: () => scan() }, busy ? 'SCANNING…' : canArchive ? 'SCAN ARCHIVE + TASKING' : 'PREDICT PASSES'),
    el('div.progress', { class: busy && !progress ? 'indet' : '', id: 'scan-progress' }, el('i', { style: { width: `${Math.round(progress * 100)}%` } })),
  );
}

export async function scan() {
  const f = fl();
  if (!f) return;
  const aoi = aoiFor(map);
  if (aoi.type === 'global') { toast(`DESIGNATE A FOCUS OR ZOOM PAST ${BOX_ZOOM} TO SCAN`, 'warn'); designate(true); return; }
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const signal = ctl.signal;
  const now = clock.now();
  S.scan = { fid: f.id, aoi, acquired: [], tasking: [], busy: true, notes: [] };
  S.record = null;
  progress = 0;
  renderMission();
  drawFootprints();
  const jobs = [];
  const centre = aoi.type === 'point' ? [aoi.lon, aoi.lat] : [(aoi.bbox[0] + aoi.bbox[2]) / 2, (aoi.bbox[1] + aoi.bbox[3]) / 2];

  if (f.archive) {
    lamp('stac', 'busy', 'STAC: searching');
    jobs.push(searchScenes(f, aoi, now - S.lookbackDays * DAY, now, S.cloudMax, signal).then((r) => {
      S.scan.acquired = r.records;
      if (r.truncated) S.scan.notes.push('ARCHIVE LIST CAPPED AT 500 SCENES');
      lamp('stac', 'ok', `STAC: ${r.records.length} scenes`);
    }).catch((e) => { if (!signal.aborted) { lamp('stac', 'err', `STAC: ${e.message}`); S.scan.notes.push(`ARCHIVE: ${e.message}`); } }));
  }
  if (f.plan) {
    lamp('esa', 'busy', 'ESA plans: loading (first load downloads the plan files)');
    jobs.push(fetchPlans(f, aoi, now - DAY, now + S.aheadDays * DAY, map, signal).then((r) => {
      S.scan.tasking.push(...r.records);
      lamp('esa', 'ok', `ESA plans: ${r.records.length} acquisitions`);
    }).catch((e) => { if (!signal.aborted) { lamp('esa', 'err', `ESA plans: ${e.message}`); S.scan.notes.push(`PLANS: ${e.message}`); } }));
  } else if (f.geom) {
    jobs.push(predict(f, centre, now, now + S.aheadDays * DAY, (p) => {
      progress = p;
      const bar = $('#scan-progress');
      if (bar) { bar.classList.remove('indet'); bar.firstChild.style.width = `${Math.round(p * 100)}%`; }
    }, signal).then((r) => { S.scan.tasking.push(...r); }));
  }
  await Promise.allSettled(jobs);
  if (signal.aborted) return;
  S.scan.tasking.sort((a, b) => a.time - b.time);
  S.scan.busy = false;
  view = S.scan.acquired.length || !S.scan.tasking.length ? 'acquired' : 'tasking';
  if (!f.archive) view = 'tasking';
  renderMission();
  drawFootprints();
  emit('scan');
  const n = S.scan.acquired.length + S.scan.tasking.length;
  toast(`${f.name}: ${S.scan.acquired.length} ACQUIRED · ${S.scan.tasking.length} AHEAD`, n ? '' : 'warn');
}

// ------------------------------------------------------------------ results

function resultsSection(f) {
  const sc = S.scan && S.scan.fid === f.id ? S.scan : null;
  if (!sc) return null;
  const list = view === 'acquired' ? sc.acquired : sc.tasking;
  const tabs = el('div.subtabs', null,
    f.archive ? el('button', { class: view === 'acquired' ? 'on' : '', onclick: () => { view = 'acquired'; renderMission(); } }, 'ACQUIRED', el('b', null, sc.acquired.length)) : null,
    el('button', { class: view === 'tasking' ? 'on' : '', onclick: () => { view = 'tasking'; renderMission(); } }, f.plan ? 'TASKING PLAN' : 'PREDICTED', el('b', null, sc.tasking.length)));
  const now = clock.now();
  const rows = list.slice(0, 400).map((r) => {
    const row = el('div.rec', { class: `${r.kind} ${S.record && S.record.id === r.id ? 'sel' : ''}`, style: { '--c': r.color }, onclick: () => focusRecord(r, true) },
      el('i.bar'),
      el('div.when', null, `${dmon(r.time)} ${hm(r.time)}`, el('small', null, tminus(r.time, now))),
      el('div.what', null, el('b', null, r.platform), r.sub.join(' · ')),
      r.cloud != null ? el('div.cc', { style: { '--p': `${r.cloud}%` } }, `${r.cloud.toFixed(0)}%`, el('i'))
        : el('div.cc.k', null, r.kind === 'planned' ? 'PLAN' : r.kind === 'predicted' ? 'GEOM' : ''));
    row.addEventListener('mouseenter', () => hoverRecord(r.id));
    row.addEventListener('mouseleave', () => hoverRecord(null));
    return row;
  });
  return el('div.sec', null,
    tabs,
    sc.notes.length ? el('div.note', { style: { 'margin-bottom': '6px', color: 'var(--sun)' } }, sc.notes.join(' · ')) : null,
    S.record ? detail(S.record) : null,
    rows.length ? el('div', null, rows) : el('div.empty', null, sc.busy ? 'WORKING…' : view === 'acquired' ? 'NO SCENES IN WINDOW' : 'NO PASSES IN WINDOW'),
    view === 'tasking' && !f.plan && sc.tasking.length ? el('div.note', { style: { 'margin-top': '8px' } },
      f.geom.mode === 'agile' ? 'OPPORTUNITIES ONLY: WHEN THE SENSOR COULD POINT HERE. OPERATOR TASKING IS NOT PUBLIC.' : 'PREDICTED FROM CURRENT ELEMENTS AND SWATH GEOMETRY.') : null);
}

let hovered = null;
function hoverRecord(id) { hovered = id; drawFootprints(); }

export function focusRecord(r, fly) {
  S.record = r;
  if (r && fly) {
    const [w, s, e, n] = r.bbox;
    if (e - w < 300) map.fitBounds([[w, s], [e, n]], { padding: { top: 110, bottom: 160, left: 340, right: 420 }, maxZoom: 9, duration: 1100 });
  }
  renderMission();
  drawFootprints();
  emit('record', r);
}
export function clearRecord() { focusRecord(null); }

function detail(r) {
  const f = S.fleets.get(r.fid);
  const box = el('div.sec', { style: { margin: '0 -12px 10px', 'border-top': '1px solid var(--ph-4)', background: 'rgba(255,180,59,0.035)' } });
  const head = el('div.sec-h', null, r.kind === 'scene' ? 'SCENE' : r.kind === 'planned' ? 'PLANNED ACQUISITION' : 'PREDICTED PASS', el('b', null, r.platform));
  const kv = el('div.kv', null,
    el('span', null, 'TIME'), el('span', null, `${stamp(r.time)} · ${tminus(r.time, clock.now())}`),
    el('span', null, 'PLATFORM'), el('span', null, r.sat ? r.sat.name : r.platform),
    el('span', null, 'DETAIL'), el('span', null, r.sub.join(' · ') || '—'),
    r.cloud != null ? [el('span', null, 'CLOUD'), el('span', null, `${r.cloud.toFixed(1)}%`)] : null,
    r.kind === 'scene' ? [el('span', null, 'ITEM'), el('span', { style: { 'font-size': '9.5px' } }, r.id)] : null);
  box.append(head);
  if (r.kind !== 'scene') {
    box.append(kv, el('div.btn-row', { style: { 'margin-top': '10px' } },
      el('button.btn.cmd', { onclick: () => { clock.setRate(1); clock.set(r.time - 90000); if (r.sat) selectSat(r.sat.id); toast('CLOCK SET 90 S BEFORE PASS'); } }, 'RUN CLOCK TO PASS'),
      r.sat ? el('button.btn', { onclick: () => selectSat(r.sat.id, true) }, 'TRACK SAT') : null,
      el('button.btn', { onclick: () => clearRecord() }, 'CLOSE')));
    return box;
  }
  const hero = el('div.scene-hero', null, el('div.ph', null, 'LOADING QUICKLOOK…'), el('span.corner', null, `${f.name} · ${dmon(r.time)}`));
  const list = presets(r.collection, r.props);
  let pick = (S.rendered.find((x) => x.rec.id === r.id) || {}).preset || list[0];
  const hint = el('div.hint', null, pick.hint);
  const grid = el('div.preset-grid');
  const img = el('img', { alt: 'Scene quicklook', loading: 'lazy' });
  const setImg = () => {
    img.src = quicklook(r.collection, r.id, pick.q);
    img.onload = () => { hero.querySelector('.ph')?.remove(); };
    img.onerror = () => { const ph = hero.querySelector('.ph'); if (ph) ph.textContent = 'QUICKLOOK UNAVAILABLE'; };
  };
  hero.prepend(img);
  const drawGrid = () => grid.replaceChildren(...list.map((p) => el('button', { class: p.id === pick.id ? 'on' : '', title: p.hint, onclick: () => {
    pick = p; hint.textContent = p.hint; drawGrid(); setImg();
    const on = S.rendered.find((x) => x.rec.id === r.id);
    if (on) { on.preset = p; drawRendered(); }
  } }, p.label)));
  drawGrid();
  setImg();
  const onBoard = S.rendered.some((x) => x.rec.id === r.id);
  const quality = el('select', { 'aria-label': 'Render quality' }, Object.entries(QUALITY).map(([k, q]) => el('option', { value: k, selected: k === 'std' }, q.label)));
  const bands = el('div', null, el('div.note', null, 'LOADING BANDS…'));
  fetchItem(r).then((item) => {
    const { main, rest } = bandsFor(r.collection, item.assets || {});
    const link = (a) => el('a', { href: downloadUrl(r.collection, r.id, a), title: `Download ${a} as cloud-optimised GeoTIFF` }, a.toUpperCase());
    fill(bands, el('div.bands', null, main.map(link)),
      rest.length ? el('details', { style: { 'margin-top': '6px' } }, el('summary', { class: 'note', style: { cursor: 'pointer' } }, `${rest.length} MORE ASSETS`), el('div.bands', { style: { 'margin-top': '6px' } }, rest.map(link))) : null);
  }).catch(() => bands.replaceChildren(el('div.note.red', null, 'ITEM METADATA UNAVAILABLE')));
  box.append(hero, el('div.sec-h', null, 'VISUALISATION'), grid, hint,
    el('div.btn-row', null,
      el('button.btn.cmd', { class: onBoard ? 'on' : '', onclick: () => {
        if (onBoard) unrender(r.id); else render(r, pick, quality.value);
        renderMission();
      } }, onBoard ? 'ON BOARD ✓' : 'RENDER ON BOARD'),
      quality,
      el('a.btn', { href: exportUrl(r.collection, r.id, pick.q, pick.id), title: 'Save this rendering as PNG', style: { 'line-height': '22px', 'text-decoration': 'none' } }, 'PNG')),
    el('div.sec-h', { style: { 'margin-top': '12px' } }, 'BANDS · GEOTIFF'), bands,
    el('div.sec-h', { style: { 'margin-top': '12px' } }, 'METADATA'), kv,
    el('div.btn-row', { style: { 'margin-top': '10px' } },
      r.sat ? el('button.btn', { onclick: () => selectSat(r.sat.id, true) }, 'TRACK SAT') : null,
      el('a.btn', { href: `https://planetarycomputer.microsoft.com/api/stac/v1/collections/${r.collection}/items/${encodeURIComponent(r.id)}`, target: '_blank', rel: 'noopener', style: { 'line-height': '22px', 'text-decoration': 'none' } }, 'STAC JSON'),
      el('button.btn', { onclick: () => clearRecord() }, 'CLOSE')));
  return box;
}

// ------------------------------------------------------------------ scenes on the board

export function render(rec, preset, quality = 'std') {
  if (S.rendered.length >= MAX_ON_BOARD) { toast(`BOARD HOLDS ${MAX_ON_BOARD} SCENES · REMOVE ONE FIRST`, 'warn'); return; }
  S.rendered.push({ id: `scene-${Date.now().toString(36)}`, rec, preset, quality });
  drawRendered();
  const f = S.fleets.get(rec.fid);
  if (map.getZoom() < f.archive.minzoom) toast(`ZOOM PAST ${f.archive.minzoom} TO SEE THE SCENE`, 'warn');
}
export function unrender(recId) {
  const x = S.rendered.find((r) => r.rec.id === recId);
  if (!x) return;
  removeRaster(x.id);
  S.rendered = S.rendered.filter((r) => r !== x);
  emit('rendered');
}
function drawRendered() {
  // oldest first so the newest render draws on top
  for (const x of S.rendered) {
    const f = S.fleets.get(x.rec.fid), q = QUALITY[x.quality];
    addRaster(x.id, tiles(x.rec.collection, x.rec.id, x.preset.q, x.quality), {
      tileSize: q.size, minzoom: f.archive.minzoom, maxzoom: f.archive.maxzoom, attribution: 'Microsoft Planetary Computer',
      bounds: [Math.max(-180, x.rec.bbox[0]), Math.max(-85, x.rec.bbox[1]), Math.min(180, x.rec.bbox[2]), Math.min(85, x.rec.bbox[3])],
    });
  }
  emit('rendered');
}

function onBoardSection() {
  if (!S.rendered.length) return null;
  return el('div.sec', null, el('div.sec-h', null, 'ON BOARD ', el('b', null, `${S.rendered.length}/${MAX_ON_BOARD}`)),
    el('div.onboard', null, S.rendered.map((x) => el('div', null,
      el('span', null, el('b', null, x.rec.platform), ` ${dmon(x.rec.time)} · ${x.preset.label}`),
      el('button.btn', { onclick: () => focusRecord(x.rec, true) }, 'GO'),
      el('button.btn', { onclick: () => { unrender(x.rec.id); renderMission(); } }, '✕')))));
}

// ------------------------------------------------------------------ footprints layer

export function drawFootprints() {
  const sc = S.scan;
  if (!sc || sc.fid !== S.selected) { setData('footprints', null); emit('footprints'); return; }
  const list = view === 'acquired' && S.fleets.get(sc.fid).archive ? sc.acquired : sc.tasking;
  const feats = list.slice(0, 600).map((r) => ({
    type: 'Feature', geometry: r.geometry,
    properties: { id: r.id, kind: r.kind, color: r.color, sel: (S.record && S.record.id === r.id) || hovered === r.id },
  }));
  if (S.record && !list.includes(S.record)) feats.push({ type: 'Feature', geometry: S.record.geometry, properties: { id: S.record.id, kind: S.record.kind, color: S.record.color, sel: true } });
  setData('footprints', fc(feats));
  emit('footprints');
}

export const scanView = () => view;
export function setView(v) { view = v; renderMission(); drawFootprints(); }

export function allRecords() {
  const sc = S.scan;
  return sc && sc.fid === S.selected ? [...sc.acquired, ...sc.tasking] : [];
}

export function buildMission() {
  $('#right-x').addEventListener('click', () => { emit('close-fleet'); });
  on('fleet', () => { S.record = null; renderMission(); drawFootprints(); });
  on('target', () => { if (S.selected) renderMission(); });
  on('rendered', () => {});
  map.on('moveend', () => {
    const box = $('.aoi-box');
    if (!box || S.target) return;
    const a = aoiDescription();
    box.querySelector('.ico').className = `ico ${a.cls}`;
    box.querySelector('.t').replaceChildren(el('b', null, a.title), el('span', null, a.sub));
  });
  map.on('click', 'fp-fill', (e) => {
    if (S.designating || e.defaultPrevented) return;
    const id = e.features[0].properties.id;
    const r = allRecords().find((x) => x.id === id);
    if (r) { if (r.kind === 'scene') view = 'acquired'; else view = 'tasking'; focusRecord(r, false); }
  });
  map.on('mouseenter', 'fp-fill', () => { if (!S.designating) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'fp-fill', () => { map.getCanvas().style.cursor = ''; });
}
