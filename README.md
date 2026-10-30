# Levels

Daily key-levels dashboard + a lightweight position model (cassette / observation-first). AVGO · SKHY · CRWV.

Live: https://ybenzou.github.io/levels/ — `?s=SKHY`, `?s=CRWV` to switch; `#signal`, `#observe`, … to pick a tab.

Public GitHub Pages, static files only. Statistical reference, not investment advice.

## Tabs

| Tab | What it answers |
| --- | --- |
| 信号 | How much to hold today for a chosen risk level, whether today is a better or worse day to add, and how the sizing rule did historically. |
| 观察 | The last 1 / 2 / 3 months (switch top-right). The model picks the key support / resistance prices from price structure (R1/R2…, S1/S2…), gives the odds of reaching it within 10 days, holding or breaking once touched, and following through after a break, the prices that define each outcome and the next level, and turns the band the price sits in into a plan (where to watch, where it fails, what's next). Indicator lines (MA, Bollinger, 20-day high/low) are an optional "参考线" overlay. |
| 点位 | The full level ladder (MA, Bollinger, Donchian, VRVP, Fib, gaps, swings, pivots). |
| 触及 / 突破 | Did touches hold / did breakouts follow through — over the full history, with 95% intervals and a placebo baseline. |
| 回测 | Replay the last year bar by bar with the touch / breakout events. |

## The model (`pipeline/model.py`)

1. **Risk-budget sizing (core).** Position = per-stock volatility budget ÷ forecast volatility (blend of 20-day and 1-year realised vol). Budgets: 保守 6%, 平衡 10%, 积极 15% annualised per stock. It does not try to beat buy-and-hold; it converts a risk tolerance into a position size and keeps realised volatility near the budget.
2. **Timing score (weak tilt).** Equal-weight blend of short-term reversal (5-day move, distance below SMA20, RSI(2)) and the low-volatility effect. No fitted coefficients. Shown with its pooled calibration; used for pacing adds, it does not change the recommended size.
3. **Regime + risk lines.** Trend (SMA50/200), volatility percentile, chandelier line (22-day high close − 3×ATR14), nearest priority-1 support / resistance.

**观察 key levels (`pipeline/keylevels.py`, `pipeline/observe.py`).**

- *Where.* Candidate prices are the window's swing pivots (3 bars each side); candidates within 0.3 ATR are merged into one zone. Each zone gets a structural score: how many pivots formed there (capped at 4), whether it is also a 1-year major pivot (10 bars each side), whether it is the window high/low, role reversal (was support, now resistance or vice versa), pivot volume ≥ 1.5× the 20-day average, and the largest move that started there. The top 3 per side with score ≥ 1, at least 1 ATR apart, become R1/R2/R3 and S1/S2/S3. Salience 高/中/低 comes from the score. Every number and sentence on the page is recomputed from the latest bars on each build; nothing is written by hand.
- *Backtest = our own lines.* On every 3rd trading day of 10 years × 19 symbols, the same rules draw R1–R3 / S1–S3 (window length rotating 1/2/3 months). Each line is followed forward. *Reach*: touched within 10 days (0.1 ATR). *Hold* / *break*: after a touch, does price first move 1 ATR away, or first close 0.5 ATR through, within 10 days? *Follow-through*: after a break, does price go another 1 ATR within 10 days, or first close back on the other side (false break)? About 52k lines.
- *Training.* For each outcome, three forecasts are compared out of sample (trained before 2022, tested after, Brier score, month-clustered intervals): the historical average per side; a ridge logistic on distance (ATR), side, trend, SMA20 slope and position in the window; and the same plus the line's own structure (rank, structural score, pivots, major pivot, window extreme, role reversal, crossings, volume share, MA overlap, age, touches, window length, ATR%). The best one is used, refit on all data. Rerun on every build.
- *Result so far.* Reach: the distance+trend model cuts the error by 36% (AUC 0.86, calibrated). Hold / break / follow-through: nothing beat the historical average. That includes the variants above, plus momentum, volume, volatility percentile, a rolling 12/24-month window and per-symbol track records, which were all equal or worse. So the page shows the lines' long-run rates: supports hold ≈ 53%, resistances ≈ 42%, breaks follow through ≈ 67%. The rail also shows, for the open symbol and window, the pre-2022 model's forecasts against what actually happened to its lines since 2022.
- *Replay.* "回放" draws the R1/S1 the model drew on each day of the window (dotted steps) and marks where each one held (守) or broke (破). The rail lists the latest lines with their touch / hold / break / follow-through dates.

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
