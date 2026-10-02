# Driftline Swing — redesign lab (2026-10-02)

Why: in two days of live running the old setup (intraday news trades and fast crypto
momentum) made zero qualifying trades. The research lab rated it "not reliable enough"
(14% win rate, profit factor 0.17). This folder tests slow, well-known strategies on daily
bars with real costs, so we keep only what has held up.

Data: Yahoo daily adjusted closes (ETFs, 2006–2026) and Coinbase daily candles (crypto).
Signals are computed on the close, and fills happen at the next open.

Costs:
- ETFs: 0.03% per side.
- Crypto with Robinhood fee tiers: 0.95% taker or 0.50% maker per side, plus 0.02%.

Run it:
1. `python fetch.py`
2. `python strategies.py`
3. `python sweep.py`

## Results (CAGR / max drawdown / Sharpe; full period)

| Strategy | CAGR | Max DD | Sharpe | Trades/yr | Last 3y | Last 1y |
|---|---|---|---|---|---|---|
| SPY buy & hold | 11.2% | −55% | 0.64 | 0 | 23.2% | 16.3% |
| QQQ 200-day trend filter | 11.2% | −26% | 0.76 | 3 | 24.4% | 21.5% |
| RSI(2) pullback, index ETFs | 4.2% | −18% | 0.54 | 59 | 9.8% | 9.0% |
| Dual-momentum ETF rotation (3m, top 3) | 9.2% | −27% | 0.68 | 13 | 10.6% | 11.7% |
| BTC buy & hold | 66% | −84% | 1.10 | 0 | 44% | −29% |
| BTC 50-day trend, maker fees | 69% | −63% | 1.33 | 9 | 35% | −0.3% |
| **Old style: buy after a +2–8% crypto day, hold 1 day (taker)** | **−82%** | **−100%** | −4.7 | 255 | −83% | −76% |
| **Chosen combo: QQQ 200d + BTC 50d (2 slots)** | 44% | −48% | 1.33 | 11 | 30% | 9.4% |

Robustness:
- ETF rotation results change a lot with the lookback window (Sharpe 0.3–0.6). We rejected it.
- BTC trend keeps a Sharpe between 1.04 and 1.33 for every average length from 30 to 200 days, so it does not depend on lucky tuning.
- Most of BTC's long-run return came before 2021. The later half of the data shows about 13–15% a year.

## What the evidence says

1. Short-term crypto trading at 0.95% per side cannot work at this account size. The fees
   alone cost more than any edge we found.
2. 20% a day is not achievable. Even the best long-run result here is about 40% a year,
   with drawdowns close to half the money at risk.
3. What has held up for decades is slow trend-following: hold while the price is above a
   long average and sit in cash when it is below. It trades rarely, so it pays little in fees.

## Live design (Driftline Swing)

- **Sleeve A:** about $20 in QQQ (fractional shares) while QQQ closes above its 200-day
  average; otherwise cash. Checked on weekdays at 3:45 p.m. ET and held overnight.
  A resting stop 10% below entry protects against disasters.
- **Sleeve B:** about $20 in BTC while BTC is above its 50-day average; otherwise cash.
  Checked daily. Buys and sells use resting limit orders to get the 0.50% maker fee where
  possible. A resting stop 20% below entry protects against disasters.

Unchanged hard limits:
- No margin, ever.
- At most 3 positions across the account, at most $20 each, never two in the same symbol.
- Agentic account only.
- Casey's DOGE is left alone. It uses the third slot.
- Kill switch below $50 total value.

`signal.py` prints today's state for both sleeves.
