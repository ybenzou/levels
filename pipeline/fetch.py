"""Daily OHLCV from Yahoo's v8 chart endpoint (split-adjusted, stdlib only)."""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone

CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
# Yahoo rate-limits full browser UA strings from datacenter IPs; the bare token is accepted.
UA = "Mozilla/5.0"


def _get(url, retries=4):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # network hiccups / 429
            last = e
            time.sleep(2 ** (i + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def fetch_daily(symbol, rng="10y", use_cache=False, cache_max_age_h=12):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{symbol}.json")
    if use_cache and os.path.exists(path) and time.time() - os.path.getmtime(path) < cache_max_age_h * 3600:
        with open(path) as f:
            return json.load(f)

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={rng}&interval=1d&events=div%2Csplit"
    d = _get(url)
    res = (d.get("chart") or {}).get("result")
    if not res:
        raise RuntimeError(f"no data for {symbol}: {(d.get('chart') or {}).get('error')}")
    r = res[0]
    ts = r.get("timestamp") or []
    q = r["indicators"]["quote"][0]
    tz_off = r["meta"].get("gmtoffset", 0)
    bars = []
    for i, t in enumerate(ts):
        o, h, l, c, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c):
            continue
        date = datetime.fromtimestamp(t + tz_off, tz=timezone.utc).strftime("%Y-%m-%d")
        bar = {"date": date, "open": round(o, 4), "high": round(h, 4), "low": round(l, 4),
               "close": round(c, 4), "volume": int(v or 0)}
        if bars and bars[-1]["date"] == date:
            bars[-1] = bar
        else:
            bars.append(bar)
    reg = ((r["meta"].get("currentTradingPeriod") or {}).get("regular") or {})
    if bars and ts and reg.get("start") and ts[-1] >= reg["start"] and time.time() < reg.get("end", 0):
        bars.pop()  # today's session is still open: its daily bar is not a close yet
    out = {"symbol": symbol, "currency": r["meta"].get("currency"),
           "name": r["meta"].get("longName") or r["meta"].get("shortName") or symbol, "bars": bars}
    with open(path, "w") as f:
        json.dump(out, f)
    return out


def fetch_live(symbol):
    """Latest trade incl. pre/post-market from 5-minute bars of the current trading day."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=5m&includePrePost=true"
    r = (_get(url, retries=2).get("chart") or {}).get("result")
    if not r:
        return None
    r = r[0]
    m = r["meta"]
    ts = r.get("timestamp") or []
    q = r["indicators"]["quote"][0]
    pts = [(t, q["high"][i], q["low"][i], q["close"][i]) for i, t in enumerate(ts)
           if q["close"][i] is not None and q["high"][i] is not None and q["low"][i] is not None]
    if not pts:
        return None
    per = m.get("currentTradingPeriod") or {}
    t = pts[-1][0]
    session = "closed"
    for k in ("pre", "regular", "post"):
        p = per.get(k) or {}
        if p.get("start", 0) <= t < p.get("end", 0):
            session = k
    off = m.get("gmtoffset", 0)
    return {"price": round(pts[-1][3], 2), "open": round(pts[0][3], 2), "time": datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "date": datetime.fromtimestamp(t + off, tz=timezone.utc).strftime("%Y-%m-%d"), "session": session,
            "high": round(max(x[1] for x in pts), 2), "low": round(min(x[2] for x in pts), 2)}
