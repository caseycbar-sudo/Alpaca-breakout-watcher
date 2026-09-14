# Alpaca Breakout Watcher

A read-only premarket and regular-session scanner plus a strict **PAPER—NO REAL ORDER** laboratory.

The watcher scans Alpaca's active/mover universe every five minutes. Premarket scans build a rotating daily roster and send only meaningful new or changed candidates. Regular-session scans calculate five-minute momentum, session VWAP, RSI, time-adjusted relative volume, executable spread, and opening-range confirmation. A simulated entry can occur only after the opening bell and after a second-bar hold or successful retest.

## Safety design

- Use **Alpaca paper-account keys only**.
- The code has no create, replace, cancel, or submit-order method.
- Premarket alerts are watchlist-only; they cannot create paper entries.
- Maximum simulated position: $10.
- Starting virtual balance: $50.
- Maximum three new simulations per market day.
- No new simulations after two losses that day.
- Entries use ask plus 0.05% slippage; exits use bid minus 0.05% slippage.
- Every target is at least 2:1 reward-to-risk.
- Open simulations exit at stop, target, or 3:55 p.m. Eastern.
- Losing results remain in `data/paper_ledger.csv`.
- The strategy is never promoted before 30 completed trades and positive unseen validation.

## One-time setup

1. In Alpaca, create or open a **Paper Trading** account and generate paper API keys.
2. In this GitHub repository open **Settings → Secrets and variables → Actions**.
3. Add these exact repository secrets:

| Secret | Value |
|---|---|
| `ALPACA_API_KEY` | Alpaca paper key ID |
| `ALPACA_SECRET_KEY` | Alpaca paper secret |
| `ALERT_EMAIL_FROM` | Gmail address sending alerts |
| `ALERT_EMAIL_TO` | Address receiving alerts |
| `GMAIL_APP_PASSWORD` | 16-character Google App Password |

For Gmail, enable 2-Step Verification and create an App Password. Never use a normal Gmail or Alpaca password.

## Premarket workflow

- Runs from 4:00–9:30 a.m. Eastern on valid trading days.
- Uses completed five-minute extended-hours bars.
- Requires a 2%–8% move, same-time premarket RVOL of at least 1.5x, at least 100,000 cumulative premarket shares, at least 10,000 shares in the latest completed bar, RSI 55–72, price above premarket VWAP, spread no wider than 0.40%, active/tradable status, and fresh news.
- Rejects headlines containing obvious offering, dilution, reverse-split, or delisting warnings.
- Saves no more than three symbols in `data/premarket_state.json`.
- Sends an email only when the day's roster or a symbol's trigger stage materially changes.
- Establishes one provisional breakout level per symbol.
- Never opens a paper trade before regular-session hold/retest confirmation.

## Regular-session paper-entry requirements

- price $0.50–$100;
- session move 2%–8%;
- latest completed five-minute bar move 2%–8%;
- time-adjusted relative volume at least 1.5x;
- at least 50,000 shares in the completed five-minute bar;
- five-minute RSI 55–72;
- price above session VWAP;
- executable bid/ask spread no wider than 0.40%;
- active and tradable Alpaca symbol;
- fresh news within 72 hours;
- opening-range breakout with a second-bar hold or successful retest.

No email is sent when nothing meets the relevant confirmation rules.

## Data caveat

The default free `iex` feed is not the complete consolidated SIP market. Volume, spread, and breakout readings can differ from Robinhood or a full-market feed. Automated news is a catalyst filter, not a substitute for checking the company's primary release and current SEC filings. Treat alerts as research and paper simulations, never certainty or financial advice.

## Local test

```bash
python -m pip install -r requirements.txt
pytest -q
python -m src.main
```

Never commit credentials.
