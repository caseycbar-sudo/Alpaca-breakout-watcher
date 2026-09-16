"""A small, explainable "second opinion" model.

Plain logistic regression (no extra libraries) that tries to predict whether a
learning-track trade finished green. It is trained on the older days and graded
on the newest days only. If it cannot beat a coin flip on those unseen days, the
report says so plainly — that is a useful answer, not a failure.
"""

from __future__ import annotations

import math

NUMERIC = {
    "rsi": "5-min RSI",
    "log_rvol": "Relative volume",
    "day_move_pct": "Move vs. prior close",
    "gap_pct": "Opening gap",
    "five_minute_move_pct": "Signal-bar move",
    "vwap_distance_atr": "Distance above VWAP",
    "risk_pct": "Stop distance",
    "log_dollar_volume": "Signal-bar dollar volume",
    "minutes_after_open": "Minutes after the open",
    "log_price": "Share price",
}
FLAGS = {
    "setup_b": ("Setup B (VWAP/level retest)", lambda e: e["shape"].startswith("B")),
    "setup_c": ("Setup C (premarket leader)", lambda e: bool(e.get("premarket_leader"))),
    "market_aligned": ("SPY/QQQ aligned", lambda e: e["market_mood"] == "aligned"),
    "market_bearish": ("SPY/QQQ bearish", lambda e: e["market_mood"] == "bearish"),
    "catalyst": ("Fresh news catalyst", lambda e: e["catalyst"] == "yes"),
}


def _raw_numeric(event: dict) -> dict[str, float]:
    return {
        "rsi": float(event["rsi"]),
        "log_rvol": math.log(max(float(event["relative_volume"]), 0.01)),
        "day_move_pct": max(-30.0, min(30.0, float(event["day_move_pct"]))),
        "gap_pct": max(-30.0, min(30.0, float(event["gap_pct"]))),
        "five_minute_move_pct": max(-10.0, min(10.0, float(event["five_minute_move_pct"]))),
        "vwap_distance_atr": max(-5.0, min(5.0, float(event["vwap_distance_atr"]))),
        "risk_pct": min(15.0, float(event["risk_pct"])),
        "log_dollar_volume": math.log10(max(float(event["dollar_volume"]), 1.0)),
        "minutes_after_open": float(event["minutes_after_open"]),
        "log_price": math.log10(max(float(event["price"]), 0.01)),
    }


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exp = math.exp(value)
    return exp / (1.0 + exp)


def auc(scores: list[float], labels: list[bool]) -> float | None:
    positives = sum(labels)
    negatives = len(labels) - positives
    if not positives or not negatives:
        return None
    ranked = sorted(zip(scores, labels), key=lambda pair: pair[0])
    rank_sum = 0.0
    index = 0
    while index < len(ranked):
        end = index
        while end + 1 < len(ranked) and ranked[end + 1][0] == ranked[index][0]:
            end += 1
        average_rank = (index + end) / 2 + 1
        rank_sum += average_rank * sum(1 for k in range(index, end + 1) if ranked[k][1])
        index = end + 1
    return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


class ExplainableModel:
    def __init__(self, l2: float = 0.05, epochs: int = 400, rate: float = 0.2, use_catalyst: bool = True):
        self.l2, self.epochs, self.rate = l2, epochs, rate
        self.flags = {k: v for k, v in FLAGS.items() if use_catalyst or k != "catalyst"}
        self.means: dict[str, float] = {}
        self.stds: dict[str, float] = {}
        self.weights: dict[str, float] = {}
        self.bias = 0.0

    def _vector(self, event: dict) -> dict[str, float]:
        raw = _raw_numeric(event)
        vector = {k: (raw[k] - self.means[k]) / self.stds[k] for k in NUMERIC}
        for key, (_, fn) in self.flags.items():
            vector[key] = 1.0 if fn(event) else 0.0
        return vector

    def fit(self, events: list[dict]) -> "ExplainableModel":
        raws = [_raw_numeric(e) for e in events]
        for key in NUMERIC:
            values = [r[key] for r in raws]
            mean = sum(values) / len(values)
            std = math.sqrt(sum((v - mean) ** 2 for v in values) / max(1, len(values) - 1))
            self.means[key], self.stds[key] = mean, std or 1.0
        rows = [(self._vector(e), 1.0 if e["win"] else 0.0) for e in events]
        keys = list(NUMERIC) + list(self.flags)
        self.weights = {k: 0.0 for k in keys}
        base_rate = sum(y for _, y in rows) / len(rows)
        base_rate = min(0.99, max(0.01, base_rate))
        self.bias = math.log(base_rate / (1 - base_rate))
        n = len(rows)
        for _ in range(self.epochs):
            gradient = {k: 0.0 for k in keys}
            bias_gradient = 0.0
            for vector, label in rows:
                error = _sigmoid(self.bias + sum(self.weights[k] * vector[k] for k in keys)) - label
                bias_gradient += error
                for k in keys:
                    gradient[k] += error * vector[k]
            self.bias -= self.rate * bias_gradient / n
            for k in keys:
                self.weights[k] -= self.rate * (gradient[k] / n + self.l2 * self.weights[k])
        return self

    def score(self, event: dict) -> float:
        vector = self._vector(event)
        return _sigmoid(self.bias + sum(self.weights[k] * vector[k] for k in self.weights))

    def explain(self, limit: int = 8) -> list[dict]:
        labels = {**NUMERIC, **{k: v[0] for k, v in FLAGS.items()}}
        rows = []
        for key, weight in sorted(self.weights.items(), key=lambda kv: abs(kv[1]), reverse=True)[:limit]:
            if abs(weight) < 0.02:
                continue
            numeric = key in NUMERIC
            direction = "higher" if weight > 0 else "lower"
            text = (
                f"{direction.capitalize()} {labels[key][0].lower() + labels[key][1:]} → more winners"
                if numeric
                else f"{labels[key]} → {'more' if weight > 0 else 'fewer'} winners"
            )
            rows.append({"factor": labels[key], "weight": round(weight, 3), "effect": text})
        return rows


def second_opinion(events: list[dict], train_days: set[str], test_days: set[str]) -> dict:
    learning = [e for e in events if e.get("learning")]
    # Busy tickers can have "unknown" news on older days only, which would tie the
    # catalyst factor to the calendar. Use known-news trades when there are enough.
    known = [e for e in learning if e.get("catalyst") != "unknown"]
    use_catalyst = bool(known) and len(known) >= 0.6 * len(learning)
    if use_catalyst:
        learning = known
    train = [e for e in learning if e["date"] in train_days]
    test = [e for e in learning if e["date"] in test_days]
    if len(train) < 40 or len(test) < 15 or len({e["win"] for e in train}) < 2:
        return {
            "status": "waiting",
            "verdict": "Not enough history yet — the model needs at least 40 learning trades "
            "and 15 check trades before it can give an honest opinion.",
            "train_trades": len(train),
            "test_trades": len(test),
        }
    model = ExplainableModel(use_catalyst=use_catalyst).fit(train)
    train_scores = [model.score(e) for e in train]
    test_scores = [model.score(e) for e in test]
    train_auc = auc(train_scores, [e["win"] for e in train])
    test_auc = auc(test_scores, [e["win"] for e in test])

    ranked = sorted(zip(test_scores, test), key=lambda pair: pair[0], reverse=True)
    third = max(1, len(ranked) // 3)
    top = [e["r_multiple"] for _, e in ranked[:third]]
    bottom = [e["r_multiple"] for _, e in ranked[-third:]]
    everything = [e["r_multiple"] for e in test]
    top_avg = sum(top) / len(top)
    bottom_avg = sum(bottom) / len(bottom)
    all_avg = sum(everything) / len(everything)

    if test_auc is None:
        verdict, status = "The check period had only winners or only losers, so it cannot be graded.", "waiting"
    elif test_auc >= 0.58 and top_avg > all_avg and top_avg > 0:
        verdict, status = (
            "The model ranked unseen trades better than chance, and its top-scored third "
            "did better than average. Treat this as a lead to watch, not a rule.",
            "useful",
        )
    elif test_auc >= 0.53:
        verdict, status = (
            "A faint signal on unseen days — slightly better than a coin flip. "
            "Not reliable enough to act on yet.",
            "faint",
        )
    else:
        verdict, status = (
            "On unseen days the model could not tell winners from losers better than a coin flip. "
            "That is common — it means these features alone do not explain the outcomes yet.",
            "no edge",
        )

    return {
        "status": status,
        "verdict": verdict,
        "train_trades": len(train),
        "test_trades": len(test),
        "train_auc": round(train_auc, 3) if train_auc is not None else None,
        "test_auc": round(test_auc, 3) if test_auc is not None else None,
        "top_third_avg_r": round(top_avg, 3),
        "bottom_third_avg_r": round(bottom_avg, 3),
        "all_avg_r": round(all_avg, 3),
        "factors": model.explain(),
        "_model": model,
    }

