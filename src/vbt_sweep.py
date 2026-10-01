"""Driftline parameter sweep — tests many stop/target/breakout combinations with vectorbt.

Research only. The nightly Backtest Lab replays the watcher's exact rules; this
sweep asks a broader question: would *any* simple breakout variation have made
money on the newest days it never learned from? Each combination is scored on the
older 70% of days and then checked on the newest 30%. Many combinations are tried
at once, so a single one that "holds up" can still be luck.

Usage::

    pip install -r requirements-research.txt
    python -m src.vbt_sweep                    # stock study tickers + the watcher's crypto pairs
    python -m src.vbt_sweep --days 60 --stocks SOFI,PLTR --crypto BTC/USD

Reads data with the same read-only Alpaca keys as the watcher. It never sends
alerts, never edits the paper ledger, and has no order code.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from itertools import product
from pathlib import Path
from typing import Any

from .config import Settings
from .paper_lab import SLIPPAGE_RATE
from .scanner import ET, _timestamp

JSON_PATH = Path("docs/data/sweep.json")
BACKTEST_JSON = Path("docs/data/backtest.json")

LOOKBACKS = (6, 12, 24)          # breakout above the prior N five-minute bars
STOPS = (1.0, 2.0, 3.0, 5.0)     # percent
TARGETS = (2.0, 4.0, 6.0, 10.0)  # percent
LIVE_RULE = {"lookback": 12, "stop_pct": 5.0, "target_pct": 10.0}
TREND_BARS = 48
MIN_TRAIN_TRADES = 30
MIN_TEST_TRADES = 20
TRAIN_FRACTION = 0.70
FLAT_MINUTE = 15 * 60 + 40       # the auto-trader closes everything on its 3:40 p.m. run

GROUPS = {
    "stocks": {
        "label": "Stocks (study list)",
        "spread_pct": 0.15,
        "session_only": True,
        "entry": "any five-minute bar closing 9:40–11:30 a.m. ET (the research says midday entries fail)",
    },
    "crypto": {
        "label": "Crypto (watcher pairs)",
        "spread_pct": 1.90,
        "session_only": False,
        "entry": "the hourly auto-trader runs only: bars closing at :40, 9:40 a.m.–2:40 p.m. ET weekdays",
    },
}

CAVEATS = [
    "Many combinations are tried at once, so one that holds up on the unseen days can still be luck. Treat a single winner with suspicion; look for neighbours that also hold up.",
    "Stops and targets are checked on each five-minute close, as a resting order would; fast moves inside a bar are not modeled.",
    "Stock bars come from Alpaca's free IEX feed and crypto bars from Alpaca's US venue; Robinhood prices and spreads can differ.",
    "Every fill pays half the modeled spread plus the paper lab's 0.05% slippage on the way in and out.",
    "This is research for learning. It is not financial advice and it never places orders.",
]


# ---------------------------------------------------------------------------
# Pure helpers (no vectorbt needed)
# ---------------------------------------------------------------------------


def trade_stats(returns: list[float]) -> dict:
    """Stats for a list of per-trade returns expressed as fractions (0.01 = +1%)."""
    n = len(returns)
    if not n:
        return {"trades": 0, "win_rate": 0.0, "avg_return_pct": 0.0, "total_return_pct": 0.0, "profit_factor": None}
    wins = [r for r in returns if r > 0]
    losses = [r for r in returns if r < 0]
    loss = abs(sum(losses))
    return {
        "trades": n,
        "win_rate": round(len(wins) / n * 100, 2),
        "avg_return_pct": round(sum(returns) / n * 100, 4),
        "total_return_pct": round(sum(returns) * 100, 3),
        "profit_factor": round(sum(wins) / loss, 3) if loss else None,
    }


def holds_up(train: dict, test: dict) -> bool:
    return (
        train["trades"] >= MIN_TRAIN_TRADES
        and test["trades"] >= MIN_TEST_TRADES
        and train["avg_return_pct"] > 0
        and test["avg_return_pct"] > 0
        and (test["profit_factor"] or 0) > 1.1
    )


def split_days(days: list[str], fraction: float = TRAIN_FRACTION) -> tuple[set[str], set[str]]:
    days = sorted(set(days))
    if len(days) < 5:
        return set(days), set()
    cut = max(1, min(len(days) - 1, int(round(len(days) * fraction))))
    return set(days[:cut]), set(days[cut:])


def rank(rows: list[dict]) -> list[dict]:
    eligible = [r for r in rows if r["train"]["trades"] >= MIN_TRAIN_TRADES]
    return sorted(eligible, key=lambda r: r["train"]["avg_return_pct"], reverse=True)


def group_verdict(rows: list[dict]) -> str:
    if not rows:
        return "No data for this group."
    good = [r for r in rows if r["holds_up"]]
    if not good:
        return (f"None of the {len(rows)} combinations made money on both the learning days and the unseen days. "
                "No simple breakout variation shows an edge here.")
    if len(good) == 1:
        return ("One combination held up on the unseen days. With this many tries that can easily be luck, "
                "so it is a lead to watch, not a rule to trade.")
    return (f"{len(good)} of {len(rows)} combinations held up on the unseen days. Look for neighbouring settings "
            "that agree before trusting any of them.")


# ---------------------------------------------------------------------------
# vectorbt sweep
# ---------------------------------------------------------------------------


def _frames(bars: dict[str, list[dict]], session_only: bool):
    import pandas as pd

    closes, highs = {}, {}
    for symbol, rows in bars.items():
        if not rows:
            continue
        index, close, high = [], [], []
        for row in rows:
            start = _timestamp(row)
            local = start.astimezone(ET)
            minute = local.hour * 60 + local.minute
            if session_only and (local.weekday() >= 5 or not 9 * 60 + 30 <= minute < 16 * 60):
                continue
            index.append(start + timedelta(minutes=5))  # bar close time
            close.append(float(row["c"]))
            high.append(float(row["h"]))
        if index:
            closes[symbol] = pd.Series(close, index=pd.DatetimeIndex(index))
            highs[symbol] = pd.Series(high, index=pd.DatetimeIndex(index))
    if not closes:
        return None, None, None
    close = pd.DataFrame(closes).sort_index()
    high = pd.DataFrame(highs).reindex(close.index)
    exists = close.notna()
    return close, high, exists


def _masks(index, group: str):
    import numpy as np

    local = index.tz_convert(ET)
    minute = np.asarray(local.hour * 60 + local.minute)
    weekday = np.asarray(local.weekday < 5)
    if group == "stocks":
        entry_ok = weekday & (minute >= 9 * 60 + 40) & (minute <= 11 * 60 + 30)
    else:
        runs = {h * 60 + 40 for h in range(9, 15)}
        entry_ok = weekday & np.isin(minute, list(runs))
    flat = weekday & (minute >= FLAT_MINUTE)
    return entry_ok, flat, [d.isoformat() for d in local.date]


def sweep_group(bars: dict[str, list[dict]], group: str, log=print) -> dict:
    import numpy as np
    import vectorbt as vbt

    spec = GROUPS[group]
    close, high, exists = _frames(bars, spec["session_only"])
    if close is None:
        return {"group": group, "label": spec["label"], "symbols": [], "rows": [], "verdict": "No data for this group."}
    filled = close.ffill()
    high_filled = high.ffill()
    trend = filled.rolling(TREND_BARS, min_periods=TREND_BARS).mean()
    entry_ok, flat, days = _masks(close.index, group)
    train_days, test_days = split_days(days)
    day_of = np.asarray(days)
    fee = spec["spread_pct"] / 200.0 + SLIPPAGE_RATE
    exits = np.repeat(flat[:, None], close.shape[1], axis=1)

    rows = []
    for lookback in LOOKBACKS:
        prior_high = high_filled.rolling(lookback, min_periods=lookback).max().shift(1)
        entries = (filled > prior_high) & (filled > trend) & exists
        entries = entries.values & entry_ok[:, None]
        for stop, target in product(STOPS, TARGETS):
            pf = vbt.Portfolio.from_signals(
                filled, entries, exits,
                sl_stop=stop / 100, tp_stop=target / 100,
                fees=fee, init_cash=100.0, freq="5min",
            )
            records = pf.trades.values
            closed = records[records["status"] == 1]
            train_r, test_r = [], []
            for rec in closed:
                day = day_of[int(rec["entry_idx"])]
                ret = float(rec["return"])
                if not math.isfinite(ret):
                    continue
                (train_r if day in train_days else test_r).append(ret)
            train, test = trade_stats(train_r), trade_stats(test_r)
            rows.append({
                "lookback": lookback,
                "stop_pct": stop,
                "target_pct": target,
                "train": train,
                "test": test,
                "holds_up": holds_up(train, test),
            })
    log(f"  {group}: {len(rows)} combinations over {close.shape[1]} symbols")
    ranked = rank(rows)
    live = next((r for r in rows if all(r[k] == v for k, v in LIVE_RULE.items())), None)
    return {
        "group": group,
        "label": spec["label"],
        "symbols": list(close.columns),
        "entry": spec["entry"],
        "spread_pct": spec["spread_pct"],
        "train_days": len(train_days),
        "test_days": len(test_days),
        "combinations": len(rows),
        "held_up": sum(r["holds_up"] for r in rows),
        "top": ranked[:10],
        "live_rule": live,
        "verdict": group_verdict(rows),
    }


def _stock_symbols(limit: int) -> list[str]:
    try:
        data = json.loads(BACKTEST_JSON.read_text(encoding="utf-8"))
        symbols = [t["symbol"] for t in data.get("tickers", []) if t.get("symbol")]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        symbols = []
    if not symbols:
        from .study_list import study_symbols
        symbols = [row["symbol"] for row in study_symbols(limit, datetime.now(timezone.utc))]
    return symbols[:limit]


def run(settings: Settings, client: Any, stocks: list[str], crypto: list[str], days: int,
        now: datetime | None = None, log=print) -> dict:
    from .backtest import fetch_bars
    from .crypto_lab import fetch_crypto_bars

    now = now or datetime.now(timezone.utc)
    errors: list[str] = []
    end = now - timedelta(minutes=16)
    start = now - timedelta(days=days)
    log(f"Parameter sweep: {len(stocks)} stocks, {len(crypto)} crypto pairs, {start.date()} → {end.date()}")
    groups = []
    if stocks:
        stock_bars = fetch_bars(client, stocks, "5Min", start, end, errors=errors)
        groups.append(sweep_group(stock_bars, "stocks", log))
    if crypto:
        crypto_bars = fetch_crypto_bars(client, crypto, start, end, settings.crypto_location, errors=errors)
        groups.append(sweep_group(crypto_bars, "crypto", log))
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "mode": "RESEARCH ONLY — no alerts, no paper entries, no orders",
        "engine": "vectorbt",
        "window": {"start": start.date().isoformat(), "end": end.date().isoformat(), "lookback_days": days},
        "grid": {"lookback_bars": list(LOOKBACKS), "stop_pct": list(STOPS), "target_pct": list(TARGETS)},
        "rules": {
            "entry": "close above the prior N-bar high and above the 48-bar average",
            "exit": "stop, target, or 3:40 p.m. ET — whichever comes first",
            "holds_up": f"made money on the learning days and the unseen days, ≥ {MIN_TEST_TRADES} unseen trades, profit factor above 1.1",
        },
        "groups": groups,
        "errors": errors[:20],
        "caveats": CAVEATS,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Driftline parameter sweep with vectorbt (research only)")
    parser.add_argument("--stocks", help="Comma-separated tickers (default: the Backtest Lab's tickers)")
    parser.add_argument("--crypto", help="Comma-separated pairs (default: the watcher's crypto pairs)")
    parser.add_argument("--days", type=int, default=90, help="Calendar days of history (20–400)")
    parser.add_argument("--max-stocks", type=int, default=30)
    parser.add_argument("--out", default=str(JSON_PATH))
    args = parser.parse_args(argv)
    if not 20 <= args.days <= 400:
        parser.error("--days must be between 20 and 400")

    from .scanner import AlpacaClient

    settings = Settings()
    settings.validate()
    stocks = [s.strip().upper() for s in args.stocks.split(",")] if args.stocks else _stock_symbols(args.max_stocks)
    raw_crypto = args.crypto if args.crypto is not None else settings.crypto_symbols
    crypto = [s.strip().upper() for s in raw_crypto.split(",") if s.strip()]
    payload = run(settings, AlpacaClient(settings), [s for s in stocks if s], crypto, args.days)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    for group in payload["groups"]:
        print(f"{group['label']}: {group.get('held_up', 0)}/{group.get('combinations', 0)} held up · {group['verdict']}")
    print(f"Dashboard data: {out}")


if __name__ == "__main__":
    main()
