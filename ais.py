"""
SHAMASH - AIS ship picture.

Two free feeds are merged into one store. Each runs only while a browser has the
shipping layer on, and stops two minutes after the last request.

  fintraffic   Fintraffic Digitraffic REST, Finnish waters and the Baltic approaches.
               No key. Polled once a minute (CC BY 4.0).
  aisstream    aisstream.io WebSocket, whole globe from volunteer shore stations.
               Needs a free key in AISSTREAM_API_KEY and the `websockets` package.

The store keeps the newest report per ship (a stale report never overwrites a newer one)
and a six-hour track sampled every few minutes.
"""

import gzip
import json
import os
import random
import threading
import time
import urllib.request

AGENT = "Shamash/1.0 (open-source earth-observation board)"
IDLE_STOP = 120
SHOW_FOR = 3600
FORGET = 6 * 3600
TRACK_FOR = 6 * 3600
TRACK_EVERY = 150
CAP = 40000

# Category index used by the front end palette.
KINDS = ["cargo", "tanker", "passenger", "fishing", "military", "service", "leisure", "other"]


def kind_of(t, nav):
    t = t or 0
    if 70 <= t <= 79: return 0
    if 80 <= t <= 89: return 1
    if 60 <= t <= 69 or 40 <= t <= 49: return 2
    if t == 30 or (not t and nav == 7): return 3
    if t in (35, 55): return 4
    if 31 <= t <= 34 or 50 <= t <= 59: return 5
    if t in (36, 37) or (not t and nav == 8): return 6
    return 7


def _n(v, lim):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v < lim else None


def _s(v):
    return (v or "").replace("@", " ").strip() or None


class Feed:
    id = label = ""
    credit = ""

    def __init__(self, store):
        self.store = store
        self.state, self.error, self.rate = "STANDBY", None, 0.0
        threading.Thread(target=self._loop, daemon=True, name="ais-" + self.id).start()

    def describe(self):
        return {"id": self.id, "label": self.label, "state": self.state, "error": self.error,
                "rate": round(self.rate, 1), "credit": self.credit}

    def _loop(self):
        backoff = 5
        while True:
            if not self.store.active():
                self.state, self.rate = "STANDBY", 0.0
                time.sleep(1)
                continue
            try:
                wait = self.run()
                backoff = 5
            except Fatal as e:
                self.state, self.error, self.rate = "OFFLINE", str(e), 0.0
                wait = 3600
            except Exception as e:
                self.state, self.error, self.rate = "RETRY", (str(e) or e.__class__.__name__)[:120].upper(), 0.0
                self.store.log("ais/%s:" % self.id, self.error)
                wait, backoff = backoff + random.random() * 4, min(300, backoff * 2)
            end = time.time() + wait
            while time.time() < end and self.store.active():
                time.sleep(1)


class Fatal(Exception):
    pass


class Fintraffic(Feed):
    id, label, credit = "fintraffic", "FINTRAFFIC", "Fintraffic / digitraffic.fi, CC BY 4.0"
    BASE = "https://meri.digitraffic.fi/api/ais/v1/"

    def __init__(self, store):
        self.last_pos = 0
        self.meta_due = 0
        super().__init__(store)

    def _get(self, path, since):
        url = self.BASE + path + ("?from=%d" % since if since else "")
        req = urllib.request.Request(url, headers={"Digitraffic-User": AGENT, "User-Agent": AGENT, "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=40, context=self.store.ssl) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
        return json.loads(body)

    def run(self):
        if self.state != "LIVE":
            self.state = "POLLING"
        now = int(time.time() * 1000)
        if time.time() >= self.meta_due:
            for v in self._get("vessels", 0):
                self.store.static(v.get("mmsi"), {
                    "name": _s(v.get("name")), "call": _s(v.get("callSign")), "dest": _s(v.get("destination")),
                    "type": v.get("shipType") or None, "imo": v.get("imo") or None,
                    "draught": (v["draught"] / 10) if v.get("draught") else None,
                    "length": (v.get("referencePointA") or 0) + (v.get("referencePointB") or 0) or None,
                    "beam": (v.get("referencePointC") or 0) + (v.get("referencePointD") or 0) or None,
                })
            self.meta_due = time.time() + 600
        fc = self._get("locations", self.last_pos - 120000 if self.last_pos else 0)
        n = 0
        for f in fc.get("features", []):
            p = f.get("properties") or {}
            c = (f.get("geometry") or {}).get("coordinates") or [None, None]
            if self.store.position(self.id, p.get("mmsi"), c[1], c[0], _n(p.get("sog"), 102.2), _n(p.get("cog"), 360),
                                   _n(p.get("heading"), 360), p.get("navStat"), (p.get("timestampExternal") or now) / 1000):
                n += 1
        self.last_pos = now
        self.rate = n / 60
        self.state, self.error = "LIVE", None
        return 60


class AisStream(Feed):
    id, label, credit = "aisstream", "AISSTREAM", "aisstream.io"
    TYPES = ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport",
             "ShipStaticData", "StaticDataReport"]

    def run(self):
        key = os.environ.get("AISSTREAM_API_KEY", "").strip()
        if not key:
            raise Fatal("NO KEY - SET AISSTREAM_API_KEY")
        try:
            from websockets.sync.client import connect
        except ImportError:
            raise Fatal("PIP INSTALL WEBSOCKETS")
        self.state, self.error = "LINKING", None
        count, t0 = 0, time.time()
        with connect("wss://stream.aisstream.io/v0/stream", open_timeout=20, close_timeout=3, max_size=2 ** 22) as ws:
            ws.send(json.dumps({"APIKey": key, "BoundingBoxes": [[[-90, -180], [90, 180]]], "FilterMessageTypes": self.TYPES}))
            quiet = time.time()
            while self.store.active():
                try:
                    raw = ws.recv(timeout=5)
                except TimeoutError:
                    if time.time() - quiet > 90:
                        raise ConnectionError("silent for 90 s")
                    continue
                quiet = time.time()
                msg = json.loads(raw)
                if "error" in msg:
                    err = str(msg["error"]).upper()[:120]
                    if "KEY" in err:
                        raise Fatal("KEY REFUSED")
                    raise ConnectionError(err)
                kind = msg.get("MessageType")
                body = (msg.get("Message") or {}).get(kind) or {}
                meta = msg.get("MetaData") or {}
                mmsi = meta.get("MMSI") or body.get("UserID")
                self.state = "LIVE"
                if kind == "ShipStaticData":
                    d = body.get("Dimension") or {}
                    self.store.static(mmsi, {"name": _s(body.get("Name")), "call": _s(body.get("CallSign")),
                                             "dest": _s(body.get("Destination")), "type": body.get("Type") or None,
                                             "imo": body.get("ImoNumber") or None,
                                             "draught": body.get("MaximumStaticDraught") or None,
                                             "length": (d.get("A") or 0) + (d.get("B") or 0) or None,
                                             "beam": (d.get("C") or 0) + (d.get("D") or 0) or None})
                elif kind == "StaticDataReport":
                    a, b = body.get("ReportA") or {}, body.get("ReportB") or {}
                    info = {}
                    if a.get("Valid"):
                        info["name"] = _s(a.get("Name"))
                    if b.get("Valid"):
                        info.update(type=b.get("ShipType") or None, call=_s(b.get("CallSign")))
                    self.store.static(mmsi, info)
                else:
                    self.store.position(self.id, mmsi, body.get("Latitude"), body.get("Longitude"),
                                        _n(body.get("Sog"), 102.2), _n(body.get("Cog"), 360),
                                        _n(body.get("TrueHeading"), 360), body.get("NavigationalStatus"), time.time())
                    if meta.get("ShipName"):
                        self.store.static(mmsi, {"name": _s(meta.get("ShipName"))}, weak=True)
                count += 1
                if time.time() - t0 > 10:
                    self.rate, count, t0 = count / (time.time() - t0), 0, time.time()
        return 0


class AIS:
    def __init__(self, data_dir, log, ssl_context):
        self.log, self.ssl = log, ssl_context
        self.lock = threading.Lock()
        self.ships = {}          # mmsi -> dict
        self.seen = 0
        self.feeds = []
        self._started = False

    def available(self):
        return True

    def active(self):
        return time.time() - self.seen < IDLE_STOP

    def _touch(self):
        self.seen = time.time()
        if not self._started:
            self._started = True
            self.feeds = [Fintraffic(self), AisStream(self)]

    def static(self, mmsi, info, weak=False):
        if not isinstance(mmsi, int) or not 100000000 <= mmsi <= 999999999:
            return
        with self.lock:
            s = self.ships.setdefault(mmsi, {"mmsi": mmsi, "t": 0, "track": [], "via": set()})
            for k, v in info.items():
                if v is not None and not (weak and s.get(k)):
                    s[k] = v

    def position(self, feed, mmsi, lat, lon, sog, cog, hdg, nav, t):
        if not isinstance(mmsi, int) or lat is None or lon is None:
            return False
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            return False
        with self.lock:
            s = self.ships.setdefault(mmsi, {"mmsi": mmsi, "t": 0, "track": [], "via": set()})
            s["via"].add(feed)
            if t <= s["t"]:
                return False
            s.update(lat=lat, lon=lon, sog=sog, cog=cog, hdg=hdg, nav=nav, t=t)
            tr = s["track"]
            if not tr or t - tr[-1][2] > TRACK_EVERY:
                tr.append((round(lon, 5), round(lat, 5), int(t)))
                while tr and t - tr[0][2] > TRACK_FOR:
                    tr.pop(0)
            if len(self.ships) > CAP * 1.5:
                cut = time.time() - FORGET
                self.ships = {k: v for k, v in self.ships.items() if v["t"] > cut}
        return True

    def geojson(self, box):
        self._touch()
        now, parts = time.time(), []
        with self.lock:
            for s in self.ships.values():
                if "lat" not in s or now - s["t"] > SHOW_FOR:
                    continue
                x, y = s["lon"], s["lat"]
                if box:
                    w, so, e, n = box
                    if not (so <= y <= n and ((x >= w or x <= e) if w > e else (w <= x <= e))):
                        continue
                hdg = s.get("hdg") if s.get("hdg") is not None else (s.get("cog") or 0)
                moving = (s.get("sog") or 0) >= 0.5
                parts.append('{"type":"Feature","geometry":{"type":"Point","coordinates":[%.5f,%.5f]},'
                             '"properties":{"m":%d,"k":%d,"h":%.0f,"v":%d,"n":%s}}'
                             % (x, y, s["mmsi"], kind_of(s.get("type"), s.get("nav")), hdg, moving,
                                json.dumps((s.get("name") or "")[:24])))
                if len(parts) >= CAP:
                    break
        return ('{"type":"FeatureCollection","features":[' + ",".join(parts) + "]}").encode()

    def meta(self):
        self._touch()
        now = time.time()
        with self.lock:
            live = sum(1 for s in self.ships.values() if "lat" in s and now - s["t"] < SHOW_FOR)
        return {"ships": live, "feeds": [f.describe() for f in self.feeds], "kinds": KINDS}

    def ship(self, mmsi):
        self._touch()
        with self.lock:
            s = self.ships.get(mmsi)
            if not s:
                raise ValueError("unknown ship")
            out = {k: v for k, v in s.items() if k not in ("track", "via")}
            out["via"] = sorted(s["via"])
            out["track"] = list(s["track"])
            out["kind"] = KINDS[kind_of(s.get("type"), s.get("nav"))]
        return out

    def command(self, body):
        if body.get("action") == "stop":
            self.seen = 0
            return {"ok": True}
        raise ValueError("unknown action")
