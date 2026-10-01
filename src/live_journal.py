"""Real-trade journal for the Robinhood auto-trader.

The auto-trader places orders through Robinhood outside this repository; this
module only *records* what happened so real results can sit next to the research.
It has no order code and never talks to a broker.

Usage::

    python -m src.live_journal open --symbol SOFI --asset-class stock --quantity 3 \\
        --entry 14.20 --stop 13.49 --target 15.62 --order-id abc --setup "A" --notes "gap +3%, RVOL 2.1"
    python -m src.live_journal close --trade-id 20261001-SOFI-1 --exit 14.90 --reason target --order-id def
    python -m src.live_journal summary       # rebuilds docs/data/live_trades.json
"""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

from .scanner import ET

JOURNAL_PATH = Path("data/live_trades.csv")
JSON_PATH = Path("docs/data/live_trades.json")
BACKTEST_JSON = Path("docs/data/backtest.json")
CRYPTO_JSON = Path("docs/data/crypto_lab.json")

FIELDS = [
    "trade_id", "status", "asset_class", "symbol", "setup", "opened_at", "closed_at",
    "quantity", "entry", "stop", "target", "exit", "exit_reason", "gross_pl",
    "return_pct", "entry_order_id", "exit_order_id", "notes",
]
ASSET_CLASSES = ("stock", "crypto")
EXIT_REASONS = ("target", "stop", "end of day", "manual", "kill switch")


def load(path: Path = JOURNAL_PATH) -> list[dict]:
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            return [dict(row) for row in csv.DictReader(handle)]
    except FileNotFoundError:
        return []


def save(rows: list[dict], path: Path = JOURNAL_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _positive(value: float, name: str) -> float:
    if not value > 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def open_trade(rows: list[dict], *, symbol: str, asset_class: str, quantity: float, entry: float,
               stop: float, target: float, order_id: str = "", setup: str = "", notes: str = "",
               now: datetime | None = None) -> dict:
    if asset_class not in ASSET_CLASSES:
        raise ValueError(f"asset class must be one of {', '.join(ASSET_CLASSES)}")
    symbol = symbol.strip().upper()
    if not symbol:
        raise ValueError("symbol is required")
    _positive(quantity, "quantity")
    _positive(entry, "entry")
    if not 0 < stop < entry < target:
        raise ValueError("expected stop < entry < target for a long trade")
    now = now or _now()
    day = now.astimezone(ET).strftime("%Y%m%d")
    prefix = f"{day}-{symbol.replace('/', '')}-"
    number = 1 + sum(1 for row in rows if row["trade_id"].startswith(prefix))
    row = {
        "trade_id": f"{prefix}{number}",
        "status": "open",
        "asset_class": asset_class,
        "symbol": symbol,
        "setup": setup,
        "opened_at": now.isoformat(),
        "closed_at": "",
        "quantity": f"{quantity:g}",
        "entry": f"{entry:g}",
        "stop": f"{stop:g}",
        "target": f"{target:g}",
        "exit": "",
        "exit_reason": "",
        "gross_pl": "",
        "return_pct": "",
        "entry_order_id": order_id,
        "exit_order_id": "",
        "notes": notes,
    }
    rows.append(row)
    return row


def close_trade(rows: list[dict], *, trade_id: str, exit_price: float, reason: str,
                order_id: str = "", now: datetime | None = None) -> dict:
    if reason not in EXIT_REASONS:
        raise ValueError(f"reason must be one of {', '.join(EXIT_REASONS)}")
    _positive(exit_price, "exit")
    for row in rows:
        if row["trade_id"] == trade_id:
            if row["status"] != "open":
                raise ValueError(f"{trade_id} is already closed")
            entry, quantity = float(row["entry"]), float(row["quantity"])
            row.update({
                "status": "closed",
                "closed_at": (now or _now()).isoformat(),
                "exit": f"{exit_price:g}",
                "exit_reason": reason,
                "gross_pl": f"{(exit_price - entry) * quantity:.4f}",
                "return_pct": f"{(exit_price / entry - 1) * 100:.4f}",
                "exit_order_id": order_id,
            })
            return row
    raise ValueError(f"no trade with id {trade_id}")


def _stats(rows: list[dict]) -> dict:
    n = len(rows)
    if not n:
        return {"trades": 0, "win_rate": 0.0, "net_pl": 0.0, "avg_return_pct": 0.0, "profit_factor": None}
    pls = [float(r["gross_pl"]) for r in rows]
    rets = [float(r["return_pct"]) for r in rows]
    wins = sum(p for p in pls if p > 0)
    losses = abs(sum(p for p in pls if p < 0))
    return {
        "trades": n,
        "win_rate": round(sum(p > 0 for p in pls) / n * 100, 2),
        "net_pl": round(sum(pls), 4),
        "avg_return_pct": round(sum(rets) / n, 4),
        "profit_factor": round(wins / losses, 3) if losses else None,
    }


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def research_expectation(backtest: dict, crypto: dict) -> dict:
    """What the research predicted, so real results can be compared with it."""
    out = {}
    learning = (backtest.get("summary") or {}).get("learning") or {}
    if learning:
        out["stocks"] = {
            "source": "Backtest Lab learning track",
            "trades": learning.get("trades", 0),
            "win_rate": learning.get("win_rate", 0.0),
            "avg_r": learning.get("avg_r", 0.0),
        }
    crypto_all = (crypto.get("summary") or {}).get("all") or {}
    if crypto_all:
        out["crypto"] = {
            "source": "Crypto Lab",
            "trades": crypto_all.get("trades", 0),
            "win_rate": crypto_all.get("win_rate", 0.0),
            "avg_return_pct": crypto_all.get("avg_return_pct", 0.0),
        }
    return out


def summary(rows: list[dict], now: datetime | None = None, backtest: dict | None = None,
            crypto: dict | None = None) -> dict:
    now = now or _now()
    closed = [r for r in rows if r["status"] == "closed"]
    days: dict[str, float] = {}
    for row in closed:
        day = datetime.fromisoformat(row["closed_at"]).astimezone(ET).date().isoformat()
        days[day] = days.get(day, 0.0) + float(row["gross_pl"])
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "mode": "Real Robinhood trades placed by the auto-trader, recorded after the fact",
        "summary": {
            "all": _stats(closed),
            "stocks": _stats([r for r in closed if r["asset_class"] == "stock"]),
            "crypto": _stats([r for r in closed if r["asset_class"] == "crypto"]),
            "open": len(rows) - len(closed),
        },
        "by_day": [{"date": d, "net_pl": round(v, 4)} for d, v in sorted(days.items())][-60:],
        "research": research_expectation(backtest or {}, crypto or {}),
        "open_trades": [r for r in rows if r["status"] == "open"],
        "recent_trades": sorted(closed, key=lambda r: r["closed_at"], reverse=True)[:50],
    }


def write_summary(rows: list[dict], out: Path = JSON_PATH) -> dict:
    payload = summary(rows, backtest=_read_json(BACKTEST_JSON), crypto=_read_json(CRYPTO_JSON))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    return payload


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Record real auto-trader trades (no order code)")
    parser.add_argument("--journal", default=str(JOURNAL_PATH))
    parser.add_argument("--out", default=str(JSON_PATH))
    sub = parser.add_subparsers(dest="command", required=True)

    opened = sub.add_parser("open", help="record a filled entry")
    opened.add_argument("--symbol", required=True)
    opened.add_argument("--asset-class", required=True, choices=ASSET_CLASSES)
    opened.add_argument("--quantity", required=True, type=float)
    opened.add_argument("--entry", required=True, type=float)
    opened.add_argument("--stop", required=True, type=float)
    opened.add_argument("--target", required=True, type=float)
    opened.add_argument("--order-id", default="")
    opened.add_argument("--setup", default="")
    opened.add_argument("--notes", default="")

    closed = sub.add_parser("close", help="record a filled exit")
    closed.add_argument("--trade-id", required=True)
    closed.add_argument("--exit", required=True, type=float)
    closed.add_argument("--reason", required=True, choices=EXIT_REASONS)
    closed.add_argument("--order-id", default="")

    sub.add_parser("summary", help="rebuild the dashboard JSON")
    args = parser.parse_args(argv)

    journal = Path(args.journal)
    rows = load(journal)
    try:
        if args.command == "open":
            row = open_trade(rows, symbol=args.symbol, asset_class=args.asset_class, quantity=args.quantity,
                             entry=args.entry, stop=args.stop, target=args.target, order_id=args.order_id,
                             setup=args.setup, notes=args.notes)
            print(f"Opened {row['trade_id']}")
        elif args.command == "close":
            row = close_trade(rows, trade_id=args.trade_id, exit_price=args.exit, reason=args.reason,
                              order_id=args.order_id)
            print(f"Closed {row['trade_id']}: {float(row['gross_pl']):+.2f} ({float(row['return_pct']):+.2f}%)")
    except ValueError as exc:
        parser.error(str(exc))
    if args.command != "summary":
        save(rows, journal)
    payload = write_summary(rows, Path(args.out))
    s = payload["summary"]["all"]
    print(f"Journal: {s['trades']} closed trades · net {s['net_pl']:+.2f} · {payload['summary']['open']} open")


if __name__ == "__main__":
    main()
