from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
STARTING_BALANCE = 50.0
MAX_POSITION = 10.0
MAX_NEW_TRADES_PER_DAY = 3
MAX_DAILY_LOSSES = 2
SLIPPAGE_RATE = 0.0005

FIELDS = [
    "trade_id", "timestamp", "symbol", "setup", "entry", "size", "quantity",
    "stop", "target", "exit_timestamp", "exit", "reason", "gross_pl",
    "modeled_spread_slippage", "net_pl", "account_balance", "status",
]


class PaperLab:
    def __init__(self, path: str = "data/paper_ledger.csv"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.rows = self._load()

    def _load(self) -> list[dict]:
        if not self.path.exists():
            return []
        with self.path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    def _save(self) -> None:
        with self.path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(self.rows)

    def balance(self) -> float:
        return STARTING_BALANCE + sum(
            float(row["net_pl"]) for row in self.rows if row.get("net_pl")
        )

    def open_symbols(self) -> list[str]:
        return [row["symbol"] for row in self.rows if row.get("status") == "open"]

    def process_exits(self, snapshots: dict, now: datetime) -> list[str]:
        events = []
        local = now.astimezone(ET)
        for row in self.rows:
            if row.get("status") != "open":
                continue
            snapshot = snapshots.get(row["symbol"], {})
            quote = snapshot.get("latestQuote") or {}
            bid = float(quote.get("bp") or 0)
            if bid <= 0:
                continue
            executable = bid * (1 - SLIPPAGE_RATE)
            stop, target = float(row["stop"]), float(row["target"])
            reason = None
            if executable <= stop:
                reason = "stop"
            elif executable >= target:
                reason = "target"
            elif local.hour == 15 and local.minute >= 55:
                reason = "end of session"
            if not reason:
                continue
            quantity, entry = float(row["quantity"]), float(row["entry"])
            gross = (bid - entry) * quantity
            friction = max(0.0, (bid - executable) * quantity)
            net = (executable - entry) * quantity
            row.update(
                {
                    "exit_timestamp": now.isoformat(),
                    "exit": f"{executable:.6f}",
                    "reason": reason,
                    "gross_pl": f"{gross:.4f}",
                    "modeled_spread_slippage": f"{float(row['modeled_spread_slippage']) + friction:.4f}",
                    "net_pl": f"{net:.4f}",
                    "status": "closed",
                }
            )
            row["account_balance"] = f"{self.balance():.4f}"
            events.append(
                f"PAPER TRADE RESULT — PAPER—NO REAL ORDER\n"
                f"{row['symbol']} exit {executable:.4f} | {reason} | net P/L {net:+.2f}\n"
                f"Account balance: {self.balance():.2f}"
            )
        if events:
            self._save()
        return events

    def process_entries(self, candidates: list[dict], now: datetime) -> list[str]:
        events = []
        day = now.astimezone(ET).date().isoformat()
        todays = [row for row in self.rows if row.get("timestamp", "")[:10] == day]
        entries_today = len(todays)
        losses_today = sum(
            1 for row in todays if row.get("net_pl") and float(row["net_pl"]) < 0
        )
        open_symbols = set(self.open_symbols())
        open_notional = sum(
            float(row["size"]) for row in self.rows if row.get("status") == "open"
        )
        available = max(0.0, self.balance() - open_notional)

        for candidate in candidates:
            if entries_today >= MAX_NEW_TRADES_PER_DAY or losses_today >= MAX_DAILY_LOSSES:
                break
            symbol = candidate["symbol"]
            if symbol in open_symbols or available < 0.50:
                continue
            ask, bid = float(candidate["ask"]), float(candidate["bid"])
            entry = ask * (1 + SLIPPAGE_RATE)
            stop = float(candidate["breakout_level"]) * 0.995
            risk = entry - stop
            if risk <= 0:
                continue
            target = entry + (2 * risk)
            size = min(MAX_POSITION, available)
            quantity = size / entry
            friction = ((ask - bid) / 2 + (entry - ask)) * quantity
            trade_id = f"{day.replace('-', '')}-{entries_today + 1:02d}-{symbol}"
            row = {
                "trade_id": trade_id,
                "timestamp": now.astimezone(ET).isoformat(),
                "symbol": symbol,
                "setup": candidate["confirmation"],
                "entry": f"{entry:.6f}",
                "size": f"{size:.4f}",
                "quantity": f"{quantity:.8f}",
                "stop": f"{stop:.6f}",
                "target": f"{target:.6f}",
                "exit_timestamp": "",
                "exit": "",
                "reason": "",
                "gross_pl": "",
                "modeled_spread_slippage": f"{friction:.4f}",
                "net_pl": "",
                "account_balance": f"{self.balance():.4f}",
                "status": "open",
            }
            self.rows.append(row)
            entries_today += 1
            available -= size
            open_symbols.add(symbol)
            events.append(
                "BREAKOUT PAPER TRADE — PAPER—NO REAL ORDER\n"
                f"{symbol} {candidate['price']:.4f} ({candidate['day_move_pct']:+.2f}%) | "
                f"RVOL {candidate['relative_volume']:.2f}x | spread {candidate['spread_pct']:.3f}%\n"
                f"VWAP {candidate['vwap']:.4f} | 5m RSI {candidate['rsi']:.1f} | "
                f"5m move {candidate['five_minute_move_pct']:+.2f}%\n"
                f"Entry {entry:.4f} | size {size:.2f} dollars | target {target:.4f} | "
                f"invalidation {stop:.4f}\n"
                f"Stage: {candidate['confirmation']} above {candidate['breakout_level']:.4f}\n"
                f"Catalyst ({candidate['news_time']}): {candidate['news_headline']}\n"
                f"{candidate['news_url']}\n"
                "Could work: catalyst, relative volume, VWAP and breakout confirmation align.\n"
                "Could fail: fast moves reverse; IEX data is not the full SIP market; "
                "the news headline still needs primary-source confirmation."
            )
        if events:
            self._save()
        return events

    def metrics(self) -> str:
        closed = [row for row in self.rows if row.get("status") == "closed"]
        if not closed:
            return "Completed trades: 0 | Balance: 50.00 dollars | Strategy not validated."
        pnls = [float(row["net_pl"]) for row in closed]
        wins = [value for value in pnls if value > 0]
        losses = [value for value in pnls if value < 0]
        gross_profit = sum(wins)
        gross_loss = abs(sum(losses))
        profit_factor = gross_profit / gross_loss if gross_loss else float("inf")
        expectancy = sum(pnls) / len(pnls)
        peak = STARTING_BALANCE
        balance = STARTING_BALANCE
        maximum_drawdown = 0.0
        for value in pnls:
            balance += value
            peak = max(peak, balance)
            maximum_drawdown = max(maximum_drawdown, peak - balance)
        return (
            f"Completed trades: {len(closed)} | Win rate: {len(wins)/len(closed):.1%} | "
            f"Avg win: {sum(wins)/len(wins) if wins else 0:.2f} | "
            f"Avg loss: {sum(losses)/len(losses) if losses else 0:.2f} | "
            f"Profit factor: {profit_factor:.2f} | Expectancy: {expectancy:.2f} | "
            f"Max drawdown: {maximum_drawdown:.2f} | Balance: {self.balance():.2f}\n"
            "Strategy not eligible for promotion until 30 completed trades plus positive unseen validation."
        )
