from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


HUB_DATA_PATH = Path("docs/data/dashboard.json")


def _money(value: Any) -> float:
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return 0.0


def _public_candidate(row: dict) -> dict:
    """Return market research only; never publish credentials or account identifiers."""
    keys = (
        "symbol", "price", "bid", "ask", "spread_pct", "day_move_pct",
        "five_minute_move_pct", "five_minute_volume", "five_minute_dollar_volume",
        "premarket_volume", "relative_volume", "vwap", "atr", "rsi",
        "breakout_level", "technical_stop", "stage", "confirmation", "setup",
        "market_context", "news_headline", "news_time", "news_url", "score",
    )
    return {key: row[key] for key in keys if key in row}


def _paper_summary(lab: Any) -> dict:
    rows = list(lab.rows)
    closed = [row for row in rows if row.get("status") == "closed"]
    open_rows = [row for row in rows if row.get("status") == "open"]
    pnls = [_money(row.get("net_pl")) for row in closed]
    wins = [value for value in pnls if value > 0]
    losses = [value for value in pnls if value < 0]
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    balance = 50.0
    peak = balance
    max_drawdown = 0.0
    for value in pnls:
        balance += value
        peak = max(peak, balance)
        max_drawdown = max(max_drawdown, peak - balance)

    public_rows = []
    for row in reversed(rows[-50:]):
        public_rows.append({
            key: row.get(key, "")
            for key in (
                "trade_id", "timestamp", "symbol", "setup", "entry", "size",
                "stop", "target", "exit_timestamp", "exit", "reason", "gross_pl",
                "modeled_spread_slippage", "net_pl", "account_balance", "status",
            )
        })

    return {
        "starting_balance": 50.0,
        "balance": round(lab.balance(), 4),
        "completed_trades": len(closed),
        "open_trades": len(open_rows),
        "win_rate": round(len(wins) / len(closed) * 100, 2) if closed else 0,
        "average_win": round(sum(wins) / len(wins), 4) if wins else 0,
        "average_loss": round(sum(losses) / len(losses), 4) if losses else 0,
        "profit_factor": round(gross_profit / gross_loss, 3) if gross_loss else None,
        "expectancy": round(sum(pnls) / len(pnls), 4) if pnls else 0,
        "maximum_drawdown": round(max_drawdown, 4),
        "validated": len(closed) >= 100,
        "trades": public_rows,
    }


def publish_hub(
    *,
    now: datetime,
    phase: str,
    clock: dict,
    candidates: list[dict],
    events: list[str],
    lab: Any,
    paper_account: dict | None = None,
    email_sent: bool = False,
    note: str = "",
) -> None:
    account = paper_account or {}
    roster = [_public_candidate(row) for row in candidates[:5]]
    research = []
    for row in roster:
        research.append({
            "time": row.get("news_time") or now.isoformat(),
            "symbol": row.get("symbol", "MARKET"),
            "kind": "qualified candidate",
            "title": row.get("news_headline") or "Technical gate passed",
            "detail": (
                f"{row.get('setup') or row.get('stage', 'watching')} · "
                f"RVOL {float(row.get('relative_volume', 0)):.2f}x · "
                f"RSI {float(row.get('rsi', 0)):.1f} · "
                f"spread {float(row.get('spread_pct', 0)):.3f}%"
            ),
            "source_url": row.get("news_url", ""),
        })
    for event in events[-8:]:
        research.append({
            "time": now.isoformat(),
            "symbol": "SYSTEM",
            "kind": "stage change",
            "title": event.splitlines()[0][:120],
            "detail": "Recorded by the read-only watcher and paper laboratory.",
            "source_url": "",
        })

    payload = {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "market": {
            "phase": phase,
            "is_open": bool(clock.get("is_open")),
            "next_open": clock.get("next_open"),
            "next_close": clock.get("next_close"),
        },
        "system": {
            "watcher": "online",
            "market_data": "Alpaca IEX",
            "scan_frequency": "5 minutes",
            "email_bridge": "alert sent" if email_sent else "standing by",
            "paper_account": "attention" if account.get("trading_blocked") else "healthy",
            "paper_positions": len(account.get("positions") or []),
            "paper_open_orders": len(account.get("open_orders") or []),
            "note": note,
        },
        "candidates": roster,
        "research_log": research,
        "paper_lab": _paper_summary(lab),
        "gates": [
            {"label": "Price", "rule": "$0.50–$100"},
            {"label": "Session move", "rule": "2%–8%"},
            {"label": "Relative volume", "rule": "at least 1.5x"},
            {"label": "5-minute liquidity", "rule": "at least $250,000"},
            {"label": "RSI", "rule": "52–78; 55–72 preferred"},
            {"label": "Spread", "rule": "0.40% maximum"},
            {"label": "VWAP", "rule": "above; within one ATR"},
            {"label": "Catalyst", "rule": "verified news within 24 hours"},
            {"label": "Confirmation", "rule": "second-bar hold or first retest"},
        ],
        "privacy": {
            "public_data": "Market research and paper simulations only",
            "private_data": "Robinhood verification remains inside ChatGPT",
            "orders": "No real-order code exists in this repository",
        },
    }
    HUB_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    HUB_DATA_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
