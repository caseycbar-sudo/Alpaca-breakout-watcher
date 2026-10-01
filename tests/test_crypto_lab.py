from datetime import date, datetime, time, timedelta, timezone

from src.crypto_lab import CryptoLabConfig, build_payload, replay, verdict
from src.scanner import ET


def series(start_day: date, days: int, price_at):
    """Five-minute crypto bars around the clock; ``price_at(local_dt)`` sets each close."""
    rows = []
    moment = datetime.combine(start_day, time(0, 0), tzinfo=ET)
    end = moment + timedelta(days=days)
    prev = price_at(moment)
    while moment < end:
        close = price_at(moment)
        rows.append({
            "t": moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "o": prev, "h": max(prev, close) * 1.0005, "l": min(prev, close) * 0.9995, "c": close, "v": 50,
        })
        prev = close
        moment += timedelta(minutes=5)
    return rows


def ramp_day(target_day: date, rise_pct: float):
    """Flat at 100 until 9:00 ET on ``target_day``, then a steady climb of ``rise_pct`` per hour."""
    start = datetime.combine(target_day, time(9, 0), tzinfo=ET)

    def price(moment):
        if moment < start:
            return 100.0
        hours = (moment - start).total_seconds() / 3600
        return 100.0 * (1 + rise_pct / 100 * hours)
    return price


def test_breakout_entry_hits_target_on_a_later_hourly_run():
    day = date(2026, 9, 2)  # a Wednesday
    bars = {"BTC/USD": series(date(2026, 9, 1), 2, ramp_day(day, 3.0))}
    trades = replay(bars, CryptoLabConfig())
    assert len(trades) == 1
    trade = trades[0]
    assert trade["symbol"] == "BTC/USD"
    assert trade["run"] == "9:40 a.m."
    assert trade["exit_reason"] == "target"
    assert trade["return_pct"] > 9
    assert trade["r_multiple"] > 1.8


def test_open_position_is_closed_on_the_last_run():
    day = date(2026, 9, 2)
    # A slow climb never reaches +10% (or −5%), so the 3:40 p.m. run closes it.
    bars = {"ETH/USD": series(date(2026, 9, 1), 2, ramp_day(day, 1.2))}
    trades = replay(bars, CryptoLabConfig())
    assert len(trades) == 1
    # The 24-hour move is still under +1% at 9:40, so the first entry waits for 10:40.
    assert trades[0]["run"] == "10:40 a.m."
    assert trades[0]["exit_reason"] == "end of day"
    assert trades[0]["exit_time"].startswith("2026-09-02T15:40")


def test_no_entries_on_weekends_or_without_a_day_move():
    flat = {"SOL/USD": series(date(2026, 9, 1), 2, lambda m: 100.0)}
    assert replay(flat, CryptoLabConfig()) == []
    weekend = {"SOL/USD": series(date(2026, 9, 5), 2, ramp_day(date(2026, 9, 6), 3.0))}
    assert replay(weekend, CryptoLabConfig()) == []


def test_verdict_needs_unseen_trades_and_profit():
    few = {"trades": 5, "avg_r": 1.0, "profit_factor": 3.0}
    assert verdict(few, few)[0] == "too few"
    good = {"trades": 40, "avg_r": 0.3, "profit_factor": 1.5}
    bad = {"trades": 40, "avg_r": -0.2, "profit_factor": 0.7}
    assert verdict(good, good)[0] == "held up"
    assert verdict(good, bad)[0] == "no edge"


def test_payload_shape():
    day = date(2026, 9, 2)
    trades = replay({"BTC/USD": series(date(2026, 9, 1), 2, ramp_day(day, 3.0))}, CryptoLabConfig())
    payload = build_payload(datetime(2026, 9, 3, tzinfo=timezone.utc), CryptoLabConfig(), ["BTC/USD"],
                            trades, {"start": "2026-09-01", "end": "2026-09-02"}, [])
    assert payload["summary"]["all"]["trades"] == 1
    assert payload["by_symbol"][0]["symbol"] == "BTC/USD"
    assert payload["exit_reasons"]["target"] == 1
    assert "no orders" in payload["mode"]
