// Bottom timeline: acquired scenes left of NOW, planned / predicted passes right of it.
// Wheel zooms around the cursor, drag pans, double-click resets, click selects.

import { S, clock, on } from './state.js';
import { allRecords, focusRecord } from './mission.js';
import { showTip, hideTip } from './ui.js';
import { $, DAY, HOUR, dmon, hm, tminus, pad } from './util.js';

const C = { ph: '#8dffb8', ph2: '#4fc47f', ph3: '#2a7a4c', ph4: '#123d26', sun: '#ffb43b', bg: 'rgba(0,0,0,0)' };
let cv, g, W = 0, H = 0, dpr = 1;
let range = null;            // [t0, t1] when the user has zoomed / panned
let hits = [];               // [{x0, x1, y0, y1, rec}]
let drag = null;

function span() {
  if (range) return range;
  const now = clock.now();
  const sc = S.scan && S.scan.fid === S.selected ? S.scan : null;
  const f = S.selected && S.fleets.get(S.selected);
  const back = sc && f && f.archive ? S.lookbackDays * DAY : 2 * DAY;
  const ahead = sc ? S.aheadDays * DAY : 2 * DAY;
  return [now - back * 1.02, now + ahead * 1.02];
}

function size() {
  dpr = window.devicePixelRatio || 1;
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw() {
  if (!W) return;
  const [t0, t1] = span();
  const X = (t) => 14 + ((t - t0) / (t1 - t0)) * (W - 28);
  g.clearRect(0, 0, W, H);
  const recs = allRecords();
  $('#tl-empty').hidden = recs.length > 0 || (S.scan && S.scan.busy);
  const axisY = H - 16, laneA = 10, laneB = Math.round(axisY / 2) + 2, laneH = Math.round(axisY / 2) - 10;

  // lanes
  g.fillStyle = 'rgba(141,255,184,0.025)';
  g.fillRect(0, laneA - 4, W, laneH + 4);
  g.font = '500 8px "IBM Plex Mono", monospace';
  g.fillStyle = C.ph3;
  g.fillText('ACQUIRED', 16, laneA + 7);
  g.fillText('AHEAD', 16, laneB + 7);

  // axis ticks: pick a step that keeps labels ~90px apart
  const per = (t1 - t0) / (W / 90);
  const steps = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const step = steps.find((s) => s >= per) || 60 * DAY;
  const minor = step >= DAY ? (step >= 7 * DAY ? DAY : 6 * HOUR) : HOUR;
  g.strokeStyle = C.ph4; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, axisY + 0.5); g.lineTo(W, axisY + 0.5); g.stroke();
  for (let t = Math.ceil(t0 / minor) * minor; t < t1; t += minor) {
    const x = Math.round(X(t)) + 0.5;
    g.beginPath(); g.moveTo(x, axisY); g.lineTo(x, axisY + 3); g.stroke();
  }
  g.fillStyle = C.ph2;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) {
    const x = Math.round(X(t)) + 0.5;
    g.strokeStyle = 'rgba(18,61,38,0.7)';
    g.beginPath(); g.moveTo(x, 4); g.lineTo(x, axisY + 6); g.stroke();
    const d = new Date(t);
    const lbl = step >= DAY ? dmon(t) : `${pad(d.getUTCHours())}00Z${d.getUTCHours() === 0 ? ' ' + dmon(t) : ''}`;
    g.fillText(lbl, x + 3, H - 4);
  }

  // records
  hits = [];
  const sel = S.record && S.record.id;
  for (const r of recs) {
    if (r.time < t0 || r.time > t1) continue;
    const x = X(r.time), w = Math.max(2, Math.min(8, ((r.end - r.time) / (t1 - t0)) * W));
    const future = r.kind !== 'scene';
    const y = future ? laneB : laneA;
    let h = laneH;
    if (r.cloud != null) h = Math.max(6, laneH * (1 - r.cloud / 120));
    g.globalAlpha = sel && sel !== r.id ? 0.55 : 1;
    if (future) {
      g.strokeStyle = r.color; g.lineWidth = 1;
      g.strokeRect(Math.round(x) + 0.5, y + laneH - h + 0.5, Math.round(w), h - 1);
      g.fillStyle = r.color; g.globalAlpha *= 0.25;
      g.fillRect(Math.round(x), y + laneH - h, Math.round(w), h);
    } else {
      g.fillStyle = r.color;
      g.fillRect(Math.round(x), y + laneH - h, Math.round(w), h);
    }
    g.globalAlpha = 1;
    if (sel === r.id) {
      g.strokeStyle = C.sun; g.lineWidth = 1.5;
      g.strokeRect(Math.round(x) - 2.5, y - 2.5, Math.round(w) + 5, laneH + 5);
    }
    hits.push({ x0: x - 3, x1: x + w + 3, y0: y, y1: y + laneH, rec: r });
  }

  // now
  const nx = Math.round(X(clock.now())) + 0.5;
  if (nx > 0 && nx < W) {
    g.strokeStyle = C.sun; g.lineWidth = 1; g.shadowColor = C.sun; g.shadowBlur = 6;
    g.beginPath(); g.moveTo(nx, 2); g.lineTo(nx, axisY + 4); g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = C.sun;
    g.beginPath(); g.moveTo(nx - 4, 0); g.lineTo(nx + 4, 0); g.lineTo(nx, 5); g.fill();
    g.font = '500 8.5px "IBM Plex Mono", monospace';
    g.fillText(clock.live ? 'NOW' : `SIM ${hm(clock.now())}`, nx + 5, 9);
  }
}

function hitAt(e) {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 1e9;
  for (const h of hits) {
    if (y < h.y0 - 3 || y > h.y1 + 3) continue;
    const d = x < h.x0 ? h.x0 - x : x > h.x1 ? x - h.x1 : 0;
    if (d < 4 && d < bd) { bd = d; best = h; }
  }
  return best;
}

export function buildTimeline() {
  cv = $('#tl');
  g = cv.getContext('2d');
  new ResizeObserver(() => { size(); draw(); }).observe(cv);
  size();
  ['scan', 'record', 'footprints', 'fleet'].forEach((e) => on(e, () => { if (e === 'scan' || e === 'fleet') range = null; draw(); }));
  on('clock', draw);
  setInterval(draw, 1000);

  cv.addEventListener('mousemove', (e) => {
    if (drag) {
      const [a, b] = drag.range, dt = ((e.clientX - drag.x) / W) * (b - a);
      range = [a - dt, b - dt]; draw(); return;
    }
    const h = hitAt(e);
    if (!h) { hideTip(); cv.style.cursor = 'crosshair'; return; }
    cv.style.cursor = 'pointer';
    const r = h.rec;
    showTip(e, `<b>${r.platform}</b> · ${r.kind === 'scene' ? 'ACQUIRED' : r.kind === 'planned' ? 'PLANNED' : 'PREDICTED'}<br>${dmon(r.time)} ${hm(r.time)} · ${tminus(r.time, clock.now())}<br><span class="dim">${r.sub.join(' · ')}${r.cloud != null ? ` · CLOUD ${r.cloud.toFixed(0)}%` : ''}</span>`);
  });
  cv.addEventListener('mouseleave', () => { hideTip(); drag = null; });
  cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, range: span(), moved: false }; });
  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const moved = Math.abs(e.clientX - drag.x) > 3;
    drag = null;
    if (!moved && e.target === cv) { const h = hitAt(e); if (h) focusRecord(h.rec, true); }
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [a, b] = span(), r = cv.getBoundingClientRect();
    const f = (e.clientX - r.left) / W, t = a + f * (b - a);
    const k = Math.exp(e.deltaY * 0.0015), w = Math.max(2 * HOUR, Math.min(800 * DAY, (b - a) * k));
    range = [t - f * w, t + (1 - f) * w];
    draw();
  }, { passive: false });
  cv.addEventListener('dblclick', () => { range = null; draw(); });
}
