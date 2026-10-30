"""关键位：模型自己从价格结构里画出的支撑 / 压力线，以及「这些线后来怎样了」的训练与回测。

1. 画线：窗口内的转折点（局部高/低点）聚类，按「转折次数、一年级别大转折、窗口极值、角色互换、
   转折放量、转折幅度」打结构分，每侧取最显著的 3 条（R1–R3 / S1–S3，按离现价远近编号）。
2. 回测：在 19 只股票 × 10 年的每个历史交易日（每 3 天取一次）用同样的规则画线，记录每条线之后的结局：
   10 日内有没有碰到；碰到后是先反向走出 1 ATR（守住）还是先收盘穿过 0.5 ATR（突破）；
   突破后是继续走出 1 ATR（延续）还是先收回线的另一侧（假突破）。
3. 训练：用这些结局训练逻辑回归，比较三种预估——不训练（历史平均）、只看距离和趋势、再加上线本身的结构；
   2022 年以前的数据训练，2022 年以后检验，按样本外误差选用，再用全部数据重训。
"""
import bisect
import math
from operator import mul

TOL = 0.3
TOUCH = 0.1
HORIZON = 20
REACT_DAYS = 10
WIN_ATR = 1.0
FAIL_ATR = 0.5
MIN_DIST = 0.3
MAX_DIST = 8.0
SPACING = 1.0
PER_SIDE = 3
STRIDE = 3
MAJOR_K = 10
SPLIT = "2022-01-01"
WINDOWS = (21, 42, 63)
PIVOT_K = 3
RIDGE = 1.0
REACH_DAYS = 10
MIN_SCORE = 1.0
FOLLOW_ATR = 1.0
FOLLOW_DAYS = 10
SIDES = ("support", "resistance")
OUTCOMES = (
    ("reach", "10 日内碰到"),
    ("hold", "碰到后守住"),
    ("brk", "碰到后突破"),
    ("follow", "突破后延续"),
)
VARIANTS = ("base", "ctx", "full")

FEATS = [
    ("n_piv", "转折次数"),
    ("both", "既当过支撑也当过压力"),
    ("react", "转折后的反应幅度"),
    ("cross", "被收盘穿越的频率"),
    ("tap", "成交量经过的比例"),
    ("dist", "离现价的距离"),
    ("ext", "窗口最高/最低点"),
    ("ma", "与均线重合"),
    ("age", "离上次转折的时间"),
    ("with_trend", "顺势（升势里的支撑 / 跌势里的压力）"),
    ("support", "是支撑（相对压力）"),
    ("react_max", "最强一次转折的幅度"),
    ("piv_vol", "转折当天的放量程度"),
    ("n_touch", "被试探的次数"),
    ("major", "一年级别的大转折点"),
    ("round", "整数关口"),
    ("pos", "现价在窗口区间里的位置"),
    ("slope", "20日均线斜率"),
]


IX = {k: i for i, (k, _) in enumerate(FEATS)}


def ctx(x):
    """Features of the situation, not of the level: distance, side, trend, position in the window."""
    d = x[IX["dist"]]
    return [d, d * d, x[IX["support"]], x[IX["with_trend"]], x[IX["slope"]], x[IX["pos"]],
            x[IX["support"]] * x[IX["slope"]]]


def struct_score(x):
    return (min(x[IX["n_piv"]], 4) + min(x[IX["major"]], 1) + x[IX["ext"]] + 0.5 * x[IX["both"]]
            + (0.5 if x[IX["piv_vol"]] >= 1.5 else 0.0) + 0.5 * min(x[IX["react_max"]], 4) / 4)


def _pivots(h, l, k=PIVOT_K):
    n = len(h)
    ph, pl = [], []
    for i in range(k, n - k):
        hi, lo = h[i], l[i]
        if all(hi >= h[j] for j in range(i - k, i + k + 1)):
            ph.append(i)
        if all(lo <= l[j] for j in range(i - k, i + k + 1)):
            pl.append(i)
    return ph, pl


class Sym:
    def __init__(self, bars, ind):
        self.bars = bars
        self.d = [b["date"] for b in bars]
        self.h, self.l, self.c, self.v = ind["high"], ind["low"], ind["close"], ind["volume"]
        self.a = ind["atr14"]
        self.ma = (ind["sma20"], ind["sma50"], ind["sma200"])
        self.ref = (ind["boll_up"], ind["boll_lo"], ind["don20_hi"], ind["don20_lo"])
        self.ph, self.pl = _pivots(self.h, self.l)
        self.Ph, self.Pl = _pivots(self.h, self.l, MAJOR_K)
        self.v20 = [None] * len(self.v)
        acc = 0.0
        for i, x in enumerate(self.v):
            acc += x
            if i >= 20:
                acc -= self.v[i - 20]
            if i >= 19:
                self.v20[i] = acc / 20


def _window_pivots(S, t, L, major=False):
    s = t - L + 1
    e = t - (MAJOR_K if major else PIVOT_K)
    out = []
    for arr, kind in (((S.Ph, "hi"), (S.Pl, "lo")) if major else ((S.ph, "hi"), (S.pl, "lo"))):
        i0 = bisect.bisect_left(arr, s)
        i1 = bisect.bisect_right(arr, e)
        for i in arr[i0:i1]:
            out.append((i, kind, S.h[i] if kind == "hi" else S.l[i]))
    return out


def candidates(S, t, L):
    a = S.a[t]
    s = t - L + 1
    raw = [p for _, _, p in _window_pivots(S, t, L)]
    raw += [arr[t] for arr in S.ma + S.ref if arr[t]]
    wh, wl = max(S.h[s:t + 1]), min(S.l[s:t + 1])
    raw += [wh, wl]
    raw.sort()
    groups = []
    for p in raw:
        if groups and p - groups[-1][-1] <= TOL * a:
            groups[-1].append(p)
        else:
            groups.append([p])
    c = S.c[t]
    out = [sum(g) / len(g) for g in groups]
    return [p for p in out if MIN_DIST * a <= abs(p - c) <= MAX_DIST * a], wh, wl


def features(S, t, L, P, wh, wl):
    a = S.a[t]
    tol = TOL * a
    s = t - L + 1
    h, l, c, v = S.h, S.l, S.c, S.v
    nh = nl = 0
    react = []
    pv = []
    last = -1
    piv = []
    for i, kind, p in _window_pivots(S, t, L):
        if abs(p - P) > tol:
            continue
        j1 = min(i + 6, t + 1)
        if j1 <= i + 1:
            continue
        if kind == "hi":
            nh += 1
            react.append((h[i] - min(l[i + 1:j1])) / a)
        else:
            nl += 1
            react.append((max(h[i + 1:j1]) - l[i]) / a)
        last = max(last, i)
        piv.append((i, kind))
        if S.v20[i]:
            pv.append(v[i] / S.v20[i])
    crosses = 0
    for j in range(s + 1, t + 1):
        if (c[j] - P) * (c[j - 1] - P) < 0:
            crosses += 1
    vt = vin = 0.0
    for j in range(s, t + 1):
        vt += v[j]
        if l[j] <= P <= h[j]:
            vin += v[j]
    tap = vin / vt if vt else 0.0
    ma = sum(1 for arr in S.ma if arr[t] and abs(arr[t] - P) <= tol)
    pset = set(i for i, _ in piv)
    n_touch = 0
    for j in range(max(s, last + 1 if last >= 0 else s), t + 1):
        if j not in pset and l[j] - tol <= P <= h[j] + tol:
            n_touch += 1
    major = 0
    for i, kind, p in _window_pivots(S, t, 252, major=True):
        if abs(p - P) <= tol:
            major += 1
    step = 5 * 10 ** (math.floor(math.log10(P)) - 1) if P > 0 else 1
    rnd = 1 if abs(P - round(P / step) * step) <= 0.15 * a else 0
    s20 = S.ma[0]
    slope = (s20[t] - s20[t - 5]) / a if t >= 5 and s20[t] and s20[t - 5] else 0.0
    support = 1 if P < c[t] else 0
    up = S.ma[1][t] is not None and c[t] > S.ma[1][t]
    x = [
        min(nh + nl, 5),
        1 if nh and nl else 0,
        min(sum(react) / len(react), 6.0) if react else 0.0,
        min(crosses * 21.0 / L, 10.0),
        tap,
        min(abs(P - c[t]) / a, MAX_DIST),
        1 if abs(P - wh) <= tol or abs(P - wl) <= tol else 0,
        ma,
        (t - last) / L if last >= 0 else 1.5,
        1 if (support and up) or (not support and not up) else 0,
        support,
        min(max(react), 8.0) if react else 0.0,
        min(sum(pv) / len(pv), 4.0) if pv else 0.0,
        min(n_touch, 10) / L * 21,
        min(major, 3),
        rnd,
        (c[t] - wl) / (wh - wl) if wh > wl else 0.5,
        max(-3.0, min(3.0, slope)),
    ]
    return x


def _solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[piv] = M[piv], M[col]
        d = M[col][col]
        if abs(d) < 1e-12:
            continue
        for r in range(n):
            if r != col and M[r][col]:
                f = M[r][col] / d
                for k in range(col, n + 1):
                    M[r][k] -= f * M[col][k]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def _sig(z):
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def fit_logit(X, y, iters=8):
    n, d = len(X), len(X[0])
    cols = [[r[k] for r in X] for k in range(d)]
    mu = [sum(cl) / n for cl in cols]
    sd = [math.sqrt(sum((v - m) ** 2 for v in cl) / n) or 1.0 for cl, m in zip(cols, mu)]
    Z = [[1.0] * n] + [[(v - m) / sd_ for v in cl] for cl, m, sd_ in zip(cols, mu, sd)]
    D = d + 1
    w = [0.0] * D
    for _ in range(iters):
        eta = [w[0]] * n
        for i in range(1, D):
            wi = w[i]
            if wi:
                eta = [e + wi * z for e, z in zip(eta, Z[i])]
        p = [_sig(e) for e in eta]
        q = [pi * (1 - pi) for pi in p]
        res = [t - pi for t, pi in zip(y, p)]
        g = [sum(map(mul, res, Z[i])) for i in range(D)]
        H = [[0.0] * D for _ in range(D)]
        for i in range(D):
            qz = list(map(mul, q, Z[i]))
            for j in range(i, D):
                H[i][j] = H[j][i] = sum(map(mul, qz, Z[j]))
        for i in range(1, D):
            H[i][i] += RIDGE
            g[i] -= RIDGE * w[i]
        step = _solve(H, g)
        w = [wi + si for wi, si in zip(w, step)]
    return {"w": w, "mu": mu, "sd": sd}


def predict(m, x):
    z = m["w"][0] + sum(wk * (xk - mk) / sk for wk, xk, mk, sk in zip(m["w"][1:], x, m["mu"], m["sd"]))
    return _sig(z)


def _auc(ps, ys):
    pairs = sorted(zip(ps, ys))
    pos = sum(ys)
    neg = len(ys) - pos
    if not pos or not neg:
        return None
    rank_sum, i = 0.0, 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        r = (i + j + 1) / 2
        rank_sum += r * sum(1 for k in range(i, j) if pairs[k][1])
        i = j
    return round((rank_sum - pos * (pos + 1) / 2) / (pos * neg), 3)


def select(cands, a, c):
    """cands: list of dict(price, score). Highest structural score per side, at least SPACING×ATR apart."""
    out = []
    for side in ("resistance", "support"):
        pool = [x for x in cands if (x["price"] > c) == (side == "resistance") and x["score"] >= MIN_SCORE]
        pool.sort(key=lambda x: (-x["score"], abs(x["price"] - c)))
        chosen = []
        for x in pool:
            if all(abs(x["price"] - y["price"]) >= SPACING * a for y in chosen):
                chosen.append(x)
            if len(chosen) >= PER_SIDE:
                break
        out += chosen
    return out


def _rate(xs):
    return round(sum(xs) / len(xs), 3) if xs else None


def _mean_ci(xs):
    if not xs:
        return None, None
    n = len(xs)
    mu = sum(xs) / n
    sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / max(1, n - 1))
    return round(mu, 4), round(1.96 * sd / math.sqrt(n), 4)


def outcome(S, t, P):
    """What happened to a line drawn at P on day t. None = not resolved yet (too close to the last bar)."""
    a = S.a[t]
    h, l, c = S.h, S.l, S.c
    last = len(c) - 1
    sup = P < c[t]
    o = {"reach": None, "hold": None, "brk": None, "follow": None, "j0": None, "jr": None, "jf": None}
    j0 = None
    for j in range(t + 1, min(last, t + HORIZON) + 1):
        if (l[j] <= P + TOUCH * a) if sup else (h[j] >= P - TOUCH * a):
            j0 = j
            break
    if j0 is None:
        if last >= t + REACH_DAYS:
            o["reach"] = 0
        return o
    o["reach"] = 1 if j0 - t <= REACH_DAYS else 0
    o["j0"] = j0
    thru = (lambda k: c[k] < P - FAIL_ATR * a) if sup else (lambda k: c[k] > P + FAIL_ATR * a)
    away = (lambda k: h[k] >= P + WIN_ATR * a) if sup else (lambda k: l[k] <= P - WIN_ATR * a)
    jb = j0 if thru(j0) else None
    if jb is None:
        for k in range(j0 + 1, min(last, j0 + REACT_DAYS) + 1):
            if thru(k):
                jb = k
                break
            if away(k):
                o.update(hold=1, brk=0, jr=k)
                return o
        if jb is None:
            if last >= j0 + REACT_DAYS:
                o.update(hold=0, brk=0)
            return o
    o.update(hold=0, brk=1, jr=jb)
    beyond = (FAIL_ATR + FOLLOW_ATR) * a
    far = (lambda k: l[k] <= P - beyond) if sup else (lambda k: h[k] >= P + beyond)
    back = (lambda k: c[k] > P) if sup else (lambda k: c[k] < P)
    for k in range(jb + 1, min(last, jb + FOLLOW_DAYS) + 1):
        if far(k):
            o.update(follow=1, jf=k)
            return o
        if back(k):
            o.update(follow=0, jf=k)
            return o
    if last >= jb + FOLLOW_DAYS:
        o["follow"] = 0
    return o


def lines_at(S, t, L):
    """The lines the model would have drawn on day t with an L-day window, with R/S rank by distance."""
    a, c = S.a[t], S.c[t]
    ps, wh, wl = candidates(S, t, L)
    scored = []
    for P in ps:
        x = features(S, t, L, P, wh, wl)
        scored.append({"price": P, "x": x, "score": struct_score(x)})
    sel = select(scored, a, c)
    for side in SIDES:
        same = sorted((z for z in sel if (z["price"] > c) == (side == "resistance")), key=lambda z: abs(z["price"] - c))
        for i, z in enumerate(same):
            x = z["x"]
            z["side"], z["rank"] = side, i + 1
            z["ctx"] = ctx(x)
            z["full"] = z["ctx"] + [i + 1, z["score"], x[IX["n_piv"]], x[IX["major"]], x[IX["ext"]], x[IX["both"]],
                                    x[IX["cross"]], x[IX["tap"]], x[IX["ma"]], x[IX["age"]], x[IX["n_touch"]],
                                    L / 63, a / c * 100]
    return sel


def _fit(rows, y, var):
    if var == "base":
        return {s: _rate([r[y] for r in rows if r["side"] == s]) for s in SIDES}
    return fit_logit([r[var] for r in rows], [r[y] for r in rows])


def _pred(var, mdl, r):
    return mdl[r["side"]] if var == "base" else predict(mdl, r[var])


def _predict_all(models, r):
    p = {y: _pred(*models[y], r) for y, _ in OUTCOMES}
    tot = p["hold"] + p["brk"]
    if tot > 0.98:
        p["hold"], p["brk"] = p["hold"] / tot * 0.98, p["brk"] / tot * 0.98
    return p


def _brier(ps, ys):
    return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ys)


def _logloss(ps, ys):
    e = 1e-4
    return -sum(math.log(max(e, p)) if y else math.log(max(e, 1 - p)) for p, y in zip(ps, ys)) / len(ys)


def _bins(ps, ys, k=5):
    q = sorted(zip(ps, ys), key=lambda x: x[0])
    out = []
    for i in range(k):
        part = q[len(q) * i // k:len(q) * (i + 1) // k]
        if part:
            out.append([round(sum(p for p, _ in part) / len(part), 3), round(sum(y for _, y in part) / len(part), 3), len(part)])
    return out


def train(uni):
    syms = {k: Sym(b, ind) for k, (b, ind) in uni.items()}
    rows = []
    for sk, S in syms.items():
        n = len(S.c)
        k = 0
        for t in range(max(WINDOWS) + 1, n - HORIZON - REACT_DAYS - FOLLOW_DAYS - 1, STRIDE):
            if not S.a[t]:
                continue
            L = WINDOWS[k % len(WINDOWS)]
            k += 1
            for z in lines_at(S, t, L):
                o = outcome(S, t, z["price"])
                rows.append({"d": S.d[t], "side": z["side"], "rank": z["rank"], "ctx": z["ctx"], "full": z["full"],
                             **{y: o[y] for y, _ in OUTCOMES}})
    tr = [r for r in rows if r["d"] < SPLIT]
    te = [r for r in rows if r["d"] >= SPLIT]
    oos, oos_models, prod, base = {}, {}, {}, {}
    for y, _ in OUTCOMES:
        a_tr = [r for r in tr if r[y] is not None]
        a_te = [r for r in te if r[y] is not None]
        ys = [r[y] for r in a_te]
        fits, ps, res = {}, {}, {}
        for var in VARIANTS:
            fits[var] = _fit(a_tr, y, var)
            ps[var] = [_pred(var, fits[var], r) for r in a_te]
            res[var] = {"brier": round(_brier(ps[var], ys), 4), "logloss": round(_logloss(ps[var], ys), 4),
                        "auc": _auc(ps[var], ys)}
        for var in ("ctx", "full"):
            by = {}
            for r, pb, pv in zip(a_te, ps["base"], ps[var]):
                by.setdefault(r["d"][:7], []).append((pb - r[y]) ** 2 - (pv - r[y]) ** 2)
            mu, ci = _mean_ci([sum(v) / len(v) for v in by.values()])
            res[var]["skill"] = round(1 - res[var]["brier"] / res["base"]["brier"], 4)
            res[var]["gain"], res[var]["gain_ci"] = mu, ci
        best = min(VARIANTS, key=lambda v: res[v]["logloss"])
        oos[y] = {"n_train": len(a_tr), "n_test": len(a_te), "rate": _rate(ys), "best": best,
                  "pred": round(sum(ps[best]) / len(ys), 3), "cal": _bins(ps[best], ys), **res}
        oos_models[y] = (best, fits[best])
        alln = [r for r in rows if r[y] is not None]
        prod[y] = (best, _fit(alln, y, best))
        base[y] = _fit(alln, y, "base")
    by_rank = {}
    for side in SIDES:
        for rk in (1, 2, 3):
            part = [r for r in te if r["side"] == side and r["rank"] == rk]
            if not part:
                continue
            ent = {}
            for y, _ in OUTCOMES:
                got = [r for r in part if r[y] is not None]
                ent[y] = {"n": len(got), "rate": _rate([r[y] for r in got]),
                          "pred": _rate([_pred(*oos_models[y], r) for r in got])}
            by_rank[("R" if side == "resistance" else "S") + str(rk)] = ent
    return {"prod": prod, "oos_models": oos_models, "base": base, "oos": oos, "by_rank": by_rank,
            "n": len(rows), "years": round(max(len(S.c) for S in syms.values()) / 252), "n_symbols": len(syms)}


def _salience(score):
    if score >= 3:
        return "high", "高"
    if score >= 2:
        return "mid", "中"
    return "low", "低"


def judge(m, bars, ind, nb):
    S = Sym(bars, ind)
    t = len(bars) - 1
    a = S.a[t]
    if not a or len(bars) < nb + 1:
        return None
    c = S.c[t]
    levels = []
    for z in sorted(lines_at(S, t, nb), key=lambda z: -z["price"]):
        side = z["side"]
        sg = 1 if side == "support" else -1
        k, zh = _salience(z["score"])
        p = _predict_all(m["prod"], z)
        levels.append({
            "price": round(z["price"], 2), "lo": round(z["price"] - TOL * a, 2), "hi": round(z["price"] + TOL * a, 2),
            "kind": side, "rank": z["rank"], "score": round(z["score"], 1), "salience": k, "salience_zh": zh,
            **{y: round(p[y], 3) for y, _ in OUTCOMES},
            "base": {y: m["base"][y][side] for y, _ in OUTCOMES},
            "dist_pct": round((z["price"] / c - 1) * 100, 2), "atr_dist": round((z["price"] - c) / a, 2),
            "target": round(z["price"] + sg * WIN_ATR * a, 2),
            "fail": round(z["price"] - sg * FAIL_ATR * a, 2),
            "follow_to": round(z["price"] - sg * (FAIL_ATR + FOLLOW_ATR) * a, 2),
        })
    return levels


def _episode(S, e, last):
    o, t = e["o"], e["t"]
    if o["j0"] is None:
        res = "miss" if last >= t + HORIZON else "wait"
    elif o["hold"] == 1:
        res = "hold"
    elif o["brk"] == 1:
        res = "brk"
    elif o["hold"] == 0:
        res = "chop"
    else:
        res = "pending"
    d = lambda j: S.d[j] if j is not None else None
    return {"side": e["side"], "from": S.d[t], "price": round(e["P"], 2),
            "pred": {y: round(v, 3) for y, v in e["p"].items()},
            "touch": d(o["j0"]), "result": res, "rdate": d(o["jr"]),
            "follow": o["follow"], "fdate": d(o["jf"])}


def history(m, bars, ind, nb):
    """Replay: the R1/S1 the model drew on each day of the window and what became of them, plus how the
    pre-2022 model's forecasts did on this symbol's own lines since 2022."""
    S = Sym(bars, ind)
    n = len(bars)
    last = n - 1
    track = {"r1": [], "s1": []}
    eps, cur = [], {s: None for s in SIDES}
    for t in range(max(nb, n - nb), n):
        if not S.a[t]:
            continue
        sel = lines_at(S, t, nb)
        for side, key in (("resistance", "r1"), ("support", "s1")):
            z = next((z for z in sel if z["side"] == side and z["rank"] == 1), None)
            track[key].append([S.d[t], round(z["price"], 2) if z else None])
            e = cur[side]
            if z and e and abs(z["price"] - e["P"]) <= TOL * S.a[t]:
                continue
            if z:
                e = {"side": side, "t": t, "P": z["price"], "o": outcome(S, t, z["price"]),
                     "p": _predict_all(m["oos_models"], z)}
                eps.append(e)
            cur[side] = e if z else None
    agg = {y: [[], []] for y, _ in OUTCOMES}
    t0 = next((i for i, d in enumerate(S.d) if d >= SPLIT), n)
    for t in range(max(t0, nb + 1), n, STRIDE):
        if not S.a[t]:
            continue
        for z in lines_at(S, t, nb):
            o = outcome(S, t, z["price"])
            p = _predict_all(m["oos_models"], z)
            for y, _ in OUTCOMES:
                if o[y] is not None:
                    agg[y][0].append(p[y])
                    agg[y][1].append(o[y])
    score = {y: {"n": len(v[1]), "pred": _rate(v[0]), "rate": _rate(v[1])} for y, v in agg.items()}
    out = []
    for e in eps:
        ep = _episode(S, e, last)
        tol = TOL * S.a[e["t"]]
        if any(o["side"] == ep["side"] and o["result"] == ep["result"] and o["rdate"] == ep["rdate"]
               and o["touch"] == ep["touch"] and abs(o["price"] - ep["price"]) <= tol for o in out):
            continue
        out.append(ep)
    return {"track": track, "episodes": out, "score": score,
            "score_from": S.d[max(t0, nb + 1)] if max(t0, nb + 1) < n else None}


def model_card(m):
    return {
        "n": m["n"], "oos": m["oos"], "by_rank": m["by_rank"], "years": m["years"], "n_symbols": m["n_symbols"],
        "outcomes": [{"key": y, "label": lab} for y, lab in OUTCOMES],
        "reach_days": REACH_DAYS, "react_days": REACT_DAYS, "follow_days": FOLLOW_DAYS,
        "win_atr": WIN_ATR, "fail_atr": FAIL_ATR, "follow_atr": FOLLOW_ATR, "split": SPLIT,
        "def": (f"画线：窗口内的局部高/低点（左右各 {PIVOT_K} 根 K 线）相差 {TOL:g} ATR 以内归为同一个价位，"
                f"结构分 = 转折次数（最多 4）+ 一年级别大转折 1 + 窗口极值 1 + 角色互换 0.5 + 转折放量 0.5 + 转折幅度 0–0.5；"
                f"每一侧取结构分 ≥ {MIN_SCORE:g} 里最高、彼此相隔至少 {SPACING:g} ATR 的 {PER_SIDE} 条。"
                f"结局：{REACH_DAYS} 日内碰到（离线 {TOUCH:g} ATR 以内）；碰到后 {REACT_DAYS} 日内先反向走出 {WIN_ATR:g} ATR = 守住，"
                f"先收盘穿过 {FAIL_ATR:g} ATR = 突破；突破后 {FOLLOW_DAYS} 日内再走出 {FOLLOW_ATR:g} ATR = 延续，先收回线的另一侧 = 假突破。"),
    }
