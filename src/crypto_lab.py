"""Driftline Crypto Lab — replays the auto-trader's crypto rules on past bars.

Research only. The stock Backtest Lab skips crypto because its setups use the stock
session, so crypto trades had no research behind them. This lab mirrors how the
hourly auto-trader actually behaves with crypto:

* it only looks at the market on its hourly runs (9:40 a.m.–3:40 p.m. ET, weekdays);
* an entry needs a fresh one-hour breakout, an uptrend, a +1% to +10% day move and
  enough dollar volume;
* it fills on the next five-minute bar with a modeled spread plus slippage;
* the −5% stop and +10% target are only checked on later hourly runs (crypto has
  no resting stop), and anything still open is closed on the 3:40 p.m. run;
* one position at a time across all pairs.

Usage::

    python -m src.crypto_lab                 # ~4 months of the watcher's crypto pairs
    python -m src.crypto_lab --days 60 --symbols BTC/USD,ETH/USD

Reads data with the same read-only Alpaca keys as the watcher. It never sends
alerts, never edits the paper ledger, and has no order code.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

from .backtest import _get, summarize
from .config import Settings
from .paper_lab import SLIPPAGE_RATE
from .pattern_miner import split_dates
from .scanner import ET, AlpacaClient, _timestamp

JSON_PATH = Path("docs/data/crypto_lab.json")
BAR_MINUTES = 5

CAVEATS = [
    "Bars come from Alpaca's US crypto venue. Robinhood prices and spreads can differ.",
    "Historical bid/ask quotes are not replayed, so every fill pays a modeled spread plus slippage.",
    "Stops and targets are checked only on the hourly runs, exactly like the auto-trader, so a stop can fill well past −5%.",
    "One position at a time across every pair; the first qualifying pair in list order is taken.",
    "This is research for learning. It is not financial advice and it never places orders.",
]


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class CryptoLabConfig:
    lookback_days: int = 120
    # Robinhood crypto spreads are wider than large-cap stock spreads.
    spread_pct: float = field(default_factory=lambda: _env_float("CRYPTO_BACKTEST_SPREAD_PCT", 0.30))
    slippage_rate: float = SLIPPAGE_RATE
    stop_pct: float = 5.0
    target_pct: float = 10.0
    breakout_bars: int = 12      # one hour of five-minute bars
    trend_bars: int = 48         # four hours
    min_day_move_pct: float = 1.0
    max_day_move_pct: float = 10.0
    min_hour_dollar_volume: float = 50_000
    # Hourly auto-trader runs (ET). New entries are never opened on the last run.
    run_minutes: tuple[int, ...] = tuple(h * 60 + 40 for h in range(9, 16))
    train_fraction: float = 0.70

    @property
    def cost_rate(self) -> float:
        return self.spread_pct / 200.0 + self.slippage_rate


# ---------------------------------------------------------------------------
# Data access (read-only)
# ---------------------------------------------------------------------------


def fetch_crypto_bars(
    client: Any,
    symbols: list[str],
    start: datetime,
    end: datetime,
    location: str = "us",
    max_pages: int = 400,
    errors: list[str] | None = None,
) -> dict[str, list[dict]]:
    errors = errors if errors is not None else []
    output: dict[str, list[dict]] = {symbol: [] for symbol in symbols}
    token = None
    for _ in range(max_pages):
        params = {
            "symbols": ",".join(symbols),
            "timeframe": "5Min",
            "start": start.astimezone(timezone.utc).isoformat(),
            "end": end.astimezone(timezone.utc).isoformat(),
            "limit": 10000,
            "sort": "asc",
        }
        if token:
            params["page_token"] = token
        try:
            payload = _get(client, f"/v1beta3/crypto/{location}/bars", params)
        except requests.RequestException as exc:
            errors.append(f"crypto history unavailable ({exc.__class__.__name__})")
            return output
        for symbol, rows in (payload.get("bars") or {}).items():
            output.setdefault(symbol, []).extend(rows or [])
        token = payload.get("next_page_token")
        if not token:
            return output
    errors.append("crypto history was cut short; try fewer days")
    return output


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------


@dataclass
class _Series:
    times: list[datetime]   # bar close time, ET
    rows: list[dict]


def _prepare(rows: list[dict]) -> _Series:
    rows = sorted(rows, key=lambda r: r["t"])
    times = [(_timestamp(r) + timedelta(minutes=BAR_MINUTES)).astimezone(ET) for r in rows]
    return _Series(times, rows)


def _last_index_at(series: _Series, moment: datetime, start: int = 0) -> int:
    """Index of the last bar that had closed by ``moment`` (or -1)."""
    lo, hi = start, len(series.times)
    while lo < hi:
        mid = (lo + hi) // 2
        if series.times[mid] <= moment:
            lo = mid + 1
        else:
            hi = mid
    return lo - 1


def signal_at(series: _Series, i: int, cfg: CryptoLabConfig) -> dict | None:
    """Features of bar ``i`` when it is a qualifying entry signal, else None."""
    if i < max(cfg.trend_bars, cfg.breakout_bars, 288):
        return None
    rows = series.rows
    close = float(rows[i]["c"])
    prior_high = max(float(r["h"]) for r in rows[i - cfg.breakout_bars:i])
    trend = sum(float(r["c"]) for r in rows[i - cfg.trend_bars + 1:i + 1]) / cfg.trend_bars
    day_ago = float(rows[i - 288]["c"])  # 288 five-minute bars = 24 hours
    day_move = (close / day_ago - 1) * 100 if day_ago else 0.0
    hour_dollars = sum(float(r["c"]) * float(r["v"]) for r in rows[i - cfg.breakout_bars + 1:i + 1])
    if close <= prior_high or close <= trend:
        return None
    if not cfg.min_day_move_pct <= day_move <= cfg.max_day_move_pct:
        return None
    if hour_dollars < cfg.min_hour_dollar_volume:
        return None
    return {
        "breakout_pct": round((close / prior_high - 1) * 100, 3),
        "trend_gap_pct": round((close / trend - 1) * 100, 3),
        "day_move_pct": round(day_move, 3),
        "hour_dollar_volume": round(hour_dollars, 2),
    }


def _run_moments(day: date, minutes: tuple[int, ...]) -> list[datetime]:
    return [datetime(day.year, day.month, day.day, m // 60, m % 60, tzinfo=ET) for m in minutes]


def replay(bars: dict[str, list[dict]], cfg: CryptoLabConfig) -> list[dict]:
    """Walk the hourly runs day by day, one position at a time across all pairs."""
    series = {s: _prepare(rows) for s, rows in bars.items() if rows}
    if not series:
        return []
    days = sorted({t.date() for s in series.values() for t in s.times if t.weekday() < 5})
    trades: list[dict] = []
    for day in days:
        runs = _run_moments(day, cfg.run_minutes)
        position: dict | None = None
        for run_index, moment in enumerate(runs):
            last_run = run_index == len(runs) - 1
            if position:
                s = series[position["symbol"]]
                i = _last_index_at(s, moment)
                if i > position["entry_index"]:
                    price = float(s.rows[i]["c"])
                    change = (price / position["entry"] - 1) * 100
                    reason = None
                    if change <= -cfg.stop_pct:
                        reason = "stop"
                    elif change >= cfg.target_pct:
                        reason = "target"
                    elif last_run:
                        reason = "end of day"
                    if reason:
                        trades.append(_close(position, price, moment, reason, cfg))
                        position = None
                elif last_run:
                    trades.append(_close(position, position["entry"] / (1 + cfg.cost_rate), moment, "end of day", cfg))
                    position = None
            if position or last_run:
                continue
            for symbol, s in series.items():
                i = _last_index_at(s, moment)
                if i < 0 or (moment - s.times[i]) > timedelta(minutes=BAR_MINUTES):
                    continue
                features = signal_at(s, i, cfg)
                if not features or i + 1 >= len(s.rows):
                    continue
                entry = float(s.rows[i + 1]["o"]) * (1 + cfg.cost_rate)
                position = {
                    "symbol": symbol,
                    "date": day.isoformat(),
                    "entry_time": s.times[i].isoformat(),
                    "run": _run_label(moment),
                    "entry": entry,
                    "entry_index": i + 1,
                    **features,
                }
                break
    return trades


def _run_label(moment: datetime) -> str:
    hour = moment.hour % 12 or 12
    return f"{hour}:{moment.minute:02d} {'a.m.' if moment.hour < 12 else 'p.m.'}"


def _close(position: dict, price: float, moment: datetime, reason: str, cfg: CryptoLabConfig) -> dict:
    exit_price = price * (1 - cfg.cost_rate)
    ret = (exit_price / position["entry"] - 1) * 100
    out = {k: v for k, v in position.items() if k != "entry_index"}
    out.update({
        "entry": round(position["entry"], 6),
        "exit": round(exit_price, 6),
        "exit_time": moment.isoformat(),
        "exit_reason": reason,
        "return_pct": round(ret, 4),
        "r_multiple": round(ret / cfg.stop_pct, 4),
    })
    return out


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def _group(trades: list[dict], key: str) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for trade in trades:
        groups.setdefault(trade[key], []).append(trade)
    rows = []
    for name, items in groups.items():
        stats = summarize([t["r_multiple"] for t in items])
        stats["avg_return_pct"] = round(sum(t["return_pct"] for t in items) / len(items), 4)
        rows.append({key: name, **stats})
    rows.sort(key=lambda r: r["avg_r"], reverse=True)
    return rows


def verdict(train: dict, test: dict) -> tuple[str, str]:
    if test["trades"] < 20:
        return "too few", (
            f"Only {test['trades']} trades on the unseen days — too few to judge. "
            "Treat crypto entries as unproven."
        )
    if train["avg_r"] > 0 and test["avg_r"] > 0 and (test.get("profit_factor") or 0) > 1.1:
        return "held up", "The crypto rules made money on the learning days and again on the unseen days."
    return "no edge", (
        "The crypto rules did not make money on both the learning days and the unseen days. "
        "There is no proven crypto edge; the auto-trader should treat crypto as unproven."
    )


def build_payload(now: datetime, cfg: CryptoLabConfig, symbols: list[str], trades: list[dict],
                  window: dict, errors: list[str]) -> dict:
    rows = [dict(t, learning=True) for t in trades]
    train_days, test_days = split_dates(rows, cfg.train_fraction)
    train = summarize([t["r_multiple"] for t in trades if t["date"] in train_days])
    test = summarize([t["r_multiple"] for t in trades if t["date"] in test_days])
    status, text = verdict(train, test)
    overall = summarize([t["r_multiple"] for t in trades])
    overall["avg_return_pct"] = round(sum(t["return_pct"] for t in trades) / len(trades), 4) if trades else 0.0
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "mode": "RESEARCH ONLY — no alerts, no paper entries, no orders",
        "window": window,
        "symbols": symbols,
        "rules": {
            "runs": "hourly at :40, 9:40 a.m.–3:40 p.m. ET, weekdays (no entries on the 3:40 run)",
            "entry": f"close above the prior {cfg.breakout_bars}-bar high and the {cfg.trend_bars}-bar average, "
                     f"24-hour move {cfg.min_day_move_pct:g}% to {cfg.max_day_move_pct:g}%, "
                     f"≥ ${cfg.min_hour_dollar_volume:,.0f} traded in the last hour",
            "exit": f"−{cfg.stop_pct:g}% stop or +{cfg.target_pct:g}% target checked on each hourly run; "
                    "everything closed on the 3:40 p.m. run",
            "modeled_spread_pct": cfg.spread_pct,
            "slippage_pct": cfg.slippage_rate * 100,
            "r_unit": f"1R = the {cfg.stop_pct:g}% stop",
        },
        "summary": {
            "all": overall,
            "train": train,
            "test": test,
            "train_days": len(train_days),
            "test_days": len(test_days),
            "status": status,
            "verdict": text,
        },
        "by_symbol": _group(trades, "symbol"),
        "by_run": _group(trades, "run"),
        "exit_reasons": {r: sum(t["exit_reason"] == r for t in trades) for r in ("stop", "target", "end of day")},
        "recent_trades": sorted(trades, key=lambda t: t["entry_time"], reverse=True)[:40],
        "errors": errors[:20],
        "caveats": CAVEATS,
    }


def run(settings: Settings, client: Any, cfg: CryptoLabConfig, symbols: list[str],
        now: datetime | None = None, log=print) -> dict:
    now = now or datetime.now(timezone.utc)
    errors: list[str] = []
    end = now - timedelta(minutes=16)
    # One extra day so the 24-hour move is available on the first day.
    start = now - timedelta(days=cfg.lookback_days + 1)
    log(f"Crypto Lab: {len(symbols)} pairs, {start.date()} → {end.date()}")
    bars = fetch_crypto_bars(client, symbols, start, end, settings.crypto_location, errors=errors)
    for symbol in symbols:
        if not bars.get(symbol):
            errors.append(f"{symbol}: no five-minute history")
    trades = replay(bars, cfg)
    window = {
        "start": start.date().isoformat(),
        "end": end.date().isoformat(),
        "trading_days": len({t["date"] for t in trades}),
        "lookback_days": cfg.lookback_days,
    }
    return build_payload(now, cfg, symbols, trades, window, errors)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Driftline Crypto Lab (research only)")
    parser.add_argument("--symbols", help="Comma-separated pairs such as BTC/USD,ETH/USD")
    parser.add_argument("--days", type=int, default=120, help="Calendar days of history (20–400)")
    parser.add_argument("--out", default=str(JSON_PATH), help="Dashboard JSON output")
    args = parser.parse_args(argv)
    if not 20 <= args.days <= 400:
        parser.error("--days must be between 20 and 400")
    settings = Settings()
    settings.validate()
    raw = args.symbols or settings.crypto_symbols
    symbols = [s.strip().upper() for s in raw.split(",") if s.strip()]
    payload = run(settings, AlpacaClient(settings), CryptoLabConfig(lookback_days=args.days), symbols)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    s = payload["summary"]
    print(f"Done. {s['all']['trades']} crypto trades (avg {s['all']['avg_r']:+.2f}R) · {s['status']}: {s['verdict']}")
    print(f"Dashboard data: {out}")


if __name__ == "__main__":
    main()
