import json
import random
from datetime import date, datetime, time, timedelta, timezone

from src.backtest import (
    SETUP_A,
    SETUP_B,
    BacktestConfig,
    _prepare,
    find_events,
    market_mood_table,
    replay_portfolio,
    simulate_exit,
    summarize,
)
from src.backtest_lab import run
from src.config import Settings
from src.learning_model import auc, second_opinion
from src.pattern_miner import mine_patterns, split_dates
from src.scanner import ET


def stamp(day: date, hour: int, minute: int) -> str:
    local = datetime.combine(day, time(hour, minute), tzinfo=ET)
    return local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def bar(day, hour, minute, o, h, l, c, v=60_000):
    return {"t": stamp(day, hour, minute), "o": o, "h": h, "l": l, "c": c, "v": v}


def breakout_day(day: date, prior_close: float = 10.0, run_up: bool = True) -> list[dict]:
    """Gap up ~3%, 15-minute range, clean breakout and hold, then a trend or a fade."""
    rows = []
    price = prior_close * 1.03
    for k in range(20):  # quiet warm-up bars from 8:00 so RSI/ATR have history
        minute = 8 * 60 + k * 5
        rows.append(bar(day, minute // 60, minute % 60, price, price + 0.15, price - 0.15, price + (0.05 if k % 2 else -0.05), 5_000))
    opening = [(10.30, 10.36, 10.26, 10.33), (10.33, 10.38, 10.30, 10.35), (10.35, 10.40, 10.31, 10.37)]
    for idx, (o, h, l, c) in enumerate(opening):
        minute = 9 * 60 + 30 + idx * 5
        rows.append(bar(day, minute // 60, minute % 60, o, h, l, c, 90_000))
    level = 10.40
    price = 10.37
    breakout = [(10.37, 10.44, 10.36, 10.43), (10.43, 10.47, 10.42, 10.46), (10.46, 10.52, 10.45, 10.51)]
    for idx, (o, h, l, c) in enumerate(breakout):
        minute = 9 * 60 + 45 + idx * 5
        rows.append(bar(day, minute // 60, minute % 60, o, h, l, c, 80_000))
    price = 10.51
    minute = 10 * 60
    while minute < 16 * 60:
        step = 0.03 if run_up else -0.04
        o = price
        c = max(level - 0.5, price + step)
        rows.append(bar(day, minute // 60, minute % 60, o, max(o, c) + 0.02, min(o, c) - 0.02, c, 70_000))
        price = c
        minute += 5
    return rows


def daily_history(start: date, days: int, close: float = 10.0) -> list[dict]:
    rows = []
    current = start
    while len(rows) < days:
        if current.weekday() < 5:
            rows.append({"t": stamp(current, 0, 0), "o": close, "h": close, "l": close, "c": close, "v": 1_000_000})
        current += timedelta(days=1)
    return rows


def test_breakout_day_produces_strict_winner():
    day = date(2026, 9, 14)
    events = find_events(
        "TEST",
        breakout_day(day, run_up=True),
        daily_history(day - timedelta(days=45), 30),
        {},
        [{"created_at": stamp(day, 7, 0), "headline": "Test wins contract", "url": "https://example.com"}],
        Settings(),
        BacktestConfig(use_news=True),
    )
    assert events, "the breakout shape should be detected"
    first = events[0]
    assert first["setup"] in {SETUP_A, SETUP_B}
    assert first["catalyst"] == "yes"
    assert first["entry"] > first["stop"]
    assert first["target"] > first["entry"]
    strict_winners = [e for e in events if e["strict"] and e["win"]]
    assert strict_winners and strict_winners[0]["exit_reason"] == "target"
    assert abs(strict_winners[0]["r_multiple"] - 2.0) < 1e-6


def test_fading_day_loses_and_never_overlaps():
    day = date(2026, 9, 14)
    events = find_events(
        "FADE", breakout_day(day, run_up=False), daily_history(day - timedelta(days=45), 30),
        {}, None, Settings(), BacktestConfig(use_news=False),
    )
    learning = [e for e in events if e["learning"]]
    assert learning and learning[0]["exit_reason"] == "stop"
    assert learning[0]["r_multiple"] < 0
    for earlier, later in zip(learning, learning[1:]):
        assert later["entry_time"] >= earlier["exit_time"] or later["signal_time"] >= earlier["exit_time"]
    assert all(e["catalyst"] == "unknown" for e in events)


def test_risky_headline_blocks_strict_track():
    day = date(2026, 9, 14)
    events = find_events(
        "DIL", breakout_day(day), daily_history(day - timedelta(days=45), 30), {},
        [{"created_at": stamp(day, 7, 0), "headline": "DIL announces registered direct offering"}],
        Settings(), BacktestConfig(use_news=True),
    )
    assert events
    assert not any(e["strict"] for e in events)
    assert all("catalyst" in e["failed_gates"] for e in events)


def test_market_mood_matches_live_rules():
    day = date(2026, 9, 14)
    down = [bar(day, 9, 30 + 5 * k, 100 - k, 100.2 - k, 99.8 - k, 100 - k) for k in range(4)]
    up = [bar(day, 9, 30 + 5 * k, 100 + k, 100.2 + k, 99.8 + k, 100 + k) for k in range(4)]
    assert market_mood_table({"SPY": down, "QQQ": down})[day][-1][1] == "bearish"
    assert market_mood_table({"SPY": up, "QQQ": up})[day][-1][1] == "aligned"
    assert market_mood_table({"SPY": up, "QQQ": down})[day][-1][1] == "mixed"


def _prepared(rows):
    return _prepare(rows)


def test_same_bar_stop_and_target_counts_as_stop():
    day = date(2026, 9, 14)
    session = _prepared([bar(day, 10, 0, 10, 12, 8, 10)])
    result = simulate_exit(session, 0, entry=10.0, stop=9.5, target=11.0, cfg=BacktestConfig())
    assert result["reason"] == "stop"
    assert result["exit"] <= 9.5


def test_gap_through_stop_fills_at_open():
    day = date(2026, 9, 14)
    session = _prepared([
        bar(day, 10, 0, 10, 10.1, 9.95, 10.05),
        bar(day, 10, 5, 9.0, 9.1, 8.9, 9.0),
    ])
    result = simulate_exit(session, 0, entry=10.0, stop=9.5, target=11.0, cfg=BacktestConfig(spread_pct=0.0, slippage_rate=0.0))
    assert result["reason"] == "stop"
    assert result["exit"] == 9.0


def test_end_of_session_exit():
    day = date(2026, 9, 14)
    session = _prepared([bar(day, 15, 45, 10, 10.1, 9.9, 10), bar(day, 15, 50, 10, 10.1, 9.9, 10.05)])
    result = simulate_exit(session, 0, 10.0, 9.0, 12.0, BacktestConfig(spread_pct=0.0, slippage_rate=0.0))
    assert result["reason"] == "end of session"
    assert result["exit"] == 10.05


def _event(symbol, signal, exit_time, r, day="2026-09-14", strict=True):
    return {
        "symbol": symbol, "date": day, "signal_time": signal, "exit_time": exit_time,
        "entry_time": signal, "strict": strict, "learning": True, "score": 1.0,
        "entry": 10.0, "exit": 10.0 + r * 0.5, "r_multiple": r, "setup": SETUP_A,
    }


def test_portfolio_rules_cap_entries_and_losses():
    t = lambda h, m: f"2026-09-14T{h:02d}:{m:02d}:00-04:00"
    events = [
        _event("AAA", t(10, 0), t(10, 10), -1),
        _event("BBB", t(10, 15), t(10, 20), -1),
        _event("CCC", t(10, 30), t(10, 40), 2),  # blocked: two losses already
        _event("AAA", t(10, 5), t(10, 30), 1, strict=False),  # never strict
    ]
    taken = replay_portfolio(events)
    assert [x["symbol"] for x in taken] == ["AAA", "BBB"]
    assert all(x["size"] <= 10 for x in taken)

    events = [_event(s, t(10, i), t(15, 55), 1) for i, s in enumerate(["A", "B", "C", "D"])]
    assert len(replay_portfolio(events)) == 3


def test_summary_and_auc():
    stats = summarize([2, -1, -1, 2], [0.2, -0.1, -0.1, 0.2])
    assert stats["trades"] == 4 and stats["win_rate"] == 50.0
    assert stats["profit_factor"] == 2.0
    assert stats["max_drawdown"] == 0.2
    assert auc([0.9, 0.8, 0.2, 0.1], [True, True, False, False]) == 1.0
    assert auc([0.1, 0.2], [True, False]) == 0.0


def _random_events(n=400, seed=7, signal=True, noise=1.0, drift=0.0):
    rng = random.Random(seed)
    base = date(2026, 5, 1)
    events = []
    for i in range(n):
        day = base + timedelta(days=i // 5)
        rsi = rng.uniform(45, 85)
        edge = (0.6 if rsi < 65 else -0.4) if signal else drift
        r = max(-1.2, rng.gauss(edge, noise))
        events.append({
            "symbol": "SYN", "date": day.isoformat(), "learning": True, "strict": False,
            "setup": SETUP_A, "shape": SETUP_A, "premarket_leader": False,
            "time_bucket": rng.choice(["9:30–10:30", "10:30–11:30", "11:30–2:00 (midday)", "2:00–3:30"]),
            "rsi": rsi, "relative_volume": rng.uniform(0.5, 8), "day_move_pct": rng.uniform(-3, 18),
            "gap_pct": rng.uniform(-3, 10), "five_minute_move_pct": rng.uniform(-0.5, 2.5),
            "vwap_distance_atr": rng.uniform(-0.2, 2.5), "risk_pct": rng.uniform(0.3, 5),
            "dollar_volume": rng.uniform(5e4, 8e6), "price": rng.uniform(1, 90),
            "market_mood": rng.choice(["aligned", "mixed", "bearish"]),
            "catalyst": rng.choice(["yes", "no"]), "weekday": rng.choice(["Mon", "Tue", "Wed", "Thu", "Fri"]),
            "minutes_after_open": rng.uniform(20, 350),
            "failed_gates": ["RSI"] if rsi > 78 else [], "r_multiple": r, "win": r > 0,
        })
    return events


def test_pattern_miner_finds_planted_pattern_and_checks_unseen_days():
    events = _random_events()
    result = mine_patterns(events)
    assert result["train_days"] > result["test_days"] > 0
    promising = {p["pattern"] for p in result["promising"]}
    avoid = {p["pattern"] for p in result["avoid"]}
    assert any("5-min RSI: 55–65" in p for p in promising)
    assert any("72–78" in p or "over 78" in p for p in avoid)


def test_pattern_miner_stays_quiet_on_noise():
    false_alarms = 0
    for seed in range(12):
        for drift in (0.0, -0.1):
            result = mine_patterns(_random_events(n=1500, signal=False, seed=seed, drift=drift))
            false_alarms += len(result["promising"]) + len(result["avoid"])
    assert false_alarms <= 3  # across 24 noise-only runs with ~400 patterns each


def test_model_second_opinion():
    events = _random_events(n=600, noise=0.6)
    train, test = split_dates(events)
    opinion = second_opinion(events, train, test)
    assert opinion["status"] in {"useful", "faint"}
    assert opinion["test_auc"] > 0.55
    assert any(f["factor"] == "5-min RSI" and f["weight"] < 0 for f in opinion["factors"])
    assert second_opinion(events[:10], train, test)["status"] == "waiting"


class FakeClient:
    """Serves synthetic history through the same read-only paths as Alpaca."""

    def __init__(self, days=40):
        self.settings = Settings()
        self.calls = []
        start = date(2026, 7, 1)
        self.five = {"SPY": [], "QQQ": [], "WIN": [], "LOSE": []}
        self.daily = {"WIN": [], "LOSE": []}
        current = start
        count = 0
        rng = random.Random(3)
        while count < days:
            if current.weekday() < 5:
                count += 1
                self.five["WIN"] += breakout_day(current, run_up=rng.random() < 0.7)
                self.five["LOSE"] += breakout_day(current, run_up=rng.random() < 0.2)
                for sym in ("SPY", "QQQ"):
                    for k in range(78):
                        minute = 9 * 60 + 30 + 5 * k
                        p = 500 + k * 0.1
                        self.five[sym].append(bar(current, minute // 60, minute % 60, p, p + 0.1, p - 0.1, p + 0.05))
                for sym in self.daily:
                    self.daily[sym].append({"t": stamp(current, 0, 0), "o": 10, "h": 10, "l": 10, "c": 10.0, "v": 1_000_000})
            current += timedelta(days=1)

    def _get(self, base, path, params):
        self.calls.append(path)
        assert "order" not in path
        if path == "/v2/calendar":
            self.calendar_calls = getattr(self, "calendar_calls", 0) + 1
            rows, current = [], date.fromisoformat(params["start"])
            while current <= date.fromisoformat(params["end"]):
                if current.weekday() < 5:
                    rows.append({"date": current.isoformat(), "open": "09:30", "close": "16:00"})
                current += timedelta(days=1)
            return rows
        if path == "/v2/stocks/bars":
            assert params["adjustment"] == "raw" or (params["adjustment"] == "split" and params["timeframe"] == "1Day")
            source = self.five if params["timeframe"] == "5Min" else self.daily
            return {"bars": {s: source.get(s, []) for s in params["symbols"].split(",")}}
        if path == "/v1beta1/news":
            return {"news": []}
        if path.endswith("most-actives"):
            return {"most_actives": [{"symbol": "WIN"}, {"symbol": "LOSE"}]}
        raise AssertionError(path)


def test_end_to_end_run_with_fake_data(tmp_path):
    client = FakeClient()
    payload, events, portfolio, history = run(
        Settings(), client, BacktestConfig(lookback_days=90), symbols=["WIN", "LOSE"],
        now=datetime(2026, 9, 1, tzinfo=timezone.utc), history_path=tmp_path / "h.json", log=lambda *_: None,
    )
    json.dumps(payload)  # must be serializable
    tickers = {row["symbol"]: row for row in payload["tickers"]}
    assert tickers["WIN"]["learning"]["avg_r"] > tickers["LOSE"]["learning"]["avg_r"]
    assert payload["summary"]["learning"]["trades"] == len([e for e in events if e["learning"]])
    assert payload["model"]["status"] in {"useful", "faint", "no edge", "waiting"}
    assert "_model" not in payload["model"]
    assert len(history) == 1
    # No catalyst in the fake archive, so the strict track stays empty.
    assert payload["summary"]["portfolio"]["trades"] == 0 == len(portfolio)


def test_early_close_day_uses_calendar():
    day = date(2026, 11, 27)  # day after Thanksgiving: 1:00 p.m. close
    rows = breakout_day(day, run_up=True)
    events = find_events(
        "HALF", rows, daily_history(day - timedelta(days=45), 30), {}, None, Settings(),
        BacktestConfig(use_news=False), session_closes={day: 13 * 60},
    )
    assert events
    for event in events:
        assert event["signal_time"][11:16] < "12:30"
        assert event["exit_time"][11:16] <= "12:55"
    assert find_events(
        "HALF", rows, daily_history(day - timedelta(days=45), 30), {}, None, Settings(),
        BacktestConfig(use_news=False), session_closes={day + timedelta(days=3): 960},
    ) == []


def test_split_sized_gap_and_data_gaps_are_skipped():
    day = date(2026, 9, 14)
    daily = daily_history(day - timedelta(days=45), 30, close=0.2)  # e.g. before a 1:50 reverse split
    assert find_events("RS", breakout_day(day), daily, {}, None, Settings(), BacktestConfig(use_news=False)) == []
    rows = [r for r in breakout_day(day) if not r["t"].startswith(stamp(day, 9, 55)[:16])]
    events = find_events("GAP", rows, daily_history(day - timedelta(days=45), 30), {}, None, Settings(), BacktestConfig(use_news=False))
    assert all(e["signal_time"][11:16] != "09:55" for e in events)


def test_partial_news_coverage_marks_older_signals_unknown():
    day = date(2026, 9, 14)
    covered = datetime.combine(day, time(12, 0), tzinfo=ET).astimezone(timezone.utc)
    news = {"articles": [{"created_at": stamp(day, 7, 0), "headline": "Deal", "url": ""}], "covered_from": covered}
    events = find_events("BUSY", breakout_day(day), daily_history(day - timedelta(days=45), 30), {}, news, Settings(), BacktestConfig(use_news=True))
    assert events and all(e["catalyst"] == "unknown" and not e["strict"] for e in events)


def test_bad_ticker_does_not_stop_the_run(tmp_path):
    import requests
    from src.backtest import fetch_bars

    class Picky(FakeClient):
        def _get(self, base, path, params):
            if path == "/v2/stocks/bars" and "BAD" in params["symbols"].split(","):
                response = requests.Response()
                response.status_code = 400
                raise requests.HTTPError("invalid symbol", response=response)
            return super()._get(base, path, params)

    errors = []
    start = datetime(2026, 6, 1, tzinfo=timezone.utc)
    bars = fetch_bars(Picky(days=3), ["WIN", "BAD"], "5Min", start, start + timedelta(days=30), errors=errors)
    assert bars["WIN"] and not bars["BAD"]
    assert any(e.startswith("BAD:") for e in errors)


def test_two_for_one_split_day_is_skipped_and_volume_is_rescaled():
    day = date(2026, 9, 14)
    before = daily_history(day - timedelta(days=45), 30, close=20.0)   # raw, pre-split
    adjusted = [dict(r, c=10.0, v=r["v"] * 2) for r in before]         # split-adjusted
    today_raw = {"t": stamp(day, 0, 0), "o": 10, "h": 10, "l": 10, "c": 10.4, "v": 900_000}
    today_adj = dict(today_raw)
    rows = breakout_day(day)
    cfg = BacktestConfig(use_news=False)
    # Without split data the day looks like a -48% crash; with it, the day is skipped.
    assert find_events("SPL", rows, before + [today_raw], {}, None, Settings(), cfg, None, adjusted + [today_adj]) == []

    # The day after a split: raw prior close is post-split, and the average volume is
    # expressed in post-split shares (2,000,000), so relative volume is not doubled.
    nxt = day + timedelta(days=1)
    raw_days = before + [today_raw, {"t": stamp(nxt, 0, 0), "o": 10, "h": 10, "l": 10, "c": 10.4, "v": 900_000}]
    adj_days = adjusted + [today_adj, dict(raw_days[-1])]
    events = find_events("SPL", breakout_day(nxt, prior_close=10.0), raw_days, {}, None, Settings(), cfg, None, adj_days)
    unsplit = find_events(
        "SPL", breakout_day(nxt, prior_close=10.0),
        [dict(r, c=10.0, v=2_000_000) for r in before] + raw_days[-2:], {}, None, Settings(), cfg,
    )
    assert events and [e["relative_volume"] for e in events] == [e["relative_volume"] for e in unsplit]

