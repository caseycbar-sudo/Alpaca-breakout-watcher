from datetime import datetime, timezone

from src.config import Settings
from src.options_flow import OptionsVolumeMonitor


class FakeClient:
    def option_contracts(self, *args, **kwargs):
        return [
            {
                "symbol": "TEST261016C00010000",
                "type": "call",
                "strike_price": "10",
                "expiration_date": "2026-10-16",
                "open_interest": "100",
                "tradable": True,
            },
            {
                "symbol": "TEST261016P00010000",
                "type": "put",
                "strike_price": "10",
                "expiration_date": "2026-10-16",
                "open_interest": "50",
                "tradable": True,
            },
        ]

    def option_daily_bars(self, symbols, start):
        return {
            "TEST261016C00010000": [{"v": 300, "vw": 0.50}],
            "TEST261016P00010000": [{"v": 100, "vw": 0.40}],
        }


def test_options_monitor_aggregates_volume_open_interest_and_premium():
    monitor = OptionsVolumeMonitor(
        Settings(api_key="test", secret_key="test"), FakeClient()
    )
    monitor.refresh(
        {"TEST": 10.0}, datetime(2026, 9, 15, 19, 0, tzinfo=timezone.utc)
    )

    row = monitor.rows[0]
    assert monitor.status == "live"
    assert row["call_volume"] == 300
    assert row["put_volume"] == 100
    assert row["put_call_ratio"] == 1 / 3
    assert row["volume_oi"] == 400 / 150
    assert row["estimated_premium"] == 19_000
    assert row["busiest"]["symbol"] == "TEST261016C00010000"
    assert row["status"] == "CALL-HEAVY — CONTEXT ONLY"


def test_options_monitor_fails_softly_when_data_plan_rejects_request():
    class RejectedClient(FakeClient):
        def option_contracts(self, *args, **kwargs):
            raise RuntimeError("subscription does not permit options data")

    monitor = OptionsVolumeMonitor(
        Settings(api_key="test", secret_key="test"), RejectedClient()
    )
    monitor.refresh({"TEST": 10.0})

    assert monitor.status == "unavailable"
    assert "subscription" in monitor.error
    assert monitor.rows == []
