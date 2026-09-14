from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests

from .config import Settings
from .indicators import five_minute_move_pct, relative_volume, rsi, spread_pct, vwap

DATA_URL = "https://data.alpaca.markets"
PAPER_URL = "https://paper-api.alpaca.markets"
ET = ZoneInfo("America/New_York")


class AlpacaClient:
    """Read-only client. Deliberately contains no order endpoint or order method."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.headers = {
            "APCA-API-KEY-ID": settings.api_key,
            "APCA-API-SECRET-KEY": settings.secret_key,
        }

    def _get(self, base: str, path: str, params: dict | None = None):
        response = requests.get(
            f"{base}{path}", headers=self.headers, params=params, timeout=25
        )
        response.raise_for_status()
        return response.json()

    def clock(self) -> dict:
        return self._get(PAPER_URL, "/v2/clock")

    def account_snapshot(self) -> dict:
        account = self._get(PAPER_URL, "/v2/account")
        positions = self._get(PAPER_URL, "/v2/positions")
        orders = self._get(
            PAPER_URL, "/v2/orders", {"status": "open", "direction": "desc"}
        )
        return {
            "equity": account.get("equity"),
            "buying_power": account.get("buying_power"),
            "trading_blocked": account.get("trading_blocked"),
            "positions": positions,
            "open_orders": orders,
        }

    def universe(self) -> list[str]:
        symbols: list[str] = []
        calls = [
            ("/v1beta1/screener/stocks/most-actives", {"top": 100, "by": "volume"}),
            ("/v1beta1/screener/stocks/movers", {"top": 50}),
        ]
        for path, params in calls:
            try:
                payload = self._get(DATA_URL, path, params)
            except requests.RequestException:
                continue
            groups = [
                payload.get("most_actives", []),
                payload.get("gainers", []),
            ]
            for group in groups:
                for item in group:
                    symbol = item.get("symbol")
                    if symbol and symbol not in symbols:
                        symbols.append(symbol)
        return symbols[: self.settings.max_symbols]

    def snapshots(self, symbols: list[str]) -> dict:
        if not symbols:
            return {}
        return self._get(
            DATA_URL,
            "/v2/stocks/snapshots",
            {"symbols": ",".join(symbols), "feed": self.settings.feed},
        )

    def bars(
        self, symbols: list[str], timeframe: str, start: datetime, limit_pages: int = 12
    ) -> dict[str, list[dict]]:
        output: dict[str, list[dict]] = {symbol: [] for symbol in symbols}
        token = None
        pages = 0
        while symbols and pages < limit_pages:
            params = {
                "symbols": ",".join(symbols),
                "timeframe": timeframe,
                "start": start.astimezone(timezone.utc).isoformat(),
                "adjustment": "all",
                "feed": self.settings.feed,
                "limit": 10000,
                "sort": "asc",
            }
            if token:
                params["page_token"] = token
            payload = self._get(DATA_URL, "/v2/stocks/bars", params)
            for symbol, rows in payload.get("bars", {}).items():
                output.setdefault(symbol, []).extend(rows)
            token = payload.get("next_page_token")
            pages += 1
            if not token:
                break
        return output

    def asset(self, symbol: str) -> dict:
        return self._get(PAPER_URL, f"/v2/assets/{symbol}")

    def latest_news(self, symbol: str, now: datetime) -> dict | None:
        payload = self._get(
            DATA_URL,
            "/v1beta1/news",
            {
                "symbols": symbol,
                "start": (now - timedelta(hours=72)).astimezone(timezone.utc).isoformat(),
                "end": now.astimezone(timezone.utc).isoformat(),
                "sort": "desc",
                "limit": 1,
            },
        )
        articles = payload.get("news", [])
        return articles[0] if articles else None


def _timestamp(row: dict) -> datetime:
    return datetime.fromisoformat(row["t"].replace("Z", "+00:00"))


def completed_five_minute_bars(rows: list[dict], now: datetime) -> list[dict]:
    cutoff = now.astimezone(timezone.utc) - timedelta(minutes=5)
    return [row for row in rows if _timestamp(row) <= cutoff]


def regular_session_bars(rows: list[dict], now: datetime) -> list[dict]:
    today = now.astimezone(ET).date()
    result = []
    for row in rows:
        local = _timestamp(row).astimezone(ET)
        minute = local.hour * 60 + local.minute
        if local.date() == today and 570 <= minute < 960:
            result.append(row)
    return result


def opening_breakout(session: list[dict]) -> tuple[float | None, str | None]:
    if len(session) < 5:
        return None, None
    level = max(float(row["h"]) for row in session[:3])
    previous, latest = session[-2], session[-1]
    previous_close = float(previous["c"])
    latest_close = float(latest["c"])
    latest_low = float(latest["l"])
    if previous_close > level and latest_close > level:
        return level, "second-bar hold"
    if previous_close > level and latest_low <= level * 1.002 and latest_close > level:
        return level, "successful retest"
    return level, None


def elapsed_regular_minutes(now: datetime) -> float:
    local = now.astimezone(ET)
    opened = local.replace(hour=9, minute=30, second=0, microsecond=0)
    return max(5.0, min(390.0, (local - opened).total_seconds() / 60))


def average_daily_volume(rows: list[dict]) -> float:
    completed = [float(row.get("v", 0)) for row in rows[:-1] if row.get("v")]
    sample = completed[-30:]
    return sum(sample) / len(sample) if sample else 0.0


def scan(settings: Settings, client: AlpacaClient, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    symbols = client.universe()
    snapshots = client.snapshots(symbols)
    five_minute = client.bars(symbols, "5Min", now - timedelta(days=8))
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
        session = regular_session_bars(complete, now)
        if len(complete) < 15 or len(session) < 5:
            continue

        indicator_rsi = rsi([float(row["c"]) for row in complete])
        session_vwap = vwap(session)
        bar_move = five_minute_move_pct(session)
        avg_volume = average_daily_volume(daily.get(symbol, []))
        rel_volume = relative_volume(
            sum(float(row.get("v", 0)) for row in session),
            avg_volume,
            elapsed_regular_minutes(now),
        )
        level, confirmation = opening_breakout(session)

        values = (day_move, spread, indicator_rsi, session_vwap, bar_move, rel_volume)
        if any(value is None for value in values):
            continue
        if not (settings.min_price <= price <= settings.max_price):
            continue
        if not (settings.min_day_move_pct <= day_move <= settings.max_day_move_pct):
            continue
        if not (2.0 <= bar_move <= 8.0):
            continue
        if rel_volume < settings.min_relative_volume:
            continue
        if float(session[-1].get("v", 0)) < settings.min_latest_bar_volume:
            continue
        if not (settings.min_rsi <= indicator_rsi <= settings.max_rsi):
            continue
        if spread > settings.max_spread_pct or price <= session_vwap:
            continue
        if not confirmation:
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

        matches.append(
            {
                "symbol": symbol,
                "price": price,
                "bid": bid,
                "ask": ask,
                "spread_pct": spread,
                "day_move_pct": day_move,
                "five_minute_move_pct": bar_move,
                "five_minute_volume": int(session[-1].get("v", 0)),
                "relative_volume": rel_volume,
                "vwap": session_vwap,
                "rsi": indicator_rsi,
                "breakout_level": level,
                "confirmation": confirmation,
                "news_headline": news.get("headline", ""),
                "news_time": news.get("created_at", ""),
                "news_url": news.get("url", ""),
            }
        )
    return sorted(matches, key=lambda row: row["relative_volume"], reverse=True)
