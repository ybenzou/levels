# Levels

Daily key-levels dashboard + a lightweight position model (cassette / observation-first). AVGO · SKHY · CRWV.

Live: https://ybenzou.github.io/levels/ — `?s=SKHY`, `?s=CRWV` to switch; `#signal`, `#observe`, … to pick a tab.

Public GitHub Pages, static files only. Statistical reference, not investment advice.

## Tabs

| Tab | What it answers |
| --- | --- |
| 信号 | How much to hold today for a chosen risk level, whether today is a better or worse day to add, and how the sizing rule did historically. |
| 观察 | The last 1 / 2 / 3 months (switch top-right). The model picks the key support / resistance prices from price structure (R1/R2…, S1/S2…), explains why each one matters, gives the odds of reaching it within 10 days and of a 1-ATR reaction once touched, and turns the band the price sits in into a plan (where to watch, where it fails, what's next). Indicator lines (MA, Bollinger, 20-day high/low) are an optional "参考线" overlay. |
| 点位 | The full level ladder (MA, Bollinger, Donchian, VRVP, Fib, gaps, swings, pivots). |
| 触及 / 突破 | Did touches hold / did breakouts follow through — over the full history, with 95% intervals and a placebo baseline. |
| 回测 | Replay the last year bar by bar with the touch / breakout events. |

## The model (`pipeline/model.py`)

1. **Risk-budget sizing (core).** Position = per-stock volatility budget ÷ forecast volatility (blend of 20-day and 1-year realised vol). Budgets: 保守 6%, 平衡 10%, 积极 15% annualised per stock. It does not try to beat buy-and-hold; it converts a risk tolerance into a position size and keeps realised volatility near the budget.
2. **Timing score (weak tilt).** Equal-weight blend of short-term reversal (5-day move, distance below SMA20, RSI(2)) and the low-volatility effect. No fitted coefficients. Shown with its pooled calibration; used for pacing adds, it does not change the recommended size.
3. **Regime + risk lines.** Trend (SMA50/200), volatility percentile, chandelier line (22-day high close − 3×ATR14), nearest priority-1 support / resistance.

**观察 key levels (`pipeline/keylevels.py`, `pipeline/observe.py`).**

- *Where.* Candidate prices are the window's swing pivots (3 bars each side); candidates within 0.3 ATR are merged into one zone. Each zone gets a structural score: how many pivots formed there (capped at 4), whether it is also a 1-year major pivot (10 bars each side), whether it is the window high/low, role reversal (was support, now resistance or vice versa), pivot volume ≥ 1.5× the 20-day average, and the largest move that started there. The top 3 per side with score ≥ 1, at least 1 ATR apart, become R1/R2/R3 and S1/S2/S3. Salience 高/中/低 comes from the score.
- *Odds.* Two pooled logistic models (19 symbols × 10 years, sampled every 3 days, ridge-penalised) on the level's context: ATR distance, side, with/against the SMA200 trend, SMA50 slope, position in the 1-year range. *Reach* = touched within 10 days. *React* = after a touch, price moves 1 ATR away before closing 0.5 ATR through it within 10 days.
- *Honest check (out of sample, trained before 2022, tested after).* Reach AUC ≈ 0.85 and well calibrated by decile. React AUC ≈ 0.54, only a rough guide. Residual edge over the context model: structural levels −1.0 pp (support) / +1.3 pp (resistance); MA/Bollinger/Donchian lines and random prices at the same distance land within about ±1 pp. Neither structural nor indicator levels hold better per se; what matters is distance and trend. The levels are for planning (what to watch, where an idea fails, the next target), not a promise that a line holds. The full table is in the 观察 rail under 模型体检.

The chart draws key levels as solid lines (thicker means more salient) with a ±0.3 ATR band. Bands between lines show the price's current zone and how often paths reached the upper vs lower line first within 10 days.

Rendering note: the CRT look uses a colour-only CSS filter on the candle canvas and no blend-mode overlays. Drop-shadow filters and `mix-blend-mode` made every crosshair repaint re-rasterise the page (~900 ms/frame); it now holds 60 fps (p50 16.7 ms).

Every build re-runs the validation and publishes it (信号 → 模型体检):

- Risk-budget sizing across the 19-symbol pool: realised vol vs budget, drawdowns, Sharpe vs a constant position of the same average size.
- Timing score: top-minus-bottom quintile forward 10-day vol-adjusted return in 2017–19, 2020–22, 2023–26; and whether tilting the size by the score beats the untilted size after costs (so far: it doesn't).
- A walk-forward pooled ridge regression on 11 features (trend, momentum, reversal, vol, VRVP, breakout). Out-of-sample IC ≈ −0.06, so it is **not** used — kept as a standing check that extra complexity isn't adding anything.

Assumptions: trade at the close, 10 bp per unit of turnover each side, rebalance only when the target moves ≥ 5% of capital.

SKHY (US listing) has only a few months of history; its page also shows the Korean primary line 000660.KS as a long-history reference.

## Data pipeline (`pipeline/`)

Python 3 stdlib only.

```bash
python3 pipeline/build.py          # fetch fresh daily bars from Yahoo and rebuild everything
python3 pipeline/build.py --cache  # reuse pipeline/.cache (< 12h) while iterating
```

Outputs:

- `data/<SYMBOL>.json` — per-symbol levels, state, 1-year OHLCV, full-history level backtest, model card / curves / validation.
- `data/index.json` — summary across symbols + pooled validation.
- `data.json`, `fallback-data.js` — AVGO in the legacy shape (superset), for older links and offline opens.

Symbols shown and the training pool live in `pipeline/config.py`.

`.github/workflows/refresh-data.yml` rebuilds at 08:00 HKT Tue–Sat (after each US session) and commits the data. It can also be run by hand from the Actions tab.
