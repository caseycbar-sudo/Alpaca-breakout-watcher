# Alpaca Breakout Watcher

A read-only market scanner plus a strict **PAPER—NO REAL ORDER** laboratory.

It scans Alpaca's broad active/mover lists every five minutes during U.S. market hours, calculates five-minute momentum, session VWAP, RSI, time-adjusted relative volume, executable spread, and opening-range confirmation, and requires a recent news catalyst. A simulated entry can occur only after a second-bar hold or successful retest.

## Safety design

- Use **Alpaca paper-account keys only**.
- The code has no create, replace, cancel, or submit-order method.
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
3. Choose **New repository secret** and add these exact names:

| Secret | Value |
|---|---|
| `ALPACA_API_KEY` | Alpaca paper key ID |
| `ALPACA_SECRET_KEY` | Alpaca paper secret |
| `ALERT_EMAIL_FROM` | Gmail address sending alerts |
| `ALERT_EMAIL_TO` | Address that should receive alerts |
| `GMAIL_APP_PASSWORD` | 16-character Google App Password |

4. For Gmail, first enable 2-Step Verification, then create an App Password. Never use your normal Gmail password.
5. Open **Actions → Alpaca breakout watcher → Run workflow** for the first test.

The workflow then runs every five minutes while the U.S. stock market may be open. Alpaca's official market clock prevents scanning on market holidays and outside the regular session.

## What qualifies

A paper entry needs all of the following:

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

No email is sent when nothing meets the full confirmation rules.

## Data caveat

The default free `iex` feed is useful for development but is not the complete consolidated SIP market. Volume, spread, and breakout readings can differ from Robinhood or a full-market feed. Treat alerts as research and paper simulations, never certainty or financial advice.

## Local test

```bash
python -m pip install -r requirements.txt
pytest -q
python -m src.main
```

Copy `.env.example` values into your own secret manager or shell environment. Never commit credentials.
