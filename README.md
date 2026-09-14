# Alpaca Breakout Watcher

A read-only premarket and regular-session scanner plus a strict **PAPER—NO REAL ORDER** laboratory.

The watcher scans Alpaca's active/mover universe every five minutes. Premarket scans build a rotating daily roster and send only meaningful new or changed candidates. Regular-session scans evaluate catalyst momentum, VWAP, volatility-adjusted risk, dollar liquidity, broad-market alignment, and opening-range confirmation.

## Safety design

- Use **Alpaca paper-account keys only**.
- The code has no create, replace, cancel, or submit-order method.
- Premarket alerts are watchlist-only; they cannot create paper entries.
- Maximum simulated position: $10 from a $50 virtual balance.
- Maximum three new simulations per market day.
- No new simulations after two losses that day.
- Entries use ask plus 0.05% slippage; exits use bid minus 0.05% slippage.
- Stops are technical and ATR-aware; targets are at least 2:1 reward-to-risk.
- Open simulations exit at stop, target, or 3:55 p.m. Eastern.
- Losing results remain in `data/paper_ledger.csv`.
- Setups A, B and C are measured separately.
- No strategy promotion before at least 100 completed trades per setup and positive unseen validation.

## Repository secrets

| Secret | Value |
|---|---|
| `ALPACA_API_KEY` | Alpaca paper key ID |
| `ALPACA_SECRET_KEY` | Alpaca paper secret |
| `ALERT_EMAIL_FROM` | Gmail address sending alerts |
| `ALERT_EMAIL_TO` | Address receiving alerts |
| `GMAIL_APP_PASSWORD` | 16-character Google App Password |

For Gmail, enable 2-Step Verification and create an App Password. Never use a normal Gmail or Alpaca password.

## Strategy families

- **A — Catalyst ORB second-bar hold:** a fresh-catalyst stock breaks its first 15-minute range and holds above it for a second completed bar.
- **B — First VWAP/level retest:** a breakout pulls back toward VWAP or the opening-range level, then closes back above the anchor.
- **C — Premarket leader confirmed after open:** a symbol from the saved premarket roster later satisfies the regular-session confirmation rules.

## Core candidate filters

- price $0.50–$100;
- daily or premarket move 2%–8%;
- latest completed five-minute acceleration normally 0.40%–2.00% (0.15% minimum on a controlled retest);
- relative volume at least 1.5x;
- at least $250,000 of dollar volume in the confirmation bar;
- five-minute RSI allowed from 52–78, with 55–72 ranked higher;
- price above VWAP and no more than one five-minute ATR above it;
- executable bid/ask spread no wider than 0.40%;
- active and tradable Alpaca symbol;
- catalyst no older than 24 hours;
- automatic rejection of obvious offering, dilution, reverse-split, or delisting headlines;
- broad-market filter rejects new longs when both SPY and QQQ are below VWAP and weakening;
- technical stop below the retest/VWAP/opening-range structure, with no more than one ATR of entry risk.

Premarket candidates remain watchlist-only. Regular-session paper entries require a confirmed hold or retest. No email is sent when nothing meets the relevant rules.

## Data caveat

The default free `iex` feed is not the complete consolidated SIP market. Volume, spread, and breakout readings can differ from Robinhood or a full-market feed. Automated news is a catalyst filter, not a substitute for checking the company's primary release and current SEC filings. Treat alerts as research and paper simulations, never certainty or financial advice.

## Local test

```bash
python -m pip install -r requirements.txt
pytest -q
python -m src.main
```

Never commit credentials.
