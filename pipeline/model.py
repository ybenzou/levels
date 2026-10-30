"""Levels position model.

What it does, in order of how much weight it deserves:

1. Risk-budget sizing (the core). Position = per-stock volatility budget / forecast volatility.
   It does not try to beat buy-and-hold; it turns "how much risk can I take" into "how much to hold",
   and keeps realised volatility close to the budget.
2. Timing score (a weak tilt). Equal-weight blend of the factors that were stable across all three
   sub-periods tested: short-term reversal and the low-volatility effect. No fitted coefficients.
   Shown with its out-of-sample calibration; it is a pacing aid for adds, not a reason to change
   total size.
3. Regime + risk lines (descriptive).

Validation that runs on every build and is published with the data:
- A walk-forward pooled ridge regression over all features (the "smarter" model) — kept only to
  show whether added complexity predicts anything out of sample.
- Timing-score quintile calibration per sub-period.
- Timing tilt vs constant exposure, and risk-budget sizing vs constant exposure at matched size.
"""
import math

HORIZON = 10
COST_BPS = 10
SIZE_STEP = 0.05
REBALANCE_BAND = 0.05
PROFILES = [("conservative", "保守", 0.06), ("balanced", "平衡", 0.10), ("aggressive", "积极", 0.15)]
DEFAULT_PROFILE = "balanced"
PERIODS = [("2017", "2020"), ("2020", "2023"), ("2023", "2100")]

RIDGE_LAMBDA = 50.0
REFIT_EVERY_MONTHS = 3
MIN_TRAIN_SAMPLES = 3000

FEATURES = [
    ("trend200", "长期趋势", "价格相对 SMA200 的偏离"),
    ("slope50", "中期斜率", "SMA50 近 20 日斜率"),
    ("mom63", "3 月动量", "近 3 个月收益（剔除最近 1 周），按波动率标准化"),
    ("rev5", "5 日反转", "近 5 日涨跌的反向，按 ATR 标准化"),
    ("rsi2", "RSI2 超卖", "RSI(2) 低于 50 的程度"),
    ("dip_up", "上升趋势回调", "处于 SMA200 之上时的 RSI(2) 超卖"),
    ("ext20", "偏离 SMA20", "价格偏离 SMA20 的 ATR 倍数"),
    ("macd", "MACD 柱", "MACD 柱 / ATR"),
    ("volpct", "波动分位", "20 日波动率在近 1 年的分位（0 居中）"),
    ("vrvp", "相对 POC", "价格相对 120 日成交量峰 POC 的 ATR 倍数"),
    ("brk20", "20 日突破", "收盘突破前 20 日高点 = +1，跌破前 20 日低点 = −1"),
]
FEATURE_KEYS = [f[0] for f in FEATURES]
K = {k: j for j, k in enumerate(FEATURE_KEYS)}

SCORE_PARTS = [
    ("rev5", "5 日反转", "近 5 日跌得多 → 加分"),
    ("ext20", "低于 SMA20", "价格低于 20 日均线越多 → 加分"),
    ("rsi2", "RSI(2)", "短线超卖 → 加分，超买 → 减分"),
    ("lowvol", "低波动", "波动率处于近 1 年低分位 → 加分"),
]
QUINTILE_LABELS = ["偏贵 · 不宜追高", "略偏贵", "中性", "略有利", "有利 · 适合分批"]


def _clip(x, a=-3.0, b=3.0):
    return max(a, min(b, x))


def _r(x, d=4):
    return None if x is None else round(x, d)


# ——— features ———

def features_at(ind, i):
    """Feature vector at bar i using data up to and including bar i. Missing inputs → 0 (neutral)."""
    c = ind["close"]
    atr = ind["atr14"][i]
    vol = ind["vol20"][i]
    if atr is None or vol is None or vol <= 0 or i < 70:
        return None
    px = c[i]
    atr_pct = atr / px
    f = {}
    s200 = ind["sma200"][i]
    f["trend200"] = _clip((px / s200 - 1) / 0.15) if s200 else 0.0
    s50, s50p = ind["sma50"][i], ind["sma50"][i - 20]
    f["slope50"] = _clip((s50 / s50p - 1) / (vol * math.sqrt(20 / 252))) if s50 and s50p else 0.0
    f["mom63"] = _clip((c[i - 5] / c[i - 68] - 1) / (vol * math.sqrt(63 / 252)))
    f["rev5"] = _clip(-(px / c[i - 5] - 1) / (atr_pct * math.sqrt(5)))
    r2 = ind["rsi2"][i]
    f["rsi2"] = max(0.0, (50 - r2) / 50) if r2 is not None else 0.0
    f["dip_up"] = f["rsi2"] if (s200 and px > s200) else 0.0
    s20 = ind["sma20"][i]
    f["ext20"] = _clip((px - s20) / atr / 2) if s20 else 0.0
    h = ind["macd_hist"][i]
    f["macd"] = _clip(h / atr * 2) if h is not None else 0.0
    hist = [v for v in ind["vol20"][max(0, i - 251):i + 1] if v is not None]
    f["volpct"] = (sum(1 for v in hist if v <= vol) / len(hist) - 0.5) * 2 if len(hist) > 20 else 0.0
    poc = ind["poc"][i]
    f["vrvp"] = _clip((px - poc) / atr / 3) if poc else 0.0
    dh, dl = ind["don20_hi"][i], ind["don20_lo"][i]
    f["brk20"] = 1.0 if (dh and px > dh) else (-1.0 if (dl and px < dl) else 0.0)
    return [f[k] for k in FEATURE_KEYS]


def label_at(ind, i):
    c, vol = ind["close"], ind["vol20"][i]
    if i + HORIZON >= len(c) or not vol:
        return None
    return _clip((c[i + HORIZON] / c[i] - 1) / (vol * math.sqrt(HORIZON / 252)))


def timing_score(ind, i, x):
    """Returns (score in [-1, 1], {part: contribution})."""
    cl = lambda v: max(-1.0, min(1.0, v))
    r2 = ind["rsi2"][i]
    parts = {
        "rev5": cl(x[K["rev5"]] / 2),
        "ext20": cl(-x[K["ext20"]]),
        "rsi2": (50 - r2) / 50 if r2 is not None else 0.0,
        "lowvol": -x[K["volpct"]],
    }
    reversal = (parts["rev5"] + parts["ext20"] + parts["rsi2"]) / 3
    score = 0.5 * reversal + 0.5 * parts["lowvol"]
    contrib = {"rev5": parts["rev5"] / 6, "ext20": parts["ext20"] / 6, "rsi2": parts["rsi2"] / 6,
               "lowvol": parts["lowvol"] / 2}
    return score, contrib


def vol_forecast(ind, i):
    """Annualised: blend of 20-day and up-to-1-year realised volatility (needs ≥ 40 days)."""
    v20 = ind["vol20"][i]
    w = ind["ret1"][max(1, i - 251):i + 1]
    if v20 is None or len(w) < 40:
        return None
    m = sum(w) / len(w)
    vl = math.sqrt(sum((x - m) ** 2 for x in w) / len(w)) * math.sqrt(252)
    return math.sqrt(0.5 * v20 ** 2 + 0.5 * vl ** 2)


def risk_size(budget, vol):
    if not vol:
        return None
    return round(min(1.0, round(budget / vol / SIZE_STEP) * SIZE_STEP), 2)


# ——— panel ———

def build_panel(universe):
    """universe: {symbol: (bars, ind)} → per-symbol rows with features, label, score."""
    panel = {}
    for sym, (bars, ind) in universe.items():
        rows = []
        for i in range(len(bars)):
            x = features_at(ind, i)
            if x is None:
                continue
            y = label_at(ind, i)
            s, _ = timing_score(ind, i, x)
            rows.append({"i": i, "date": bars[i]["date"], "x": x, "y": y, "score": s,
                         "r10": (ind["close"][i + HORIZON] / ind["close"][i] - 1) * 100 if y is not None else None,
                         "label_end": bars[i + HORIZON]["date"] if y is not None else None})
        panel[sym] = rows
    return panel


# ——— validation: walk-forward ridge ———

def _solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[piv] = M[piv], M[col]
        p = M[col][col]
        if abs(p) < 1e-12:
            continue
        for r in range(n):
            if r != col:
                k = M[r][col] / p
                if k:
                    for j in range(col, n + 1):
                        M[r][j] -= k * M[col][j]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def fit_ridge(X, y, lam=RIDGE_LAMBDA):
    n, k = len(X), len(X[0])
    mx = [sum(r[j] for r in X) / n for j in range(k)]
    my = sum(y) / n
    A = [[0.0] * k for _ in range(k)]
    b = [0.0] * k
    for r, t in zip(X, y):
        d = [r[j] - mx[j] for j in range(k)]
        dt = t - my
        for p in range(k):
            dp = d[p]
            b[p] += dp * dt
            Ap = A[p]
            for q in range(p, k):
                Ap[q] += dp * d[q]
    for p in range(k):
        for q in range(p):
            A[p][q] = A[q][p]
        A[p][p] += lam
    w = _solve(A, b)
    return my - sum(w[j] * mx[j] for j in range(k)), w


def _add_months(ym, m):
    y, mo = ym
    mo += m
    while mo > 12:
        y, mo = y + 1, mo - 12
    return (y, mo)


def walk_forward_ridge(panel):
    """Quarterly refits on samples whose label window had closed before the quarter began."""
    rows = [r for v in panel.values() for r in v]
    first, last = min(r["date"] for r in rows), max(r["date"] for r in rows)
    cur = _add_months((int(first[:4]), int(first[5:7])), 24)
    cur = (cur[0], ((cur[1] - 1) // 3) * 3 + 1)
    labelled = [r for r in rows if r["y"] is not None]
    preds, last_model, n_fits = [], None, 0
    while True:
        start = f"{cur[0]:04d}-{cur[1]:02d}-01"
        if start > last:
            break
        nxt = _add_months(cur, REFIT_EVERY_MONTHS)
        end = f"{nxt[0]:04d}-{nxt[1]:02d}-01"
        train = [r for r in labelled if r["label_end"] < start]
        if len(train) >= MIN_TRAIN_SAMPLES:
            a, w = fit_ridge([r["x"] for r in train], [r["y"] for r in train])
            last_model, n_fits = (a, w), n_fits + 1
            for r in labelled:
                if start <= r["date"] < end:
                    preds.append((a + sum(wi * xi for wi, xi in zip(w, r["x"])), r["y"], r["date"]))
        cur = nxt
    ic = spearman([p[0] for p in preds], [p[1] for p in preds]) if len(preds) > 30 else None
    ic_by = {}
    for lo, hi in PERIODS:
        sub = [p for p in preds if lo <= p[2] < hi]
        if len(sub) > 30:
            ic_by[f"{lo}–{min(int(hi), 2026)}"] = round(spearman([p[0] for p in sub], [p[1] for p in sub]), 3)
    return {"oos_ic": _r(ic, 3), "ic_by_period": ic_by, "n_oos": len(preds), "n_fits": n_fits,
            "first_oos": min((p[2] for p in preds), default=None),
            "last_coefs": {k: round(w, 3) for k, w in zip(FEATURE_KEYS, last_model[1])} if last_model else None}


def _rank(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    rk = [0.0] * len(xs)
    for pos, i in enumerate(order):
        rk[i] = pos
    return rk


def spearman(a, b):
    ra, rb = _rank(a), _rank(b)
    n = len(a)
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x - ma) ** 2 for x in ra))
    vb = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return cov / (va * vb) if va and vb else 0.0


# ——— validation: timing-score calibration ———

def score_thresholds(panel):
    s = sorted(r["score"] for v in panel.values() for r in v)
    return [s[len(s) * k // 5] for k in (1, 2, 3, 4)]


def quintile_of(score, th):
    return sum(1 for t in th if score >= t)


def _bucket_stats(rows):
    if not rows:
        return {"n": 0}
    r10 = [r["r10"] for r in rows]
    ys = [r["y"] for r in rows]
    return {"n": len(rows), "r10_mean": round(sum(r10) / len(r10), 3),
            "win": round(sum(1 for v in r10 if v > 0) / len(r10), 3),
            "y_mean": round(sum(ys) / len(ys), 3)}


def score_calibration(rows, th):
    lab = [r for r in rows if r["y"] is not None]
    out = {"all": [], "by_period": {}}
    for q in range(5):
        out["all"].append(dict(_bucket_stats([r for r in lab if quintile_of(r["score"], th) == q]),
                               q=q + 1, label=QUINTILE_LABELS[q]))
    for lo, hi in PERIODS:
        sub = [r for r in lab if lo <= r["date"] < hi]
        if not sub:
            continue
        bq = [_bucket_stats([r for r in sub if quintile_of(r["score"], th) == q]) for q in range(5)]
        key = f"{lo}–{min(int(hi), 2026)}"
        out["by_period"][key] = {"q1": bq[0], "q5": bq[4],
                                 "spread_y": round(bq[4].get("y_mean", 0) - bq[0].get("y_mean", 0), 3) if bq[0]["n"] and bq[4]["n"] else None}
    return out


# ——— backtests ———

def _metrics(rets, eq, exposure):
    if len(rets) < 20:
        return None
    n = len(rets)
    years = n / 252
    mu = sum(rets) / n
    sd = math.sqrt(sum((r - mu) ** 2 for r in rets) / max(1, n - 1))
    peak, mdd = eq[0], 0.0
    for v in eq:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    return {"total": _r(eq[-1] / eq[0] - 1), "cagr": _r((eq[-1] / eq[0]) ** (1 / years) - 1 if eq[-1] > 0 else -1),
            "vol": _r(sd * math.sqrt(252)), "sharpe": _r(mu / sd * math.sqrt(252) if sd > 0 else 0.0, 3),
            "max_dd": _r(mdd), "avg_exposure": _r(sum(exposure) / len(exposure), 3), "years": round(years, 2)}


def simulate(close, start, target_fn, band=REBALANCE_BAND):
    """Exposure set at close t earns close t→t+1; trades only when target drifts ≥ band; costs per turnover."""
    pos = target_fn(start) or 0.0
    eq, rets, curve, expo, turnover = 1.0, [], [1.0], [pos], 0.0
    for i in range(start + 1, len(close)):
        r = pos * (close[i] / close[i - 1] - 1)
        t = target_fn(i)
        cost = 0.0
        if t is not None and abs(t - pos) >= band - 1e-9:
            cost = abs(t - pos) * COST_BPS / 1e4
            turnover += abs(t - pos)
            pos = t
        eq *= (1 + r) * (1 - cost)
        rets.append((1 + r) * (1 - cost) - 1)
        curve.append(eq)
        expo.append(pos)
    m = _metrics(rets, curve, expo)
    if m:
        m["turnover_yr"] = round(turnover / m["years"], 2)
    return m, curve, expo


def sizing_backtest(bars, ind, budget):
    c = ind["close"]
    start = next((i for i in range(len(c)) if vol_forecast(ind, i)), None)
    if start is None or len(c) - start < 40:
        return None
    if len(c) - 252 > 200:
        start = max(start, 252)
    size = lambda i: risk_size(budget, vol_forecast(ind, i))
    m_rb, eq_rb, ex_rb = simulate(c, start, size)
    avg = m_rb["avg_exposure"] if m_rb else 0
    m_cst, eq_cst, _ = simulate(c, start, lambda i: avg, band=1.0)
    m_bh, eq_bh, _ = simulate(c, start, lambda i: 1.0, band=1.0)
    return {"start": bars[start]["date"], "budget": budget,
            "metrics": {"risk_budget": m_rb, "constant": m_cst, "buy_hold": m_bh},
            "curve": {"dates": [b["date"] for b in bars[start:]], "risk_budget": eq_rb,
                      "constant": eq_cst, "buy_hold": eq_bh, "exposure": ex_rb}}


def tilt_backtest(bars, ind, rows, budget):
    """Risk-budget size × timing tilt (0.5…1.5) vs untilted risk-budget size: does the score add value?"""
    by_i = {r["i"]: r for r in rows}
    c = ind["close"]
    if not by_i or len(c) < 120:
        return None
    start = max(min(by_i), 252 if len(c) - 252 > 200 else 0)
    if len(c) - start < 60:
        return None
    base = lambda i: risk_size(budget, vol_forecast(ind, i))

    def tilt(i):
        b = base(i)
        r = by_i.get(i)
        if b is None or r is None:
            return b
        return round(min(1.0, round(b * (1 + 0.5 * r["score"]) / SIZE_STEP) * SIZE_STEP), 2)
    m_t, _, _ = simulate(c, start, tilt)
    m_b, _, _ = simulate(c, start, base)
    return {"tilt": m_t, "base": m_b}


# ——— today ———

def regime_of(ind, i):
    c = ind["close"][i]
    s50, s200 = ind["sma50"][i], ind["sma200"][i]
    if s200 is None:
        trend = ("na", "历史不足 200 日")
    elif c > s200 and s50 and s50 > s200:
        trend = ("up", "上升趋势")
    elif c < s200 and s50 and s50 < s200:
        trend = ("down", "下降趋势")
    else:
        trend = ("mixed", "震荡 / 过渡")
    v = ind["vol20"][i]
    hist = [x for x in ind["vol20"][max(0, i - 251):i + 1] if x is not None]
    pct = sum(1 for x in hist if x <= v) / len(hist) if hist and v else None
    vol = ("na", "—") if pct is None else (("low", "低波动") if pct < 1 / 3 else (("high", "高波动") if pct > 2 / 3 else ("mid", "中等波动")))
    return {"trend": trend[0], "trend_zh": trend[1], "vol": vol[0], "vol_zh": vol[1],
            "vol_pctile": _r(pct, 3), "above_sma200": None if s200 is None else c > s200,
            "sma50_slope_20d": _r(ind["sma50"][i] / ind["sma50"][i - 20] - 1) if s50 and i >= 20 and ind["sma50"][i - 20] else None}


def today_card(bars, ind, rows, th, levels):
    i = len(bars) - 1
    px = ind["close"][i]
    vf = vol_forecast(ind, i)
    row = next((r for r in reversed(rows) if r["i"] == i), None)
    card = {"date": bars[i]["date"], "close": round(px, 2), "vol_forecast": _r(vf),
            "regime": regime_of(ind, i), "sizes": {}}
    for key, zh, budget in PROFILES:
        card["sizes"][key] = {"label": zh, "budget": budget, "size": risk_size(budget, vf)}
    if row is not None:
        s, contrib = timing_score(ind, i, row["x"])
        q = quintile_of(s, th)
        card["timing"] = {"score": round(s, 3), "quintile": q + 1, "label": QUINTILE_LABELS[q],
                          "parts": [{"key": k, "label": zh, "hint": hint, "contrib": round(contrib[k], 3)}
                                    for k, zh, hint in SCORE_PARTS]}
    atr = ind["atr14"][i]
    if atr:
        hi22 = max(ind["close"][max(0, i - 21):i + 1])
        card["risk_line"] = {"price": round(hi22 - 3 * atr, 2), "def": "近 22 日最高收盘 − 3×ATR14（吊灯线）",
                             "dist_pct": round(((hi22 - 3 * atr) / px - 1) * 100, 2)}
        card["atr14"] = round(atr, 2)
    sup = [lv for lv in levels if lv["kind"] == "support" and lv["priority"] <= 1]
    res = [lv for lv in levels if lv["kind"] == "resistance" and lv["priority"] <= 1]
    if sup:
        s0 = max(sup, key=lambda lv: lv["price"])
        card["next_support"] = {"price": s0["price"], "dist_pct": s0["dist_pct"], "role": s0["role"]}
    if res:
        r0 = min(res, key=lambda lv: lv["price"])
        card["next_resistance"] = {"price": r0["price"], "dist_pct": r0["dist_pct"], "role": r0["role"]}
    return card


def downsample_curve(curve, max_points=900):
    n = len(curve["dates"])
    step = max(1, math.ceil(n / max_points))
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return {k: [v[j] if k in ("dates", "exposure") else round(v[j], 4) for j in idx] for k, v in curve.items()}
