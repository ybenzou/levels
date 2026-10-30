"""Indicator series. Every function returns a list aligned to the input; None during warm-up."""
import math


def sma(xs, n):
    out = [None] * len(xs)
    s = 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= n:
            s -= xs[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(xs, n):
    out = [None] * len(xs)
    if len(xs) < n:
        return out
    k = 2.0 / (n + 1)
    v = sum(xs[:n]) / n
    out[n - 1] = v
    for i in range(n, len(xs)):
        v = xs[i] * k + v * (1 - k)
        out[i] = v
    return out


def stdev(xs, n):
    out = [None] * len(xs)
    for i in range(n - 1, len(xs)):
        w = xs[i - n + 1:i + 1]
        m = sum(w) / n
        out[i] = math.sqrt(sum((x - m) ** 2 for x in w) / n)
    return out


def wilder(xs, n):
    out = [None] * len(xs)
    if len(xs) < n:
        return out
    v = sum(xs[:n]) / n
    out[n - 1] = v
    for i in range(n, len(xs)):
        v = (v * (n - 1) + xs[i]) / n
        out[i] = v
    return out


def true_range(high, low, close):
    tr = [high[0] - low[0]]
    for i in range(1, len(close)):
        tr.append(max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1])))
    return tr


def atr(high, low, close, n=14):
    return wilder(true_range(high, low, close), n)


def rsi(close, n=14):
    out = [None] * len(close)
    if len(close) <= n:
        return out
    gains = [0.0]
    losses = [0.0]
    for i in range(1, len(close)):
        d = close[i] - close[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    ag = sum(gains[1:n + 1]) / n
    al = sum(losses[1:n + 1]) / n
    out[n] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(close)):
        ag = (ag * (n - 1) + gains[i]) / n
        al = (al * (n - 1) + losses[i]) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def macd(close, fast=12, slow=26, sig=9):
    ef, es = ema(close, fast), ema(close, slow)
    line = [None if a is None or b is None else a - b for a, b in zip(ef, es)]
    start = next((i for i, v in enumerate(line) if v is not None), None)
    signal = [None] * len(close)
    if start is not None:
        s = ema(line[start:], sig)
        signal[start:] = s
    hist = [None if a is None or b is None else a - b for a, b in zip(line, signal)]
    return line, signal, hist


def rolling_max(xs, n):
    return [max(xs[i - n + 1:i + 1]) if i >= n - 1 else None for i in range(len(xs))]


def rolling_min(xs, n):
    return [min(xs[i - n + 1:i + 1]) if i >= n - 1 else None for i in range(len(xs))]


def volume_profile(bars, n_bins=48, value_area=0.7):
    """Volume-by-price over `bars`, spreading each bar's volume uniformly across its high-low range."""
    lo = min(b["low"] for b in bars)
    hi = max(b["high"] for b in bars)
    if not hi > lo:
        return None
    step = (hi - lo) / n_bins
    vol = [0.0] * n_bins
    for b in bars:
        v = b["volume"]
        if v <= 0:
            continue
        i0 = max(0, min(n_bins - 1, int((b["low"] - lo) / step)))
        i1 = max(0, min(n_bins - 1, int((b["high"] - lo) / step)))
        share = v / (i1 - i0 + 1)
        for i in range(i0, i1 + 1):
            vol[i] += share
    total = sum(vol)
    if total <= 0:
        return None
    poc = max(range(n_bins), key=lambda i: vol[i])
    covered, L, R = vol[poc], poc, poc
    while covered < total * value_area and (L > 0 or R < n_bins - 1):
        left = vol[L - 1] if L > 0 else -1
        right = vol[R + 1] if R < n_bins - 1 else -1
        if right >= left:
            R += 1
            covered += vol[R]
        else:
            L -= 1
            covered += vol[L]
    return {"lo": lo, "hi": hi, "step": step, "vol": vol,
            "poc": lo + (poc + 0.5) * step, "val": lo + L * step, "vah": lo + (R + 1) * step}


def rolling_vrvp(bars, n=120, n_bins=32, every=1):
    """POC / VAL / VAH using only the trailing `n` bars at each index (no look-ahead)."""
    out = [None] * len(bars)
    last = None
    for i in range(n - 1, len(bars)):
        if (i - (n - 1)) % every == 0 or last is None:
            vp = volume_profile(bars[i - n + 1:i + 1], n_bins)
            last = None if vp is None else (vp["poc"], vp["val"], vp["vah"])
        out[i] = last
    return out


def compute_all(bars):
    o = [b["open"] for b in bars]
    h = [b["high"] for b in bars]
    l = [b["low"] for b in bars]
    c = [b["close"] for b in bars]
    v = [b["volume"] for b in bars]
    sd20 = stdev(c, 20)
    s20 = sma(c, 20)
    line, sig, hist = macd(c)
    ind = {
        "open": o, "high": h, "low": l, "close": c, "volume": v,
        "sma20": s20, "sma50": sma(c, 50), "sma100": sma(c, 100), "sma200": sma(c, 200),
        "ema20": ema(c, 20), "ema50": ema(c, 50), "ema200": ema(c, 200),
        "boll_up": [None if m is None else m + 2 * s for m, s in zip(s20, sd20)],
        "boll_lo": [None if m is None else m - 2 * s for m, s in zip(s20, sd20)],
        "boll_w": [None if m is None or not m else 4 * s / m for m, s in zip(s20, sd20)],
        "atr14": atr(h, l, c, 14),
        "rsi14": rsi(c, 14), "rsi2": rsi(c, 2),
        "macd": line, "macd_sig": sig, "macd_hist": hist,
        # Donchian of the *prior* n bars, so a close can actually break it.
        "don20_hi": [None] + rolling_max(h, 20)[:-1], "don20_lo": [None] + rolling_min(l, 20)[:-1],
        "don55_hi": [None] + rolling_max(h, 55)[:-1], "don55_lo": [None] + rolling_min(l, 55)[:-1],
        "vol20": [None] * len(c),
    }
    rets = [0.0] + [c[i] / c[i - 1] - 1 for i in range(1, len(c))]
    sd = stdev(rets, 20)
    ind["vol20"] = [None if s is None else s * math.sqrt(252) for s in sd]
    ind["ret1"] = rets
    vr = rolling_vrvp(bars, 120, 32, every=1)
    ind["poc"] = [None if x is None else x[0] for x in vr]
    ind["val"] = [None if x is None else x[1] for x in vr]
    ind["vah"] = [None if x is None else x[2] for x in vr]
    return ind
