"""观察窗口（近 1/2/3 月）：一组精选价位线、每条线代表什么、线与线之间的区间代表什么。

线的位置只用窗口内的数据（加上当天的均线/布林/唐奇安值）；线和区间的统计全部来自
10 年日线 × 整个训练池，不在窗口里"训练"。
"""
import math

from events import wilson
from levels import _unfilled_gaps

WINDOWS = (("1m", 21, "近1月"), ("2m", 42, "近2月"), ("3m", 63, "近3月"))
DEFAULT_WINDOW = "3m"
MERGE_PCT = 0.004
SWING_K = 3
FIRST_TOUCH_DAYS = 10
PROFILE_BINS = 40

# key: (名称, 分组, 是什么, 怎么看, 回测族)
DEFS = {
    "sma20": ("SMA20 · 20日均线", "ma",
              "过去 20 个交易日（约 1 个月）收盘价的平均，可以看作近 1 个月买入者的平均成本。",
              "价在线上 = 短线偏强，回踩到这里常是第一道支撑；价在线下 = 短线偏弱，反弹到这里常遇卖压。", "SMA20"),
    "sma50": ("SMA50 · 50日均线", "ma",
              "过去 50 个交易日（约一个季度）的平均收盘价，衡量中期趋势。",
              "价在其上 = 中期偏多；有效跌破常意味着中期转弱，重新站回是修复信号。", "SMA50"),
    "sma200": ("SMA200 · 200日均线", "ma",
               "过去 200 个交易日（约一年）的平均收盘价，市场公认的长期牛熊分界。",
               "价在其上 = 长期上升趋势；在其下 = 长期弱势，反弹到这里阻力通常最大。", "SMA200"),
    "boll_up": ("布林上轨", "boll",
                "SMA20 加 2 倍 20 日标准差。按统计口径，大约 95% 的收盘落在上下轨之间。",
                "碰到上轨 = 短期涨得快、偏热，但不等于马上回落；强势时价格会贴着上轨走。", "Boll up"),
    "boll_lo": ("布林下轨", "boll",
                "SMA20 减 2 倍 20 日标准差，统计意义上的正常波动下沿。",
                "碰到下轨 = 短期跌得急、偏冷；弱势时价格会沿下轨下滑，不要单凭它抄底。", "Boll lo"),
    "don20_hi": ("20日最高", "range",
                 "过去 20 个交易日（不含今天）的最高价。",
                 "收盘站上 = 创 1 个月新高，趋势跟踪里的突破触发线。", "Don20 hi"),
    "don20_lo": ("20日最低", "range",
                 "过去 20 个交易日（不含今天）的最低价。",
                 "收盘跌破 = 创 1 个月新低，常用作止损 / 破位参考。", "Don20 lo"),
    "win_hi": ("{w}最高", "range",
               "所选窗口内的最高成交价。",
               "这条线上方近期没人成交过，没有套牢盘；收盘站上 = 创窗口新高。", None),
    "win_lo": ("{w}最低", "range",
               "所选窗口内的最低成交价。",
               "跌破 = 创窗口新低，下方近期没有成交可参考，承接要重新寻找。", None),
    "poc": ("POC · 成交最密价", "vrvp",
            "所选窗口内成交量最大的价位，代表这段时间市场最认可的「公允价」。",
            "价格偏离后常被拉回来；在它上方 = 多数筹码获利，在它下方 = 多数筹码被套。", None),
    "vah": ("VAH · 价值区上沿", "vrvp",
            "窗口内 70% 的成交量集中在 VAL 到 VAH 之间，这是这个区间的上沿。",
            "站稳 VAH 之上 = 市场接受更高的价格；跌回 VAH 以下 = 回到震荡区。", None),
    "val": ("VAL · 价值区下沿", "vrvp",
            "70% 成交集中区的下沿。",
            "跌破 VAL = 价格被拒绝、容易向下寻找新的平衡；守住 = 仍在震荡区内。", None),
    "swing_hi": ("前高 {d}", "swing",
                 "窗口内的一个局部高点（左右各 3 根 K 线都比它低），之后还没有收盘站上过。",
                 "上次涨到这里就掉头，再次接近时常再遇卖压；收盘站上 = 这批卖压被消化。", None),
    "swing_lo": ("前低 {d}", "swing",
                 "窗口内的一个局部低点（左右各 3 根 K 线都比它高），之后没有收盘跌破过。",
                 "上次跌到这里就反弹，再次接近时常有买盘；收盘跌破 = 支撑失效。", None),
    "gap_up": ("向上缺口下沿 {d}", "gap",
               "缺口那天整根 K 线高于前一天的最高价，中间留下一段没有成交的空白，至今未回补。",
               "缺口下沿常成为支撑；跌进缺口后，价格往往会较快走完这段空白。", None),
    "gap_down": ("向下缺口上沿 {d}", "gap",
                 "缺口那天整根 K 线低于前一天的最低价，中间留下一段没有成交的空白，至今未回补。",
                 "缺口上沿常成为压力；涨进缺口后，价格往往会较快走完这段空白。", None),
}
RANK = ["sma200", "sma50", "sma20", "win_hi", "win_lo", "don20_hi", "don20_lo",
        "boll_up", "boll_lo", "poc", "vah", "val", "swing_hi", "swing_lo", "gap_up", "gap_down"]


def _r(x, d=2):
    return None if x is None else round(x, d)


def pooled_hold_stats(runs, years=None):
    """Pool touch→hold counts by family/side across every symbol's 10-year backtest."""
    fam, base = {}, {"support": [0.0, 0], "resistance": [0.0, 0]}
    for bt in runs:
        h = bt["hold"]
        for k, v in h["by_family"].items():
            f = fam.setdefault(k, [0, 0])
            f[0] += v["held"]
            f[1] += v["n"]
        for side in ("support", "resistance"):
            r, n = h.get(f"baseline_{side}"), h["baseline_n"].get(side, 0)
            if r is not None and n:
                base[side][0] += r * n
                base[side][1] += n
    out = {}
    for k, (held, n) in fam.items():
        lo, hi = wilson(held, n)
        out[k] = {"n": n, "rate": round(held / n, 3) if n else None, "ci_lo": lo, "ci_hi": hi}
    return {"by_family": out,
            "baseline": {s: round(v[0] / v[1], 3) if v[1] else None for s, v in base.items()},
            "n_symbols": len(runs), "years": years}


def first_touch(uni, ku, kd, regime_up, days=FIRST_TOUCH_DAYS):
    """Real price paths from the whole universe: starting at a close, which comes first within
    `days` — +ku×ATR or −kd×ATR? Only days in the same long-term regime (vs SMA200) count."""
    up = dn = none = 0.0
    for _, ind in uni.values():
        c, h, l, a, s200 = ind["close"], ind["high"], ind["low"], ind["atr14"], ind["sma200"]
        for i in range(1, len(c) - days):
            if a[i] is None:
                continue
            if regime_up is not None:
                if s200[i] is None or (c[i] > s200[i]) != regime_up:
                    continue
            U, D = c[i] + ku * a[i], c[i] - kd * a[i]
            hit = 0
            for j in range(i + 1, i + 1 + days):
                hu, hd = h[j] >= U, l[j] <= D
                if hu and hd:
                    hit = 3
                    break
                if hu:
                    hit = 1
                    break
                if hd:
                    hit = 2
                    break
            if hit == 1:
                up += 1
            elif hit == 2:
                dn += 1
            elif hit == 3:
                up += 0.5
                dn += 0.5
            else:
                none += 1
    n = up + dn + none
    if not n:
        return None
    return {"days": days, "n": int(n), "up": round(up / n, 3), "down": round(dn / n, 3), "none": round(none / n, 3)}


def _swings(win, k=SWING_K):
    highs, lows = [], []
    for i in range(k, len(win) - k):
        if all(win[i]["high"] >= win[j]["high"] for j in range(i - k, i + k + 1)):
            highs.append(i)
        if all(win[i]["low"] <= win[j]["low"] for j in range(i - k, i + k + 1)):
            lows.append(i)
    return highs, lows


def _profile(win):
    lo = min(b["low"] for b in win)
    hi = max(b["high"] for b in win)
    if not hi > lo:
        return None
    step = (hi - lo) / PROFILE_BINS
    vol = [0.0] * PROFILE_BINS
    for b in win:
        if b["volume"] <= 0:
            continue
        i0 = max(0, min(PROFILE_BINS - 1, int((b["low"] - lo) / step)))
        i1 = max(0, min(PROFILE_BINS - 1, int((b["high"] - lo) / step)))
        for i in range(i0, i1 + 1):
            vol[i] += b["volume"] / (i1 - i0 + 1)
    total = sum(vol)
    if total <= 0:
        return None
    poc = max(range(PROFILE_BINS), key=lambda i: vol[i])
    covered, L, R = vol[poc], poc, poc
    while covered < total * 0.7 and (L > 0 or R < PROFILE_BINS - 1):
        left = vol[L - 1] if L > 0 else -1
        right = vol[R + 1] if R < PROFILE_BINS - 1 else -1
        if right >= left:
            R += 1
            covered += vol[R]
        else:
            L -= 1
            covered += vol[L]
    return {"lo": lo, "hi": hi, "step": step, "vol": vol, "total": total,
            "poc": lo + (poc + 0.5) * step, "val": lo + L * step, "vah": lo + (R + 1) * step}


def _vol_between(p, lo, hi):
    """Share of window volume traded in [lo, hi], and the share of the window's price range it spans."""
    v = 0.0
    for i, x in enumerate(p["vol"]):
        b0 = p["lo"] + i * p["step"]
        ov = max(0.0, min(hi, b0 + p["step"]) - max(lo, b0))
        v += x * ov / p["step"]
    span = max(0.0, min(hi, p["hi"]) - max(lo, p["lo"]))
    return v / p["total"], span / (p["hi"] - p["lo"]), span / (hi - lo) if hi > lo else 0.0


ZONE_TAGS = {
    "outside": ("窗口外", "所选窗口里价格基本没到过这里：没有成交记录，也就没有成本筹码可参考。"),
    "va_above": ("价值区上方", "高于窗口内大多数成交价：在这里买的人少，持有者普遍获利，回落时卖压来自获利了结。"),
    "va_in": ("价值区内", "窗口内 70% 成交发生的地方：多空相对平衡，价格容易在里面来回。"),
    "va_edge": ("跨价值区边界", "一半在价值区里、一半在外，是「平衡」和「偏离」的交界。"),
    "va_below": ("价值区下方", "低于窗口内大多数成交价：之前买入的人在这里普遍被套，反弹时容易遇到解套卖盘。"),
    "dense": ("成交密集", "这段价格的成交量明显高于窗口平均：换手充分，价格进来后容易震荡、走得慢。"),
    "thin": ("成交稀疏", "这段价格的成交量明显低于窗口平均：缺少换手，价格一旦进入常较快穿过。"),
    "boll_out": ("布林带外", "在布林上轨之上或下轨之下：统计上偏离过大的区域，很难长时间停留。"),
}


def _zone_tags(z, p, boll):
    lo, hi = z["lo"], z["hi"]
    tags = []
    if z["inside_frac"] < 0.5:
        tags.append("outside")
    elif lo >= p["vah"] * 0.999:
        tags.append("va_above")
    elif hi <= p["val"] * 1.001:
        tags.append("va_below")
    elif lo >= p["val"] * 0.999 and hi <= p["vah"] * 1.001:
        tags.append("va_in")
    else:
        tags.append("va_edge")
    d = z.get("density")
    if d is not None and z["inside_frac"] >= 0.5:
        if d >= 1.3:
            tags.append("dense")
        elif d <= 0.6:
            tags.append("thin")
    if (boll[0] is not None and lo >= boll[0] * 0.999) or (boll[1] is not None and hi <= boll[1] * 1.001):
        tags.append("boll_out")
    return tags


def _merge(raw):
    raw.sort(key=lambda x: -x["price"])
    clusters = []
    for m in raw:
        if clusters and clusters[-1][0]["price"] / m["price"] - 1 <= MERGE_PCT:
            clusters[-1].append(m)
        else:
            clusters.append([m])
    out = []
    for cl in clusters:
        cl.sort(key=lambda m: RANK.index(m["key"]))
        out.append({"price": cl[0]["price"], "members": cl})
    return out


def window_guide(bars, ind, nb, wl, pooled, own_hold, uni, ft_cache):
    n = len(bars)
    i = n - 1
    px = bars[i]["close"]
    win = bars[-nb:]
    a = ind["atr14"][i]
    g = lambda k: ind[k][i]
    raw = []

    def add(key, price, d=None):
        if price is None or price <= 0:
            return
        raw.append({"key": key, "price": round(price, 2), "d": d})

    for k in ("sma20", "sma50", "sma200", "boll_up", "boll_lo", "don20_hi", "don20_lo"):
        add(k, g(k))
    add("win_hi", max(b["high"] for b in win))
    add("win_lo", min(b["low"] for b in win))
    p = _profile(win)
    if p:
        add("poc", p["poc"])
        add("vah", p["vah"])
        add("val", p["val"])
    sh, sl = _swings(win)
    above = [j for j in sh if win[j]["high"] > px and all(x["close"] <= win[j]["high"] for x in win[j + 1:])]
    below = [j for j in sl if win[j]["low"] < px and all(x["close"] >= win[j]["low"] for x in win[j + 1:])]
    for j in sorted(above, key=lambda j: win[j]["high"])[:2]:
        add("swing_hi", win[j]["high"], win[j]["date"])
    for j in sorted(below, key=lambda j: -win[j]["low"])[:2]:
        add("swing_lo", win[j]["low"], win[j]["date"])
    for gp in _unfilled_gaps(win)[-2:]:
        add("gap_up" if gp["dir"] == "up" else "gap_down", gp["price"], gp["date"])

    lines = _merge(raw)
    base = pooled["baseline"]
    for ln in lines:
        side = "resistance" if ln["price"] > px else "support"
        ln["kind"] = side
        ln["dist_pct"] = round((ln["price"] / px - 1) * 100, 2)
        ln["atr_dist"] = round((ln["price"] - px) / a, 2) if a else None
        for m in ln["members"]:
            name, group, _, _, fam = DEFS[m["key"]]
            m["name"] = name.format(w=wl, d=m.pop("d") or "")
            m["group"] = group
            if fam:
                k = f"{fam}|{side}"
                pf, of = pooled["by_family"].get(k), own_hold.get(k)
                if pf:
                    m["stat"] = {"side": side, "pool": pf, "base": base.get(side),
                                 "own": {"n": of["n"], "rate": of["hit_rate"]} if of else None}
        ln["group"] = ln["members"][0]["group"]

    zones = []
    boll = (g("boll_up"), g("boll_lo"))
    for up, dn in zip(lines, lines[1:]):
        hi, lo = up["price"], dn["price"]
        z = {"hi": hi, "lo": lo, "width_pct": round((hi / lo - 1) * 100, 2),
             "atr_w": round((hi - lo) / a, 2) if a else None,
             "days_in": sum(1 for b in win if lo <= b["close"] <= hi),
             "current": lo <= px <= hi}
        if p:
            vs, ps, inside = _vol_between(p, lo, hi)
            z["vol_share"] = round(vs, 3)
            z["inside_frac"] = round(inside, 2)
            z["density"] = round(vs / ps, 2) if ps > 0.01 else None
            z["tags"] = _zone_tags(z, p, boll)
        if z["current"] and a:
            ku, kd = round((hi - px) / a, 1), round((px - lo) / a, 1)
            s200 = g("sma200")
            reg = None if s200 is None else px > s200
            key = (ku, kd, reg)
            if key not in ft_cache:
                ft_cache[key] = first_touch(uni, max(ku, 0.05), max(kd, 0.05), reg)
            ft = ft_cache[key]
            if ft:
                z["first_touch"] = dict(ft, up_atr=ku, down_atr=kd, regime=None if reg is None else ("up" if reg else "down"))
        zones.append(z)

    prof = None
    if p:
        mx = max(p["vol"])
        prof = {"lo": _r(p["lo"]), "step": round(p["step"], 4), "vol": [round(v / mx * 1000) for v in p["vol"]],
                "poc": _r(p["poc"]), "val": _r(p["val"]), "vah": _r(p["vah"])}
    return {"bars": nb, "from": win[0]["date"], "lines": lines, "zones": zones, "profile": prof,
            "atr14": _r(a), "close": _r(px)}


def build(bars, ind, own_bt, pooled, uni, ft_cache):
    own_hold = own_bt["hold"]["by_family"]
    by = {}
    for key, nb, wl in WINDOWS:
        if len(bars) >= nb:
            by[key] = dict(window_guide(bars, ind, nb, wl, pooled, own_hold, uni, ft_cache), label=wl)
    return {
        "windows": [{"key": k, "bars": nb, "label": wl} for k, nb, wl in WINDOWS if k in by],
        "default": DEFAULT_WINDOW if DEFAULT_WINDOW in by else next(iter(by), None),
        "by_window": by,
        "defs": {k: {"what": v[2], "use": v[3]} for k, v in DEFS.items()},
        "zone_tags": {k: {"label": v[0], "text": v[1]} for k, v in ZONE_TAGS.items()},
        "training": {"n_symbols": pooled["n_symbols"], "years": pooled["years"],
                     "first_touch_days": FIRST_TOUCH_DAYS,
                     "hold_def": "触及后 5 个交易日内收盘没有反向穿越这条线超过 1.5% 算「守住」；对照 = 把同一条线整体平移 ±2%/±4% 后按同样规则统计（随机线）。",
                     "first_touch_def": "从每个历史收盘出发，把上下两条线换算成 ATR 倍数，统计 10 个交易日内哪边先被碰到；只用和现在同一长期趋势（在 SMA200 上方或下方）的日子。"},
    }
