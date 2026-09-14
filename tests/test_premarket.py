from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from src.premarket import is_premarket_session, roster_event

ET = ZoneInfo("America/New_York")


def test_premarket_session_requires_todays_open():
    now = datetime(2026, 9, 14, 6, 0, tzinfo=ET)
    clock = {"next_open": "2026-09-14T09:30:00-04:00"}
    assert is_premarket_session(clock, now)


def test_premarket_session_rejects_wrong_open_date():
    now = datetime(2026, 9, 14, 6, 0, tzinfo=ET)
    clock = {"next_open": "2026-09-15T09:30:00-04:00"}
    assert not is_premarket_session(clock, now)


def test_roster_event_is_deduplicated(tmp_path: Path):
    now = datetime(2026, 9, 14, 6, 0, tzinfo=ET)
    path = tmp_path / "state.json"
    candidate = {
        "symbol": "TEST",
        "stage": "watching below trigger",
        "breakout_level": 10.5,
        "price": 10.25,
        "day_move_pct": 4.0,
        "bid": 10.24,
        "ask": 10.25,
        "spread_pct": 0.098,
        "premarket_volume": 250000,
        "relative_volume": 2.1,
        "five_minute_volume": 60000,
        "vwap": 10.1,
        "rsi": 64.0,
        "five_minute_move_pct": 2.4,
        "news_time": "2026-09-14T09:00:00Z",
        "news_headline": "Verified test catalyst",
        "news_url": "https://example.com",
    }
    assert roster_event([candidate], now, path)
    assert roster_event([candidate], now, path) is None
