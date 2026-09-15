"""Driftline Backtest Lab runner — research and learning only.

Usage::

    python -m src.backtest_lab                      # study list, ~4 months
    python -m src.backtest_lab --symbols SOFI,PLTR  # just these tickers
    python -m src.backtest_lab --report lab.html    # also write a standalone report

Reads market data with the same read-only Alpaca paper keys as the watcher.
It never sends alerts, never edits the live paper ledger, and has no order code.
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .backtest import (
    SETUP_A,
    SETUP_B,
    SETUP_C,
    BacktestConfig,
    fetch_bars,
    fetch_news,
    fetch_session_closes,
    fill_in_symbols,
    find_events,
    market_mood_table,
    replay_portfolio,
    summarize,
)
from .config import Settings
from .paper_lab import STARTING_BALANCE
from .learning_model import second_opinion
from .pattern_miner import mine_patterns, split_dates
from .scanner import ET, MARKET_SYMBOLS, AlpacaClient, _timestamp
from .study_list import _clean, study_symbols

JSON_PATH = Path("docs/data/backtest.json")
CSV_DIR = Path("data/backtest")
HISTORY_PATH = Path("data/backtest_history.json")
HISTORY_LIMIT = 120

EVENT_FIELDS = [
    "symbol", "date", "signal_time", "entry_time", "exit_time", "setup", "learning", "strict",
    "failed_gates", "price", "day_move_pct", "gap_pct", "five_minute_move_pct",
    "relative_volume", "dollar_volume", "rsi", "vwap_distance_atr", "risk_pct",
    "time_bucket", "market_mood", "catalyst", "catalyst_headline", "entry", "stop",
    "target", "exit", "exit_reason", "bars_held", "r_multiple", "best_r", "win",
]

CAVEATS = [
    "History uses Alpaca's free IEX feed, which is a slice of the full market. Volume and prices can differ from Robinhood.",
    "Historical bid/ask quotes are not replayed, so every fill pays a modeled spread plus the paper lab's 0.05% slippage.",
    "Prices are as traded (not split-adjusted); days with split-sized gaps are skipped, and entries need the very next 5-minute bar.",
    "Stops and targets are checked inside each 5-minute bar; if both could have hit in the same bar, the stop is assumed.",
    "SEC filing and Nasdaq halt checks are not replayed. News catalysts use Alpaca's news archive; when a ticker's news cannot be checked, it is left out of paper-rule trades.",
    "Setup C is approximated from premarket bars; the live roster also ranks names against each other.",
    "The study list is partly made of tickers the watcher already flagged, which can flatter results.",
    "Many patterns are tested at once, so some will look good by luck. A pattern is listed only when it stands clearly apart from the average on the learning days and again on the unseen check days. Trades on the same day tend to move together, so even listed patterns deserve caution.",
    "This is research for learning. It is not financial advice and it never changes live alerts or paper trades.",
]


def _ticker_summary(symbol: str, events: list[dict], portfolio: list[dict], days: int, news_ok: bool | None) -> dict:
    learning = [e for e in events if e["learning"]]
    strict = [e for e in events if e["strict"]]
    taken = [t for t in portfolio if t["symbol"] == symbol]
    highlights: list[str] = []

    def best_and_worst(key: str, label: str) -> None:
        groups: dict[str, list[float]] = {}
        for event in learning:
            groups.setdefault(event[key], []).append(event["r_multiple"])
        scored = [(k, sum(v) / len(v), len(v)) for k, v in groups.items() if len(v) >= 5]
        if len(scored) < 2:
            return
        scored.sort(key=lambda row: row[1], reverse=True)
        best, worst = scored[0], scored[-1]
        if best[1] > 0:
            highlights.append(f"Best {label}: {best[0]} ({best[1]:+.2f}R over {best[2]})")
        if worst[1] < 0:
            highlights.append(f"Weakest {label}: {worst[0]} ({worst[1]:+.2f}R over {worst[2]})")

    best_and_worst("setup", "setup")
    best_and_worst("time_bucket", "time")
    best_and_worst("market_mood", "market mood")
    stats = summarize([e["r_multiple"] for e in learning])
    strict_stats = summarize([e["r_multiple"] for e in strict])
    if stats["trades"] < 10:
        note = "Too few setups to judge"
    elif stats["avg_r"] > 0.15:
        note = "Breakouts have tended to follow through"
    elif stats["avg_r"] < -0.15:
        note = "Breakouts have tended to fail"
    else:
        note = "No clear edge either way"
    return {
        "symbol": symbol,
        "days_with_data": days,
        "news": "ok" if news_ok else ("off" if news_ok is None else "unavailable"),
        "learning": stats,
        "strict": strict_stats,
        "portfolio_trades": len(taken),
        "portfolio_net_pl": round(sum(t["net_pl"] for t in taken), 4),
        "stop_rate": round(sum(e["exit_reason"] == "stop" for e in learning) / len(learning) * 100, 1) if learning else 0.0,
        "target_rate": round(sum(e["exit_reason"] == "target" for e in learning) / len(learning) * 100, 1) if learning else 0.0,
        "avg_best_r": round(sum(e["best_r"] for e in learning) / len(learning), 3) if learning else 0.0,
        "note": note,
        "highlights": highlights[:4],
        "recent": [
            {k: e[k] for k in ("date", "entry_time", "setup", "strict", "entry", "exit", "exit_reason", "r_multiple")}
            for e in learning[-5:]
        ][::-1],
    }


def _et_day(row: dict) -> str:
    try:
        return _timestamp(row).astimezone(ET).date().isoformat()
    except (KeyError, ValueError):
        return ""


def _public_trade(trade: dict) -> dict:
    keys = (
        "symbol", "date", "entry_time", "exit_time", "setup", "entry", "stop", "target",
        "exit", "exit_reason", "r_multiple", "size", "net_pl", "rsi", "relative_volume",
        "day_move_pct", "market_mood", "catalyst", "catalyst_headline", "catalyst_url",
    )
    return {k: trade[k] for k in keys if k in trade}


def build_payload(
    *,
    now: datetime,
    cfg: BacktestConfig,
    study: list[dict],
    events: list[dict],
    portfolio: list[dict],
    patterns: dict,
    model: dict,
    per_ticker: list[dict],
    window: dict,
    history: list[dict],
    errors: list[str],
) -> dict:
    learning = [e for e in events if e["learning"]]
    strict = [e for e in events if e["strict"]]
    by_setup = []
    for setup in (SETUP_A, SETUP_B, SETUP_C):
        rows = [t for t in portfolio if t["setup"] == setup]
        learn_rows = [e for e in learning if e["setup"] == setup]
        by_setup.append({
            "setup": setup,
            "learning": summarize([e["r_multiple"] for e in learn_rows]),
            "portfolio": summarize([t["r_multiple"] for t in rows], [t["net_pl"] for t in rows]),
        })
    equity = [STARTING_BALANCE]
    running = STARTING_BALANCE
    for trade in sorted(portfolio, key=lambda t: t["exit_time"]):
        running += trade["net_pl"]
        equity.append(round(running, 4))
    model_public = {k: v for k, v in model.items() if not k.startswith("_")}
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "mode": "RESEARCH ONLY — no alerts, no paper entries, no orders",
        "window": window,
        "assumptions": {
            "modeled_spread_pct": cfg.spread_pct,
            "slippage_pct": cfg.slippage_rate * 100,
            "reward_to_risk": cfg.reward_risk,
            "entry": "open of the bar after the signal, plus half the modeled spread and slippage",
            "exit": "stop, 2R target, or 3:55 p.m. ET — stop assumed first if both fit one bar",
            "news_catalysts": "replayed" if cfg.use_news else "off",
        },
        "study_list": study,
        "summary": {
            "tickers": len(per_ticker),
            "learning": summarize([e["r_multiple"] for e in learning]),
            "strict_setups": summarize([e["r_multiple"] for e in strict]),
            "portfolio": summarize([t["r_multiple"] for t in portfolio], [t["net_pl"] for t in portfolio]),
            "by_setup": by_setup,
            "validated": all(row["portfolio"]["trades"] >= 100 for row in by_setup),
        },
        "equity_curve": equity[-400:],
        "patterns": {k: v for k, v in patterns.items() if k != "buckets"},
        "buckets": patterns.get("buckets", []),
        "model": model_public,
        "tickers": per_ticker,
        "portfolio_trades": [_public_trade(t) for t in sorted(portfolio, key=lambda t: t["entry_time"], reverse=True)[:60]],
        "history": history[-60:],
        "errors": errors[:20],
        "caveats": CAVEATS,
    }


def _write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            out = dict(row)
            if isinstance(out.get("failed_gates"), list):
                out["failed_gates"] = "; ".join(out["failed_gates"])
            writer.writerow(out)


def _load_history(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def run(
    settings: Settings,
    client,
    cfg: BacktestConfig,
    symbols: list[str] | None = None,
    now: datetime | None = None,
    history_path: Path = HISTORY_PATH,
    log=print,
) -> tuple[dict, list[dict], list[dict], list[dict]]:
    now = now or datetime.now(timezone.utc)
    errors: list[str] = []
    if symbols:
        cleaned = []
        for raw in symbols:
            symbol = _clean(raw)
            if symbol and symbol not in cleaned:
                cleaned.append(symbol)
            elif raw.strip() and not symbol:
                errors.append(f"{raw.strip()}: not a stock ticker; skipped")
        study = [{"symbol": s, "source": "chosen for this run", "days_flagged": 0, "last_flagged": None}
                 for s in cleaned]
    else:
        study = study_symbols(cfg.max_symbols, now)
        if len(study) < cfg.min_symbols:
            known = {row["symbol"] for row in study}
            for symbol in fill_in_symbols(client, cfg.max_symbols):
                if len(study) >= max(cfg.min_symbols, 20):
                    break
                if symbol not in known:
                    study.append({"symbol": symbol, "source": "today's movers (fill-in)", "days_flagged": 0, "last_flagged": None})
                    known.add(symbol)
    tickers = [row["symbol"] for row in study][: cfg.max_symbols]
    study = study[: cfg.max_symbols]
    if not tickers:
        raise RuntimeError("The study list is empty and no fill-in movers were available.")

    end = now - timedelta(minutes=16)
    start = now - timedelta(days=cfg.lookback_days)
    log(f"Backtest Lab: {len(tickers)} tickers, {start.date()} → {end.date()}")
    five_minute = fetch_bars(client, tickers + list(MARKET_SYMBOLS), "5Min", start, end, errors=errors)
    daily = fetch_bars(client, tickers, "1Day", start - timedelta(days=60), end, errors=errors)
    daily_split = fetch_bars(
        client, tickers, "1Day", start - timedelta(days=60), end, errors=errors, adjustment="split"
    )
    moods = market_mood_table({s: five_minute.get(s, []) for s in MARKET_SYMBOLS})
    closes = fetch_session_closes(client, start, end)
    if not closes:
        errors.append("Market calendar unavailable; early-close days were treated as full days")
    if not any(five_minute.get(s) for s in MARKET_SYMBOLS):
        errors.append("SPY/QQQ history unavailable; market-mood gate not replayed")

    events: list[dict] = []
    per_symbol_events: dict[str, list[dict]] = {}
    news_status: dict[str, bool | None] = {}
    for index, symbol in enumerate(tickers, 1):
        news = None
        if cfg.use_news:
            news = fetch_news(client, symbol, start - timedelta(days=1), end)
            news_status[symbol] = news is not None
            if news is None:
                errors.append(f"{symbol}: news archive unavailable; excluded from paper-rule trades")
            elif news["covered_from"] > start:
                errors.append(
                    f"{symbol}: very busy news feed; catalysts checked from "
                    f"{news['covered_from'].astimezone(ET).date().isoformat()} on"
                )
        else:
            news_status[symbol] = None
        rows = five_minute.get(symbol, [])
        if not rows:
            errors.append(f"{symbol}: no 5-minute history on the IEX feed")
        found = find_events(symbol, rows, daily.get(symbol, []), moods, news, settings, cfg, closes or None,
                            daily_split.get(symbol) or None)
        per_symbol_events[symbol] = found
        events.extend(found)
        log(f"  [{index}/{len(tickers)}] {symbol}: {sum(e['learning'] for e in found)} setups, "
            f"{sum(e['strict'] for e in found)} strict")

    events.sort(key=lambda e: e["signal_time"])
    portfolio = replay_portfolio(events)
    patterns = mine_patterns(events, cfg.train_fraction)
    train_days, test_days = split_dates([e for e in events if e["learning"]], cfg.train_fraction)
    model = second_opinion(events, train_days, test_days)

    per_ticker = []
    for symbol in tickers:
        rows = five_minute.get(symbol, [])
        trading_days = {d.isoformat() for d in closes}
        seen_days = {_et_day(r) for r in rows} - {""}
        days = len(seen_days & trading_days) if trading_days else len(seen_days)
        per_ticker.append(_ticker_summary(symbol, per_symbol_events[symbol], portfolio, days, news_status.get(symbol)))
    per_ticker.sort(key=lambda row: (row["learning"]["trades"] >= 10, row["learning"]["avg_r"]), reverse=True)

    learning = [e for e in events if e["learning"]]
    history = _load_history(history_path)
    custom_run = bool(symbols)
    port_stats = summarize([t["r_multiple"] for t in portfolio], [t["net_pl"] for t in portfolio])
    learn_stats = summarize([e["r_multiple"] for e in learning])
    history_row = {
        "generated_at": now.isoformat(),
        "tickers": len(tickers),
        "learning_trades": learn_stats["trades"],
        "learning_avg_r": learn_stats["avg_r"],
        "portfolio_trades": port_stats["trades"],
        "portfolio_win_rate": port_stats["win_rate"],
        "portfolio_avg_r": port_stats["avg_r"],
        "model_test_auc": model.get("test_auc"),
        "promising": [p["pattern"] for p in patterns["promising"][:3]],
        "avoid": [p["pattern"] for p in patterns["avoid"][:3]],
        "run": "chosen tickers" if custom_run else "study list",
    }
    history = (history + [history_row])[-HISTORY_LIMIT:]

    window = {
        "start": start.date().isoformat(),
        "end": end.date().isoformat(),
        "trading_days": len({e["date"] for e in events}) if events else 0,
        "lookback_days": cfg.lookback_days,
    }
    payload = build_payload(
        now=now, cfg=cfg, study=study, events=events, portfolio=portfolio,
        patterns=patterns, model=model, per_ticker=per_ticker, window=window,
        history=history, errors=errors,
    )
    return payload, events, portfolio, history


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Driftline Backtest Lab (research only)")
    parser.add_argument("--symbols", help="Comma-separated tickers (overrides the study list)")
    parser.add_argument("--days", type=int, help="Calendar days of history (default 120)")
    parser.add_argument("--max-symbols", type=int, help="Maximum tickers to study (default 60)")
    parser.add_argument("--no-news", action="store_true", help="Skip the news-catalyst replay")
    parser.add_argument("--out", default=str(JSON_PATH), help="Dashboard JSON output")
    parser.add_argument("--csv-dir", default=str(CSV_DIR), help="Folder for detailed CSV files")
    parser.add_argument("--history", default=str(HISTORY_PATH), help="Nightly history file")
    parser.add_argument("--report", help="Also write a standalone HTML report here")
    args = parser.parse_args(argv)

    if args.days is not None and not 20 <= args.days <= 400:
        parser.error("--days must be between 20 and 400")
    if args.max_symbols is not None and not 1 <= args.max_symbols <= 200:
        parser.error("--max-symbols must be between 1 and 200")

    overrides = {}
    if args.days:
        overrides["lookback_days"] = args.days
    if args.max_symbols:
        overrides["max_symbols"] = args.max_symbols
    if args.no_news:
        overrides["use_news"] = False
    cfg = BacktestConfig(**overrides)

    settings = Settings()
    settings.validate()
    client = AlpacaClient(settings)
    symbols = args.symbols.split(",") if args.symbols else None
    history_path = Path(args.history)
    payload, events, portfolio, history = run(settings, client, cfg, symbols, history_path=history_path)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(json.dumps(history, indent=1) + "\n", encoding="utf-8")
    csv_dir = Path(args.csv_dir)
    _write_csv(csv_dir / "setups.csv", events, EVENT_FIELDS)
    _write_csv(csv_dir / "portfolio_trades.csv", portfolio, EVENT_FIELDS + ["size", "net_pl"])
    if args.report:
        from .backtest_report import write_report
        write_report(payload, Path(args.report))
        print(f"Report: {args.report}")

    summary = payload["summary"]
    print(
        f"Done. {summary['tickers']} tickers · {summary['learning']['trades']} learning setups "
        f"(avg {summary['learning']['avg_r']:+.2f}R) · {summary['portfolio']['trades']} paper-rule trades · "
        f"model: {payload['model'].get('status')}"
    )
    print(f"Dashboard data: {out}")
    print(f"Details: {csv_dir}/setups.csv and {csv_dir}/portfolio_trades.csv")


if __name__ == "__main__":
    main()
