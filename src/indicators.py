from __future__ import annotations


def rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    changes = [b - a for a, b in zip(closes, closes[1:])]
    seed = changes[-period:]
    avg_gain = sum(max(x, 0.0) for x in seed) / period
    avg_loss = sum(max(-x, 0.0) for x in seed) / period
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    return 100.0 - (100.0 / (1.0 + avg_gain / avg_loss))


def vwap(bars: list[dict]) -> float | None:
    volume = sum(float(bar.get("v", 0)) for bar in bars)
    if volume <= 0:
        return None
    value = 0.0
    for bar in bars:
        typical = (float(bar["h"]) + float(bar["l"]) + float(bar["c"])) / 3
        value += typical * float(bar.get("v", 0))
    return value / volume


def spread_pct(bid: float, ask: float) -> float | None:
    if bid <= 0 or ask <= 0 or ask < bid:
        return None
    midpoint = (bid + ask) / 2
    return ((ask - bid) / midpoint) * 100 if midpoint else None


def five_minute_move_pct(bars: list[dict]) -> float | None:
    if len(bars) < 2 or float(bars[-2]["c"]) <= 0:
        return None
    return (float(bars[-1]["c"]) / float(bars[-2]["c"]) - 1) * 100


def relative_volume(
    cumulative_volume: float,
    average_daily_volume: float,
    elapsed_regular_minutes: float,
) -> float | None:
    if average_daily_volume <= 0 or elapsed_regular_minutes <= 0:
        return None
    expected = average_daily_volume * min(elapsed_regular_minutes, 390.0) / 390.0
    return cumulative_volume / expected if expected else None
