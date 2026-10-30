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
- *Reading the chart.* Each key line has its own colour. Resistance: R1 vermilion, R2 amber, R3 pale gold. Support: S1 green, S2 cyan, S3 lavender. Rank-3 lines are dashed, and a thicker line means higher salience. The price axis labels each line R1…S3. Hovering a card or line highlights it and dims the others. The same colour is used for the line's card border and wherever its name appears in the text. Replay tracks use the R1/S1 colours; 守 markers are cream, 破 markers magenta. The live price is the white line.
- *Replay.* "回放" draws the R1/S1 the model drew on each day of the window (dotted steps) and marks where each one held (守) or broke (破). The rail lists the latest lines with their touch / hold / break / follow-through dates.

- *Pre-market / intraday.* Builds during the US pre-market and session add the latest trade (Yahoo 5-minute bars incl. pre/post). The lines stay as drawn from the last close. The page says which lines the price has already crossed and how far it is from each break line (a close beyond it is what counts). It also re-estimates the 10-day reach of the next lines at the new distance. The backtest only uses regular-session highs, lows and closes, so pre-market prints are a heads-up, not a touch. While a session is open, Yahoo's partial daily bar is dropped, so the model never treats an unfinished day as a close.

- *Real-time (tick by tick).* The page opens a Finnhub websocket in the browser and follows every trade for the open symbol. The free feed covers the US regular session only; pre-market comes from the scheduled builds above. Each trade updates the live candle and price line. It also updates each line's state, the same one the backtest uses: touched → beyond the break line (a warning; only a close counts) → follow-through, or back across (false break), or reached the hold target. The 10-day reach of the next lines is recomputed in the browser with the published reach model (`key_model.reach_model`, `key.rt`). State changes are listed in the 盘中 block and can raise browser notifications (「提醒」). The default API key ships in `app.js`. Click 「实时」 to use your own; it is stored only in that browser.

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

`.github/workflows/refresh-data.yml` rebuilds after each US session (05:30 and 08:00 HKT), and also during the US pre-market and session (18:00, 20:00, 22:00, 00:00, 03:00 HKT), and commits the data. It can also be run by hand from the Actions tab.
