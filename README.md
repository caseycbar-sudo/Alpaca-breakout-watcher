# Alpaca Breakout Watcher

A read-only premarket and regular-session scanner, a strict **PAPER—NO REAL ORDER** laboratory, and the [Driftline Trading Command Center](https://caseycbar-sudo.github.io/Alpaca-breakout-watcher/).

The watcher has two layers. Separate always-on Alpaca WebSocket services listen to live stock and crypto trades and quotes and emit conservative **EARLY HEADS-UP** messages within seconds. The stock feed dynamically follows up to 180 active names; the independent 24/7 crypto feed follows ten liquid USD pairs. A bounded options-volume monitor follows near-the-money contracts on SPY, QQQ, and the highest-ranked stocks, showing call volume, put volume, put/call ratio, volume versus open interest, estimated premium, and the busiest contract. The existing five-minute scanner remains the confirmation layer: it evaluates catalyst momentum, VWAP, volatility-adjusted risk, dollar liquidity, broad-market alignment, SEC filings, Nasdaq halts, and opening-range hold/retest confirmation. Stocktwits supplements discovery as an untrusted attention signal only; it never supplies executable prices or bypasses a gate. Early messages never create paper entries.

## Why the stream service matters

GitHub Actions remains a useful fallback and dashboard publisher, but its scheduler cannot be the fast path. The deployable `src.stream_watcher` process stays connected between events, refreshes the Alpaca mover universe every minute, watches rolling 15-second acceleration and 60-second dollar volume, and wakes the email/verification bridge without waiting for the next five-minute job.

The streaming alert is deliberately preliminary. Stocks require a 2%–8% session move, a tight live spread, at least $100,000 of rolling 60-second dollar volume, price above rolling VWAP, and at least 0.25% acceleration over 15 seconds. A roster symbol must also be near its stored trigger. The crypto scanner uses crypto-specific thresholds, but still refuses wide spreads and low-dollar-volume spikes; its alert must be verified against Robinhood pricing and a tested-support or breakout-retest pattern. Thirty-day stock RVOL, five-minute RSI/VWAP, catalyst, filings, halts, and second-bar hold/retest remain mandatory in the downstream verification layer.

### Always-on deployment

#### Run it continuously on a Mac — no hosting bill

1. On the repository page, choose **Code → Download ZIP**, then open the downloaded folder.
2. Open the `macos` folder and double-click **Install Driftline Watcher.command**. If macOS blocks it, Control-click the file, choose **Open**, then confirm **Open**.
3. Enter the Alpaca **paper-account** API key, paper secret key, and Gmail's 16-character App Password when asked. Secret typing is hidden. The two email addresses are already set to `caseycbarai@gmail.com` → `caseycbar@gmail.com`.
4. The installer opens the private [live scanner dashboard](http://127.0.0.1:8765/). It shows independent stock, crypto, and options health; expanded stock coverage; the 24/7 crypto rankings; call/put session volume; clickable contract details; message counts; latest live trades; watcher activity; and a safe bridge-test button. The technical JSON remains available at [healthz](http://127.0.0.1:8765/healthz).
5. Use **Check Driftline Status.command**, **Start Driftline Watcher.command**, or **Stop Driftline Watcher.command** at any time.

The Mac service starts at login, automatically restarts after a crash, and prevents idle sleep while it is running. The installer copies the working program into `~/Library/Application Support/DriftlineWatcher/app`, so the downloaded ZIP may be moved or deleted afterward. Keep the Mac powered on, logged in, connected to the internet, and leave a MacBook lid open during market hours. Credentials are stored only in `~/Library/Application Support/DriftlineWatcher/watcher.env`, protected with owner-only permissions; they are never written to the repository or dashboard. GitHub Actions remains the five-minute backup and confirmation scan.

#### Cloud alternative

1. Deploy this repository as a Docker web service using `render.yaml` (or the same `Dockerfile` on Railway, Fly.io, or another host that permits persistent WebSockets).
2. Add the existing Alpaca paper keys and Gmail secrets to the host. Do not paste secrets into the repository.
3. Use an always-on plan; a service that sleeps cannot provide seconds-level alerts.
4. Confirm `/healthz` reports `connected: true`, a recent `last_message_at`, and `orders_enabled: false`.
5. Keep `.github/workflows/scan.yml` enabled as the slower confirmation/dashboard fallback.

Optional `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_TOKEN` variables send the same early signal directly to a private HTTPS endpoint in parallel with email. This is the fastest path to a phone/watch push provider.

## Trading Command Center

The command center shows:

- watcher, market-session, data-feed, and email-bridge status;
- the dynamic roster with price move, relative volume, and trigger level;
- catalyst headlines, timestamps, and working source links;
- the exact screening gates and why an empty roster is intentional;
- the paper ledger, virtual balance, win rate, expectancy, profit factor, and drawdown;
- the Alpaca → technical gate → Gmail → private Robinhood-verification bridge.
- live connection status for Stocktwits, SEC EDGAR, and the Nasdaq Trader halt feed;
- a linked audit entry when a halt, offering, dilution, reverse split, or listing risk blocks a setup.

The Mac's private live dashboard adds seconds-level transparency without publishing
private data. It ranks the most active incoming symbols, assigns a 0–100 early-quality
score, and shows the exact reason a symbol is still scanning, blocked, or ready for
downstream verification. Trigger distance, rolling VWAP, 60-second dollar volume,
estimated intraday relative-volume pace, executable spread, and source health are
visible together. The Symbols Watched, Market Messages, and Trades Inspected counters
open drill-down views, and meaningful activity history survives service restarts.

The live score is an early-warning ranking, not trade approval. Estimated RVOL uses
the current session pace versus the prior session because calculating full 30-day
RVOL for 120 symbols on every streaming tick would be both slower and misleading on
the free IEX sample. The five-minute confirmation layer still performs the complete
30-day RVOL, RSI, catalyst, SEC, halt, Robinhood, and hold/retest checks.

Options volume is confirmation context, not a directional signal. A call trade can be
an opening purchase, a closing sale, or one leg of a spread; the same ambiguity applies
to puts. Driftline therefore never labels raw call volume as automatically bullish or
raw put volume as automatically bearish. It polls only a bounded near-money chain every
two minutes, keeps stock and crypto scanning alive if the options entitlement is absent,
and never enables options trading.

Only public market research and paper simulations are published. Credentials, complete account numbers, and private Robinhood information never enter the dashboard. It is responsive and refreshes itself every two minutes.

## Backtest Lab — research only

The Backtest Lab replays the A/B/C setup shapes over historical five-minute bars and keeps its results completely separate from live alerts and the paper ledger. It enters on the next bar, models spread plus slippage, assumes the stop was hit first when a stop and target both fit inside one bar, and applies the same $50 balance, $10 position, three-trades-per-day, and two-loss daily limits.

- The learning track studies every recognizable setup shape so failed gates can be compared honestly.
- The strict track includes only setups that pass every historical gate available to replay.
- Pattern mining trains on the older 70% of days and must agree on the newest unseen 30%.
- The explainable second-opinion model reports when it cannot beat chance; it never becomes an automatic trading rule.
- Historical quotes, SEC filings, and Nasdaq halts are not replayed, so the report clearly labels those limits.

Run **Install Driftline Watcher.command** again and choose **Y** to reuse saved settings. Then double-click **Run Backtest Lab.command**. The private report and CSV details are stored under `~/Library/Application Support/DriftlineWatcher/backtest`. The public Command Center also has a **Backtest lab** tab populated by `.github/workflows/backtest.yml` after completed research runs.

```bash
python -m src.backtest_lab
python -m src.backtest_lab --symbols SOFI,PLTR --days 120 --report backtest.html
```

## Safety design

- Use **Alpaca paper-account keys only**.
- The code has no create, replace, cancel, or submit-order method.
- A confirmed Nasdaq halt is a hard block.
- A recent SEC registration/prospectus or filing with offering, dilution, reverse-split, or listing-risk language is a hard block.
- If either official risk source cannot be verified, the candidate is suppressed instead of assumed safe.
- Stocktwits outages fall back to Alpaca-only discovery; social activity never qualifies a setup by itself.
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
| `SEC_USER_AGENT` | Optional SEC-compliant app/contact string; falls back to `DriftlineWatcher/1.0` plus the sender address |
| `ALERT_WEBHOOK_URL` | Optional private HTTPS endpoint for immediate push delivery |
| `ALERT_WEBHOOK_TOKEN` | Optional bearer token for that endpoint |

Streaming tuning variables are documented in `src/config.py`. Conservative defaults are already supplied; the important defaults are up to 180 stocks, ten liquid crypto/USD pairs, a 60-second stock-universe refresh, a 10-minute duplicate cooldown, 0.25% minimum stock acceleration, and $100,000 minimum rolling stock dollar volume. Crypto runs around the clock on its separate Alpaca `v1beta3` stream with lower but still liquidity-gated early-warning thresholds.

For Gmail, enable 2-Step Verification and create an App Password. Never use a normal Gmail or Alpaca password.

## Strategy families

- **A — Catalyst ORB second-bar hold:** a fresh-catalyst stock breaks its first 15-minute range and holds above it for a second completed bar.
- **B — First VWAP/level retest:** a breakout pulls back toward VWAP or the opening-range level, then closes back above the anchor.
- **C — Premarket leader confirmed after open:** a symbol from the saved premarket roster later satisfies regular-session confirmation.

## Core candidate filters

- price $0.50–$100;
- daily or premarket move 2%–8%;
- completed five-minute acceleration normally 0.40%–2.00% (0.15% minimum on a controlled retest);
- relative volume at least 1.5x;
- at least $250,000 of dollar volume in the confirmation bar;
- five-minute RSI allowed from 52–78, with 55–72 ranked higher;
- price above VWAP and no more than one five-minute ATR above it;
- executable bid/ask spread no wider than 0.40%;
- active and tradable Alpaca symbol;
- catalyst no older than 24 hours;
- rejection of obvious offering, dilution, reverse-split, or delisting headlines;
- official Nasdaq Trader halt/resumption verification;
- the last 30 days of SEC submissions, including prospectuses and filing text for offering, convertible, warrant, reverse-split, and listing-risk language;
- no new long when both SPY and QQQ are below VWAP and weakening;
- technical risk no larger than one ATR.

Premarket candidates remain watchlist-only. Regular-session paper entries require a confirmed hold or retest. No trade is invented when nothing meets the rules.

## Data caveat

The free `iex` feed is not the complete consolidated SIP market. Volume, spread, and breakout readings can differ from Robinhood or a full-market feed. Automated news is a catalyst filter, not a substitute for checking the company's primary release and current SEC filings. Stocktwits metrics are crowd-attention context, not verified facts or market data. Treat alerts as research and paper simulations, never certainty or financial advice.

## Local test

```bash
python -m pip install -r requirements.txt
pytest -q
python -m src.main
python -m src.stream_watcher
```

Never commit credentials.
