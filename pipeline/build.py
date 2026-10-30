"""Build every JSON the site reads.

    python3 pipeline/build.py            # fetch fresh data
    python3 pipeline/build.py --cache    # reuse pipeline/.cache (< 12h old) while developing

Writes data/<SYMBOL>.json for each target, data/index.json, and the legacy data.json /
fallback-data.js (AVGO) so older links and offline opens keep working.
"""
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
import events  # noqa: E402
import model as M  # noqa: E402
import keylevels  # noqa: E402
import observe  # noqa: E402
from config import DISPLAY_BARS, PROXY, TARGETS, UNIVERSE  # noqa: E402
from fetch import fetch_daily  # noqa: E402
from indicators import compute_all  # noqa: E402
from levels import compute_levels, indicator_state, key_bands  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HKT = timezone(timedelta(hours=8))


def _avg(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 4) if xs else None


def _med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 4) if xs else None


def pooled_validation(uni, panel, th):
    ridge = M.walk_forward_ridge(panel)
    calib = M.score_calibration([r for v in panel.values() for r in v], th)
    sizing = {}
    for key, zh, budget in M.PROFILES:
        res = [M.sizing_backtest(b, ind, budget) for b, ind in uni.values()]
        res = [r for r in res if r and r["metrics"]["risk_budget"] and r["metrics"]["risk_budget"]["years"] >= 1]
        rb = [r["metrics"]["risk_budget"] for r in res]
        cs = [r["metrics"]["constant"] for r in res]
        sizing[key] = {
            "label": zh, "budget": budget, "n_symbols": len(res),
            "realised_vol_median": _med([m["vol"] for m in rb]),
            "max_dd_median": _med([m["max_dd"] for m in rb]), "max_dd_worst": min(m["max_dd"] for m in rb),
            "sharpe_avg": _avg([m["sharpe"] for m in rb]), "const_sharpe_avg": _avg([m["sharpe"] for m in cs]),
            "const_vol_median": _med([m["vol"] for m in cs]),
        }
    tilts = [M.tilt_backtest(b, ind, panel[s], 0.10) for s, (b, ind) in uni.items()]
    tilts = [t for t in tilts if t and t["tilt"] and t["base"] and t["base"]["years"] >= 1]
    tilt = {"n_symbols": len(tilts),
            "tilt_sharpe_avg": _avg([t["tilt"]["sharpe"] for t in tilts]),
            "base_sharpe_avg": _avg([t["base"]["sharpe"] for t in tilts]),
            "tilt_better": sum(1 for t in tilts if t["tilt"]["sharpe"] > t["base"]["sharpe"]),
            "tilt_turnover_avg": _avg([t["tilt"]["turnover_yr"] for t in tilts]),
            "base_turnover_avg": _avg([t["base"]["turnover_yr"] for t in tilts])}
    spreads = [v["spread_y"] for v in calib["by_period"].values() if v["spread_y"] is not None]
    verdict = {
        "ridge_useful": ridge["oos_ic"] is not None and ridge["oos_ic"] > 0.02,
        "score_stable": bool(spreads) and all(s > 0 for s in spreads),
        "tilt_adds_value": tilt["tilt_sharpe_avg"] is not None and tilt["tilt_sharpe_avg"] > (tilt["base_sharpe_avg"] or 0) + 0.03,
    }
    return {"universe": list(uni.keys()), "horizon_days": M.HORIZON, "cost_bps": M.COST_BPS,
            "ridge": ridge, "score_calibration": calib, "score_thresholds": [round(t, 4) for t in th],
            "sizing": sizing, "tilt": tilt, "verdict": verdict}


def build_symbol(sym, uni, panel, th, validation, generated_at, meta, pooled_hold, ft_cache, km):
    bars, ind = uni[sym]
    levels, vp, window = compute_levels(bars, ind, DISPLAY_BARS)
    disp = bars[-DISPLAY_BARS:]
    bt = events.run(bars, ind, disp[0]["date"])
    card = M.today_card(bars, ind, panel[sym], th, levels)
    sizing = {}
    for key, zh, budget in M.PROFILES:
        sb = M.sizing_backtest(bars, ind, budget)
        sizing[key] = None if not sb else {"start": sb["start"], "budget": budget, "metrics": sb["metrics"],
                                           "curve": M.downsample_curve(sb["curve"])}
    mdl = {
        "version": 1,
        "card": card,
        "profiles": [{"key": k, "label": zh, "budget": b} for k, zh, b in M.PROFILES],
        "default_profile": M.DEFAULT_PROFILE,
        "sizing": sizing,
        "score_calibration": M.score_calibration(panel[sym], th),
        "tilt": M.tilt_backtest(bars, ind, panel[sym], 0.10),
        "validation": validation,
        "history_days": len(bars),
    }
    if sym in PROXY and PROXY[sym] in uni:
        pb, pind = uni[PROXY[sym]]
        plv, _, _ = compute_levels(pb, pind, DISPLAY_BARS)
        pc = M.today_card(pb, pind, panel[PROXY[sym]], th, plv)
        psz = {}
        for key, zh, budget in M.PROFILES:
            sb = M.sizing_backtest(pb, pind, budget)
            psz[key] = None if not sb else {"start": sb["start"], "budget": budget, "metrics": sb["metrics"],
                                            "curve": M.downsample_curve(sb["curve"])}
        mdl["proxy"] = {"symbol": PROXY[sym], "name": meta[PROXY[sym]]["name"], "currency": meta[PROXY[sym]]["currency"],
                        "history_days": len(pb), "card": pc, "sizing": psz}
    return {
        "symbol": sym, "name": meta[sym]["name"], "currency": meta[sym]["currency"],
        "as_of": bars[-1]["date"], "last_close": round(bars[-1]["close"], 2),
        "generated_at": generated_at, "source": "yahoo_v8_chart",
        "state": indicator_state(bars, ind, vp, window),
        "levels": levels, "key_bands": key_bands(levels),
        "ohlcv": [{"date": b["date"], "open": round(b["open"], 2), "high": round(b["high"], 2),
                   "low": round(b["low"], 2), "close": round(b["close"], 2), "volume": b["volume"]} for b in disp],
        "price_series": [{"date": b["date"], "close": round(b["close"], 2)} for b in disp],
        "backtest": bt,
        "observe": observe.build(bars, ind, bt, pooled_hold, uni, ft_cache, km),
        "model": mdl,
    }


def _dump(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main():
    use_cache = "--cache" in sys.argv
    uni, meta = {}, {}
    for s in UNIVERSE:
        try:
            d = fetch_daily(s, use_cache=use_cache)
        except Exception as e:
            if s in TARGETS:
                raise
            print(f"skip {s}: {e}", file=sys.stderr)
            continue
        uni[s] = (d["bars"], compute_all(d["bars"]))
        meta[s] = {"name": d["name"], "currency": d["currency"]}
    panel = M.build_panel(uni)
    th = M.score_thresholds(panel)
    validation = pooled_validation(uni, panel, th)
    pooled_hold = observe.pooled_hold_stats([events.run(b, ind, b[-1]["date"]) for b, ind in uni.values()],
                                            round(max(len(b) for b, _ in uni.values()) / 252))
    ft_cache = {}
    km = keylevels.train(uni)
    generated_at = datetime.now(HKT).replace(microsecond=0).isoformat()

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    index = {"generated_at": generated_at, "symbols": [], "validation": validation}
    for sym in TARGETS:
        out = build_symbol(sym, uni, panel, th, validation, generated_at, meta, pooled_hold, ft_cache, km)
        _dump(out, os.path.join(ROOT, "data", f"{sym}.json"))
        card = out["model"]["card"]
        index["symbols"].append({"symbol": sym, "name": out["name"], "as_of": out["as_of"], "last_close": out["last_close"],
                                 "history_days": out["model"]["history_days"],
                                 "size_balanced": card["sizes"]["balanced"]["size"],
                                 "timing": (card.get("timing") or {}).get("label"),
                                 "regime": card["regime"]["trend_zh"]})
        if sym == "AVGO":
            _dump(out, os.path.join(ROOT, "data.json"))
            with open(os.path.join(ROOT, "fallback-data.js"), "w") as f:
                f.write("window.__AVGO_FALLBACK__ = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
        print(f"{sym}: as_of {out['as_of']} close {out['last_close']} levels {len(out['levels'])} "
              f"size(bal) {card['sizes']['balanced']['size']} timing {(card.get('timing') or {}).get('label')}")
    _dump(index, os.path.join(ROOT, "data", "index.json"))
    v = validation
    print("ridge OOS IC", v["ridge"]["oos_ic"], v["ridge"]["ic_by_period"])
    print("tilt", v["tilt"])
    print("verdict", v["verdict"])
    print("key levels OOS", {k: km["oos"][k] for k in ("react_auc", "reach_auc")},
          {k: {s: x["edge"] for s, x in d.items()} for k, d in km["oos"]["edge"].items()})


if __name__ == "__main__":
    main()
