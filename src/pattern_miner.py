"""Find which conditions historically helped or hurt the A/B/C setups.

Every learning-track trade is sorted into buckets (time of day, RSI band, RVOL
band, …). Each bucket is scored on the **older** part of the history
("learning days") and then checked on the **newest** days it never saw
("check days"). A bucket is only called *promising* or *avoid* when both periods
agree and there are enough trades — otherwise it is reported as *not proven*.

Results are measured in R: +1R means the trade made as much as it risked,
−1R means the stop was hit. That keeps $1 stocks and $90 stocks comparable.
"""

from __future__ import annotations

import math
from itertools import combinations
from typing import Callable

MIN_TRAIN_TRADES = 20
MIN_TEST_TRADES = 10
MIN_COMBO_TRAIN_TRADES = 30
# Hundreds of buckets are tested at once, so a pattern must stand clearly apart from
# the average trade (not just from zero) on the learning days AND on the check days.
TRAIN_T = 2.5
COMBO_TRAIN_T = 3.0
TEST_T = 1.5


def _band(value: float, edges: list[float], labels: list[str]) -> str:
    for edge, label in zip(edges, labels):
        if value < edge:
            return label
    return labels[-1]


FEATURES: dict[str, tuple[str, Callable[[dict], str]]] = {
    "setup": ("Setup", lambda e: e["setup"]),
    "time_bucket": ("Time of day (ET)", lambda e: e["time_bucket"]),
    "rsi": ("5-min RSI", lambda e: _band(e["rsi"], [52, 55, 65, 72, 78], ["under 52", "52–55", "55–65", "65–72", "72–78", "over 78"])),
    "relative_volume": ("Relative volume", lambda e: _band(e["relative_volume"], [1.0, 1.5, 3, 6], ["under 1x", "1–1.5x", "1.5–3x", "3–6x", "6x+"])),
    "day_move": ("Move vs. prior close", lambda e: _band(e["day_move_pct"], [0, 2, 4, 8, 15], ["down", "0–2%", "2–4%", "4–8%", "8–15%", "15%+"])),
    "gap": ("Opening gap", lambda e: _band(e["gap_pct"], [-1, 1, 3, 8], ["gap down", "flat (±1%)", "gap up 1–3%", "gap up 3–8%", "gap up 8%+"])),
    "five_minute_move": ("Signal-bar move", lambda e: _band(e["five_minute_move_pct"], [0, 0.4, 1, 2], ["red bar", "0–0.4%", "0.4–1%", "1–2%", "2%+"])),
    "vwap_distance": ("Distance above VWAP", lambda e: _band(e["vwap_distance_atr"], [0, 0.5, 1, 2], ["below VWAP", "0–0.5 ATR", "0.5–1 ATR", "1–2 ATR", "2+ ATR"])),
    "risk": ("Stop distance", lambda e: _band(e["risk_pct"], [0.5, 1, 2, 4], ["under 0.5%", "0.5–1%", "1–2%", "2–4%", "4%+"])),
    "liquidity": ("Signal-bar dollar volume", lambda e: _band(e["dollar_volume"], [100_000, 250_000, 1_000_000, 5_000_000], ["under $100k", "$100k–250k", "$250k–1M", "$1M–5M", "$5M+"])),
    "price": ("Share price", lambda e: _band(e["price"], [2, 5, 20, 50, 100], ["under $2", "$2–5", "$5–20", "$20–50", "$50–100", "over $100"])),
    "market_mood": ("SPY/QQQ mood", lambda e: e["market_mood"]),
    "catalyst": ("News catalyst (24h)", lambda e: e["catalyst"]),
    "weekday": ("Weekday", lambda e: e["weekday"]),
}

COMBO_FEATURES = ("setup", "time_bucket", "rsi", "relative_volume", "vwap_distance", "market_mood", "catalyst", "gap")


def split_dates(events: list[dict], train_fraction: float = 0.70) -> tuple[set[str], set[str]]:
    days = sorted({e["date"] for e in events})
    if len(days) < 5:
        return set(days), set()
    cut = max(1, min(len(days) - 1, int(round(len(days) * train_fraction))))
    return set(days[:cut]), set(days[cut:])


def _stats(values: list[float], baseline: float = 0.0) -> dict:
    """Summary plus ``t``: how many standard errors the average sits above ``baseline``."""
    n = len(values)
    if not n:
        return {"n": 0, "avg_r": 0.0, "win_rate": 0.0, "total_r": 0.0, "t": 0.0, "std": 0.0}
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / (n - 1) if n > 1 else 0.0
    std = math.sqrt(variance)
    t_stat = (mean - baseline) / (std / math.sqrt(n)) if std > 0 else 0.0
    return {
        "n": n,
        "avg_r": round(mean, 4),
        "win_rate": round(sum(v > 0 for v in values) / n * 100, 1),
        "total_r": round(sum(values), 3),
        "t": round(t_stat, 2),
        "std": round(std, 4),
    }


def _verdict(train: dict, test: dict, min_train: int, train_t: float = TRAIN_T) -> str:
    if train["n"] < min_train or test["n"] < MIN_TEST_TRADES:
        return "not proven"
    if train["t"] >= train_t and test["t"] >= TEST_T and train["avg_r"] > 0 and test["avg_r"] > 0:
        return "promising"
    if train["t"] <= -train_t and test["t"] <= -TEST_T and test["avg_r"] < 0:
        return "avoid"
    return "mixed"


def _evidence(train: dict, test: dict, verdict: str, train_t: float = TRAIN_T) -> str:
    if verdict == "not proven":
        return "not enough trades"
    if verdict not in {"promising", "avoid"}:
        return "weak"
    if abs(train["t"]) >= train_t + 1.0 and abs(test["t"]) >= TEST_T + 1.0:
        return "strong"
    return "moderate"


def _describe(label: str, value: str) -> str:
    return f"{label}: {value}"


def mine_patterns(events: list[dict], train_fraction: float = 0.70) -> dict:
    learning = [e for e in events if e.get("learning")]
    train_days, test_days = split_dates(learning, train_fraction)
    train = [e for e in learning if e["date"] in train_days]
    test = [e for e in learning if e["date"] in test_days]
    baseline_train = _stats([e["r_multiple"] for e in train])
    baseline_test = _stats([e["r_multiple"] for e in test])
    base_train, base_test = baseline_train["avg_r"], baseline_test["avg_r"]

    buckets: list[dict] = []
    for key, (label, fn) in FEATURES.items():
        values: dict[str, dict[str, list[float]]] = {}
        for group, rows in (("train", train), ("test", test)):
            for event in rows:
                bucket = fn(event)
                values.setdefault(bucket, {"train": [], "test": []})[group].append(event["r_multiple"])
        for bucket, groups in values.items():
            s_train, s_test = _stats(groups["train"], base_train), _stats(groups["test"], base_test)
            verdict = _verdict(s_train, s_test, MIN_TRAIN_TRADES)
            if bucket == "unknown" and verdict in {"promising", "avoid"}:
                verdict = "mixed"  # "unknown" reflects data coverage, not the market
            buckets.append({
                "feature": key,
                "feature_label": label,
                "bucket": bucket,
                "pattern": _describe(label, bucket),
                "train": s_train,
                "test": s_test,
                "verdict": verdict,
                "evidence": _evidence(s_train, s_test, verdict),
            })

    combos: list[dict] = []
    combos_tested = 0
    keyed = {k: FEATURES[k] for k in COMBO_FEATURES}
    for first, second in combinations(COMBO_FEATURES, 2):
        (label_a, fn_a), (label_b, fn_b) = keyed[first], keyed[second]
        values: dict[tuple[str, str], dict[str, list[float]]] = {}
        for group, rows in (("train", train), ("test", test)):
            for event in rows:
                bucket = (fn_a(event), fn_b(event))
                values.setdefault(bucket, {"train": [], "test": []})[group].append(event["r_multiple"])
        for (a, b), groups in values.items():
            s_train = _stats(groups["train"], base_train)
            if s_train["n"] < MIN_COMBO_TRAIN_TRADES:
                continue
            combos_tested += 1
            s_test = _stats(groups["test"], base_test)
            verdict = _verdict(s_train, s_test, MIN_COMBO_TRAIN_TRADES, COMBO_TRAIN_T)
            if verdict not in {"promising", "avoid"} or "unknown" in (a, b):
                continue
            combos.append({
                "feature": f"{first}+{second}",
                "pattern": f"{_describe(label_a, a)} + {_describe(label_b, b)}",
                "train": s_train,
                "test": s_test,
                "verdict": verdict,
                "evidence": _evidence(s_train, s_test, verdict, COMBO_TRAIN_T),
            })

    def rank(rows: list[dict], verdict: str) -> list[dict]:
        chosen = [r for r in rows if r["verdict"] == verdict]
        sign = 1 if verdict == "promising" else -1
        return sorted(chosen, key=lambda r: sign * (r["train"]["t"] + r["test"]["t"]), reverse=True)

    # Which live gates earn their keep? Compare trades that passed vs failed each gate.
    gate_names = sorted({g for e in learning for g in e.get("failed_gates", [])})
    gate_review = []
    for gate in gate_names:
        failed = [e["r_multiple"] for e in learning if gate in e["failed_gates"]]
        passed = [e["r_multiple"] for e in learning if gate not in e["failed_gates"]]
        s_failed, s_passed = _stats(failed), _stats(passed)
        difference = s_passed["avg_r"] - s_failed["avg_r"]
        standard_error = math.sqrt(
            (s_passed["std"] ** 2 / max(1, s_passed["n"])) + (s_failed["std"] ** 2 / max(1, s_failed["n"]))
        )
        welch_t = difference / standard_error if standard_error > 0 else 0.0
        if s_failed["n"] < MIN_TEST_TRADES or s_passed["n"] < MIN_TEST_TRADES:
            verdict = "too few"
        elif difference >= 0.1 and welch_t >= 2.0:
            verdict = "helping"
        elif difference <= -0.1 and welch_t <= -2.0:
            verdict = "not helping"
        else:
            verdict = "unclear"
        gate_review.append({"gate": gate, "passed": s_passed, "failed": s_failed, "verdict": verdict})

    tested_count = len(buckets) + combos_tested
    return {
        "train_days": len(train_days),
        "test_days": len(test_days),
        "train_range": [min(train_days), max(train_days)] if train_days else None,
        "test_range": [min(test_days), max(test_days)] if test_days else None,
        "baseline": {"train": baseline_train, "test": baseline_test},
        "promising": (rank(buckets, "promising") + rank(combos, "promising"))[:12],
        "avoid": (rank(buckets, "avoid") + rank(combos, "avoid"))[:12],
        "buckets": buckets,
        "gate_review": gate_review,
        "patterns_tested": tested_count,
        "min_trades": {"learning": MIN_TRAIN_TRADES, "check": MIN_TEST_TRADES, "combo": MIN_COMBO_TRAIN_TRADES},
    }

