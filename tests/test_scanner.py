from datetime import datetime, timedelta, timezone

from src.scanner import completed_five_minute_bars, opening_breakout


def bar(timestamp, high, low, close, volume=100_000):
    return {
        "t": timestamp.isoformat().replace("+00:00", "Z"),
        "h": high,
        "l": low,
        "c": close,
        "v": volume,
    }


def test_excludes_incomplete_bar():
    now = datetime(2026, 9, 14, 15, 0, tzinfo=timezone.utc)
    rows = [
        bar(now - timedelta(minutes=10), 1, 1, 1),
        bar(now - timedelta(minutes=2), 1, 1, 1),
    ]
    assert len(completed_five_minute_bars(rows, now)) == 1


def test_second_bar_hold():
    now = datetime.now(timezone.utc)
    rows = [
        bar(now, 10.0, 9.8, 9.9),
        bar(now, 10.1, 9.9, 10.0),
        bar(now, 10.2, 10.0, 10.1),
        bar(now, 10.4, 10.25, 10.3),
        bar(now, 10.5, 10.25, 10.4),
    ]
    level, confirmation = opening_breakout(rows, 10.15)
    assert level == 10.2
    assert confirmation == "A — catalyst ORB second-bar hold"


def test_vwap_level_retest_takes_priority():
    now = datetime.now(timezone.utc)
    rows = [
        bar(now, 10.0, 9.8, 9.9),
        bar(now, 10.1, 9.9, 10.0),
        bar(now, 10.2, 10.0, 10.1),
        bar(now, 10.6, 10.25, 10.5),
        bar(now, 10.45, 10.19, 10.35),
    ]
    level, confirmation = opening_breakout(rows, 10.2)
    assert level == 10.2
    assert confirmation == "B — first VWAP/level retest"
