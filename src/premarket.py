from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from .config import Settings
from .indicators import atr, five_minute_move_pct, rsi, spread_pct, vwap
from .scanner import (
    ET,
    RISK_WORDS,
    AlpacaClient,
    _timestamp,
    average_daily_volume,
    completed_five_minute_bars,
)

STATE_PATH = Path("data/premarket_state.json")


def is_premarket_session(clock: dict, now: datetime) -> bool:
    local = now.astimezone(ET)
    minute = local.hour * 60 + local.minute
    if local.weekday() >= 5 or not (240 <= minute < 570):
        return False
    next_open_raw = clock.get("next_open")
    if not next_open_raw:
        return False
    next_open = datetime.fromisoformat(next_open_raw.replace("Z", "+00:00"))
    return next_open.astimezone(ET).date() == local.date()


def premarket_rows(rows: list[dict], now: datetime, today_only: bool = True) -> list[dict]:
    today = now.astimezone(ET).date()
    cutoff_minute = now.astimezone(ET).hour * 60 + now.astimezone(ET).minute
    result = []
    for row in rows:
        local = _timestamp(row).astimezone(ET)
        minute = local.hour * 60 + local.minute
        if not (240 <= minute < 570):
            continue
        if today_only and local.date() != today:
            continue
        if not today_only and local.date() == today:
            continue
        if minute <= cutoff_minute:
            result.append(row)
    return result


def premarket_relative_volume(rows: list[dict], now: datetime) -> float | None:
    today_rows = premarket_rows(rows, now, today_only=True)
    history = premarket_rows(rows, now, today_only=False)
    totals: dict[str, float] = {}
    for row in history:
        key = _timestamp(row).astimezone(ET).date().isoformat()
        totals[key] = totals.get(key, 0.0) + float(row.get("v", 0))
    prior = [value for value in totals.values() if value > 0]
    if not today_rows or not prior:
        return None
    current = sum(float(row.get("v", 0)) for row in today_rows)
    baseline = sum(prior) / len(prior)
    return current / baseline if baseline > 0 else None


def scan_premarket(
    settings: Settings, client: AlpacaClient, now: datetime | None = None
) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    symbols = client.universe()
    snapshots = client.snapshots(symbols)
    five_minute = client.bars(symbols, "5Min", now - timedelta(days=10), limit_pages=20)
    daily = client.bars(symbols, "1Day", now - timedelta(days=50), limit_pages=3)
    matches: list[dict] = []

    for symbol in symbols:
        snapshot = snapshots.get(symbol, {})
        quote = snapshot.get("latestQuote") or {}
        trade = snapshot.get("latestTrade") or {}
        previous_day = snapshot.get("prevDailyBar") or {}
        bid = float(quote.get("bp") or 0)
        ask = float(quote.get("ap") or 0)
        price = float(trade.get("p") or 0)
        previous_close = float(previous_day.get("c") or 0)
        spread = spread_pct(bid, ask)
        day_move = ((price / previous_close) - 1) * 100 if previous_close else None

        complete = completed_five_minute_bars(five_minute.get(symbol, []), now)
        session = premarket_rows(complete, now, today_only=True)
        if len(session) < 15:
            continue

        indicator_rsi = rsi([float(row["c"]) for row in session])
        session_vwap = vwap(session)
        indicator_atr = atr(session)
        bar_move = five_minute_move_pct(session)
        rel_volume = premarket_relative_volume(complete, now)
        cumulative_volume = sum(float(row.get("v", 0)) for row in session)
        trigger = max(float(row["h"]) for row in session[:-1])
        avg_volume = average_daily_volume(daily.get(symbol, []))
        latest_volume = float(session[-1].get("v", 0))
        dollar_volume = latest_volume * float(session[-1]["c"])

        values = (
            day_move,
            spread,
            indicator_rsi,
            session_vwap,
            indicator_atr,
            bar_move,
            rel_volume,
        )
        if any(value is None for value in values):
            continue
        if not (settings.min_price <= price <= settings.max_price):
            continue
        if not (settings.min_day_move_pct <= day_move <= settings.max_day_move_pct):
            continue
        if not (
            settings.min_five_minute_move_pct
            <= bar_move
            <= settings.max_five_minute_move_pct
        ):
            continue
        if rel_volume < settings.min_relative_volume:
            continue
        if cumulative_volume < 100_000:
            continue
        if dollar_volume < settings.min_five_minute_dollar_volume:
            continue
        if not (settings.min_rsi <= indicator_rsi <= settings.max_rsi):
            continue
        if spread > settings.max_spread_pct or price <= session_vwap:
            continue
        if price - session_vwap > indicator_atr * settings.max_vwap_distance_atr:
            continue

        try:
            asset = client.asset(symbol)
            if not asset.get("tradable") or asset.get("status") != "active":
                continue
            news = client.latest_news(symbol, now)
        except requests.RequestException:
            continue
        if not news:
            continue
        headline = news.get("headline", "")
        if any(word in headline.lower() for word in RISK_WORDS):
            continue

        preferred_rsi = settings.preferred_min_rsi <= indicator_rsi <= settings.preferred_max_rsi
        stage = "above provisional trigger" if price > trigger else "watching below trigger"
        score = (
            rel_volume
            + (1.0 if preferred_rsi else 0.0)
            + (0.5 if stage == "above provisional trigger" else 0.0)
            - spread
        )
        matches.append(
            {
                "symbol": symbol,
                "price": price,
                "bid": bid,
                "ask": ask,
                "spread_pct": spread,
                "day_move_pct": day_move,
                "five_minute_move_pct": bar_move,
                "five_minute_volume": int(latest_volume),
                "five_minute_dollar_volume": dollar_volume,
                "premarket_volume": int(cumulative_volume),
                "relative_volume": rel_volume,
                "average_daily_volume": avg_volume,
                "vwap": session_vwap,
                "atr": indicator_atr,
                "rsi": indicator_rsi,
                "preferred_rsi": preferred_rsi,
                "breakout_level": trigger,
                "stage": stage,
                "news_headline": headline,
                "news_time": news.get("created_at", ""),
                "news_url": news.get("url", ""),
                "score": score,
            }
        )

    return sorted(matches, key=lambda row: row["score"], reverse=True)[:3]


def _load_state(path: Path = STATE_PATH) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def todays_roster_symbols(now: datetime, path: Path = STATE_PATH) -> set[str]:
    state = _load_state(path)
    day = now.astimezone(ET).date().isoformat()
    if state.get("date") != day:
        return set()
    return {row["symbol"] for row in state.get("roster", []) if row.get("symbol")}


def roster_event(candidates: list[dict], now: datetime, path: Path = STATE_PATH) -> str | None:
    day = now.astimezone(ET).date().isoformat()
    previous = _load_state(path)
    roster = [
        {
            "symbol": row["symbol"],
            "stage": row["stage"],
            "breakout_level": round(float(row["breakout_level"]), 6),
        }
        for row in candidates
    ]
    if previous.get("date") == day and previous.get("roster") == roster:
        return None

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"date": day, "roster": roster}, indent=2) + "\n",
        encoding="utf-8",
    )
    if not candidates:
        return None

    sections = [
        "PREMARKET BREAKOUT WATCH — WATCHLIST ONLY — NO REAL ORDER — NO PAPER ENTRY",
        "Today's dynamic roster changed. Regular-session hold/retest confirmation is still required.",
    ]
    for rank, row in enumerate(candidates, 1):
        sections.append(
            f"{rank}. {row['symbol']} | {row['price']:.4f} ({row['day_move_pct']:+.2f}%)\n"
            f"Bid/ask {row['bid']:.4f}/{row['ask']:.4f} | spread {row['spread_pct']:.3f}%\n"
            f"Premarket volume {row['premarket_volume']:,} | same-time RVOL "
            f"{row['relative_volume']:.2f}x | latest 5m dollar volume "
            f"{row['five_minute_dollar_volume']:,.0f}\n"
            f"Premarket VWAP {row['vwap']:.4f} | ATR {row['atr']:.4f} | "
            f"RSI {row['rsi']:.1f} | 5m move {row['five_minute_move_pct']:+.2f}%\n"
            f"Provisional breakout alert {row['breakout_level']:.4f} | stage: {row['stage']}\n"
            f"Catalyst ({row['news_time']}): {row['news_headline']}\n{row['news_url']}\n"
            "Could work: fresh catalyst, dollar liquidity, RVOL, VWAP and momentum align.\n"
            "Could fail: premarket liquidity can disappear; IEX is not the full SIP feed; "
            "filings and the primary source still require verification."
        )
    return "\n\n".join(sections)
