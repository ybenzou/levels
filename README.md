# Levels

Daily key-levels dashboard + a lightweight position model (cassette / observation-first). AVGO · SKHY · CRWV.

Live: https://ybenzou.github.io/levels/ — `?s=SKHY`, `?s=CRWV` to switch; `#signal`, `#observe`, … to pick a tab.

Public GitHub Pages, static files only. Statistical reference, not investment advice.

## Tabs

| Tab | What it answers |
| --- | --- |
| 信号 | How much to hold today for a chosen risk level, whether today is a better or worse day to add, and how the sizing rule did historically. |
| 观察 | The last 1 / 2 / 3 months (switch top-right). Every line on the chart, and every band between two lines, is explained in plain words on the right: what it is, how to read it, and how it behaved in 10 years × 19 symbols. |
| 点位 | The full level ladder (MA, Bollinger, Donchian, VRVP, Fib, gaps, swings, pivots). |
| 触及 / 突破 | Did touches hold / did breakouts follow through — over the full history, with 95% intervals and a placebo baseline. |
| 回测 | Replay the last year bar by bar with the touch / breakout events. |

## The model (`pipeline/model.py`)

1. **Risk-budget sizing (core).** Position = per-stock volatility budget ÷ forecast volatility (blend of 20-day and 1-year realised vol). Budgets: 保守 6%, 平衡 10%, 积极 15% annualised per stock. It does not try to beat buy-and-hold; it converts a risk tolerance into a position size and keeps realised volatility near the budget.
2. **Timing score (weak tilt).** Equal-weight blend of short-term reversal (5-day move, distance below SMA20, RSI(2)) and the low-volatility effect. No fitted coefficients. Shown with its pooled calibration; used for pacing adds, it does not change the recommended size.
3. **Regime + risk lines.** Trend (SMA50/200), volatility percentile, chandelier line (22-day high close − 3×ATR14), nearest priority-1 support / resistance.

**观察 lines (`pipeline/observe.py`).** Line positions use only the chosen window (window high/low, volume profile POC/VAH/VAL, swing highs/lows, unfilled gaps) plus today's SMA20/50/200, Bollinger bands and 20-day high/low. Lines within 0.4% are merged. Each band between neighbouring lines is tagged by where it sits relative to the value area, its volume density, and whether it lies outside the Bollinger bands. Statistics are learned on the full history, never on the window: touch→hold rates pooled across all 19 symbols against a shifted-line placebo, and, for the band the price is in, which line real price paths reached first within 10 days (distances in ATR, same SMA200 regime).

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
