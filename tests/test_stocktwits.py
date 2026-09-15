from datetime import datetime, timedelta, timezone

import requests

from src.stocktwits import StocktwitsClient


class FakeResponse:
    def __init__(self, payload=None, error=None):
        self.payload = payload or {}
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise self.error

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, payload=None, error=None):
        self.payload = payload
        self.error = error
        self.urls = []

    def get(self, url, **kwargs):
        self.urls.append(url)
        return FakeResponse(self.payload, self.error)


def test_trending_symbols_are_valid_deduplicated_and_limited():
    session = FakeSession({
        "symbols": [
            {"symbol": "spy"},
            {"symbol": "SPY"},
            {"symbol": "BRK.B"},
            {"symbol": "bad symbol!"},
            {"symbol": "TSLA"},
        ]
    })
    client = StocktwitsClient(session=session)

    assert client.trending_symbols(limit=3) == ["SPY", "BRK.B", "TSLA"]
    assert client.status == "online — secondary discovery"
    assert session.urls[0].endswith("/trending/symbols.json")


def test_symbol_pulse_counts_recent_messages_and_tagged_sentiment():
    now = datetime(2026, 9, 15, 15, 0, tzinfo=timezone.utc)
    recent = (now - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    old = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    session = FakeSession({
        "messages": [
            {"created_at": recent, "entities": {"sentiment": {"basic": "Bullish"}}},
            {"created_at": recent, "entities": {"sentiment": {"basic": "Bearish"}}},
            {"created_at": recent, "entities": {"sentiment": None}},
            {"created_at": old, "entities": {"sentiment": {"basic": "Bullish"}}},
        ]
    })

    pulse = StocktwitsClient(session=session).symbol_pulse("SPY", now)

    assert pulse["stocktwits_message_count_1h"] == 3
    assert pulse["stocktwits_bullish_pct"] == 50.0
    assert pulse["stocktwits_bearish_pct"] == 50.0
    assert pulse["stocktwits_url"].endswith("/SPY")
    assert "never a catalyst" in pulse["stocktwits_role"]


def test_stocktwits_failure_keeps_alpaca_discovery_available():
    client = StocktwitsClient(
        session=FakeSession(error=requests.RequestException("unavailable"))
    )

    assert client.trending_symbols() == []
    assert client.status == "unavailable — Alpaca-only discovery"
