"""关键位：模型自己从价格结构里找出来的重要价位，以及用 10 年 × 19 只股票训练出的判断。

1. 找位：窗口内的转折点（局部高/低点）聚类，按「转折次数、一年级别大转折、窗口极值、角色互换、
   转折放量、转折幅度」打结构分；常用参考线（均线、布林、20 日高低）只作候选，没有结构分就不会入选。
2. 判断：两个逻辑回归，特征只用距离（ATR 倍数）、支撑/压力、顺逆势、均线斜率、现价在窗口里的位置：
   - 10 个交易日内碰到这个价位的概率；
   - 碰到之后，先朝反方向走出 1 ATR（有效）还是先收盘穿过 0.5 ATR（失效）。
3. 体检：2022 年以后的数据不参与训练，用来检验两个概率是否校准，以及结构关键位 / 常用参考线
   比「同样距离、同样趋势」的随机价位多出多少有效率。
"""
import bisect
import math
import random

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


def reach(S, t, P, days=REACH_DAYS):
    a = S.a[t]
    sup = P < S.c[t]
    for j in range(t + 1, t + 1 + days):
        if (sup and S.l[j] <= P + TOUCH * a) or (not sup and S.h[j] >= P - TOUCH * a):
            return 1
    return 0


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


def candidates(S, t, L, rng=None):
    a = S.a[t]
    s = t - L + 1
    raw = []
    for i, kind, p in _window_pivots(S, t, L):
        raw.append((p, "pivot"))
    for arr in S.ma + S.ref:
        if arr[t]:
            raw.append((arr[t], "ref"))
    wh, wl = max(S.h[s:t + 1]), min(S.l[s:t + 1])
    raw += [(wh, "ref"), (wl, "ref")]
    if rng is not None:
        for _ in range(4):
            raw.append((rng.uniform(wl - a, wh + a), "rand"))
    raw.sort()
    groups = []
    for p, src in raw:
        if groups and p - groups[-1][-1][0] <= TOL * a:
            groups[-1].append((p, src))
        else:
            groups.append([(p, src)])
    c = S.c[t]
    out = []
    for g in groups:
        p = sum(x[0] for x in g) / len(g)
        if MIN_DIST * a <= abs(p - c) <= MAX_DIST * a:
            srcs = set(x[1] for x in g)
            out.append((p, srcs == {"rand"}, "ref" if srcs == {"ref"} else ("rand" if srcs == {"rand"} else "mixed")))
    return out, wh, wl


def features(S, t, L, P, wh, wl, detail=False):
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
    if not detail:
        return x
    return x, {"pivots": piv, "crosses": crosses, "hi": nh, "lo": nl,
               "ext": "hi" if abs(P - wh) <= tol else ("lo" if abs(P - wl) <= tol else None),
               "ma": [k for k, arr in zip(("SMA20", "SMA50", "SMA200"), S.ma) if arr[t] and abs(arr[t] - P) <= tol]}


def label(S, t, P):
    a = S.a[t]
    h, l, c = S.h, S.l, S.c
    sup = P < c[t]
    j0 = None
    for j in range(t + 1, t + 1 + HORIZON):
        if (sup and l[j] <= P + TOUCH * a) or (not sup and h[j] >= P - TOUCH * a):
            j0 = j
            break
    if j0 is None:
        return None
    if (sup and c[j0] < P - FAIL_ATR * a) or (not sup and c[j0] > P + FAIL_ATR * a):
        return 0
    for k in range(j0 + 1, j0 + 1 + REACT_DAYS):
        if sup:
            if c[k] < P - FAIL_ATR * a:
                return 0
            if h[k] >= P + WIN_ATR * a:
                return 1
        else:
            if c[k] > P + FAIL_ATR * a:
                return 0
            if l[k] <= P - WIN_ATR * a:
                return 1
    return 0


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
    d = len(X[0])
    mu = [sum(r[k] for r in X) / len(X) for k in range(d)]
    sd = [math.sqrt(sum((r[k] - mu[k]) ** 2 for r in X) / len(X)) or 1.0 for k in range(d)]
    Z = [[1.0] + [(r[k] - mu[k]) / sd[k] for k in range(d)] for r in X]
    D = d + 1
    w = [0.0] * D
    for _ in range(iters):
        H = [[0.0] * D for _ in range(D)]
        g = [0.0] * D
        for z, t in zip(Z, y):
            p = _sig(sum(wi * zi for wi, zi in zip(w, z)))
            q = p * (1 - p)
            e = t - p
            for i in range(D):
                zi = z[i]
                g[i] += e * zi
                qi = q * zi
                Hi = H[i]
                for j in range(i, D):
                    Hi[j] += qi * z[j]
        for i in range(D):
            for j in range(i):
                H[i][j] = H[j][i]
            if i:
                H[i][i] += RIDGE
                g[i] -= RIDGE * w[i]
        step = _solve(H, g)
        w = [wi + si for wi, si in zip(w, step)]
    return {"w": w, "mu": mu, "sd": sd}


def predict(m, x):
    z = m["w"][0] + sum(wk * (xk - mk) / sk for wk, xk, mk, sk in zip(m["w"][1:], x, m["mu"], m["sd"]))
    return _sig(z)


def contributions(m, x):
    return [wk * (xk - mk) / sk for wk, xk, mk, sk in zip(m["w"][1:], x, m["mu"], m["sd"])]


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


def train(uni, seed=7):
    rng = random.Random(seed)
    syms = {k: Sym(b, ind) for k, (b, ind) in uni.items()}
    rows = []
    for sk, S in syms.items():
        n = len(S.c)
        k = 0
        for t in range(max(WINDOWS) + 1, n - HORIZON - REACT_DAYS - 1, STRIDE):
            if not S.a[t]:
                continue
            L = WINDOWS[k % len(WINDOWS)]
            k += 1
            cs, wh, wl = candidates(S, t, L, rng)
            for P, _, src in cs:
                x = features(S, t, L, P, wh, wl)
                rows.append({"d": S.d[t], "g": (sk, t), "x": x, "c": ctx(x), "y": label(S, t, P), "r": reach(S, t, P),
                             "src": src, "p": P, "a": S.a[t], "close": S.c[t], "score": struct_score(x),
                             "side": "support" if P < S.c[t] else "resistance"})
    tr = [r for r in rows if r["d"] < SPLIT]
    te = [r for r in rows if r["d"] >= SPLIT]
    trl = [r for r in tr if r["y"] is not None]
    tel = [r for r in te if r["y"] is not None]
    react_oos = fit_logit([r["c"] for r in trl], [r["y"] for r in trl])
    reach_oos = fit_logit([r["c"] for r in tr], [r["r"] for r in tr])
    for r in te:
        r["pr"] = predict(reach_oos, r["c"])
        if r["y"] is not None:
            r["py"] = predict(react_oos, r["c"])

    # Reach calibration: predicted vs realised by decile.
    q = sorted(te, key=lambda r: r["pr"])
    dec = []
    for i in range(10):
        part = q[len(q) * i // 10:len(q) * (i + 1) // 10]
        if part:
            dec.append([round(sum(r["pr"] for r in part) / len(part), 3), round(sum(r["r"] for r in part) / len(part), 3)])
    # Does the level itself add anything beyond distance + trend? Residual = outcome − context prediction.
    picked = {}
    for r in te:
        picked.setdefault(r["g"], []).append(r)
    sel_ids = set()
    for g in picked.values():
        for x in select([dict(price=r["p"], score=r["score"], _id=id(r)) for r in g], g[0]["a"], g[0]["close"]):
            sel_ids.add(x["_id"])
    edge = {}
    for name, pick in (("structure", lambda r: id(r) in sel_ids), ("ref", lambda r: r["src"] == "ref"),
                       ("random", lambda r: r["src"] == "rand")):
        edge[name] = {}
        for side in ("support", "resistance"):
            res = [r["y"] - r["py"] for r in tel if r["side"] == side and pick(r)]
            mu, ci = _mean_ci(res)
            edge[name][side] = {"edge": mu, "ci": ci, "n": len(res),
                                "rate": _rate([r["y"] for r in tel if r["side"] == side and pick(r)])}
    oos = {"split": SPLIT, "n_train": len(trl), "n_test": len(tel),
           "react_auc": _auc([r["py"] for r in tel], [r["y"] for r in tel]),
           "reach_auc": _auc([r["pr"] for r in te], [r["r"] for r in te]),
           "reach_deciles": dec, "edge": edge}
    m = {"react": fit_logit([r["c"] for r in rows if r["y"] is not None], [r["y"] for r in rows if r["y"] is not None]),
         "reach": fit_logit([r["c"] for r in rows], [r["r"] for r in rows])}
    m["base_side"] = {s: _rate([r["y"] for r in rows if r["y"] is not None and r["side"] == s]) for s in ("support", "resistance")}
    m["oos"] = oos
    m["n"] = sum(1 for r in rows if r["y"] is not None)
    m["years"] = round(max(len(S.c) for S in syms.values()) / 252)
    m["n_symbols"] = len(syms)
    return m


PHRASE = {
    "n_piv": ("转折次数多", "转折次数少"),
    "both": ("支撑和压力角色互换过", "没有角色互换"),
    "react": ("转折后的平均反应大", "转折后的平均反应小"),
    "cross": ("被收盘来回穿越得多", "很少被收盘穿越"),
    "tap": ("成交量集中经过这里", "成交量很少经过这里"),
    "dist": ("离现价较远", "离现价很近"),
    "ext": ("是窗口最高/最低点", "不是窗口极值"),
    "ma": ("与均线重合", "附近没有均线"),
    "age": ("很久没有在这里转折", "最近刚在这里转折"),
    "with_trend": ("顺着趋势方向", "逆着趋势方向"),
    "support": ("是支撑（历史上支撑整体比压力可靠）", "是压力（历史上压力整体比支撑弱）"),
    "react_max": ("有过一次很强的转折", "没有过强转折"),
    "piv_vol": ("转折当天放量", "转折当天没有放量"),
    "n_touch": ("被反复试探过", "很少被试探"),
    "major": ("是一年级别的大转折点", "不是一年级别的转折点"),
    "round": ("是整数关口", "不是整数关口"),
    "pos": ("现价在窗口区间偏上", "现价在窗口区间偏下"),
    "slope": ("20 日均线向上", "20 日均线向下"),
}


def _salience(score):
    if score >= 3:
        return "high", "高"
    if score >= 2:
        return "mid", "中"
    return "low", "低"


def _reasons(x, det, S, wl):
    out = []
    piv = sorted(det["pivots"])
    if piv:
        ds = "、".join(S.d[i][5:] for i, _ in piv[-4:])
        kinds = ("高点" if det["hi"] else "") + ("/" if det["hi"] and det["lo"] else "") + ("低点" if det["lo"] else "")
        out.append(f"{wl}在这里形成过 {len(piv)} 次{kinds}（{ds}），最强一次之后走出 {x[IX['react_max']]:.1f} ATR")
    if x[IX["major"]]:
        out.append("也是近一年的大级别转折点（左右各 10 根 K 线里的最高/最低）")
    if det["ext"]:
        out.append(f"是{wl}{'最高' if det['ext'] == 'hi' else '最低'}点")
    if x[IX["both"]]:
        out.append("既当过支撑也当过压力（角色互换）")
    if x[IX["piv_vol"]] >= 1.5:
        out.append(f"转折当天成交量是 20 日均量的 {x[IX['piv_vol']]:.1f} 倍")
    if det["ma"]:
        out.append("附近还有 " + "、".join(det["ma"]))
    if det["crosses"] >= 4:
        out.append(f"{wl}收盘来回穿过它 {det['crosses']} 次，这一带更像震荡中枢而不是硬边界")
    return out


def judge(m, bars, ind, nb, wl):
    S = Sym(bars, ind)
    t = len(bars) - 1
    a = S.a[t]
    if not a or len(bars) < nb + 1:
        return None
    c = S.c[t]
    cs, wh, wl_ = candidates(S, t, nb)
    scored = []
    for P, _, _ in cs:
        x, det = features(S, t, nb, P, wh, wl_, detail=True)
        scored.append({"price": P, "score": struct_score(x), "x": x, "det": det})
    sel = select(scored, a, c)
    sel.sort(key=lambda z: -z["price"])
    levels = []
    for z in sel:
        side = "resistance" if z["price"] > c else "support"
        k, zh = _salience(z["score"])
        cx = ctx(z["x"])
        levels.append({
            "price": round(z["price"], 2), "lo": round(z["price"] - TOL * a, 2), "hi": round(z["price"] + TOL * a, 2),
            "kind": side, "score": round(z["score"], 1), "salience": k, "salience_zh": zh,
            "reach": round(predict(m["reach"], cx), 3), "react": round(predict(m["react"], cx), 3),
            "base": m["base_side"].get(side),
            "dist_pct": round((z["price"] / c - 1) * 100, 2), "atr_dist": round((z["price"] - c) / a, 2),
            "why": _reasons(z["x"], z["det"], S, wl),
        })
    return levels


def model_card(m):
    return {
        "base_side": m["base_side"], "n": m["n"], "oos": m["oos"], "years": m["years"], "n_symbols": m["n_symbols"],
        "reach_days": REACH_DAYS, "react_days": REACT_DAYS, "win_atr": WIN_ATR, "fail_atr": FAIL_ATR,
        "def": (f"找位：窗口内的局部高/低点（左右各 {PIVOT_K} 根 K 线）相差 {TOL:g} ATR 以内归为同一个价位，"
                f"结构分 = 转折次数（最多 4）+ 一年级别大转折 1 + 窗口极值 1 + 角色互换 0.5 + 转折放量 0.5 + 转折幅度 0–0.5；"
                f"每一侧取结构分 ≥ {MIN_SCORE:g} 里最高、彼此相隔至少 {SPACING:g} ATR 的 {PER_SIDE} 个。"
                f"有效：{HORIZON} 个交易日内碰到后，{REACT_DAYS} 天内先朝反方向走出 {WIN_ATR:g} ATR；"
                f"失效：先收盘穿过 {FAIL_ATR:g} ATR 或没反应。"),
    }
