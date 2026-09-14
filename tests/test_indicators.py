import pytest

from src.indicators import (
    five_minute_move_pct,
    relative_volume,
    rsi,
    spread_pct,
    vwap,
)


def test_spread_pct():
    assert spread_pct(9.99, 10.01) == pytest.approx(0.2)


def test_vwap():
    bars = [
        {"h": 10, "l": 9, "c": 9.5, "v": 100},
        {"h": 11, "l": 10, "c": 10.5, "v": 100},
    ]
    assert vwap(bars) == pytest.approx(10.0)


def test_rsi_rising_is_overbought():
    assert rsi([float(value) for value in range(1, 17)]) == 100.0


def test_five_minute_move():
    assert five_minute_move_pct([{"c": 10}, {"c": 10.5}]) == pytest.approx(5.0)


def test_time_adjusted_relative_volume():
    assert relative_volume(100_000, 390_000, 60) == pytest.approx(100_000 / 60_000)
