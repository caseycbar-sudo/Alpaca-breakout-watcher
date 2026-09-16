"""Always-on, read-only Alpaca market-data watcher.

This process has no brokerage order methods. It emits preliminary research alerts
from live trades and quotes; the existing five-minute scanner remains the final
confirmation and paper-lab gate.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import ssl
import threading
import time
from typing import Any

import truststore

# Use the native certificate store. On macOS this means certificates trusted by
# Apple Keychain also work for both Requests and the Alpaca WebSocket.
truststore.inject_into_ssl()

import requests
import websockets

from .config import Settings
from .emailer import send_email
from .live_dashboard import dashboard_page
from .options_flow import OptionsVolumeMonitor
from .premarket import STATE_PATH as ROSTER_PATH
from .scanner import AlpacaClient, ET
from .study_list import record_picks


STREAM_ROOT = "wss://stream.data.alpaca.markets/v2"
CRYPTO_STREAM_ROOT = "wss://stream.data.alpaca.markets/v1beta3/crypto"
BUILD_ID = "2026.09.16.9-visible-backtest-lab"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: str | None) -> datetime:
    if not value:
        return _utc_now()
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _pct_change(current: float, previous: float) -> float:
    return ((current / previous) - 1.0) * 100.0 if previous > 0 else 0.0


def _spread_pct(bid: float, ask: float) -> float:
    midpoint = (bid + ask) / 2.0
    if bid <= 0 or ask < bid or midpoint <= 0:
        return 999.0
    return ((ask - bid) / midpoint) * 100.0


def load_backtest_summary(paths: list[Path] | None = None) -> dict[str, Any]:
    """Load a compact, read-only Backtest Lab summary for the live dashboard."""
    candidates = paths or [
        Path.home() / "Library/Application Support/DriftlineWatcher/backtest/backtest.json",
        Path("docs/data/backtest.json"),
        Path("data/backtest.json"),
    ]
    for path in candidates:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            summary = payload.get("summary") or {}
            learning = summary.get("learning") or {}
            portfolio = summary.get("portfolio") or {}
            model = payload.get("model") or {}
            patterns = payload.get("patterns") or {}
            return {
                "status": "ready",
                "generated_at": payload.get("generated_at"),
                "tickers": int(summary.get("tickers") or 0),
                "setups": int(learning.get("trades") or 0),
                "average_r": float(learning.get("avg_r") or 0),
                "win_rate": float(learning.get("win_rate") or 0),
                "paper_trades": int(portfolio.get("trades") or 0),
                "paper_pl": float(portfolio.get("net_pl") or 0),
                "model_status": str(model.get("status") or "waiting"),
                "model_auc": model.get("test_auc"),
                "promising": [str(row.get("pattern")) for row in patterns.get("promising", [])[:5]],
                "avoid": [str(row.get("pattern")) for row in patterns.get("avoid", [])[:5]],
                "source": str(path),
            }
        except (OSError, json.JSONDecodeError, TypeError, ValueError, AttributeError):
            continue
    return {
        "status": "not_run",
        "tickers": 0,
        "setups": 0,
        "message": "Run ‘Run Backtest Lab.command’ once to create the first report.",
    }


@dataclass
class Tick:
    timestamp: datetime
    price: float
    size: float


@dataclass
class LiveSymbol:
    symbol: str
    asset_class: str = "stock"
    previous_close: float = 0.0
    bid: float = 0.0
    ask: float = 0.0
    last_price: float = 0.0
    trigger: float | None = None
    previous_volume: float = 0.0
    session_volume: float = 0.0
    ticks: deque[Tick] = field(default_factory=deque)

    def add_trade(self, tick: Tick) -> None:
        self.last_price = tick.price
        self.ticks.append(tick)
        cutoff = tick.timestamp - timedelta(seconds=65)
        while self.ticks and self.ticks[0].timestamp < cutoff:
            self.ticks.popleft()

    def window(self, seconds: int, now: datetime) -> list[Tick]:
        cutoff = now - timedelta(seconds=seconds)
        return [tick for tick in self.ticks if tick.timestamp >= cutoff]


class EarlyWarningEngine:
    """Conservative seconds-level detector for preliminary alerts only."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.symbols: dict[str, LiveSymbol] = {}
        self.last_alert: dict[str, datetime] = {}

    def prime(
        self,
        symbol: str,
        previous_close: float,
        bid: float = 0.0,
        ask: float = 0.0,
        trigger: float | None = None,
        previous_volume: float = 0.0,
        session_volume: float = 0.0,
        asset_class: str = "stock",
    ) -> None:
        state = self.symbols.setdefault(
            symbol, LiveSymbol(symbol=symbol, asset_class=asset_class)
        )
        state.asset_class = asset_class
        state.previous_close = previous_close or state.previous_close
        state.bid = bid or state.bid
        state.ask = ask or state.ask
        state.trigger = trigger if trigger else state.trigger
        state.previous_volume = previous_volume or state.previous_volume
        state.session_volume = session_volume or state.session_volume

    def quote(self, symbol: str, bid: float, ask: float) -> None:
        state = self.symbols.setdefault(symbol, LiveSymbol(symbol=symbol))
        if bid > 0:
            state.bid = bid
        if ask > 0:
            state.ask = ask

    def trade(
        self, symbol: str, price: float, size: float, timestamp: datetime
    ) -> dict[str, Any] | None:
        state = self.symbols.setdefault(symbol, LiveSymbol(symbol=symbol))
        state.add_trade(Tick(timestamp=timestamp, price=price, size=max(size, 0.0)))
        return self.evaluate(state, timestamp)

    def evaluate(self, state: LiveSymbol, now: datetime) -> dict[str, Any] | None:
        one_minute = state.window(60, now)
        fifteen_seconds = state.window(15, now)
        if len(one_minute) < self.settings.stream_min_trade_count or len(fifteen_seconds) < 2:
            return None
        is_crypto = state.asset_class == "crypto"
        if not is_crypto and not (
            self.settings.min_price <= state.last_price <= self.settings.max_price
        ):
            return None

        day_move = _pct_change(state.last_price, state.previous_close)
        min_day_move = (
            self.settings.crypto_min_day_move_pct if is_crypto
            else self.settings.min_day_move_pct
        )
        max_day_move = (
            self.settings.crypto_max_day_move_pct if is_crypto
            else self.settings.max_day_move_pct
        )
        if not (min_day_move <= abs(day_move) <= max_day_move):
            return None
        acceleration = _pct_change(fifteen_seconds[-1].price, fifteen_seconds[0].price)
        min_acceleration = (
            self.settings.crypto_min_15s_move_pct if is_crypto
            else self.settings.stream_min_15s_move_pct
        )
        max_acceleration = (
            self.settings.crypto_max_15s_move_pct if is_crypto
            else self.settings.stream_max_15s_move_pct
        )
        if not (
            min_acceleration <= acceleration <= max_acceleration
        ):
            return None
        spread = _spread_pct(state.bid, state.ask)
        max_spread = (
            self.settings.crypto_max_spread_pct if is_crypto
            else self.settings.max_spread_pct
        )
        if spread > max_spread:
            return None

        volume = sum(tick.size for tick in one_minute)
        dollar_volume = sum(tick.price * tick.size for tick in one_minute)
        min_dollar_volume = (
            self.settings.crypto_min_rolling_dollar_volume if is_crypto
            else self.settings.stream_min_rolling_dollar_volume
        )
        if dollar_volume < min_dollar_volume:
            return None
        total_volume = sum(tick.size for tick in one_minute)
        rolling_vwap = (
            sum(tick.price * tick.size for tick in one_minute) / total_volume
            if total_volume > 0
            else 0.0
        )
        if rolling_vwap <= 0 or state.last_price < rolling_vwap:
            return None

        previous_alert = self.last_alert.get(state.symbol)
        if previous_alert and (now - previous_alert).total_seconds() < self.settings.stream_cooldown_seconds:
            return None

        stage = "EARLY MOMENTUM — VERIFYING"
        trigger_distance = None
        if state.trigger and state.trigger > 0:
            trigger_distance = _pct_change(state.last_price, state.trigger)
            proximity = self.settings.stream_trigger_proximity_pct
            if trigger_distance < -proximity or trigger_distance > 1.0:
                return None
            stage = (
                "TRIGGER CROSSED — NOT YET CONFIRMED"
                if state.last_price >= state.trigger
                else "APPROACHING TRIGGER — NOT YET CONFIRMED"
            )

        self.last_alert[state.symbol] = now
        return {
            "symbol": state.symbol,
            "asset_class": state.asset_class,
            "stage": stage,
            "price": state.last_price,
            "bid": state.bid,
            "ask": state.ask,
            "spread_pct": spread,
            "day_move_pct": day_move,
            "fifteen_second_move_pct": acceleration,
            "rolling_volume": volume,
            "rolling_dollar_volume": dollar_volume,
            "rolling_vwap": rolling_vwap,
            "trigger": state.trigger,
            "trigger_distance_pct": trigger_distance,
            "timestamp": now.isoformat(),
        }


class StreamWatcher:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = AlpacaClient(settings)
        self.engine = EarlyWarningEngine(settings)
        self.options_monitor = OptionsVolumeMonitor(settings, self.client)
        self.data_lock = threading.RLock()
        self.subscribed: set[str] = set()
        self.crypto_subscribed: set[str] = set()
        self.started_at = _utc_now()
        self.last_message_at: datetime | None = None
        self.last_alert_at: datetime | None = None
        self.connected = False
        self.crypto_connected = False
        self.reconnects = 0
        self.crypto_reconnects = 0
        self.message_count = 0
        self.trade_count = 0
        self.quote_count = 0
        self.alert_count = 0
        self.last_universe_refresh_at: datetime | None = None
        self.recent_events: deque[dict[str, str]] = deque(maxlen=80)
        self.recent_messages: deque[dict[str, Any]] = deque(maxlen=120)
        self.recent_trades: deque[dict[str, Any]] = deque(maxlen=120)
        self.last_test_at: datetime | None = None
        self.universe_refresh_count = 0
        self._load_cooldowns()

    def record_event(self, title: str, detail: str, kind: str = "info") -> None:
        with self.data_lock:
            self.recent_events.appendleft({
                "title": title,
                "detail": detail,
                "kind": kind,
                "timestamp": _utc_now().isoformat(),
            })

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok" if self.connected else "starting",
            "build": BUILD_ID,
            "mode": "READ ONLY — PAPER TRAINING",
            "connected": self.connected,
            "crypto_connected": self.crypto_connected,
            "feed": self.settings.feed,
            "symbols": len(self.subscribed),
            "crypto_symbols": len(self.crypto_subscribed),
            "options_status": self.options_monitor.status,
            "options_underlyings": len(self.options_monitor.rows),
            "options_contracts": self.options_monitor.contracts_observed,
            "options_last_refresh_at": (
                self.options_monitor.last_refresh_at.isoformat()
                if self.options_monitor.last_refresh_at else None
            ),
            "started_at": self.started_at.isoformat(),
            "last_message_at": self.last_message_at.isoformat() if self.last_message_at else None,
            "last_alert_at": self.last_alert_at.isoformat() if self.last_alert_at else None,
            "reconnects": self.reconnects,
            "crypto_reconnects": self.crypto_reconnects,
            "message_count": self.message_count,
            "trade_count": self.trade_count,
            "quote_count": self.quote_count,
            "other_message_count": max(
                0, self.message_count - self.trade_count - self.quote_count
            ),
            "alert_count": self.alert_count,
            "last_universe_refresh_at": (
                self.last_universe_refresh_at.isoformat()
                if self.last_universe_refresh_at else None
            ),
            "orders_enabled": False,
        }

    @staticmethod
    def _session_fraction(now: datetime) -> float | None:
        local = now.astimezone(ET)
        minutes = (local.hour * 60 + local.minute) - (9 * 60 + 30)
        if minutes < 0 or minutes > 390:
            return None
        return max(minutes / 390.0, 1 / 390.0)

    def _score_symbol(self, state: LiveSymbol, now: datetime) -> dict[str, Any]:
        recent = state.window(60, now)
        fast = state.window(15, now)
        volume = sum(tick.size for tick in recent)
        dollar_volume = sum(tick.price * tick.size for tick in recent)
        rolling_vwap = (
            sum(tick.price * tick.size for tick in recent) / volume if volume else 0.0
        )
        acceleration = (
            _pct_change(fast[-1].price, fast[0].price) if len(fast) > 1 else 0.0
        )
        day_move = _pct_change(state.last_price, state.previous_close)
        spread = _spread_pct(state.bid, state.ask)
        trigger_distance = (
            _pct_change(state.last_price, state.trigger) if state.trigger else None
        )
        is_crypto = state.asset_class == "crypto"
        fraction = (
            max(
                (now.hour * 3600 + now.minute * 60 + now.second) / 86400.0,
                1 / 1440.0,
            )
            if is_crypto else self._session_fraction(now)
        )
        estimated_rvol = (
            state.session_volume / (state.previous_volume * fraction)
            if fraction and state.previous_volume > 0 and state.session_volume > 0
            else None
        )

        reasons: list[str] = []
        status = "SCANNING — BUILDING DATA"
        kind = "scanning"
        min_day_move = (
            self.settings.crypto_min_day_move_pct if is_crypto
            else self.settings.min_day_move_pct
        )
        max_day_move = (
            self.settings.crypto_max_day_move_pct if is_crypto
            else self.settings.max_day_move_pct
        )
        min_acceleration = (
            self.settings.crypto_min_15s_move_pct if is_crypto
            else self.settings.stream_min_15s_move_pct
        )
        max_acceleration = (
            self.settings.crypto_max_15s_move_pct if is_crypto
            else self.settings.stream_max_15s_move_pct
        )
        min_dollar_volume = (
            self.settings.crypto_min_rolling_dollar_volume if is_crypto
            else self.settings.stream_min_rolling_dollar_volume
        )
        max_spread = (
            self.settings.crypto_max_spread_pct if is_crypto
            else self.settings.max_spread_pct
        )
        if not is_crypto and not (
            self.settings.min_price <= state.last_price <= self.settings.max_price
        ):
            status, kind = "BLOCKED — PRICE RANGE", "blocked"
            reasons.append("Outside the $0.50–$100 range")
        elif spread > max_spread:
            status, kind = "BLOCKED — WIDE SPREAD", "blocked"
            reasons.append(
                "No reliable executable spread" if spread >= 999
                else f"{spread:.2f}% spread exceeds {max_spread:.2f}%"
            )
        elif abs(day_move) > max_day_move:
            status, kind = "BLOCKED — OVEREXTENDED", "blocked"
            reasons.append(f"{day_move:+.2f}% session move exceeds the chase limit")
        elif abs(day_move) < min_day_move:
            status = "SCANNING — BELOW MOVE GATE"
            reasons.append(f"Needs a {min_day_move:.1f}% session move")
        elif len(recent) < self.settings.stream_min_trade_count:
            status = "SCANNING — BUILDING DATA"
            reasons.append(
                f"{len(recent)}/{self.settings.stream_min_trade_count} recent trades"
            )
        elif dollar_volume < min_dollar_volume:
            status, kind = "BLOCKED — LOW DOLLAR VOLUME", "blocked"
            reasons.append(
                f"${dollar_volume:,.0f}/${min_dollar_volume:,.0f} rolling target"
            )
        elif acceleration < min_acceleration:
            status = "SCANNING — NO ACCELERATION"
            reasons.append(
                f"15-second move below {min_acceleration:.2f}%"
            )
        elif acceleration > max_acceleration:
            status, kind = "BLOCKED — SPIKE RISK", "blocked"
            reasons.append("15-second move exceeds the safe acceleration range")
        elif rolling_vwap <= 0 or state.last_price < rolling_vwap:
            status, kind = "BLOCKED — BELOW VWAP", "blocked"
            reasons.append("Price is below rolling 60-second VWAP")
        elif state.trigger and trigger_distance is not None:
            proximity = self.settings.stream_trigger_proximity_pct
            if -proximity <= trigger_distance <= 1.0:
                status = (
                    "TRIGGER CROSSED — VERIFYING"
                    if trigger_distance >= 0 else "NEAR TRIGGER — VERIFYING"
                )
                kind = "candidate"
                reasons.append("Near the saved breakout level; five-minute hold still required")
            else:
                status = "SCANNING — AWAY FROM TRIGGER"
                reasons.append(f"{trigger_distance:+.2f}% from saved trigger")
        else:
            status, kind = "EARLY MOMENTUM — VERIFYING", "candidate"
            reasons.append("Fast move passed local gates; downstream verification required")

        score = 0.0
        score += min(max((day_move - 1.0) / 5.0, 0.0), 1.0) * 20
        score += min(max(acceleration / min_acceleration, 0.0), 1.0) * 20
        score += min(dollar_volume / min_dollar_volume, 1.0) * 20
        score += max(0.0, 1.0 - spread / max(max_spread, 0.01)) * 15
        score += (15 if rolling_vwap and state.last_price >= rolling_vwap else 0)
        score += min(max((estimated_rvol or 0) / 1.5, 0.0), 1.0) * 10
        if kind == "blocked":
            score = min(score, 39)
        elif kind == "scanning":
            score = min(score, 59)

        return {
            "symbol": state.symbol,
            "asset_class": state.asset_class,
            "last": state.last_price,
            "bid": state.bid,
            "ask": state.ask,
            "day_move_pct": day_move,
            "acceleration_pct": acceleration,
            "volume_60s": volume,
            "dollar_volume_60s": dollar_volume,
            "rolling_vwap": rolling_vwap,
            "estimated_rvol": estimated_rvol,
            "spread_pct": spread,
            "trigger": state.trigger,
            "trigger_distance_pct": trigger_distance,
            "score": round(score),
            "status": status,
            "status_kind": kind,
            "reason": "; ".join(reasons),
            "last_trade_at": state.ticks[-1].timestamp.isoformat(),
        }

    def live_snapshot(self) -> dict[str, Any]:
        with self.data_lock:
            now = _utc_now()
            rows: list[dict[str, Any]] = []
            for state in self.engine.symbols.values():
                if not state.ticks or state.last_price <= 0:
                    continue
                rows.append(self._score_symbol(state, now))
            rows.sort(
                key=lambda row: (row["score"], row["last_trade_at"]), reverse=True
            )
            stock_rows = [row for row in rows if row["asset_class"] == "stock"]
            crypto_rows = [row for row in rows if row["asset_class"] == "crypto"]
            universe = []
            for symbol in sorted(self.subscribed):
                state = self.engine.symbols.get(symbol)
                universe.append({
                    "symbol": symbol,
                    "trigger": state.trigger if state else None,
                    "last": state.last_price if state else 0,
                    "bid": state.bid if state else 0,
                    "ask": state.ask if state else 0,
                    "previous_close": state.previous_close if state else 0,
                })
            crypto_universe = []
            for symbol in sorted(self.crypto_subscribed):
                state = self.engine.symbols.get(symbol)
                crypto_universe.append({
                    "symbol": symbol,
                    "last": state.last_price if state else 0,
                    "bid": state.bid if state else 0,
                    "ask": state.ask if state else 0,
                    "previous_close": state.previous_close if state else 0,
                })
            return {
                "health": self.health(),
                "backtest": load_backtest_summary(),
                "symbols": stock_rows[:30],
                "crypto": crypto_rows[:20],
                "options": list(self.options_monitor.rows),
                "universe": universe,
                "crypto_universe": crypto_universe,
                "messages": list(self.recent_messages),
                "trades": list(self.recent_trades),
                "events": list(self.recent_events),
                "sources": [
                    {
                        "name": "Alpaca stream",
                        "state": "live" if self.connected else "reconnecting",
                        "detail": f"{self.settings.feed.upper()} feed",
                    },
                    {
                        "name": "Alpaca crypto",
                        "state": "live" if self.crypto_connected else (
                            "disabled" if not self.settings.crypto_enabled else "reconnecting"
                        ),
                        "detail": f"{len(self.crypto_subscribed)} pairs · {self.settings.crypto_location}",
                    },
                    {
                        "name": "Alpaca options volume",
                        "state": self.options_monitor.status if self.settings.options_enabled else "disabled",
                        "detail": (
                            f"{self.options_monitor.contracts_observed} near-money contracts · "
                            f"{self.settings.options_feed.upper()}"
                            if self.settings.options_enabled else "turned off"
                        ),
                    },
                    {
                        "name": "Market coverage",
                        "state": "partial" if self.settings.feed == "iex" else "full",
                        "detail": "IEX sample" if self.settings.feed == "iex" else "consolidated feed",
                    },
                    {
                        "name": "Gmail bridge",
                        "state": "ready" if self.settings.gmail_app_password else "not configured",
                        "detail": "alert delivery",
                    },
                    {
                        "name": "Direct webhook",
                        "state": "ready" if self.settings.alert_webhook_url else "optional",
                        "detail": "fastest push path",
                    },
                    {
                        "name": "Risk verification",
                        "state": "on alert",
                        "detail": "catalyst + SEC + Nasdaq + Robinhood",
                    },
                    {
                        "name": "Order access",
                        "state": "disabled",
                        "detail": "read only",
                    },
                ],
            }

    def send_test_alert(self) -> bool:
        now = _utc_now()
        if self.last_test_at and (now - self.last_test_at).total_seconds() < 30:
            return False
        self.last_test_at = now
        subject = "ALPACA WATCHER HEALTHCHECK — LOCAL DASHBOARD TEST"
        body = (
            "BRIDGE HEALTHCHECK REQUEST\n\n"
            "The Driftline Mac watcher dashboard sent this safe test.\n"
            f"Watcher connected: {self.connected}\n"
            f"Symbols watched: {len(self.subscribed)}\n"
            f"Live messages inspected: {self.message_count:,}\n"
            f"Timestamp: {now.isoformat()}\n\n"
            "PAPER—NO REAL ORDER. No real or paper order was created."
        )
        sent = send_email(self.settings, subject, body)
        self.record_event(
            "Safe test alert sent" if sent else "Test alert not sent",
            "Gmail bridge test; no order was created.",
            "alert" if sent else "info",
        )
        self._save_cooldowns()
        return sent

    def _load_cooldowns(self) -> None:
        path = Path(self.settings.stream_state_path)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for symbol, raw in data.get("last_alert", {}).items():
            try:
                self.engine.last_alert[symbol] = _parse_time(raw)
            except (TypeError, ValueError):
                continue
        for event in reversed(data.get("recent_events", [])):
            if all(event.get(key) for key in ("title", "detail", "kind", "timestamp")):
                self.recent_events.appendleft(event)

    def _save_cooldowns(self) -> None:
        path = Path(self.settings.stream_state_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "last_alert": {
                symbol: moment.isoformat()
                for symbol, moment in self.engine.last_alert.items()
            },
            "recent_events": list(self.recent_events)[:40],
        }
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def _roster_levels() -> dict[str, float]:
        try:
            payload = json.loads(ROSTER_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        today = _utc_now().astimezone(ET).date().isoformat()
        if payload.get("date") != today:
            return {}
        return {
            row["symbol"]: float(row["breakout_level"])
            for row in payload.get("roster", [])
            if row.get("symbol") and row.get("breakout_level")
        }

    async def refresh_universe(self, websocket: Any) -> None:
        symbols = await asyncio.to_thread(self.client.universe)
        roster = self._roster_levels()
        options_core = [
            symbol.strip().upper()
            for symbol in self.settings.options_core_symbols.split(",")
            if symbol.strip()
        ] if self.settings.options_enabled else []
        selected = list(dict.fromkeys(list(roster) + options_core + symbols))[
            : self.settings.stream_max_symbols
        ]
        if not selected:
            selected = ["SPY", "QQQ"]
        snapshots = await asyncio.to_thread(self.client.snapshots, selected)
        with self.data_lock:
            for symbol in selected:
                snapshot = snapshots.get(symbol, {})
                quote = snapshot.get("latestQuote") or {}
                previous = snapshot.get("prevDailyBar") or {}
                current = snapshot.get("dailyBar") or {}
                self.engine.prime(
                    symbol,
                    float(previous.get("c") or 0),
                    float(quote.get("bp") or 0),
                    float(quote.get("ap") or 0),
                    roster.get(symbol),
                    float(previous.get("v") or 0),
                    float(current.get("v") or 0),
                )
        additions = set(selected) - self.subscribed
        removals = self.subscribed - set(selected)
        if additions:
            batch = sorted(additions)
            await websocket.send(json.dumps({
                "action": "subscribe",
                "trades": batch,
                "quotes": batch,
                "bars": batch,
                "statuses": ["*"],
            }))
        if removals:
            batch = sorted(removals)
            await websocket.send(json.dumps({
                "action": "unsubscribe",
                "trades": batch,
                "quotes": batch,
                "bars": batch,
            }))
        changed = bool(additions or removals)
        self.subscribed = set(selected)
        self.last_universe_refresh_at = _utc_now()
        self.universe_refresh_count += 1
        if changed or self.universe_refresh_count == 1:
            detail = f"Scanning {len(self.subscribed)} live symbols"
            if additions or removals:
                detail += f"; {len(additions)} added, {len(removals)} removed"
            self.record_event("Universe updated", detail + ".")
            self._save_cooldowns()

    async def refresh_crypto_universe(self, websocket: Any) -> None:
        configured = [
            symbol.strip().upper()
            for symbol in self.settings.crypto_symbols.split(",")
            if symbol.strip()
        ]
        snapshots = await asyncio.to_thread(self.client.crypto_snapshots, configured)
        selected = [symbol for symbol in configured if snapshots.get(symbol)]
        if not selected:
            raise RuntimeError("No configured crypto pairs returned a current snapshot")
        with self.data_lock:
            for symbol in selected:
                snapshot = snapshots.get(symbol, {})
                quote = snapshot.get("latestQuote") or {}
                previous = snapshot.get("prevDailyBar") or {}
                current = snapshot.get("dailyBar") or {}
                self.engine.prime(
                    symbol,
                    float(previous.get("c") or 0),
                    float(quote.get("bp") or 0),
                    float(quote.get("ap") or 0),
                    previous_volume=float(previous.get("v") or 0),
                    session_volume=float(current.get("v") or 0),
                    asset_class="crypto",
                )
        await websocket.send(json.dumps({
            "action": "subscribe",
            "trades": selected,
            "quotes": selected,
            "bars": selected,
        }))
        response = json.loads(await websocket.recv())
        errors = [row for row in response if row.get("T") == "error"]
        if errors:
            raise RuntimeError(f"Crypto subscription failed: {errors}")
        self.crypto_subscribed = set(selected)
        self.record_event(
            "Crypto scanner connected",
            f"Watching {len(selected)} liquid USD pairs around the clock.",
        )
        self._save_cooldowns()

    def _alert_body(self, signal: dict[str, Any]) -> str:
        is_crypto = signal.get("asset_class") == "crypto"
        trigger = (
            f"{signal['trigger']:.4f}" if signal.get("trigger") else "dynamic momentum"
        )
        unit = "units" if is_crypto else "shares"
        verification = (
            "Robinhood executable crypto pricing, tested support or a breakout retest, "
            "five-minute RSI/VWAP, and spread checks are still required."
            if is_crypto else
            "Robinhood executable pricing, 30-day RVOL, five-minute RSI/VWAP, "
            "catalyst, SEC/dilution, halt, and hold/retest checks are still required."
        )
        return (
            "ALPACA WATCHER EARLY HEADS-UP — PAPER—NO REAL ORDER\n\n"
            f"Market: {'CRYPTO' if is_crypto else 'STOCK'}\n"
            f"Symbol: {signal['symbol']}\n"
            f"Stage: {signal['stage']}\n"
            f"Trigger: {trigger}\n"
            f"Price: {signal['price']:.4f}\n"
            f"Bid/ask: {signal['bid']:.4f}/{signal['ask']:.4f}\n"
            f"Spread: {signal['spread_pct']:.3f}%\n"
            f"Session move: {signal['day_move_pct']:+.2f}%\n"
            f"15-second acceleration: {signal['fifteen_second_move_pct']:+.2f}%\n"
            f"Rolling 60-second volume: {signal['rolling_volume']:,.4f} {unit}\n"
            f"Rolling 60-second dollar volume: ${signal['rolling_dollar_volume']:,.0f}\n"
            f"Rolling 60-second VWAP: {signal['rolling_vwap']:.4f}\n"
            f"Timestamp: {signal['timestamp']}\n\n"
            "This is a preliminary wake-up signal, not a confirmed breakout. "
            f"{verification}\n\n"
            "PAPER—NO REAL ORDER. No real or paper order was created."
        )

    def emit(self, signal: dict[str, Any]) -> None:
        subject = f"ALPACA WATCHER EARLY HEADS-UP — {signal['symbol']}"
        body = self._alert_body(signal)
        webhook_sent = False
        if self.settings.alert_webhook_url:
            headers = {"Content-Type": "application/json"}
            if self.settings.alert_webhook_token:
                headers["Authorization"] = f"Bearer {self.settings.alert_webhook_token}"
            try:
                requests.post(
                    self.settings.alert_webhook_url,
                    json={"subject": subject, "body": body, "signal": signal},
                    headers=headers,
                    timeout=3,
                ).raise_for_status()
                webhook_sent = True
            except requests.RequestException as exc:
                print(f"Direct alert webhook failed: {exc}", flush=True)
        try:
            email_sent = send_email(self.settings, subject, body)
        except Exception as exc:
            email_sent = False
            print(f"Alert email failed: {exc}", flush=True)
        print(
            f"{subject}; webhook_sent={webhook_sent}; email_sent={email_sent}",
            flush=True,
        )
        self.last_alert_at = _utc_now()
        self.alert_count += 1
        self.record_event(
            f"Early heads-up: {signal['symbol']}",
            f"{signal['stage']} at {signal['price']:.4f}; verification required.",
            "alert",
        )
        if signal.get("asset_class", "stock") == "stock":
            # Research bookkeeping only: feeds the isolated backtest study list.
            record_picks(
                [signal["symbol"]],
                "stream",
                path=self.settings.stream_picks_path,
            )
        self._save_cooldowns()

    async def handle(
        self, message: dict[str, Any], asset_class: str = "stock"
    ) -> None:
        kind = message.get("T")
        symbol = str(message.get("S") or "").upper()
        if not symbol:
            return
        timestamp = _parse_time(message.get("t"))
        signal = None
        with self.data_lock:
            self.message_count += 1
            self.recent_messages.appendleft({
                "type": {"q": "Quote", "t": "Trade", "b": "Bar", "s": "Status"}.get(kind, str(kind)),
                "symbol": symbol,
                "asset_class": asset_class,
                "timestamp": timestamp.isoformat(),
            })
            state = self.engine.symbols.setdefault(
                symbol, LiveSymbol(symbol=symbol, asset_class=asset_class)
            )
            state.asset_class = asset_class
            if kind == "q":
                self.quote_count += 1
                self.engine.quote(
                    symbol, float(message.get("bp") or 0), float(message.get("ap") or 0)
                )
            elif kind == "t":
                self.trade_count += 1
                price = float(message.get("p") or 0)
                size = float(message.get("s") or 0)
                self.recent_trades.appendleft({
                    "symbol": symbol,
                    "asset_class": asset_class,
                    "price": price,
                    "size": size,
                    "notional": price * size,
                    "timestamp": timestamp.isoformat(),
                })
                signal = self.engine.trade(symbol, price, size, timestamp)
        if signal:
            await asyncio.to_thread(self.emit, signal)

    async def connect_once(self) -> None:
        url = f"{STREAM_ROOT}/{self.settings.feed}"
        ssl_context = ssl.create_default_context()
        async with websockets.connect(
            url,
            ssl=ssl_context,
            ping_interval=20,
            ping_timeout=20,
        ) as websocket:
            connected = json.loads(await websocket.recv())
            if not any(
                row.get("T") == "success" and row.get("msg") == "connected"
                for row in connected
            ):
                raise RuntimeError(f"Alpaca stream connection failed: {connected}")
            await websocket.send(json.dumps({
                "action": "auth",
                "key": self.settings.api_key,
                "secret": self.settings.secret_key,
            }))
            response = json.loads(await websocket.recv())
            if not any(row.get("T") == "success" and row.get("msg") == "authenticated" for row in response):
                raise RuntimeError(f"Alpaca stream authentication failed: {response}")
            self.connected = True
            self.record_event("Alpaca connected", f"Authenticated to the {self.settings.feed.upper()} live feed.")
            await self.refresh_universe(websocket)
            next_refresh = time.monotonic() + self.settings.stream_refresh_seconds
            while True:
                timeout = max(1.0, min(5.0, next_refresh - time.monotonic()))
                try:
                    raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                except asyncio.TimeoutError:
                    raw = "[]"
                for message in json.loads(raw):
                    if message.get("T") not in {"success", "subscription"}:
                        self.last_message_at = _utc_now()
                    await self.handle(message)
                if time.monotonic() >= next_refresh:
                    await self.refresh_universe(websocket)
                    next_refresh = time.monotonic() + self.settings.stream_refresh_seconds

    async def connect_crypto_once(self) -> None:
        url = f"{CRYPTO_STREAM_ROOT}/{self.settings.crypto_location}"
        ssl_context = ssl.create_default_context()
        async with websockets.connect(
            url,
            ssl=ssl_context,
            ping_interval=20,
            ping_timeout=20,
        ) as websocket:
            connected = json.loads(await websocket.recv())
            if not any(
                row.get("T") == "success" and row.get("msg") == "connected"
                for row in connected
            ):
                raise RuntimeError(f"Alpaca crypto connection failed: {connected}")
            await websocket.send(json.dumps({
                "action": "auth",
                "key": self.settings.api_key,
                "secret": self.settings.secret_key,
            }))
            response = json.loads(await websocket.recv())
            if not any(
                row.get("T") == "success" and row.get("msg") == "authenticated"
                for row in response
            ):
                raise RuntimeError(f"Alpaca crypto authentication failed: {response}")
            await self.refresh_crypto_universe(websocket)
            self.crypto_connected = True
            while True:
                raw = await websocket.recv()
                for message in json.loads(raw):
                    if message.get("T") not in {"success", "subscription"}:
                        self.last_message_at = _utc_now()
                    await self.handle(message, asset_class="crypto")

    async def run_stocks(self) -> None:
        delay = 1
        while True:
            try:
                await self.connect_once()
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.connected = False
                self.reconnects += 1
                self.record_event("Connection interrupted", f"Retrying automatically in {delay} seconds.")
                print(f"Stream disconnected: {exc}; retrying in {delay}s", flush=True)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)

    async def run_crypto(self) -> None:
        delay = 1
        while True:
            try:
                await self.connect_crypto_once()
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.crypto_connected = False
                self.crypto_reconnects += 1
                self.record_event(
                    "Crypto connection interrupted",
                    f"Retrying automatically in {delay} seconds.",
                )
                print(f"Crypto stream disconnected: {exc}; retrying in {delay}s", flush=True)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)

    def _option_target_prices(self) -> dict[str, float]:
        """Pick core indexes plus the strongest live stock candidates."""
        with self.data_lock:
            now = _utc_now()
            rows = [
                self._score_symbol(state, now)
                for state in self.engine.symbols.values()
                if state.asset_class == "stock" and state.last_price > 0
            ]
            rows.sort(key=lambda row: row["score"], reverse=True)
            core = [
                symbol.strip().upper()
                for symbol in self.settings.options_core_symbols.split(",")
                if symbol.strip()
            ]
            ordered = list(dict.fromkeys(core + [row["symbol"] for row in rows]))
            selected = ordered[: max(1, self.settings.options_top_symbols)]
            return {
                symbol: self.engine.symbols[symbol].last_price
                for symbol in selected
                if symbol in self.engine.symbols
                and self.engine.symbols[symbol].last_price > 0
            }

    async def run_options(self) -> None:
        """Poll bounded near-money option volume without blocking live streams."""
        await asyncio.sleep(8)
        last_status = self.options_monitor.status
        while True:
            prices = self._option_target_prices()
            if prices:
                await asyncio.to_thread(self.options_monitor.refresh, prices)
                current = self.options_monitor.status
                if current == "live" and last_status != "live":
                    self.record_event(
                        "Options volume connected",
                        f"Tracking {self.options_monitor.contracts_observed} near-money contracts "
                        f"across {len(self.options_monitor.rows)} underlyings.",
                    )
                elif current == "unavailable" and last_status != "unavailable":
                    self.record_event(
                        "Options volume unavailable",
                        "Stock and crypto scanning continue; the options feed will retry automatically.",
                    )
                last_status = current
            await asyncio.sleep(max(30, self.settings.options_poll_seconds))

    async def run(self) -> None:
        tasks = [self.run_stocks()]
        if self.settings.crypto_enabled:
            tasks.append(self.run_crypto())
        if self.settings.options_enabled:
            tasks.append(self.run_options())
        await asyncio.gather(*tasks)


def start_health_server(watcher: StreamWatcher) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/":
                body = dashboard_page()
                content_type = "text/html; charset=utf-8"
            elif self.path == "/healthz":
                body = json.dumps(watcher.health()).encode("utf-8")
                content_type = "application/json"
            elif self.path == "/api/live":
                body = json.dumps(watcher.live_snapshot()).encode("utf-8")
                content_type = "application/json"
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/api/test-alert":
                self.send_response(404)
                self.end_headers()
                return
            try:
                sent = watcher.send_test_alert()
                payload = {"ok": sent, "message": "Wait 30 seconds before another test." if not sent else "Test sent."}
                status = 200 if sent else 429
            except Exception as exc:
                print(f"Dashboard test alert failed: {exc}", flush=True)
                payload = {"ok": False, "message": "Gmail test failed; check the watcher log."}
                status = 502
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", watcher.settings.health_port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> None:
    settings = Settings()
    settings.validate()
    watcher = StreamWatcher(settings)
    start_health_server(watcher)
    print(
        f"Read-only Alpaca stream watcher starting on {settings.feed}; "
        f"health port {settings.health_port}",
        flush=True,
    )
    asyncio.run(watcher.run())


if __name__ == "__main__":
    main()
