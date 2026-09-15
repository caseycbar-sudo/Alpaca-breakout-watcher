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
import threading
import time
from typing import Any

import certifi
import requests
import ssl
import websockets

from .config import Settings
from .emailer import send_email
from .premarket import STATE_PATH as ROSTER_PATH
from .scanner import AlpacaClient, ET


STREAM_ROOT = "wss://stream.data.alpaca.markets/v2"


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


@dataclass
class Tick:
    timestamp: datetime
    price: float
    size: float


@dataclass
class LiveSymbol:
    symbol: str
    previous_close: float = 0.0
    bid: float = 0.0
    ask: float = 0.0
    last_price: float = 0.0
    trigger: float | None = None
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
    ) -> None:
        state = self.symbols.setdefault(symbol, LiveSymbol(symbol=symbol))
        state.previous_close = previous_close or state.previous_close
        state.bid = bid or state.bid
        state.ask = ask or state.ask
        state.trigger = trigger if trigger else state.trigger

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
        if not (self.settings.min_price <= state.last_price <= self.settings.max_price):
            return None

        day_move = _pct_change(state.last_price, state.previous_close)
        if not (self.settings.min_day_move_pct <= day_move <= self.settings.max_day_move_pct):
            return None
        acceleration = _pct_change(fifteen_seconds[-1].price, fifteen_seconds[0].price)
        if not (
            self.settings.stream_min_15s_move_pct
            <= acceleration
            <= self.settings.stream_max_15s_move_pct
        ):
            return None
        spread = _spread_pct(state.bid, state.ask)
        if spread > self.settings.max_spread_pct:
            return None

        volume = sum(tick.size for tick in one_minute)
        dollar_volume = sum(tick.price * tick.size for tick in one_minute)
        if dollar_volume < self.settings.stream_min_rolling_dollar_volume:
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
        self.subscribed: set[str] = set()
        self.started_at = _utc_now()
        self.last_message_at: datetime | None = None
        self.last_alert_at: datetime | None = None
        self.connected = False
        self.reconnects = 0
        self._load_cooldowns()

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok" if self.connected else "starting",
            "mode": "READ ONLY — PAPER TRAINING",
            "connected": self.connected,
            "feed": self.settings.feed,
            "symbols": len(self.subscribed),
            "started_at": self.started_at.isoformat(),
            "last_message_at": self.last_message_at.isoformat() if self.last_message_at else None,
            "last_alert_at": self.last_alert_at.isoformat() if self.last_alert_at else None,
            "reconnects": self.reconnects,
            "orders_enabled": False,
        }

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

    def _save_cooldowns(self) -> None:
        path = Path(self.settings.stream_state_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "last_alert": {
                symbol: moment.isoformat()
                for symbol, moment in self.engine.last_alert.items()
            }
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
        selected = list(dict.fromkeys(list(roster) + symbols))[: self.settings.stream_max_symbols]
        if not selected:
            selected = ["SPY", "QQQ"]
        snapshots = await asyncio.to_thread(self.client.snapshots, selected)
        for symbol in selected:
            snapshot = snapshots.get(symbol, {})
            quote = snapshot.get("latestQuote") or {}
            previous = snapshot.get("prevDailyBar") or {}
            self.engine.prime(
                symbol,
                float(previous.get("c") or 0),
                float(quote.get("bp") or 0),
                float(quote.get("ap") or 0),
                roster.get(symbol),
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
        self.subscribed = set(selected)

    def _alert_body(self, signal: dict[str, Any]) -> str:
        trigger = (
            f"{signal['trigger']:.4f}" if signal.get("trigger") else "dynamic momentum"
        )
        return (
            "ALPACA WATCHER EARLY HEADS-UP — PAPER—NO REAL ORDER\n\n"
            f"Symbol: {signal['symbol']}\n"
            f"Stage: {signal['stage']}\n"
            f"Trigger: {trigger}\n"
            f"Price: {signal['price']:.4f}\n"
            f"Bid/ask: {signal['bid']:.4f}/{signal['ask']:.4f}\n"
            f"Spread: {signal['spread_pct']:.3f}%\n"
            f"Session move: {signal['day_move_pct']:+.2f}%\n"
            f"15-second acceleration: {signal['fifteen_second_move_pct']:+.2f}%\n"
            f"Rolling 60-second volume: {signal['rolling_volume']:,.0f} shares\n"
            f"Rolling 60-second dollar volume: ${signal['rolling_dollar_volume']:,.0f}\n"
            f"Rolling 60-second VWAP: {signal['rolling_vwap']:.4f}\n"
            f"Timestamp: {signal['timestamp']}\n\n"
            "This is a preliminary wake-up signal, not a confirmed breakout. "
            "Robinhood executable pricing, 30-day RVOL, five-minute RSI/VWAP, "
            "catalyst, SEC/dilution, halt, and hold/retest checks are still required.\n\n"
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
        self._save_cooldowns()

    async def handle(self, message: dict[str, Any]) -> None:
        kind = message.get("T")
        symbol = str(message.get("S") or "").upper()
        if not symbol:
            return
        if kind == "q":
            self.engine.quote(
                symbol, float(message.get("bp") or 0), float(message.get("ap") or 0)
            )
        elif kind == "t":
            signal = self.engine.trade(
                symbol,
                float(message.get("p") or 0),
                float(message.get("s") or 0),
                _parse_time(message.get("t")),
            )
            if signal:
                await asyncio.to_thread(self.emit, signal)

    async def connect_once(self) -> None:
        url = f"{STREAM_ROOT}/{self.settings.feed}"
        # Python.org macOS installs do not always inherit the Keychain trust store.
        # Certifi provides a current CA bundle for Alpaca's TLS certificate chain.
        ssl_context = ssl.create_default_context(cafile=certifi.where())
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

    async def run(self) -> None:
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
                print(f"Stream disconnected: {exc}; retrying in {delay}s", flush=True)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)


def start_health_server(watcher: StreamWatcher) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path not in {"/", "/healthz"}:
                self.send_response(404)
                self.end_headers()
                return
            body = json.dumps(watcher.health()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("0.0.0.0", watcher.settings.health_port), Handler)
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
