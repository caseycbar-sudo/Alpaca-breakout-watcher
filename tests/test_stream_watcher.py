from datetime import datetime, timedelta, timezone

from src.config import Settings
from src.stream_watcher import EarlyWarningEngine, StreamWatcher


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


def test_live_snapshot_exposes_recent_scanning_activity():
    watcher = StreamWatcher(settings())
    watcher.subscribed = {"TEST"}
    watcher.engine.prime("TEST", previous_close=9.80, bid=10.09, ask=10.10)
    watcher.engine.trade("TEST", 10.10, 100, datetime.now(timezone.utc))
    watcher.message_count = 1
    watcher.trade_count = 1
    watcher.record_event("Universe refreshed", "Scanning one symbol.")

    snapshot = watcher.live_snapshot()

    assert snapshot["health"]["orders_enabled"] is False
    assert snapshot["health"]["message_count"] == 1
    assert snapshot["symbols"][0]["symbol"] == "TEST"
    assert snapshot["events"][0]["title"] == "Universe refreshed"


def test_intelligence_labels_wide_spread_and_explains_rejection():
    watcher = StreamWatcher(settings())
    watcher.subscribed = {"WIDE"}
    watcher.engine.prime("WIDE", previous_close=9.80, bid=9.90, ask=10.20)
    watcher.engine.trade("WIDE", 10.10, 100, datetime.now(timezone.utc))

    row = watcher.live_snapshot()["symbols"][0]

    assert row["status"] == "BLOCKED — WIDE SPREAD"
    assert row["status_kind"] == "blocked"
    assert "exceeds" in row["reason"]
    assert row["score"] <= 39


def test_live_snapshot_includes_clickable_counter_details():
    watcher = StreamWatcher(settings())
    watcher.subscribed = {"TEST"}
    watcher.engine.prime(
        "TEST",
        previous_close=9.80,
        bid=10.09,
        ask=10.10,
        trigger=10.12,
        previous_volume=1_000_000,
        session_volume=500_000,
    )
    timestamp = datetime.now(timezone.utc)
    watcher.engine.trade("TEST", 10.10, 25, timestamp)
    watcher.message_count = 1
    watcher.trade_count = 1
    watcher.recent_messages.appendleft({
        "type": "Trade", "symbol": "TEST", "timestamp": timestamp.isoformat()
    })
    watcher.recent_trades.appendleft({
        "symbol": "TEST",
        "price": 10.10,
        "size": 25,
        "notional": 252.50,
        "timestamp": timestamp.isoformat(),
    })

    snapshot = watcher.live_snapshot()

    assert snapshot["universe"][0]["trigger"] == 10.12
    assert snapshot["messages"][0]["type"] == "Trade"
    assert snapshot["trades"][0]["notional"] == 252.50
    assert snapshot["symbols"][0]["rolling_vwap"] == 10.10


def test_dashboard_contains_all_three_drilldowns():
    from src.live_dashboard import PAGE

    assert 'data-view="universe"' in PAGE
    assert 'data-view="messages"' in PAGE
    assert 'data-view="trades"' in PAGE
    assert "Ranked intelligence scanner" in PAGE


def test_meaningful_activity_survives_restart(tmp_path):
    path = tmp_path / "stream-state.json"
    configured = Settings(
        api_key="test",
        secret_key="test",
        stream_state_path=str(path),
    )
    first = StreamWatcher(configured)
    first.record_event("Candidate blocked", "Spread exceeded the safety gate.")
    first._save_cooldowns()

    restarted = StreamWatcher(configured)

    assert restarted.recent_events[0]["title"] == "Candidate blocked"
    assert restarted.recent_events[0]["detail"] == "Spread exceeded the safety gate."
