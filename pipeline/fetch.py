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
    out = {"symbol": symbol, "currency": r["meta"].get("currency"),
           "name": r["meta"].get("longName") or r["meta"].get("shortName") or symbol, "bars": bars}
    with open(path, "w") as f:
        json.dump(out, f)
    return out
