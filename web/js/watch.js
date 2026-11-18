// WATCH: who sees the focus point next. Every visible fleet, next 48 hours, soonest first.
// Not in the original board: a single answer to "when is the next look at this place?"

import { S, clock, on } from './state.js';
import { fleet, accessWindows } from './orbit.js';
import { selectFleet, selectSat, designate } from './ui.js';
import { el, $, fill, HOUR, MIN, dmon, hm, tminus, fmtPos, toast } from './util.js';

const HORIZON = 48 * HOUR;
let ctl = null, rows = [], busy = false, pct = 0, at = 0;

async function compute() {
  if (ctl) ctl.abort();
  rows = [];
  if (!S.target) { paint(); return; }
  ctl = new AbortController();
  const signal = ctl.signal, target = S.target, now = clock.now();
  busy = true; pct = 0; at = now;
  paint();
  const fleets = [...S.visible].map((id) => S.fleets.get(id)).filter((f) => f && f.geom && fleet.byFleet.get(f.id));
  const out = [];
  let i = 0;
  for (const f of fleets) {
    const w = await accessWindows(fleet.byFleet.get(f.id), f.geom, target, now, now + HORIZON, { limit: 3, signal });
    if (signal.aborted) return;
    for (const p of w.slice(0, 6)) out.push({ f, p });
    pct = ++i / fleets.length;
    rows = [...out].sort((a, b) => a.p.time - b.p.time);
    paint();
  }
  busy = false;
  paint();
}

function paint() {
  const pane = $('#pane-watch');
  const now = clock.now();
  $('#ct-watch').textContent = rows.length ? tminus(rows.find((r) => r.p.time > now)?.p.time ?? now, now).replace('T+', '') : '';
  if (!S.target) {
    fill(pane, el('div.sec', null,
      el('div.sec-h', null, 'NEXT LOOK'),
      el('div.note', null, 'DESIGNATE A FOCUS POINT AND SHAMASH LISTS EVERY VISIBLE FLEET THAT CAN IMAGE IT IN THE NEXT 48 HOURS, SOONEST FIRST.'),
      el('button.btn.cmd.wide', { style: { 'margin-top': '12px' }, onclick: () => designate(true) }, 'DESIGNATE FOCUS')));
    return;
  }
  const upcoming = rows.filter((r) => r.p.time > now);
  const nextOf = (pred) => upcoming.find((r) => pred(r.f));
  const cell = (label, r) => el('div', null, el('small', null, label), el('span', null, r ? tminus(r.p.time, now).replace('T+', '') : '—'));
  const list = el('div.scroll', { style: { flex: '1' } }, upcoming.slice(0, 120).map((r) => el('div.watch-row', {
    style: { '--c': r.f.color }, title: 'Select fleet and track satellite',
    onclick: () => { selectFleet(r.f.id); selectSat(r.p.sat.id, true); },
  },
  el('i.bar'),
  el('div.t', { class: r.p.time - now < 30 * MIN ? 'soon' : '' }, tminus(r.p.time, now).replace('T', ''), el('small', null, `${dmon(r.p.time)} ${hm(r.p.time)}`)),
  el('div.w', null, el('b', null, `${r.p.sat.short} · ${r.f.name}`),
    r.f.geom.mode === 'agile' ? `OFF-NADIR ${r.p.offNadir.toFixed(0)}°` : `${Math.abs(r.p.crossKm).toFixed(0)} KM ${r.p.crossKm >= 0 ? 'R' : 'L'} OF TRACK`,
    ` · ${r.p.asc ? 'ASC' : 'DSC'}`),
  el('div.s', null, r.f.sensor === 'sar' ? 'SAR' : 'EO', el('br'), `${r.p.sun >= 0 ? '+' : ''}${r.p.sun.toFixed(0)}°`))));
  const keep = pane.querySelector('.scroll')?.scrollTop || 0;
  fill(pane, 
    el('div.sec', null,
      el('div.sec-h', null, 'NEXT LOOK ', el('b', null, S.targetLabel ? S.targetLabel.toUpperCase().slice(0, 22) : fmtPos(S.target, 2))),
      el('div.watch-sum', null, cell('ANY SENSOR', upcoming[0]), cell('OPTICAL', nextOf((f) => f.sensor !== 'sar')), cell('RADAR', nextOf((f) => f.sensor === 'sar'))),
      el('div.note', null, busy ? `COMPUTING ${Math.round(pct * 100)}% · ${[...S.visible].length} FLEETS` : `${upcoming.length} OPPORTUNITIES · VISIBLE FLEETS ONLY · OPTICAL NEEDS SUN > 3°`),
      el('div.progress', null, el('i', { style: { width: `${busy ? Math.round(pct * 100) : 100}%` } })),
      el('div.btn-row', { style: { 'margin-top': '8px' } },
        el('button.btn', { onclick: () => compute() }, 'RECOMPUTE'),
        el('button.btn', { onclick: () => { [...S.fleets.keys()].forEach((id) => S.visible.add(id)); toast('ALL FLEETS VISIBLE'); compute(); } }, 'ALL FLEETS'))),
    list);
  list.scrollTop = keep;
}

export function buildWatch() {
  on('target', () => compute());
  on('visible', () => { if (S.target) { clearTimeout(buildWatch.t); buildWatch.t = setTimeout(compute, 600); } });
  on('clock', ({ jump }) => { if (jump && S.target && Math.abs(clock.now() - at) > 20 * MIN) compute(); });
  setInterval(() => { if (!$('#pane-watch').hidden || rows.length) paint(); }, 1000);
  paint();
}
