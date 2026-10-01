from datetime import date, datetime, time, timedelta, timezone

import pytest

from src.scanner import ET
from src.vbt_sweep import group_verdict, holds_up, rank, split_days, trade_stats


def test_trade_stats():
    stats = trade_stats([0.02, -0.01, 0.01, -0.01])
    assert stats["trades"] == 4
    assert stats["win_rate"] == 50.0
    assert stats["avg_return_pct"] == pytest.approx(0.25)
    assert stats["profit_factor"] == pytest.approx(1.5)
    assert trade_stats([])["profit_factor"] is None


def test_holds_up_needs_both_periods_and_enough_trades():
    good = trade_stats([0.02, -0.01] * 20)
    bad = trade_stats([0.01, -0.02] * 20)
    few = trade_stats([0.02, -0.01] * 5)
    assert holds_up(good, good)
    assert not holds_up(good, bad)
    assert not holds_up(bad, good)
    assert not holds_up(good, few)


def test_split_days_keeps_newest_days_unseen():
    days = [f"2026-09-{d:02d}" for d in range(1, 11)]
    train, test = split_days(days * 3)
    assert max(train) < min(test)
    assert len(train) == 7 and len(test) == 3


def test_rank_and_verdict():
    rows = [
        {"train": trade_stats([0.01] * 40), "test": trade_stats([0.01] * 25), "holds_up": True},
        {"train": trade_stats([-0.01] * 40), "test": trade_stats([0.01] * 25), "holds_up": False},
        {"train": trade_stats([0.05] * 3), "test": trade_stats([]), "holds_up": False},
    ]
    ranked = rank(rows)
    assert len(ranked) == 2 and ranked[0] is rows[0]
    assert "luck" in group_verdict(rows)
    assert "None of the" in group_verdict(rows[1:])


def _bars(start: date, days: int):
    rows, price = [], 100.0
    moment = datetime.combine(start, time(0, 0), tzinfo=ET)
    for k in range(days * 288):
        local = moment.astimezone(ET)
        # Each weekday morning the price climbs steadily, then drifts back down.
        if local.weekday() < 5 and 9 <= local.hour < 12:
            close = price * 1.002
        else:
            close = price * 0.9995 if price > 100 else price
        rows.append({"t": moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                     "o": price, "h": max(price, close), "l": min(price, close), "c": close, "v": 100})
        price = close
        moment += timedelta(minutes=5)
    return rows


def test_sweep_group_runs_with_vectorbt():
    pytest.importorskip("vectorbt")
    from src.vbt_sweep import LIVE_RULE, sweep_group

    result = sweep_group({"BTC/USD": _bars(date(2026, 8, 3), 21)}, "crypto", log=lambda *_: None)
    assert result["combinations"] == 48
    assert result["symbols"] == ["BTC/USD"]
    assert result["live_rule"]["stop_pct"] == LIVE_RULE["stop_pct"]
    assert result["train_days"] > result["test_days"] > 0
    total = result["live_rule"]["train"]["trades"] + result["live_rule"]["test"]["trades"]
    assert total > 0
