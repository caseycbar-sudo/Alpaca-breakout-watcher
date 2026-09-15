"""Historical replay of the watcher's A/B/C setups — for learning only.

The replay walks completed five-minute bars exactly as the live scanner sees them,
reusing the same indicator and opening-breakout code, and simulates what would
have happened with the paper lab's stop/target/end-of-day rules plus modeled
spread and slippage.

Two tracks are produced:

* **Learning track** – every bar where the A/B breakout *shape* appeared, whether
  or not the other gates passed. The pattern finder learns from these so it can
  tell which gates (and which conditions) actually mattered.
* **Strict track** – only setups that pass every gate that can be replayed from
  history. These are then run through the paper lab's portfolio rules
  ($50 balance, $10 max position, 3 entries/day, stop after 2 losses/day).

Nothing here sends alerts, touches the live paper ledger, or places orders.
"""

from __future__ import annotations

import os
import time
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

import requests

from .config import Settings
from .indicators import atr, five_minute_move_pct, relative_volume, rsi, vwap
from .paper_lab import (
    MAX_DAILY_LOSSES,
    MAX_NEW_TRADES_PER_DAY,
    MAX_POSITION,
    SLIPPAGE_RATE,
    STARTING_BALANCE,
)
from .scanner import DATA_URL, ET, PAPER_URL, MARKET_SYMBOLS, RISK_WORDS, _timestamp, opening_breakout

SETUP_A = "A — catalyst ORB second-bar hold"
SETUP_B = "B — first VWAP/level retest"
SETUP_C = "C — premarket leader confirmed after open"

OPEN_MINUTE = 9 * 60 + 30
CLOSE_MINUTE = 16 * 60
PREMARKET_START = 4 * 60


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class BacktestConfig:
    lookback_days: int = field(default_factory=lambda: _env_int("BACKTEST_LOOKBACK_DAYS", 120))
    max_symbols: int = field(default_factory=lambda: _env_int("BACKTEST_MAX_SYMBOLS", 60))
    min_symbols: int = field(default_factory=lambda: _env_int("BACKTEST_MIN_SYMBOLS", 10))
    # Historical quotes are not replayed, so a round-trip spread is modeled instead.
    spread_pct: float = field(default_factory=lambda: _env_float("BACKTEST_SPREAD_PCT", 0.15))
    slippage_rate: float = SLIPPAGE_RATE
    reward_risk: float = 2.0
    # Live entries stop at 3:30 p.m. ET and open simulations exit at 3:55 p.m. ET.
    last_entry_minute: int = 15 * 60 + 30
    exit_minute: int = 15 * 60 + 55
    use_news: bool = field(
        default_factory=lambda: os.getenv("BACKTEST_USE_NEWS", "true").lower()
        not in {"0", "false", "no", "off"}
    )
    train_fraction: float = 0.70

    @property
    def half_spread(self) -> float:
        return self.spread_pct / 200.0


# ---------------------------------------------------------------------------
# Data access (read-only)
# ---------------------------------------------------------------------------


def _get(client: Any, path: str, params: dict, attempts: int = 4) -> dict:
    """Read-only GET with polite retries on rate limits and transient errors."""
    delay = 2.0
    for attempt in range(attempts):
        try:
            return client._get(DATA_URL, path, params)
        except requests.HTTPError as exc:
            status = getattr(exc.response, "status_code", None)
            if status not in {429, 500, 502, 503, 504} or attempt == attempts - 1:
                raise
        except (requests.ConnectionError, requests.Timeout):
            if attempt == attempts - 1:
                raise
        time.sleep(delay)
        delay *= 2
    return {}


def _fetch_bar_batch(
    client: Any,
    batch: list[str],
    timeframe: str,
    start: datetime,
    end: datetime,
    max_pages: int,
    adjustment: str = "raw",
) -> tuple[dict[str, list[dict]], bool]:
    output: dict[str, list[dict]] = {}
    token = None
    for _ in range(max_pages):
        params = {
            "symbols": ",".join(batch),
            "timeframe": timeframe,
            "start": start.astimezone(timezone.utc).isoformat(),
            "end": end.astimezone(timezone.utc).isoformat(),
            # Raw prices: the live scanner sees the price as it traded, so the $0.50–$100
            # gate must not use values adjusted for splits that happened later.
            "adjustment": adjustment,
            "feed": client.settings.feed,
            "limit": 10000,
            "sort": "asc",
        }
        if token:
            params["page_token"] = token
        payload = _get(client, "/v2/stocks/bars", params)
        for symbol, rows in (payload.get("bars") or {}).items():
            output.setdefault(symbol, []).extend(rows or [])
        token = payload.get("next_page_token")
        if not token:
            return output, True
    return output, False


def fetch_bars(
    client: Any,
    symbols: list[str],
    timeframe: str,
    start: datetime,
    end: datetime,
    batch_size: int = 10,
    max_pages: int = 200,
    errors: list[str] | None = None,
    adjustment: str = "raw",
) -> dict[str, list[dict]]:
    """Read-only historical bars. Problems are noted in ``errors`` instead of stopping the run."""
    errors = errors if errors is not None else []
    output: dict[str, list[dict]] = {symbol: [] for symbol in symbols}
    for offset in range(0, len(symbols), batch_size):
        batch = symbols[offset: offset + batch_size]
        try:
            rows, complete = _fetch_bar_batch(client, batch, timeframe, start, end, max_pages, adjustment)
            groups = [(batch, rows, complete)]
        except requests.HTTPError:
            # One bad ticker makes Alpaca reject the whole request; retry one by one.
            groups = []
            for symbol in batch:
                try:
                    rows, complete = _fetch_bar_batch(client, [symbol], timeframe, start, end, max_pages, adjustment)
                    groups.append(([symbol], rows, complete))
                except requests.RequestException as exc:
                    errors.append(f"{symbol}: {timeframe} history unavailable ({exc.__class__.__name__})")
        except requests.RequestException as exc:
            errors.append(f"{', '.join(batch)}: {timeframe} history unavailable ({exc.__class__.__name__})")
            continue
        for names, rows, complete in groups:
            for symbol, values in rows.items():
                output.setdefault(symbol, []).extend(values)
            if not complete:
                errors.append(f"{', '.join(names)}: {timeframe} history was cut short; try fewer days")
    return output


def fetch_news(
    client: Any, symbol: str, start: datetime, end: datetime, max_pages: int = 40
) -> dict | None:
    """Headlines for one symbol, newest first, or ``None`` if the archive is unavailable.

    Returns ``{"articles": [...], "covered_from": datetime}``. When a busy ticker has
    more headlines than the page budget, ``covered_from`` marks the oldest moment with
    complete coverage; earlier signals are treated as "catalyst unknown".
    """
    articles: list[dict] = []
    token = None
    complete = False
    try:
        for page in range(max_pages):
            params = {
                "symbols": symbol,
                "start": start.astimezone(timezone.utc).isoformat(),
                "end": end.astimezone(timezone.utc).isoformat(),
                "sort": "desc",
                "limit": 50,
            }
            if token:
                params["page_token"] = token
            if page:
                time.sleep(0.3)  # stay well inside Alpaca's free-plan rate limit
            payload = _get(client, "/v1beta1/news", params)
            for item in payload.get("news", []) or []:
                articles.append({
                    "created_at": item.get("created_at", ""),
                    "headline": item.get("headline", ""),
                    "url": item.get("url", ""),
                })
            token = payload.get("next_page_token")
            if not token:
                complete = True
                break
    except requests.RequestException:
        return None
    covered_from = start
    if not complete and articles:
        oldest = min(articles, key=lambda a: a["created_at"])["created_at"]
        try:
            covered_from = datetime.fromisoformat(oldest.replace("Z", "+00:00"))
        except ValueError:
            return None
    return {"articles": articles, "covered_from": covered_from}


def fetch_session_closes(client: Any, start: datetime, end: datetime) -> dict[date, int]:
    """Regular-session close (minutes after midnight ET) per trading day, incl. half-days."""
    try:
        rows = client._get(
            PAPER_URL,
            "/v2/calendar",
            {"start": start.astimezone(ET).date().isoformat(), "end": end.astimezone(ET).date().isoformat()},
        )
    except (requests.RequestException, AttributeError):
        return {}
    closes: dict[date, int] = {}
    for row in rows or []:
        try:
            day = date.fromisoformat(str(row["date"]))
            hour, minute = str(row["close"]).split(":")[:2]
            closes[day] = int(hour) * 60 + int(minute)
        except (KeyError, TypeError, ValueError):
            continue
    return closes


def fill_in_symbols(client: Any, limit: int) -> list[str]:
    """Today's most-active names, used only when the study list is short."""
    try:
        payload = _get(client, "/v1beta1/screener/stocks/most-actives", {"top": 50, "by": "volume"})
    except requests.RequestException:
        return []
    result = []
    for item in payload.get("most_actives", []) or []:
        symbol = str(item.get("symbol") or "")
        if symbol and symbol not in MARKET_SYMBOLS and symbol not in result:
            result.append(symbol)
    return result[:limit]


# ---------------------------------------------------------------------------
# Pure replay helpers (no network; covered by unit tests)
# ---------------------------------------------------------------------------


@dataclass
class _Bar:
    raw: dict
    start_utc: datetime
    local: datetime
    day: date
    minute: int
    o: float
    h: float
    l: float
    c: float
    v: float


def _prepare(rows: Iterable[dict]) -> list[_Bar]:
    prepared = []
    for row in rows:
        try:
            start = _timestamp(row)
        except (KeyError, ValueError):
            continue
        local = start.astimezone(ET)
        close = float(row["c"])
        prepared.append(_Bar(
            raw=row,
            start_utc=start,
            local=local,
            day=local.date(),
            minute=local.hour * 60 + local.minute,
            o=float(row.get("o", close)),
            h=float(row["h"]),
            l=float(row["l"]),
            c=close,
            v=float(row.get("v", 0) or 0),
        ))
    prepared.sort(key=lambda bar: bar.start_utc)
    return prepared


@dataclass
class _DailyContext:
    days: list[date]
    closes: list[float]          # as traded
    volumes: list[float]         # split-adjusted to today's share count
    factors: list[float]         # raw close / split-adjusted close (changes only on splits)


def _daily_context(daily_rows: list[dict], split_rows: list[dict] | None = None) -> _DailyContext:
    adjusted: dict[date, dict] = {}
    for row in split_rows or []:
        try:
            adjusted[_timestamp(row).astimezone(ET).date()] = row
        except (KeyError, ValueError):
            continue
    context = _DailyContext([], [], [], [])
    for row in sorted(daily_rows, key=lambda r: r.get("t", "")):
        try:
            day = _timestamp(row).astimezone(ET).date()
            close = float(row["c"])
        except (KeyError, ValueError, TypeError):
            continue
        volume = float(row.get("v", 0) or 0)
        factor = 1.0
        match = adjusted.get(day)
        if match is not None:
            try:
                adjusted_close = float(match["c"])
                if adjusted_close > 0 and close > 0:
                    factor = close / adjusted_close
                    volume = float(match.get("v", 0) or 0)
            except (KeyError, ValueError, TypeError):
                pass
        context.days.append(day)
        context.closes.append(close)
        context.volumes.append(volume)
        context.factors.append(factor)
    return context


def _prior_close_and_volume(context: _DailyContext, day: date) -> tuple[float | None, float, bool]:
    """Prior raw close, 30-day average volume in ``day``'s share count, and a split flag.

    Split-adjusted volumes divided by the day's own price factor cancel every split
    after ``day``, so the average uses only information available that morning.
    """
    index = bisect_right(context.days, day - timedelta(days=1))
    if index == 0:
        return None, 0.0, False
    has_today = index < len(context.days) and context.days[index] == day
    factor_today = context.factors[index] if has_today else context.factors[index - 1]
    split_day = has_today and abs(context.factors[index] / context.factors[index - 1] - 1) > 0.02
    sample = [v / factor_today for v in context.volumes[max(0, index - 30): index] if v > 0]
    average = sum(sample) / len(sample) if len(sample) >= 5 else 0.0
    return context.closes[index - 1], average, split_day


def market_mood_table(market_bars: dict[str, list[dict]]) -> dict[date, list[tuple[int, str]]]:
    """Per day, a time-ordered list of (bar minute, mood) for SPY/QQQ together.

    Mood mirrors ``scanner.market_regime``: ``bearish`` when both are below VWAP and
    weakening (the live scanner blocks new longs then), ``aligned`` when both are
    above VWAP and rising, otherwise ``mixed``.
    """
    per_symbol: dict[str, dict[date, dict[int, tuple[bool, bool]]]] = {}
    for symbol in MARKET_SYMBOLS:
        bars = [b for b in _prepare(market_bars.get(symbol, [])) if OPEN_MINUTE <= b.minute < CLOSE_MINUTE]
        by_day: dict[date, list[_Bar]] = {}
        for bar in bars:
            by_day.setdefault(bar.day, []).append(bar)
        states: dict[date, dict[int, tuple[bool, bool]]] = {}
        for day, session in by_day.items():
            day_states = {}
            for index in range(1, len(session)):
                sub = [b.raw for b in session[: index + 1]]
                session_vwap = vwap(sub)
                if session_vwap is None:
                    continue
                close, previous = session[index].c, session[index - 1].c
                aligned = close >= session_vwap and close >= previous
                bearish = close < session_vwap and close < previous
                day_states[session[index].minute] = (aligned, bearish)
            states[day] = day_states
        per_symbol[symbol] = states

    table: dict[date, list[tuple[int, str]]] = {}
    all_days = set().union(*[set(v) for v in per_symbol.values()]) if per_symbol else set()
    for day in all_days:
        minutes = sorted(set().union(*[set(per_symbol[s].get(day, {})) for s in per_symbol]))
        rows = []
        latest: dict[str, tuple[bool, bool]] = {}
        for minute in minutes:
            for symbol in per_symbol:
                state = per_symbol[symbol].get(day, {}).get(minute)
                if state is not None:
                    latest[symbol] = state
            if len(latest) < 2:
                mood = "unknown"
            elif all(state[1] for state in latest.values()):
                mood = "bearish"
            elif all(state[0] for state in latest.values()):
                mood = "aligned"
            else:
                mood = "mixed"
            rows.append((minute, mood))
        table[day] = rows
    return table


def _mood_at(table: dict[date, list[tuple[int, str]]], day: date, minute: int) -> str:
    rows = table.get(day)
    if not rows:
        return "unknown"
    index = bisect_right([m for m, _ in rows], minute)
    return rows[index - 1][1] if index else "unknown"


def _news_index(news: list[dict] | None) -> tuple[list[datetime], list[dict]] | None:
    if news is None:
        return None
    items = []
    for item in news:
        try:
            moment = datetime.fromisoformat(str(item.get("created_at", "")).replace("Z", "+00:00"))
        except ValueError:
            continue
        items.append((moment, item))
    items.sort(key=lambda pair: pair[0])
    return [m for m, _ in items], [i for _, i in items]


def _catalyst_at(index, moment: datetime, max_age_hours: int) -> dict | None:
    times, items = index
    position = bisect_right(times, moment)
    if position == 0:
        return None
    latest_time, latest = times[position - 1], items[position - 1]
    if moment - latest_time > timedelta(hours=max_age_hours):
        return None
    return latest


def _premarket_leader(bars: list[_Bar], prior_close: float | None) -> bool:
    """Approximation of the live premarket roster test (without quotes or news)."""
    if not prior_close:
        return False
    rows = [b for b in bars if PREMARKET_START <= b.minute < OPEN_MINUTE]
    if len(rows) < 15:
        return False
    last = rows[-1]
    move = (last.c / prior_close - 1) * 100
    volume = sum(b.v for b in rows)
    pm_vwap = vwap([b.raw for b in rows])
    return 2.0 <= move <= 8.0 and volume >= 100_000 and pm_vwap is not None and last.c > pm_vwap


def _bucket_minutes(minutes_after_open: float) -> str:
    if minutes_after_open < 60:
        return "9:30–10:30"
    if minutes_after_open < 120:
        return "10:30–11:30"
    if minutes_after_open < 270:
        return "11:30–2:00 (midday)"
    return "2:00–3:30"


def simulate_exit(
    session: list[_Bar],
    entry_index: int,
    entry: float,
    stop: float,
    target: float,
    cfg: BacktestConfig,
    exit_minute: int | None = None,
) -> dict:
    """Walk forward from the entry bar. Same-bar stop and target counts as a stop."""

    def executable(price: float) -> float:
        return price * (1 - cfg.half_spread) * (1 - cfg.slippage_rate)

    exit_minute = cfg.exit_minute if exit_minute is None else exit_minute
    best = entry
    for k in range(entry_index, len(session)):
        bar = session[k]
        low, high, open_ = executable(bar.l), executable(bar.h), executable(bar.o)
        if low <= stop:
            # The bar's high may have come after the stop, so it is not counted.
            price = min(stop, open_)
            return {"index": k, "exit": price, "reason": "stop", "best": max(best, open_)}
        best = max(best, high)
        if high >= target:
            price = max(target, open_) if k > entry_index else target
            return {"index": k, "exit": price, "reason": "target", "best": best}
        if bar.minute + 5 >= exit_minute:
            return {"index": k, "exit": executable(bar.c), "reason": "end of session", "best": best}
    last = session[-1]
    return {"index": len(session) - 1, "exit": executable(last.c), "reason": "data ended", "best": best}


def find_events(
    symbol: str,
    five_minute_rows: list[dict],
    daily_rows: list[dict],
    mood_table: dict[date, list[tuple[int, str]]],
    news: dict | list[dict] | None,
    settings: Settings,
    cfg: BacktestConfig,
    session_closes: dict[date, int] | None = None,
    split_daily_rows: list[dict] | None = None,
) -> list[dict]:
    """Replay one ticker. ``news`` is ``fetch_news`` output (or a plain article list)."""
    bars = _prepare(five_minute_rows)
    if not bars:
        return []
    daily = _daily_context(daily_rows, split_daily_rows)
    covered_from = None
    if isinstance(news, dict):
        covered_from = news.get("covered_from")
        news = news.get("articles", [])
    news_index = _news_index(news) if cfg.use_news else None
    closes = [b.c for b in bars]
    position = {id(b): i for i, b in enumerate(bars)}

    by_day: dict[date, list[_Bar]] = {}
    for bar in bars:
        by_day.setdefault(bar.day, []).append(bar)

    events: list[dict] = []
    for day in sorted(by_day):
        day_bars = by_day[day]
        if session_closes:
            if day not in session_closes:
                continue  # not a trading day (stray extended-hours prints)
            close_minute = session_closes[day]
        else:
            close_minute = CLOSE_MINUTE
        last_entry_minute = min(cfg.last_entry_minute, close_minute - 5)
        exit_minute = min(cfg.exit_minute, close_minute - 5)
        session = [b for b in day_bars if OPEN_MINUTE <= b.minute < close_minute]
        if len(session) < 6:
            continue
        prior_close, avg_volume, split_day = _prior_close_and_volume(daily, day)
        if not prior_close or avg_volume <= 0 or split_day:
            continue  # split days compare prices on two different share counts
        if not (1 / 3 <= session[0].o / prior_close <= 3):
            continue  # likely an unreported split or a data error, not a tradable gap
        leader = _premarket_leader(day_bars, prior_close)
        gap_pct = (session[0].o / prior_close - 1) * 100
        learning_busy = -1
        strict_busy = -1
        cumulative_volume = 0.0
        cumulative_value = 0.0
        session_raw: list[dict] = []

        for i, bar in enumerate(session):
            cumulative_volume += bar.v
            cumulative_value += (bar.h + bar.l + bar.c) / 3 * bar.v
            session_raw.append(bar.raw)
            completed_minute = bar.minute + 5
            if i < 4 or i + 1 >= len(session) or completed_minute >= last_entry_minute:
                continue
            if session[i + 1].minute != completed_minute:
                continue  # data gap: the next bar is not the one a live scan would fill into
            if i <= learning_busy and i <= strict_busy:
                continue

            # Same value as indicators.vwap(session_raw), computed incrementally.
            session_vwap = cumulative_value / cumulative_volume if cumulative_volume > 0 else None
            level, confirmation = opening_breakout(session_raw, session_vwap)
            if not confirmation or level is None or session_vwap is None:
                continue
            j = position[id(bar)]
            indicator_rsi = rsi(closes[max(0, j - 30): j + 1])
            indicator_atr = atr([b.raw for b in bars[max(0, j - 30): j + 1]])
            bar_move = five_minute_move_pct(session_raw)
            if indicator_rsi is None or not indicator_atr or bar_move is None:
                continue
            elapsed = completed_minute - OPEN_MINUTE
            rel_volume = relative_volume(cumulative_volume, avg_volume, max(5.0, elapsed))
            if rel_volume is None:
                continue

            price = bar.c
            day_move = (price / prior_close - 1) * 100
            dollar_volume = bar.v * price
            vwap_distance_atr = (price - session_vwap) / indicator_atr
            completed_at = (bar.start_utc + timedelta(minutes=5))
            mood = _mood_at(mood_table, day, bar.minute)

            catalyst = None
            news_known = news_index is not None and (
                covered_from is None
                or completed_at - timedelta(hours=settings.catalyst_max_age_hours) >= covered_from
            )
            if news_known:
                catalyst = _catalyst_at(news_index, completed_at, settings.catalyst_max_age_hours)
            risky_headline = bool(
                catalyst and any(word in catalyst["headline"].lower() for word in RISK_WORDS)
            )

            next_bar = session[i + 1]
            entry = next_bar.o * (1 + cfg.half_spread) * (1 + cfg.slippage_rate)
            stop = min(bar.l, float(level), float(session_vwap)) - 0.10 * indicator_atr
            risk = entry - stop
            if stop <= 0 or risk <= 0:
                continue
            target = entry + cfg.reward_risk * risk

            minimum_move = 0.15 if confirmation == SETUP_B else settings.min_five_minute_move_pct
            gates = {
                "price": settings.min_price <= price <= settings.max_price,
                "session move": settings.min_day_move_pct <= day_move <= settings.max_day_move_pct,
                "5-min move": minimum_move <= bar_move <= settings.max_five_minute_move_pct,
                "relative volume": rel_volume >= settings.min_relative_volume,
                "5-min liquidity": dollar_volume >= settings.min_five_minute_dollar_volume,
                "RSI": settings.min_rsi <= indicator_rsi <= settings.max_rsi,
                "above VWAP": price > session_vwap,
                "VWAP distance": price - session_vwap <= indicator_atr * settings.max_vwap_distance_atr,
                "market": mood != "bearish",
                "risk within ATR": risk <= indicator_atr,
                "catalyst": (bool(catalyst) and not risky_headline) if news_known else None,
            }
            failed = [name for name, ok in gates.items() if ok is False]
            # When news was requested but could not be verified, stay conservative.
            strict = not failed and (news_known or not cfg.use_news)

            take_learning = i > learning_busy
            take_strict = strict and i > strict_busy
            if not (take_learning or take_strict):
                continue

            outcome = simulate_exit(session, i + 1, entry, stop, target, cfg, exit_minute)
            exit_bar = session[outcome["index"]]
            r_multiple = (outcome["exit"] - entry) / risk
            if take_learning:
                learning_busy = outcome["index"]
            if take_strict:
                strict_busy = outcome["index"]

            setup = SETUP_C if leader else confirmation
            preferred_rsi = settings.preferred_min_rsi <= indicator_rsi <= settings.preferred_max_rsi
            score = rel_volume + (1.0 if preferred_rsi else 0.0) + (0.5 if mood == "aligned" else 0.0) - cfg.spread_pct
            events.append({
                "symbol": symbol,
                "date": day.isoformat(),
                "signal_time": completed_at.astimezone(ET).isoformat(),
                "entry_time": next_bar.local.isoformat(),
                "exit_time": (exit_bar.start_utc + timedelta(minutes=5)).astimezone(ET).isoformat(),
                "weekday": day.strftime("%a"),
                "setup": setup,
                "shape": confirmation,
                "learning": take_learning,
                "strict": take_strict,
                "failed_gates": failed,
                "price": round(price, 4),
                "day_move_pct": round(day_move, 3),
                "gap_pct": round(gap_pct, 3),
                "five_minute_move_pct": round(bar_move, 3),
                "relative_volume": round(rel_volume, 3),
                "dollar_volume": round(dollar_volume, 0),
                "rsi": round(indicator_rsi, 2),
                "atr": round(indicator_atr, 6),
                "vwap": round(session_vwap, 6),
                "vwap_distance_atr": round(vwap_distance_atr, 3),
                "risk_pct": round(risk / entry * 100, 3),
                "risk_atr": round(risk / indicator_atr, 3),
                "minutes_after_open": elapsed,
                "time_bucket": _bucket_minutes(elapsed),
                "market_mood": mood,
                "catalyst": (
                    "unknown" if not news_known else "risky headline" if risky_headline
                    else "yes" if catalyst else "no"
                ),
                "catalyst_headline": (catalyst or {}).get("headline", ""),
                "catalyst_url": (catalyst or {}).get("url", ""),
                "premarket_leader": leader,
                "breakout_level": round(float(level), 6),
                "entry": round(entry, 6),
                "stop": round(stop, 6),
                "target": round(target, 6),
                "exit": round(outcome["exit"], 6),
                "exit_reason": outcome["reason"],
                "bars_held": outcome["index"] - i,
                "r_multiple": round(r_multiple, 4),
                "best_r": round((outcome["best"] - entry) / risk, 4),
                "win": r_multiple > 0,
                "score": round(score, 4),
            })
    return events


def summarize(values: list[float], pnls: list[float] | None = None) -> dict:
    """Summary stats for a list of R-multiples (and optional dollar P/L)."""
    n = len(values)
    if not n:
        return {"trades": 0, "win_rate": 0.0, "avg_r": 0.0, "total_r": 0.0, "profit_factor": None}
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v < 0]
    gross_loss = abs(sum(losses))
    out = {
        "trades": n,
        "win_rate": round(len(wins) / n * 100, 2),
        "avg_r": round(sum(values) / n, 4),
        "total_r": round(sum(values), 3),
        "avg_win_r": round(sum(wins) / len(wins), 3) if wins else 0.0,
        "avg_loss_r": round(sum(losses) / len(losses), 3) if losses else 0.0,
        "profit_factor": round(sum(wins) / gross_loss, 3) if gross_loss else None,
    }
    if pnls is not None:
        balance = peak = STARTING_BALANCE
        drawdown = 0.0
        for value in pnls:
            balance += value
            peak = max(peak, balance)
            drawdown = max(drawdown, peak - balance)
        out.update({
            "net_pl": round(sum(pnls), 4),
            "expectancy": round(sum(pnls) / n, 4),
            "max_drawdown": round(drawdown, 4),
            "ending_balance": round(STARTING_BALANCE + sum(pnls), 4),
        })
    return out


def replay_portfolio(events: list[dict]) -> list[dict]:
    """Apply the paper lab's account rules to strict setups across all tickers."""
    candidates = sorted(
        (e for e in events if e["strict"]),
        key=lambda e: (e["signal_time"], -e["score"]),
    )
    taken: list[dict] = []
    for event in candidates:
        moment = event["signal_time"]
        day = event["date"]
        todays = [t for t in taken if t["date"] == day]
        if len(todays) >= MAX_NEW_TRADES_PER_DAY:
            continue
        losses = sum(1 for t in todays if t["exit_time"] <= moment and t["net_pl"] < 0)
        if losses >= MAX_DAILY_LOSSES:
            continue
        open_trades = [t for t in taken if t["exit_time"] > moment]
        if any(t["symbol"] == event["symbol"] for t in open_trades):
            continue
        realized = sum(t["net_pl"] for t in taken if t["exit_time"] <= moment)
        available = STARTING_BALANCE + realized - sum(t["size"] for t in open_trades)
        if available < 0.50:
            continue
        size = min(MAX_POSITION, available)
        quantity = size / event["entry"]
        net = (event["exit"] - event["entry"]) * quantity
        taken.append({**event, "size": round(size, 4), "net_pl": round(net, 4)})
    return taken

