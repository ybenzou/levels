"""Descriptive level backtest: touch→hold and breakout→forward return, over the full history.

Compared with the original one-year version: Bollinger mid is dropped (identical to SMA20),
every rate carries a 95% Wilson interval, and every number has a same-sample baseline so
that a falling or rising year doesn't masquerade as level predictiveness.
"""
import math

TOUCH_BAND = 0.005
HOLD_DAYS = 5
BREACH = 0.015
BREAK_BUF = 0.005
COOLDOWN = 10
HORIZONS = (1, 3, 5)
PLACEBO_SHIFTS = (-0.04, -0.02, 0.02, 0.04)

FAMILIES = [
    ("SMA20", "sma20", ("support", "resistance")),
    ("SMA50", "sma50", ("support", "resistance")),
    ("SMA200", "sma200", ("support", "resistance")),
    ("Boll up", "boll_up", ("resistance",)),
    ("Boll lo", "boll_lo", ("support",)),
    ("Don20 hi", "don20_hi", ("resistance",)),
    ("Don20 lo", "don20_lo", ("support",)),
    ("VRVP POC", "poc", ("support", "resistance")),
    ("VRVP VAL", "val", ("support",)),
    ("VRVP VAH", "vah", ("resistance",)),
]
BREAK_FAMILIES = [
    ("SMA20", "sma20", ("up", "down")),
    ("SMA50", "sma50", ("up", "down")),
    ("SMA200", "sma200", ("up", "down")),
    ("Boll up", "boll_up", ("up",)),
    ("Boll lo", "boll_lo", ("down",)),
    ("VRVP POC", "poc", ("up", "down")),
    ("VRVP VAL", "val", ("down",)),
    ("VRVP VAH", "vah", ("up",)),
]


def wilson(k, n, z=1.96):
    if n == 0:
        return None, None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return round((c - m) / d, 3), round((c + m) / d, 3)


def _rate(k, n):
    lo, hi = wilson(k, n)
    return {"n": n, "held": k, "hit_rate": round(k / n, 3) if n else None, "ci_lo": lo, "ci_hi": hi}


def _q(xs, p):
    s = sorted(xs)
    if not s:
        return None
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = min(len(s) - 1, f + 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def ret_stats(xs, baseline=None, win_up=True):
    if not xs:
        return {"n": 0}
    n = len(xs)
    mu = sum(xs) / n
    sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / max(1, n - 1))
    wins = sum(1 for x in xs if (x > 0 if win_up else x < 0))
    lo, hi = wilson(wins, n)
    out = {"n": n, "mean": round(mu, 3), "median": round(_q(xs, 0.5), 3), "win_rate": round(wins / n, 3),
           "win_ci_lo": lo, "win_ci_hi": hi,
           "p25": round(_q(xs, 0.25), 3), "p75": round(_q(xs, 0.75), 3),
           "mean_ci": round(1.96 * sd / math.sqrt(n), 3)}
    if baseline is not None:
        out["baseline_mean"] = round(baseline, 3)
        out["excess_mean"] = round(mu - baseline, 3)
    return out


def run(bars, ind, display_from):
    c, h, l = ind["close"], ind["high"], ind["low"]
    s200 = ind["sma200"]
    n = len(c)
    regime = lambda i: "up" if s200[i] and c[i] > s200[i] else ("down" if s200[i] else "na")

    fwd = {k: [(c[i + k] / c[i] - 1) * 100 for i in range(1, n - k)] for k in HORIZONS}
    base_ret = {k: sum(v) / len(v) for k, v in fwd.items() if v}

    def touches(lv, sides, scale=1.0):
        evs, last = [], {}
        for i in range(1, n - HOLD_DAYS):
            if lv[i] is None or lv[i - 1] is None:
                continue
            L, Lp = lv[i] * scale, lv[i - 1] * scale
            side = None
            if "support" in sides and c[i - 1] > Lp * (1 + TOUCH_BAND) and l[i] <= L * (1 + TOUCH_BAND):
                side = "support"
            elif "resistance" in sides and c[i - 1] < Lp * (1 - TOUCH_BAND) and h[i] >= L * (1 - TOUCH_BAND):
                side = "resistance"
            if not side:
                continue
            if side in last and i - last[side] < COOLDOWN:
                continue
            last[side] = i
            fut = c[i + 1:i + 1 + HOLD_DAYS]
            held = all(x >= L * (1 - BREACH) for x in fut) if side == "support" else all(x <= L * (1 + BREACH) for x in fut)
            evs.append((i, side, L, held))
        return evs

    hold_events = []
    placebo = {"support": [0, 0], "resistance": [0, 0]}
    for fam, key, sides in FAMILIES:
        for i, side, L, held in touches(ind[key], sides):
            hold_events.append({"family": fam, "side": side, "date": bars[i]["date"], "level": round(L, 2),
                                "close": round(c[i], 2), "held": held, "regime": regime(i)})
        # Placebo: the same family's line shifted ±2% / ±4%. A real level should beat its own shadow.
        for s in PLACEBO_SHIFTS:
            for _, side, _, held in touches(ind[key], sides, 1 + s):
                placebo[side][0] += held
                placebo[side][1] += 1

    brk_events, last_brk = [], {}
    for fam, key, dirs in BREAK_FAMILIES:
        lv = ind[key]
        for i in range(1, n - max(HORIZONS)):
            L, Lp = lv[i], lv[i - 1]
            if L is None or Lp is None:
                continue
            d = None
            if "up" in dirs and c[i] > L * (1 + BREAK_BUF) and c[i - 1] <= Lp * (1 + BREAK_BUF):
                d = "up"
            elif "down" in dirs and c[i] < L * (1 - BREAK_BUF) and c[i - 1] >= Lp * (1 - BREAK_BUF):
                d = "down"
            if not d:
                continue
            k = (fam, d)
            if k in last_brk and i - last_brk[k] < COOLDOWN:
                continue
            last_brk[k] = i
            rets = {str(hz): round((c[i + hz] / c[i] - 1) * 100, 3) for hz in HORIZONS}
            brk_events.append({"family": fam, "dir": d, "date": bars[i]["date"], "level": round(L, 2),
                               "close": round(c[i], 2), "rets": rets, "regime": regime(i)})

    hold_events.sort(key=lambda e: e["date"])
    brk_events.sort(key=lambda e: e["date"])

    def hold_rate(evs):
        return _rate(sum(1 for e in evs if e["held"]), len(evs))

    sup = [e for e in hold_events if e["side"] == "support"]
    res = [e for e in hold_events if e["side"] == "resistance"]
    by_family = {}
    for fam, _, sides in FAMILIES:
        for s in sides:
            evs = [e for e in hold_events if e["family"] == fam and e["side"] == s]
            if evs:
                by_family[f"{fam}|{s}"] = dict(hold_rate(evs), side=s, family=fam)
    by_regime = {}
    for rg in ("up", "down"):
        for s, evs in (("support", sup), ("resistance", res)):
            sub = [e for e in evs if e["regime"] == rg]
            by_regime[f"{rg}|{s}"] = hold_rate(sub)

    summary = {}
    for d in ("up", "down"):
        evs = [e for e in brk_events if e["dir"] == d]
        summary[d] = {str(hz): ret_stats([e["rets"][str(hz)] for e in evs], base_ret.get(hz)) for hz in HORIZONS}
    by_family_h5 = {}
    for fam, _, dirs in BREAK_FAMILIES:
        for d in dirs:
            evs = [e for e in brk_events if e["family"] == fam and e["dir"] == d]
            if evs:
                by_family_h5[f"{fam}|{d}"] = dict(ret_stats([e["rets"]["5"] for e in evs], base_ret.get(5)),
                                                  family=fam, dir=d)
    brk_regime = {}
    for rg in ("up", "down"):
        for d in ("up", "down"):
            evs = [e for e in brk_events if e["dir"] == d and e["regime"] == rg]
            brk_regime[f"{rg}|{d}"] = ret_stats([e["rets"]["5"] for e in evs], base_ret.get(5))

    win = f"{bars[0]['date']} → {bars[-1]['date']}"
    shown_hold = [e for e in hold_events if e["date"] >= display_from]
    shown_brk = [e for e in brk_events if e["date"] >= display_from]
    up_ex = sorted([e for e in shown_brk if e["dir"] == "up"], key=lambda e: e["date"])[-8:]
    dn_ex = sorted([e for e in shown_brk if e["dir"] == "down"], key=lambda e: e["date"])[-8:]
    years = round(n / 252, 1)
    return {
        "definitions": {
            "window": win, "n_bars": n, "years": years, "display_from": display_from,
            "touch_band_pct": TOUCH_BAND, "hold_horizon_days": HOLD_DAYS, "breach_through_pct": BREACH,
            "breakout_buffer_pct": BREAK_BUF, "cooldown_bars": COOLDOWN,
            "hold_def_zh": (f"触及：前收在带外、当日高低触及 level±0.5%。守住：随后5个交易日内收盘未穿越 level 超过1.5%。"
                            f"同族冷却10根K。统计区间 {years} 年；对照 = 把同一价位线整体平移 ±2%/±4% 后用同样规则检测（安慰剂）。"),
            "break_def_zh": (f"突破：收盘越过 level±0.5% 缓冲且前收在缓冲内/对侧。统计 +1/+3/+5 日收益（%），"
                             f"超额 = 减去同期任意一天的平均前瞻收益。统计区间 {years} 年，图上仅标近1年事件。"),
        },
        "hold": {
            "overall_support": hold_rate(sup), "overall_resistance": hold_rate(res),
            "baseline_support": round(placebo["support"][0] / placebo["support"][1], 3) if placebo["support"][1] else None,
            "baseline_resistance": round(placebo["resistance"][0] / placebo["resistance"][1], 3) if placebo["resistance"][1] else None,
            "baseline_n": {k: v[1] for k, v in placebo.items()},
            "by_family": by_family, "by_regime": by_regime,
            "n_events": len(hold_events), "events": shown_hold,
        },
        "breakout": {
            "summary": summary, "by_family_h5": by_family_h5, "by_regime_h5": brk_regime,
            "baseline_ret": {str(k): round(v, 3) for k, v in base_ret.items()},
            "n_events": len(brk_events), "examples_up": up_ex, "examples_down": dn_ex, "events": shown_brk,
        },
    }
