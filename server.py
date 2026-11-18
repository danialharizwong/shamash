#!/usr/bin/env python3
"""
SHAMASH - earth-observation watch board. Local relay server.

Named for the Mesopotamian sun god who saw everything under the sky. The board shows
which imaging satellites are overhead, what they have already seen, and what they will
see next.

Python 3.9+, standard library only. Serves ./web and a small JSON API for the things a
browser cannot do on its own (cross-origin scrapes, large file caching, signed downloads):

  GET  /api/status            link health and cache ages
  GET  /api/tle               orbital elements for catalogue fleets (CelesTrak, cached 3 h)
  GET  /api/plans             ESA Sentinel-1/-2 acquisition plans as GeoJSON
  GET  /api/firms             NASA FIRMS thermal detections as GeoJSON (meta=1 for counts)
  GET  /api/geo               newest geostationary frame times (GIBS + EUMETView)
  GET  /api/download          stream one band of an open scene with a real filename
  GET  /api/export            stream a rendered PNG of a scene
  GET  /api/ais[...]          ship picture (see ais.py)
  GET|POST /api/intel[...]    Telegram monitor (see intel.py)

Run:  python3 server.py [--port 8700] [--host 127.0.0.1]
"""

import argparse
import array
import calendar
import csv
import gzip
import heapq
import json
import math
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
CACHE = os.path.join(ROOT, ".cache")
DATA = os.path.join(ROOT, "data")
AGENT = "Shamash/1.0 (local open-source earth-observation board)"

for d in (CACHE, DATA, os.path.join(CACHE, "plans"), os.path.join(CACHE, "firms")):
    os.makedirs(d, exist_ok=True)


# ============================================================================ plumbing

# urllib tries addresses in order and waits out a full timeout on each. On networks with
# broken IPv6 that turns a 3-second download into minutes, so try IPv4 first.
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda *a, **k: sorted(_getaddrinfo(*a, **k), key=lambda r: r[0] != socket.AF_INET)


def _ssl():
    ctx = ssl.create_default_context()
    try:
        if not ctx.get_ca_certs():
            import certifi  # type: ignore
            ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    return ctx


SSL = _ssl()


def fetch(url, timeout=60, headers=None):
    h = {"User-Agent": AGENT}
    if headers:
        h.update(headers)
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout, context=SSL)


def get(url, timeout=60, headers=None):
    with fetch(url, timeout, headers) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return data


def log(*a):
    print(time.strftime("%H:%M:%SZ", time.gmtime()), *a, file=sys.stderr, flush=True)


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def age_of(path):
    return time.time() - os.path.getmtime(path) if os.path.exists(path) else None


def write_atomic(path, data, mode="wb"):
    with open(path + ".part", mode) as f:
        f.write(data)
    os.replace(path + ".part", path)


def parse_box(text):
    vals = [float(v) for v in text.split(",")]
    if len(vals) != 4 or not all(math.isfinite(v) for v in vals):
        raise ValueError("box must be west,south,east,north")
    return vals


# ============================================================================ orbital elements

CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"
TLE_TTL = 3 * 3600                  # CelesTrak asks clients not to pull more than every 2 h
_tle_lock = threading.Lock()


def catalog():
    with open(os.path.join(WEB, "catalog.json"), encoding="utf-8") as f:
        return json.load(f)


def tle():
    path = os.path.join(CACHE, "tle-active.txt")
    stale, error = False, None
    with _tle_lock:
        age = age_of(path)
        if age is None or age > TLE_TTL:
            try:
                raw = get(CELESTRAK, 45).decode("ascii", "replace")
                if raw.count("\n") < 300 or not re.search(r"^1 \d{5}", raw, re.M):
                    raise ValueError("CelesTrak returned: " + raw[:80].strip())
                write_atomic(path, raw, "w")
                log("elements refreshed from CelesTrak")
            except Exception as e:
                error = str(e)
                log("element refresh failed:", error)
                if age is None:
                    raise
                stale = True
        with open(path) as f:
            lines = [ln.rstrip() for ln in f if ln.strip()]
        fetched = os.path.getmtime(path)

    rules = [(c["id"], [re.compile(p) for p in c["match"]]) for c in catalog()["fleets"]]
    sats = []
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i].strip(), lines[i + 1], lines[i + 2]
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            continue
        for fid, pats in rules:
            if any(p.search(name) for p in pats):
                sats.append({"f": fid, "name": name, "norad": int(l1[2:7]), "l1": l1, "l2": l2})
                break
    return {"fetchedAt": iso(fetched), "stale": stale, "error": error, "sats": sats}


# ============================================================================ ESA acquisition plans

ESA = "https://sentinels.copernicus.eu"
PLAN_PAGES = {
    "sentinel-1": ESA + "/web/sentinel/copernicus/sentinel-1/acquisition-plans",
    "sentinel-2": ESA + "/web/sentinel/copernicus/sentinel-2/acquisition-plans",
}
PLAN_HREF = re.compile(
    r'href="(/documents/d/sentinel/(s[12][a-d])_mp_[a-z_]*?(\d{8}t\d{6})_(\d{8}t\d{6})[^"]*)"', re.I)
_plan_lock = threading.Lock()
_plan_index = {}                    # mission -> (checked, [(sat, start, end, url)])
_plan_mem = {}                      # url -> [record]


def _stamp(s):
    return calendar.timegm(time.strptime(s.upper(), "%Y%m%dT%H%M%S"))


def _kml_ts(s):
    s = s.strip().rstrip("Z").split(".")[0]
    return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%S"))


def _continuous(ring):
    out, prev = [], None
    for x, y in ring:
        if prev is not None:
            while x - prev > 180:
                x -= 360
            while x - prev < -180:
                x += 360
        out.append([round(x, 5), round(y, 5)])
        prev = x
    return out


def _plan_files(mission):
    hit = _plan_index.get(mission)
    if hit and time.time() - hit[0] < 6 * 3600:
        return hit[1]
    html = get(PLAN_PAGES[mission], 45).decode("utf-8", "replace")
    per_sat = {}
    for href, sat, a, b in set(PLAN_HREF.findall(html)):
        per_sat.setdefault(sat.upper(), []).append((_stamp(a), _stamp(b), ESA + href))
    now, keep = time.time(), []
    for sat, files in per_sat.items():
        files.sort(reverse=True)
        for start, end, url in files:          # newest first, back until "now" is covered
            if end <= now:
                continue
            keep.append((sat, start, end, url))
            if start <= now:
                break
    _plan_index[mission] = (time.time(), keep)
    log("plan index %s: %d file(s)" % (mission, len(keep)))
    return keep


def _parse_kml(text, sat):
    out = []
    for m in re.finditer(r"<Placemark>(.*?)</Placemark>", text, re.S):
        body = m.group(1)
        b = re.search(r"<begin>([^<]+)</begin>", body)
        e = re.search(r"<end>([^<]+)</end>", body)
        c = re.search(r"<coordinates>([^<]+)</coordinates>", body)
        if not (b and e and c):
            continue
        ring = []
        for tok in c.group(1).split():
            p = tok.split(",")
            if len(p) >= 2:
                ring.append((float(p[0]), float(p[1])))
        if len(ring) < 4:
            continue
        ring = _continuous(ring)
        attrs = dict(re.findall(r'<Data name="([^"]+)">\s*<value>([^<]*)</value>', body))
        try:
            t0, t1 = _kml_ts(b.group(1)), _kml_ts(e.group(1))
        except ValueError:
            continue
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        out.append({
            "sat": attrs.get("SatelliteId", sat), "t0": t0, "t1": t1,
            "id": "%s-%s" % (sat, attrs.get("DatatakeId") or attrs.get("ID") or t0),
            "mode": attrs.get("Mode", ""), "pol": attrs.get("Polarisation", ""),
            "orbit": attrs.get("OrbitRelative", ""), "ring": ring,
            "bbox": [min(xs), min(ys), max(xs), max(ys)],
        })
    return out


def _plan_records(url, sat):
    if url in _plan_mem:
        return _plan_mem[url]
    path = os.path.join(CACHE, "plans", url.rsplit("/", 1)[-1] + ".json")
    if os.path.exists(path):
        with open(path) as f:
            recs = json.load(f)
    else:
        log("downloading plan", url.rsplit("/", 1)[-1])
        recs = _parse_kml(get(url, 120).decode("iso-8859-1", "replace"), sat)
        write_atomic(path, json.dumps(recs, separators=(",", ":")), "w")
    _plan_mem[url] = recs
    return recs


def _inside(x, y, ring):
    hit, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def _cross(a, b, c, d):
    o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return (o(a, b, c) > 0) != (o(a, b, d) > 0) and (o(c, d, a) > 0) != (o(c, d, b) > 0)


def _touches(rec, w, s, e, n):
    ring, (bw, bs, be, bn) = rec["ring"], rec["bbox"]
    if bn < s or bs > n:
        return False
    for k in (-360, 0, 360):
        W, E = w + k, e + k
        if be < W or bw > E:
            continue
        if any(W <= x <= E and s <= y <= n for x, y in ring):
            return True
        box = [(W, s), (E, s), (E, n), (W, n)]
        if any(_inside(x, y, ring) for x, y in box):
            return True
        for i in range(len(ring) - 1):
            for j in range(4):
                if _cross(ring[i], ring[i + 1], box[j], box[(j + 1) % 4]):
                    return True
    return False


def plans(mission, start, end, box, limit=1500):
    if mission not in PLAN_PAGES:
        raise ValueError("unknown mission")
    with _plan_lock:
        files = [(sat, fs, _plan_records(url, sat), url) for sat, fs, _fe, url in _plan_files(mission)]
    newest = {}
    for sat, fs, _r, _u in files:
        newest[sat] = max(newest.get(sat, 0), fs)
    feats, seen = [], set()
    for sat, fs, recs, _u in files:
        for r in recs:
            if r["t1"] < start or r["t0"] > end:
                continue
            if fs < newest[sat] and r["t0"] >= newest[sat]:   # superseded by a newer plan
                continue
            key = (r["id"], r["t0"])
            if key in seen or (box and not _touches(r, *box)):
                continue
            seen.add(key)
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [r["ring"]]},
                          "properties": {"id": r["id"], "platform": r["sat"], "datetime": iso(r["t0"]),
                                         "end": iso(r["t1"]), "mode": r["mode"], "pol": r["pol"],
                                         "relOrbit": r["orbit"]}})
    feats.sort(key=lambda f: f["properties"]["datetime"])
    return {"type": "FeatureCollection", "features": feats[:limit], "truncated": len(feats) > limit,
            "sources": [u.rsplit("/", 1)[-1] for _s, _f, _r, u in files]}


# ============================================================================ FIRMS thermal detections

FIRMS = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
FIRMS_FEEDS = [  # key, folder, prefix, family, default satellite code
    ("n20", "noaa-20-viirs-c2", "J1_VIIRS_C2", "viirs", 0),
    ("n21", "noaa-21-viirs-c2", "J2_VIIRS_C2", "viirs", 1),
    ("snpp", "suomi-npp-viirs-c2", "SUOMI_VIIRS_C2", "viirs", 2),
    ("modis", "modis-c6.1", "MODIS_C6_1", "modis", 3),
]
FIRMS_SAT = {"N20": 0, "1": 0, "N21": 1, "2": 1, "N": 2, "T": 3, "TERRA": 3, "A": 4, "AQUA": 4}
FIRMS_TTL = 20 * 60
FIRMS_CAP = 150000
_firms_lock = threading.Lock()
_firms_tab = {}
_firms_q = {}


def _firms_table(feed, win):
    key, folder, prefix, _fam, dflt = feed
    name = "%s_Global_%s.csv" % (prefix, win)
    path = os.path.join(CACHE, "firms", name)
    error, age = None, age_of(path)
    if age is None or age > FIRMS_TTL:
        try:
            raw = get("%s/%s/csv/%s" % (FIRMS, folder, name), 180)
            if not raw.startswith(b"latitude"):
                raise ValueError("unexpected FIRMS response")
            write_atomic(path, raw)
        except Exception as e:
            error = str(e)
            log("FIRMS", name, "failed:", error)
            if age is None:
                return {"key": key, "n": 0, "error": error, "fetched": None}
    mtime = os.path.getmtime(path)
    hit = _firms_tab.get((key, win))
    if hit and hit[0] == mtime:
        return dict(hit[1], error=error)
    lon, lat, frp = array.array("f"), array.array("f"), array.array("f")
    when, sat, conf, night = array.array("I"), array.array("B"), array.array("B"), array.array("B")
    with open(path, newline="") as f:
        rd = csv.reader(f)
        col = {c: i for i, c in enumerate(next(rd, []))}
        try:
            iy, ix, idt, itm, ifrp, icf, idn = (col[k] for k in
                                                ("latitude", "longitude", "acq_date", "acq_time", "frp", "confidence", "daynight"))
        except KeyError:
            return {"key": key, "n": 0, "error": "unknown file layout", "fetched": mtime}
        isat = col.get("satellite")
        days = {}
        for r in rd:
            try:
                d = r[idt]
                base = days.get(d)
                if base is None:
                    base = days[d] = calendar.timegm(time.strptime(d, "%Y-%m-%d")) // 60
                hm = r[itm].zfill(4)
                c = r[icf].strip().lower()
                lvl = "lnh".index(c[0]) if c[:1] in ("l", "n", "h") else (0 if float(c) < 30 else 1 if float(c) < 80 else 2)
                lat.append(float(r[iy])); lon.append(float(r[ix])); frp.append(float(r[ifrp] or 0))
                when.append(base + int(hm[:2]) * 60 + int(hm[2:]))
                sat.append(FIRMS_SAT.get(r[isat].strip().upper(), dflt) if isat is not None else dflt)
                conf.append(lvl); night.append(r[idn].strip().upper() == "N")
            except (ValueError, IndexError):
                continue
    t = {"key": key, "n": len(lat), "error": error, "fetched": mtime,
         "lon": lon, "lat": lat, "frp": frp, "when": when, "sat": sat, "conf": conf, "night": night}
    _firms_tab[(key, win)] = (mtime, t)
    log("FIRMS %s: %d detections" % (name, len(lat)))
    return t


def firms(win, family, box):
    if win not in ("24h", "48h", "7d"):
        raise ValueError("window must be 24h, 48h or 7d")
    feeds = [f for f in FIRMS_FEEDS if family in ("all", f[3])]
    if not feeds:
        raise ValueError("unknown sensor family")
    with _firms_lock:
        with ThreadPoolExecutor(4) as pool:
            tabs = list(pool.map(lambda f: _firms_table(f, win), feeds))
        qk = (win, family, tuple(box) if box else None, tuple(t["fetched"] for t in tabs))
        if qk in _firms_q:
            return _firms_q[qk]
        picked, newest = [], 0
        for ti, t in enumerate(tabs):
            if not t["n"]:
                continue
            newest = max(newest, max(t["when"]))
            X, Y, F = t["lon"], t["lat"], t["frp"]
            if box:
                w, s, e, n = box
                wrap = w > e
                for i in range(t["n"]):
                    y = Y[i]
                    if s <= y <= n:
                        x = X[i]
                        if (x >= w or x <= e) if wrap else (w <= x <= e):
                            picked.append((F[i], ti, i))
            else:
                picked.extend((F[i], ti, i) for i in range(t["n"]))
        total = len(picked)
        if total > FIRMS_CAP:
            picked = heapq.nlargest(FIRMS_CAP, picked)
        parts = []
        for _f, ti, i in picked:
            t = tabs[ti]
            parts.append('{"type":"Feature","geometry":{"type":"Point","coordinates":[%.4f,%.4f]},'
                         '"properties":{"f":%.1f,"t":%d,"s":%d,"c":%d,"n":%d}}'
                         % (t["lon"][i], t["lat"][i], t["frp"][i], t["when"][i], t["sat"][i], t["conf"][i], t["night"][i]))
        body = ('{"type":"FeatureCollection","features":[' + ",".join(parts) + "]}").encode()
        got = [t["fetched"] for t in tabs if t["fetched"]]
        meta = {"window": win, "family": family, "total": total, "count": len(picked),
                "truncated": total > len(picked), "fetchedAt": iso(min(got)) if got else None,
                "newest": iso(newest * 60) if newest else None,
                "feeds": [{"key": t["key"], "n": t["n"], "error": t["error"]} for t in tabs]}
        if len(_firms_q) > 6:
            _firms_q.clear()
        _firms_q[qk] = (meta, body)
        return meta, body


# ============================================================================ geostationary frames

EUMETVIEW = "https://view.eumetsat.int/geoserver/ows"
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
EUM_LAYERS = ("mumi:worldcloudmap_ir108", "mumi:wideareacoverage_rgb_natural", "mtg_fd:rgb_geocolour")
GIBS_LAYERS = (("GOES-East_ABI_GeoColor", 7), ("GOES-West_ABI_GeoColor", 7), ("Himawari_AHI_Band13_Clean_Infrared", 6))
_geo = {"at": 0, "data": None}
_geo_lock = threading.Lock()


def _eum_times():
    caps = get(EUMETVIEW + "?service=WMS&request=GetCapabilities&version=1.3.0", 40).decode("utf-8", "replace")
    out = {}
    for layer in EUM_LAYERS:
        i = caps.find("<Name>%s</Name>" % layer)
        j = caps.find("</Layer>", i)
        m = re.search(r'<Dimension name="time"[^>]*default="([^"]+)"', caps[i:j]) if i >= 0 else None
        out[layer] = m.group(1) if m else None
    return out


def _gibs_time(layer, level):
    url = "%s/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=%s&TILEMATRIXSET=GoogleMapsCompatible_Level%d" % (GIBS, layer, level)
    tail = get(url, 40)[-500:].decode("ascii", "replace")
    found = re.findall(r"/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/PT", tail)
    return found[-1] if found else None


def geo_times():
    with _geo_lock:
        if _geo["data"] and time.time() - _geo["at"] < 300:
            return _geo["data"]

        def safe(fn, *a):
            try:
                return fn(*a)
            except Exception as e:
                log("geo frame lookup failed:", repr(e))
                return None
        with ThreadPoolExecutor(4) as pool:
            eum = pool.submit(safe, _eum_times)
            gb = {l: pool.submit(safe, _gibs_time, l, z) for l, z in GIBS_LAYERS}
            data = {"checkedAt": iso(time.time()), "eumetview": eum.result() or {},
                    "gibs": {k: v.result() for k, v in gb.items()}}
        _geo.update(at=time.time(), data=data)
        return data


# ============================================================================ scene downloads

PC = "https://planetarycomputer.microsoft.com/api"
PC_COLLECTIONS = {"sentinel-2-l2a", "sentinel-1-grd", "landsat-c2-l2"}
SAFE = re.compile(r"^[A-Za-z0-9_.\-]+$")


def signed_asset(collection, item, asset):
    if collection not in PC_COLLECTIONS or not SAFE.match(item) or not SAFE.match(asset):
        raise ValueError("bad request")
    doc = json.loads(get("%s/stac/v1/collections/%s/items/%s" % (PC, collection, item), 30))
    href = doc["assets"][asset]["href"]
    if not (urllib.parse.urlparse(href).hostname or "").endswith(".blob.core.windows.net"):
        raise ValueError("asset is not on open blob storage")
    signed = json.loads(get("%s/sas/v1/sign?href=%s" % (PC, urllib.parse.quote(href, safe="")), 30))["href"]
    ext = os.path.splitext(urllib.parse.urlparse(href).path)[1] or ".bin"
    return signed, "%s_%s%s" % (item, asset, ext)


# ============================================================================ HTTP

INTEL = None
AIS = None


class Handler(SimpleHTTPRequestHandler):
    server_version = "Shamash/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]) and not str(args[1] if len(args) > 1 else "").startswith("2"):
            log(self.address_string(), fmt % args)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def reply(self, body, ctype="application/json", status=200):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body, separators=(",", ":")).encode()
        zipped = len(body) > 4096 and "gzip" in self.headers.get("Accept-Encoding", "")
        if zipped:
            body = gzip.compress(body, 1)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if zipped:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def relay(self, url, filename, ctype=None):
        try:
            up = fetch(url, 120)
        except urllib.error.HTTPError as e:
            return self.reply({"error": "upstream %s" % e.code, "detail": e.read(300).decode("utf-8", "replace")}, status=502)
        with up:
            self.send_response(200)
            self.send_header("Content-Type", ctype or up.headers.get("Content-Type", "application/octet-stream"))
            n = up.headers.get("Content-Length")
            if n:
                self.send_header("Content-Length", n)
            else:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
            self.end_headers()
            try:
                while True:
                    chunk = up.read(262144)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def same_origin(self):
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "none"):
            return False
        origin = self.headers.get("Origin")
        return not origin or urllib.parse.urlparse(origin).netloc == self.headers.get("Host")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path not in ("/api/intel", "/api/ais"):
                return self.reply({"error": "not found"}, status=404)
            if not self.same_origin() or "application/json" not in self.headers.get("Content-Type", ""):
                return self.reply({"error": "forbidden"}, status=403)
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n < 8192:
                raise ValueError("bad request")
            body = json.loads(self.rfile.read(n))
            if not isinstance(body, dict):
                raise ValueError("bad request")
            if path == "/api/ais":
                return self.reply(AIS.command(body))
            return self.reply(INTEL.command(body))
        except (ValueError, KeyError, TypeError) as e:
            return self.reply({"error": str(e) or "bad request"}, status=400)
        except Exception as e:
            log("API error", path, repr(e))
            return self.reply({"error": str(e) or e.__class__.__name__}, status=502)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[-1] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            p = u.path
            if p.startswith("/api/intel") or p.startswith("/api/ais"):
                if not self.same_origin():
                    return self.reply({"error": "forbidden"}, status=403)
            if p == "/api/intel":
                return self.reply(INTEL.snapshot(int(q.get("since", "0")), watching=not q.get("peek")))
            if p == "/api/ais":
                box = parse_box(q["bbox"]) if "bbox" in q else None
                return self.reply(AIS.geojson(box), "application/geo+json")
            if p == "/api/ais/meta":
                return self.reply(AIS.meta())
            if p == "/api/ais/ship":
                return self.reply(AIS.ship(int(q.get("mmsi", "0"))))
            if p == "/api/status":
                return self.reply({"ok": True, "time": iso(time.time()),
                                   "tleAge": age_of(os.path.join(CACHE, "tle-active.txt")),
                                   "ais": AIS.available(), "intel": INTEL.available()})
            if p == "/api/tle":
                return self.reply(tle())
            if p == "/api/plans":
                now = time.time()
                box = None
                if "bbox" in q:
                    box = parse_box(q["bbox"])
                elif "lon" in q and "lat" in q:
                    x, y = float(q["lon"]), float(q["lat"])
                    box = [x - 0.01, y - 0.01, x + 0.01, y + 0.01]
                return self.reply(plans(q.get("mission", ""), float(q.get("start", now)),
                                        float(q.get("end", now + 7 * 86400)), box))
            if p == "/api/firms":
                meta, body = firms(q.get("win", "24h"), q.get("src", "all"), parse_box(q["bbox"]) if "bbox" in q else None)
                return self.reply(meta if q.get("meta") else body, "application/json" if q.get("meta") else "application/geo+json")
            if p == "/api/geo":
                return self.reply(geo_times())
            if p == "/api/download":
                url, name = signed_asset(q.get("collection", ""), q.get("item", ""), q.get("asset", ""))
                return self.relay(url, name)
            if p == "/api/export":
                col, item = q.get("collection", ""), q.get("item", "")
                if col not in PC_COLLECTIONS or not SAFE.match(item):
                    raise ValueError("bad request")
                viz = q.get("viz", "")
                if len(viz) > 800 or not re.match(r"^[A-Za-z0-9_=&%+.,;:()*/|\-]*$", viz):
                    raise ValueError("bad visualisation")
                size = max(256, min(4096, int(q.get("size", "2048"))))
                tag = re.sub(r"[^A-Za-z0-9_\-]", "", q.get("name", "render"))[:40] or "render"
                return self.relay("%s/data/v1/item/preview.png?collection=%s&item=%s&%s&max_size=%d" % (PC, col, item, viz, size),
                                  "%s_%s.png" % (item, tag), "image/png")
            return self.reply({"error": "not found"}, status=404)
        except (ValueError, KeyError) as e:
            return self.reply({"error": str(e) or "bad request"}, status=400)
        except Exception as e:
            log("API error", u.path, repr(e))
            return self.reply({"error": str(e) or e.__class__.__name__}, status=502)


def main():
    global INTEL, AIS
    ap = argparse.ArgumentParser(description="Shamash earth-observation watch board")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default: this machine only)")
    ap.add_argument("--port", type=int, default=8700)
    ap.add_argument("--intel-budget", type=float, default=0.50, metavar="USD",
                    help="daily cap on Intel model spend (default 0.50)")
    a = ap.parse_args()
    import ais
    import intel
    AIS = ais.AIS(DATA, log, SSL)
    INTEL = intel.Intel(DATA, CACHE, get, log, SSL, a.intel_budget)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    host = "localhost" if a.host in ("127.0.0.1", "0.0.0.0") else a.host
    print("\n  SHAMASH  //  earth-observation watch board\n  on watch at  http://%s:%d/\n  Ctrl-C to stand down\n" % (host, a.port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  standing down")


if __name__ == "__main__":
    main()
