from datetime import datetime, timedelta, timezone

from src.config import Settings
from src.stream_watcher import EarlyWarningEngine


def settings() -> Settings:
    return Settings(
        api_key="test",
        secret_key="test",
        stream_min_trade_count=4,
        stream_min_rolling_dollar_volume=1_000,
        stream_min_15s_move_pct=0.25,
        stream_max_15s_move_pct=2.5,
        stream_cooldown_seconds=600,
    )


def build_signal(engine: EarlyWarningEngine, trigger: float | None = None):
    now = datetime(2026, 9, 15, 14, 30, tzinfo=timezone.utc)
    engine.prime("TEST", previous_close=9.80, bid=10.09, ask=10.10, trigger=trigger)
    result = None
    for seconds, price, size in [
        (12, 10.05, 100),
        (9, 10.06, 100),
        (6, 10.07, 100),
        (0, 10.10, 100),
    ]:
        result = engine.trade("TEST", price, size, now - timedelta(seconds=seconds))
    return result


def test_early_signal_requires_fast_liquid_move():
    result = build_signal(EarlyWarningEngine(settings()))
    assert result is not None
    assert result["stage"] == "EARLY MOMENTUM — VERIFYING"
    assert result["rolling_dollar_volume"] > 1_000


def test_roster_trigger_creates_approaching_stage():
    result = build_signal(EarlyWarningEngine(settings()), trigger=10.12)
    assert result is not None
    assert result["stage"] == "APPROACHING TRIGGER — NOT YET CONFIRMED"


def test_cooldown_suppresses_duplicate_signal():
    engine = EarlyWarningEngine(settings())
    assert build_signal(engine) is not None
    assert build_signal(engine) is None


def test_wide_spread_is_rejected():
    engine = EarlyWarningEngine(settings())
    engine.prime("TEST", previous_close=9.80, bid=9.90, ask=10.20)
    now = datetime(2026, 9, 15, 14, 30, tzinfo=timezone.utc)
    result = None
    for seconds, price in [(12, 10.05), (9, 10.06), (6, 10.07), (0, 10.10)]:
        result = engine.trade("TEST", price, 100, now - timedelta(seconds=seconds))
    assert result is None
