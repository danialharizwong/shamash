// Boot and wiring.

import { S, clock, on, readHash, writeHash } from './state.js';
import { createMap, map, drawShamash, drawSun } from './map.js';
import { loadElements, fleet } from './orbit.js';
import { frame, startTracks } from './board.js';
import * as ui from './ui.js';
import { buildMission, renderMission, clearRecord, drawFootprints } from './mission.js';
import { buildTimeline } from './timeline.js';
import { buildWatch } from './watch.js';
import { buildFirms } from './firms.js';
import { buildLive } from './live.js';
import { buildAis } from './ais.js';
import { buildIntel } from './intel.js';
import { $, el, getJSON, ago, toast } from './util.js';

const log = (msg, cls = '') => {
  const line = el('span', { class: cls }, msg + '\n');
  $('#boot-log').append(line);
  $('#boot-log').scrollTop = 1e6;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function marks() {
  const paint = (id, size) => {
    const c = $(id), g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    drawShamash(g, size);
  };
  paint('#brand-mark', 88);
  paint('#boot-mark', 240);
}

async function boot() {
  marks();
  log('SHAMASH WATCH BOARD · MK I');
  log('BEARER OF LIGHT, WHO SEES ALL BENEATH THE SKY', 'dim');
  await wait(180);

  const hash = readHash();
  const view = hash.v ? hash.v.split(',').map(Number) : null;
  log('> CATALOGUE ......................');
  S.catalog = await getJSON('catalog.json');
  for (const f of S.catalog.fleets) { S.fleets.set(f.id, f); if (f.on) S.visible.add(f.id); }
  $('#boot-log').lastChild.textContent = `> CATALOGUE ...................... ${S.catalog.fleets.length} FLEETS\n`;

  log('> GLOBE ..........................');
  const mapReady = createMap(view && view.every(Number.isFinite) ? view : null);

  log('> ORBITAL ELEMENTS · CELESTRAK ...');
  ui.buildLamps();
  ui.lamp('orbit', 'busy', 'Orbital elements: loading');
  let ok = true;
  try {
    await loadElements();
    ui.lamp('orbit', fleet.stale ? 'err' : 'ok', `Orbital elements: ${fleet.sats.length} satellites · fetched ${ago(fleet.fetchedAt, Date.now())}${fleet.stale ? ' · STALE' : ''}`);
    log(`  ${fleet.sats.length} SATELLITES · ELEMENTS ${ago(fleet.fetchedAt, Date.now())}${fleet.stale ? ' · STALE' : ''}`, fleet.stale ? 'warn' : 'ok');
  } catch (e) {
    ok = false;
    ui.lamp('orbit', 'err', `Orbital elements: ${e.message}`);
    log(`  FAULT: ${e.message}`, 'err');
  }

  await mapReady;
  $('#boot-log').children[3].textContent = '> GLOBE .......................... ONLINE\n';
  log('> SUN · TERMINATOR · GRATICULE ...  OK', 'ok');

  // build the board
  ui.buildClock();
  ui.buildDisplay();
  ui.buildLocate();
  ui.buildRoster();
  ui.buildPointer();
  ui.initReticle();
  const tab = ui.buildTabs();
  ui.buildKeys({ clearRecord, tab });
  buildMission();
  buildTimeline();
  buildWatch();
  buildFirms();
  buildLive();
  buildAis();
  buildIntel();
  credits();

  on('close-fleet', () => ui.selectFleet(null));
  on('fleet', () => startTracks());

  // restore a shared view
  if (hash.at) { const t = +hash.at * 1000; if (Number.isFinite(t)) clock.set(t); }
  if (hash.t) { const [x, y] = hash.t.split(',').map(Number); if (Number.isFinite(x) && Number.isFinite(y)) ui.setTarget([x, y]); }
  if (hash.f && S.fleets.has(hash.f)) ui.selectFleet(hash.f); else renderMission();
  if (hash.b && ['imagery', 'live'].includes(hash.b)) ui.setBase(hash.b);

  drawSun(clock.now(), S.night);
  startTracks();
  requestAnimationFrame(frame);
  setInterval(async () => {                         // re-pull elements every 3 h (server caches)
    try { await loadElements(); ui.buildRoster(); } catch { /* keep flying */ }
  }, 3 * 3600 * 1000);

  log(ok ? 'WATCH ESTABLISHED.' : 'WATCH ESTABLISHED WITH FAULTS.', ok ? 'ok' : 'warn');
  $('#boot').classList.add('out');          // CSS handles the delay + fade
  $('#boot').addEventListener('transitionend', () => $('#boot').remove(), { once: true });
  if (!view) map.easeTo({ zoom: 1.9, duration: 2200 });
  if (!ok) toast('ORBITAL ELEMENTS UNAVAILABLE · CHECK THE SERVER LOG', 'err', 8000);
  writeHash(map);
}

function credits() {
  $('#credits').textContent = 'ELEMENTS CELESTRAK · IMAGERY MICROSOFT PLANETARY COMPUTER (COPERNICUS, USGS) · PLANS ESA · FIRMS & GIBS NASA · EUMETSAT · NOAA · JMA · BASEMAP OPENFREEMAP / © OPENSTREETMAP · ESRI · AIS FINTRAFFIC CC BY 4.0, AISSTREAM.IO · PLACES GEONAMES CC BY 4.0';
}

boot().catch((e) => {
  console.error(e);
  log(`BOOT FAULT: ${e.message}`, 'err');
});

window.__shamash = { S, clock, fleet, drawFootprints };
// The board writes the address bar with replaceState (no event); a hashchange means the user pasted a link.
window.addEventListener('hashchange', () => location.reload());
