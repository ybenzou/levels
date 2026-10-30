"""Current key levels + indicator state for the display window (schema of data.json)."""
from indicators import volume_profile

MERGE_PCT = 0.004


def _r(x, d=2):
    return None if x is None else round(x, d)


def _swing_pivots(bars, k=5):
    highs, lows = [], []
    for i in range(k, len(bars) - k):
        h, l = bars[i]["high"], bars[i]["low"]
        if all(h >= bars[j]["high"] for j in range(i - k, i + k + 1)):
            highs.append(i)
        if all(l <= bars[j]["low"] for j in range(i - k, i + k + 1)):
            lows.append(i)
    return highs, lows


def _unfilled_gaps(bars):
    gaps = []
    for i in range(1, len(bars)):
        p, b = bars[i - 1], bars[i]
        if b["low"] > p["high"]:
            edge, d = p["high"], "up"
            filled = any(x["low"] <= edge for x in bars[i + 1:])
        elif b["high"] < p["low"]:
            edge, d = p["low"], "down"
            filled = any(x["high"] >= edge for x in bars[i + 1:])
        else:
            continue
        if not filled:
            gaps.append({"price": edge, "dir": d, "date": b["date"]})
    return gaps[-3:]


def _profile_nodes(vp, max_hvn=4, max_lvn=2):
    vol = vp["vol"]
    n = len(vol)
    srt = sorted(vol)
    med = srt[n // 2]
    hvn, lvn = [], []
    for i in range(1, n - 1):
        px = vp["lo"] + (i + 0.5) * vp["step"]
        if not (vp["val"] <= px <= vp["vah"]):
            continue
        if vol[i] >= vol[i - 1] and vol[i] >= vol[i + 1] and vol[i] > 1.2 * med:
            hvn.append((vol[i], px))
        if vol[i] <= vol[i - 1] and vol[i] <= vol[i + 1] and vol[i] < 0.7 * med:
            lvn.append((vol[i], px))
    hvn.sort(reverse=True)
    lvn.sort()
    return [p for _, p in hvn[:max_hvn]], [p for _, p in lvn[:max_lvn]]


def compute_levels(bars, ind, display_n=252):
    n = len(bars)
    i = n - 1
    w0 = max(0, n - display_n)
    win = bars[w0:]
    px = bars[i]["close"]
    raw = []

    def add(price, role, source, priority):
        if price is None or price <= 0:
            return
        raw.append({"price": price, "role": role, "sources": [source], "priority": priority})

    add(px, "现价 / last close", "Yahoo日K", 0)

    hi_i = max(range(len(win)), key=lambda j: win[j]["high"])
    lo_i = min(range(len(win)), key=lambda j: win[j]["low"])
    hi, lo = win[hi_i]["high"], win[lo_i]["low"]
    add(hi, "近1年波段高点 阻力", f"swingH {win[hi_i]['date']}", 1)
    add(lo, "近1年波段低点 支撑", f"swingL {win[lo_i]['date']}", 1)
    for r, p in ((0.236, 2), (0.382, 1), (0.5, 1), (0.618, 1)):
        add(lo + r * (hi - lo), f"Fib {r * 100:.1f}%（1年高低区间）", "Fib1y", p)

    w80 = bars[max(0, n - 80):]
    h80 = max(range(len(w80)), key=lambda j: w80[j]["high"])
    l80 = min(range(len(w80)), key=lambda j: w80[j]["low"])
    H80, L80 = w80[h80]["high"], w80[l80]["low"]
    leg = "decline" if h80 < l80 else "advance"
    for r in (0.382, 0.5, 0.618):
        lvl = L80 + r * (H80 - L80) if leg == "decline" else H80 - r * (H80 - L80)
        add(lvl, f"Fib {r * 100:.1f}%（近80日{leg}）", "Fib80", 2)
    add(L80, f"近80日低点 {w80[l80]['date']}", "swing80L", 1)
    add(H80, f"近80日高点 {w80[h80]['date']}", "swing80H", 1)

    g = lambda k: ind[k][i]
    add(g("sma20"), "SMA20 短期均线 / 布林中轨", "SMA20", 2)
    add(g("sma50"), "SMA50 中期均线", "SMA50", 2)
    add(g("sma200"), "SMA200 长期均线 / 牛熊分界参考", "SMA200", 1)
    add(g("ema20"), "EMA20", "EMA20", 3)
    add(g("ema50"), "EMA50", "EMA50", 3)
    add(g("boll_up"), "布林上轨 阻力 / 波动上沿", "Boll20+2σ", 1)
    add(g("boll_lo"), "布林下轨 支撑 / 波动下沿", "Boll20-2σ", 1)
    dh = max(b["high"] for b in bars[max(0, n - 20):])
    dl = min(b["low"] for b in bars[max(0, n - 20):])
    add(dh, "Donchian20 上沿 / 近月突破触发", "Don20", 1)
    add(dl, "Donchian20 下沿 / 近月跌破触发", "Don20", 1)
    add(max(b["high"] for b in bars[max(0, n - 55):]), "Donchian55 上沿", "Don55", 2)
    add(min(b["low"] for b in bars[max(0, n - 55):]), "Donchian55 下沿", "Don55", 2)
    a = g("atr14")
    if a:
        add(px + a, "+1 ATR 上沿（日波动参照）", "ATR14", 3)
        add(px - a, "−1 ATR 下沿（日波动参照）", "ATR14", 3)
        add(px + 2 * a, "+2 ATR", "ATR14", 3)
        add(px - 2 * a, "−2 ATR", "ATR14", 3)
    b = bars[i]
    P = (b["high"] + b["low"] + b["close"]) / 3
    add(2 * P - b["low"], "日枢轴 R1 阻力", "Pivot", 2)
    add(2 * P - b["high"], "日枢轴 S1 支撑", "Pivot", 2)
    add(P + (b["high"] - b["low"]), "日枢轴 R2 阻力", "Pivot", 3)
    add(P - (b["high"] - b["low"]), "日枢轴 S2 支撑", "Pivot", 3)

    vp = volume_profile(win, 48)
    if vp:
        add(vp["poc"], "VRVP POC 成交量峰 / 公允价值锚", "VRVP", 1)
        add(vp["vah"], "VRVP VAH 价值区上沿", "VRVP", 1)
        add(vp["val"], "VRVP VAL 价值区下沿", "VRVP", 1)
        hvn, lvn = _profile_nodes(vp)
        for p in hvn:
            add(p, "VRVP HVN 高成交密集区", "VRVP", 2)
        for p in lvn:
            add(p, "VRVP LVN 低成交空隙 / 易穿越区", "VRVP", 3)

    for gp in _unfilled_gaps(win):
        add(gp["price"], f"未补缺口边界 {gp['dir']} {gp['date']}", "gap", 2)

    sh, sl = _swing_pivots(win)
    below = [j for j in sl if win[j]["low"] < px and all(x["close"] >= win[j]["low"] for x in win[j + 1:])]
    above = [j for j in sh if win[j]["high"] > px and all(x["close"] <= win[j]["high"] for x in win[j + 1:])]
    for j in sorted(below, key=lambda j: -win[j]["low"])[:4]:
        add(win[j]["low"], f"前低摆动支撑 {win[j]['date']}", "swingL", 2)
    for j in sorted(above, key=lambda j: win[j]["high"])[:3]:
        add(win[j]["high"], f"前高摆动阻力 {win[j]['date']}", "swingH", 2)

    levels = _merge(raw, px)
    return levels, vp, (hi, lo, win[0]["date"], win[-1]["date"])


def _merge(raw, px):
    raw.sort(key=lambda x: x["price"])
    clusters = []
    for lv in raw:
        if clusters and (lv["price"] / clusters[-1][0]["price"] - 1) <= MERGE_PCT:
            clusters[-1].append(lv)
        else:
            clusters.append([lv])
    out = []
    for cl in clusters:
        anchor = any(x["priority"] == 0 for x in cl)
        lead = min(cl, key=lambda x: (x["priority"], -len(x["role"])))
        price = px if anchor else lead["price"]
        roles, sources = [], []
        for x in sorted(cl, key=lambda x: x["priority"]):
            if x["role"] not in roles:
                roles.append(x["role"])
            for s in x["sources"]:
                if s not in sources:
                    sources.append(s)
        kind = "anchor" if anchor else ("resistance" if price > px else "support")
        out.append({
            "price": round(price, 2),
            "dist_pct": round((price / px - 1) * 100, 2),
            "role": "；".join(roles),
            "sources": sorted(sources),
            "priority": min(x["priority"] for x in cl),
            "kind": kind,
            "lo": round(min(x["price"] for x in cl), 2),
            "hi": round(max(x["price"] for x in cl), 2),
        })
    out.sort(key=lambda x: -x["price"])
    return out


def key_bands(levels):
    bands = []
    for lv in levels:
        if lv["priority"] > 1:
            continue
        label = lv["role"].split("；")[0].split(" / ")[0]
        bands.append({"label": label, "lo": lv["lo"], "hi": lv["hi"], "kind": lv["kind"]})
    return bands


def indicator_state(bars, ind, vp, window):
    i = len(bars) - 1
    px = bars[i]["close"]
    g = lambda k: ind[k][i]
    hi, lo, d0, d1 = window
    hist = ind["macd_hist"]
    last_up = last_dn = None
    for j in range(i, 0, -1):
        if hist[j] is None or hist[j - 1] is None:
            break
        if last_up is None and hist[j] > 0 >= hist[j - 1]:
            last_up = bars[j]["date"]
        if last_dn is None and hist[j] < 0 <= hist[j - 1]:
            last_dn = bars[j]["date"]
        if last_up and last_dn:
            break
    bw = [x for x in ind["boll_w"][max(0, i - 251):i + 1] if x is not None]
    w_pct = sum(1 for x in bw if x <= g("boll_w")) / len(bw) if bw and g("boll_w") else None
    ma = {}
    for k in ("ema20", "ema50", "ema200", "sma20", "sma50", "sma200"):
        v = g(k)
        if v is not None:
            ma[k] = {"val": _r(v), "price": "above" if px > v else "below"}
    st = {
        "window": f"{d0} → {d1}",
        "window_high": _r(hi), "window_low": _r(lo),
        "atr14": _r(g("atr14")), "rsi14": _r(g("rsi14"), 1),
        "macd": {
            "macd": _r(g("macd"), 3), "signal": _r(g("macd_sig"), 3), "hist": _r(g("macd_hist"), 3),
            "vs_signal": "above" if (g("macd_hist") or 0) > 0 else "below",
            "hist_trend_5d": "rising" if i >= 5 and hist[i - 5] is not None and hist[i] > hist[i - 5] else "falling",
            "last_cross_up": last_up, "last_cross_dn": last_dn,
        },
        "ma_stack": ma,
    }
    if g("sma20") is not None:
        st["boll"] = {
            "mid": _r(g("sma20")), "up": _r(g("boll_up")), "lo": _r(g("boll_lo")),
            "width_pctile": _r(w_pct, 3),
            "state": "squeeze" if w_pct is not None and w_pct < 0.2 else ("expanded" if w_pct is not None and w_pct > 0.8 else "normal"),
            "price_vs": "above_mid" if px > g("sma20") else "below_mid",
        }
    if vp:
        st["vrvp"] = {"poc": _r(vp["poc"]), "val": _r(vp["val"]), "vah": _r(vp["vah"]),
                      "price_vs_va": "above_va" if px > vp["vah"] else ("below_va" if px < vp["val"] else "inside_va")}
    return st
