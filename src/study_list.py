"""Which tickers the backtest lab studies.

Two sources are merged:

* ``data/study_list.txt`` — tickers you add by hand (one per line, ``#`` comments).
* picks files — every stock the watcher flags is recorded automatically.
  GitHub's five-minute scanner writes ``data/study_picks.json``; the Mac stream
  watcher writes ``data/stream_picks.json`` (kept separate so reinstalling the
  Mac app never overwrites it).

This module only records research symbols. It never touches alerts or orders.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from zoneinfo import ZoneInfo

MANUAL_LIST_PATH = Path("data/study_list.txt")
SCANNER_PICKS_PATH = Path("data/study_picks.json")
STREAM_PICKS_PATH = Path("data/stream_picks.json")
MARKET_SYMBOLS = {"SPY", "QQQ"}
ET = ZoneInfo("America/New_York")
SYMBOL_PATTERN = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")


def _clean(symbol: str) -> str | None:
    value = str(symbol or "").strip().upper()
    if "/" in value or not SYMBOL_PATTERN.match(value):
        # Crypto pairs (BTC/USD) and junk are skipped: the setups are stock-session based.
        return None
    return value


def _paths_from_env(name: str, default: Iterable[Path]) -> list[Path]:
    raw = os.getenv(name, "")
    if not raw.strip():
        return list(default)
    return [Path(part.strip()).expanduser() for part in raw.split(os.pathsep) if part.strip()]


def _load_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def record_picks(
    symbols: Iterable[str],
    source: str,
    now: datetime | None = None,
    path: Path | str | None = None,
) -> int:
    """Remember flagged symbols. Returns how many symbols were newly recorded today.

    Each symbol is counted at most once per day, so the file only changes when a
    new pick (or a new day) appears. Any failure is swallowed on purpose: study
    bookkeeping must never break a scan or an alert.
    """
    try:
        now = now or datetime.now(timezone.utc)
        target = Path(path) if path else SCANNER_PICKS_PATH
        cleaned = [s for s in (_clean(x) for x in symbols) if s and s not in MARKET_SYMBOLS]
        if not cleaned:
            return 0
        payload = _load_json(target)
        raw = payload.get("symbols")
        picks = raw if isinstance(raw, dict) else {}
        stamp = now.astimezone(timezone.utc).isoformat()
        today = now.astimezone(ET).date().isoformat()
        changed = 0
        for symbol in dict.fromkeys(cleaned):
            row = picks.get(symbol)
            if not isinstance(row, dict):
                row = {"first_seen": stamp, "days_flagged": 0, "sources": []}
            sources = [str(x) for x in row.get("sources", []) if isinstance(x, str)] if isinstance(row.get("sources"), list) else []
            last_day = str(row.get("last_day", ""))
            if last_day == today and source in sources:
                continue
            try:
                days = int(row.get("days_flagged") or row.get("count") or 0)
            except (TypeError, ValueError):
                days = 0
            if last_day != today:
                days += 1
            if source not in sources:
                sources.append(source)
            picks[symbol] = {
                "first_seen": str(row.get("first_seen") or stamp),
                "last_seen": stamp,
                "last_day": today,
                "days_flagged": days,
                "sources": sources,
            }
            changed += 1
        if not changed:
            return 0
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(
            json.dumps({"schema_version": 1, "symbols": dict(sorted(picks.items()))}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, target)
        return changed
    except Exception as exc:  # noqa: BLE001 - bookkeeping must never break live code
        print(f"Study list not updated: {exc}", flush=True)
        return 0


def manual_symbols(paths: Iterable[Path] | None = None) -> list[str]:
    result: list[str] = []
    for path in paths if paths is not None else _paths_from_env("STUDY_LIST_PATHS", [MANUAL_LIST_PATH]):
        try:
            lines = Path(path).read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            text = line.split("#", 1)[0]
            for token in re.split(r"[\s,]+", text):
                symbol = _clean(token)
                if symbol and symbol not in result:
                    result.append(symbol)
    return result


def picked_symbols(
    paths: Iterable[Path] | None = None,
    now: datetime | None = None,
    max_age_days: int = 60,
) -> list[tuple[str, dict]]:
    """Return (symbol, info) for watcher picks seen within ``max_age_days``, newest first."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=max_age_days)
    merged: dict[str, dict] = {}
    default = [SCANNER_PICKS_PATH, STREAM_PICKS_PATH]
    for path in paths if paths is not None else _paths_from_env("STUDY_PICKS_PATHS", default):
        symbols = _load_json(Path(path)).get("symbols")
        if not isinstance(symbols, dict):
            continue
        for symbol, info in symbols.items():
            clean = _clean(symbol)
            if not clean or not isinstance(info, dict):
                continue
            try:
                last_seen = datetime.fromisoformat(str(info.get("last_seen")))
                days = int(info.get("days_flagged") or info.get("count") or 0)
            except (TypeError, ValueError):
                continue
            raw_sources = info.get("sources")
            sources = [str(x) for x in raw_sources if isinstance(x, str)] if isinstance(raw_sources, list) else []
            if last_seen.tzinfo is None:
                last_seen = last_seen.replace(tzinfo=timezone.utc)
            if last_seen < cutoff:
                continue
            current = merged.get(clean)
            if current is None:
                merged[clean] = {"last_seen": last_seen, "count": days, "sources": sources}
            else:
                current["last_seen"] = max(current["last_seen"], last_seen)
                current["count"] = max(current["count"], days)
                for src in sources:
                    if src not in current["sources"]:
                        current["sources"].append(src)
    ordered = sorted(merged.items(), key=lambda item: (item[1]["last_seen"], item[1]["count"]), reverse=True)
    return ordered


def study_symbols(
    max_symbols: int = 60,
    now: datetime | None = None,
    manual_paths: Iterable[Path] | None = None,
    pick_paths: Iterable[Path] | None = None,
    max_age_days: int = 60,
) -> list[dict]:
    """Merged study list: your tickers first, then the most recent watcher picks."""
    rows: list[dict] = []
    seen: set[str] = set()
    for symbol in manual_symbols(manual_paths):
        if symbol in seen:
            continue
        seen.add(symbol)
        rows.append({"symbol": symbol, "source": "my list", "days_flagged": 0, "last_flagged": None})
    for symbol, info in picked_symbols(pick_paths, now, max_age_days):
        if symbol in seen:
            for row in rows:
                if row["symbol"] == symbol:
                    row["source"] = "my list + watcher"
                    row["days_flagged"] = info["count"]
                    row["last_flagged"] = info["last_seen"].isoformat()
            continue
        seen.add(symbol)
        rows.append({
            "symbol": symbol,
            "source": "watcher (" + ", ".join(info["sources"]) + ")",
            "days_flagged": info["count"],
            "last_flagged": info["last_seen"].isoformat(),
        })
    return rows[:max_symbols]

