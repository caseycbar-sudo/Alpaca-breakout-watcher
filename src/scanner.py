from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

from .config import Settings
from .indicators import atr, five_minute_move_pct, relative_volume, rsi, spread_pct, vwap
from .risk_sources import OfficialRiskClient
from .stocktwits import StocktwitsClient

DATA_URL = "https://data.alpaca.markets"
PAPER_URL = "https://paper-api.alpaca.markets"
ET = ZoneInfo("America/New_York")
MARKET_SYMBOLS = ("SPY", "QQQ")
RISK_WORDS = (
    "offering",
    "registered direct",
    "at-the-market",
    "dilution",
    "reverse split",
    "delisting",
)


class AlpacaClient:
    """Read-only client. Deliberately contains no order endpoint or order method."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.headers = {
            "APCA-API-KEY-ID": settings.api_key,
            "APCA-API-SECRET-KEY": settings.secret_key,
        }
        self.stocktwits = StocktwitsClient()

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
            groups = [payload.get("most_actives", []), payload.get("gainers", [])]
            for group in groups:
                for item in group:
                    symbol = item.get("symbol")
                    if symbol and symbol not in symbols:
                        symbols.append(symbol)
        # Stocktwits expands discovery beyond Alpaca's mover lists. It is deliberately
        # secondary: every symbol must still clear all Alpaca, news, SEC, and halt gates.
        social_symbols = self.stocktwits.trending_symbols(limit=30)
        self.stocktwits_status = self.stocktwits.status
        return list(dict.fromkeys(social_symbols + symbols))[: self.settings.max_symbols]

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
                "start": (
                    now - timedelta(hours=self.settings.catalyst_max_age_hours)
                ).astimezone(timezone.utc).isoformat(),
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


def opening_breakout(
    session: list[dict], session_vwap: float | None = None
) -> tuple[float | None, str | None]:
    if len(session) < 5:
        return None, None
    level = max(float(row["h"]) for row in session[:3])
    previous, latest = session[-2], session[-1]
    previous_close = float(previous["c"])
    latest_close = float(latest["c"])
    latest_low = float(latest["l"])
    anchor = max(level, session_vwap or level)
    breakout_seen = any(float(row["c"]) > level for row in session[3:-1])

    if (
        breakout_seen
        and latest_low <= anchor * 1.003
        and latest_close > anchor
    ):
        return level, "B — first VWAP/level retest"
    if previous_close > level and latest_close > level:
        return level, "A — catalyst ORB second-bar hold"
    return level, None


def elapsed_regular_minutes(now: datetime) -> float:
    local = now.astimezone(ET)
    opened = local.replace(hour=9, minute=30, second=0, microsecond=0)
    return max(5.0, min(390.0, (local - opened).total_seconds() / 60))


def average_daily_volume(rows: list[dict]) -> float:
    completed = [float(row.get("v", 0)) for row in rows[:-1] if row.get("v")]
    sample = completed[-30:]
    return sum(sample) / len(sample) if sample else 0.0


def market_regime(five_minute: dict[str, list[dict]], now: datetime) -> tuple[bool, str]:
    states = []
    labels = []
    for symbol in MARKET_SYMBOLS:
        complete = completed_five_minute_bars(five_minute.get(symbol, []), now)
        session = regular_session_bars(complete, now)
        if len(session) < 2:
            continue
        session_vwap = vwap(session)
        if session_vwap is None:
            continue
        close = float(session[-1]["c"])
        previous = float(session[-2]["c"])
        aligned = close >= session_vwap and close >= previous
        bearish = close < session_vwap and close < previous
        states.append((aligned, bearish))
        labels.append(f"{symbol} {'aligned' if aligned else 'soft' if not bearish else 'bearish'}")
    both_bearish = len(states) == 2 and all(state[1] for state in states)
    return not both_bearish, ", ".join(labels) if labels else "market data unavailable"


def prepare_risk_checks(
    settings: Settings,
    client: AlpacaClient,
    risk_client: OfficialRiskClient | None = None,
) -> OfficialRiskClient:
    user_agent = settings.sec_user_agent
    if not user_agent and settings.email_from:
        user_agent = f"DriftlineWatcher/1.0 {settings.email_from}"
    checker = risk_client or OfficialRiskClient(user_agent)
    checker.refresh_sources()
    client.risk_events = []
    client.risk_source_status = dict(checker.status)
    return checker


def record_risk_result(
    client: AlpacaClient,
    checker: OfficialRiskClient,
    symbol: str,
    now: datetime,
) -> dict | None:
    assessment = checker.assess(symbol, now)
    client.risk_source_status = dict(checker.status)
    if not assessment.allowed:
        client.risk_events.append(assessment.event(now))
        return None
    return {
        "halt_check": assessment.halt_check,
        "sec_check": assessment.sec_check,
        "sec_filings": assessment.filings,
        "risk_sources": assessment.source_urls,
    }


def scan(
    settings: Settings,
    client: AlpacaClient,
    now: datetime | None = None,
    risk_client: OfficialRiskClient | None = None,
) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    checker = prepare_risk_checks(settings, client, risk_client)
    symbols = client.universe()
    all_symbols = list(dict.fromkeys(symbols + list(MARKET_SYMBOLS)))
    snapshots = client.snapshots(symbols)
    five_minute = client.bars(all_symbols, "5Min", now - timedelta(days=8))
    daily = client.bars(symbols, "1Day", now - timedelta(days=50), limit_pages=3)
    market_ok, market_context = market_regime(five_minute, now)
    matches: list[dict] = []

    if not market_ok:
        return []

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
        indicator_atr = atr(complete)
        bar_move = five_minute_move_pct(session)
        avg_volume = average_daily_volume(daily.get(symbol, []))
        rel_volume = relative_volume(
            sum(float(row.get("v", 0)) for row in session),
            avg_volume,
            elapsed_regular_minutes(now),
        )
        level, confirmation = opening_breakout(session, session_vwap)
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
        minimum_move = (
            0.15 if confirmation == "B — first VWAP/level retest"
            else settings.min_five_minute_move_pct
        )
        if not (settings.min_price <= price <= settings.max_price):
            continue
        if not (settings.min_day_move_pct <= day_move <= settings.max_day_move_pct):
            continue
        if not (minimum_move <= bar_move <= settings.max_five_minute_move_pct):
            continue
        if rel_volume < settings.min_relative_volume:
            continue
        if dollar_volume < settings.min_five_minute_dollar_volume:
            continue
        if not (settings.min_rsi <= indicator_rsi <= settings.max_rsi):
            continue
        if spread > settings.max_spread_pct or price <= session_vwap:
            continue
        if price - session_vwap > indicator_atr * settings.max_vwap_distance_atr:
            continue
        if not confirmation:
            continue

        stop_anchor = min(
            float(session[-1]["l"]),
            float(level),
            float(session_vwap),
        )
        technical_stop = stop_anchor - (0.10 * indicator_atr)
        if technical_stop <= 0 or ask <= technical_stop:
            continue
        if ask - technical_stop > indicator_atr:
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
        risk_result = record_risk_result(client, checker, symbol, now)
        if risk_result is None:
            continue

        preferred_rsi = settings.preferred_min_rsi <= indicator_rsi <= settings.preferred_max_rsi
        stocktwits = None
        social_client = getattr(client, "stocktwits", None)
        if social_client is not None:
            stocktwits = social_client.symbol_pulse(symbol, now)
        social_attention = min(
            float((stocktwits or {}).get("stocktwits_message_count_1h", 0)) / 40.0,
            0.5,
        )
        score = (
            rel_volume
            + (1.0 if preferred_rsi else 0.0)
            + (0.5 if "aligned" in market_context else 0.0)
            + social_attention
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
                "relative_volume": rel_volume,
                "vwap": session_vwap,
                "atr": indicator_atr,
                "rsi": indicator_rsi,
                "preferred_rsi": preferred_rsi,
                "breakout_level": level,
                "technical_stop": technical_stop,
                "confirmation": confirmation,
                "setup": confirmation,
                "market_context": market_context,
                "news_headline": headline,
                "news_time": news.get("created_at", ""),
                "news_url": news.get("url", ""),
                "score": score,
                **(stocktwits or {}),
                **risk_result,
            }
        )
    return sorted(matches, key=lambda row: row["score"], reverse=True)
