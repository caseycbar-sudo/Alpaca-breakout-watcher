"""Read-only option-volume context for the live stock watcher."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .config import Settings


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


class OptionsVolumeMonitor:
    """Aggregate near-the-money call/put volume without inferring trade direction."""

    def __init__(self, settings: Settings, client: Any):
        self.settings = settings
        self.client = client
        self.rows: list[dict[str, Any]] = []
        self.last_refresh_at: datetime | None = None
        self.status = "waiting"
        self.error: str | None = None
        self.contracts_observed = 0

    def _contracts(self, symbol: str, price: float, now: datetime) -> list[dict]:
        local_day = now.date()
        band = max(self.settings.options_strike_band_pct, 1.0) / 100.0
        contracts = self.client.option_contracts(
            symbol,
            local_day.isoformat(),
            (local_day + timedelta(days=self.settings.options_expiration_days)).isoformat(),
            max(0.01, price * (1.0 - band)),
            price * (1.0 + band),
        )
        contracts = [row for row in contracts if row.get("tradable", True)]
        contracts.sort(key=lambda row: (
            str(row.get("expiration_date") or "9999-12-31"),
            abs(_number(row.get("strike_price")) - price),
        ))
        return contracts[: self.settings.options_max_contracts_per_symbol]

    @staticmethod
    def _label(call_volume: float, put_volume: float) -> tuple[str, str]:
        total = call_volume + put_volume
        if total <= 0:
            return "NO SESSION VOLUME", "scanning"
        call_share = call_volume / total
        if call_share >= 0.65:
            return "CALL-HEAVY — CONTEXT ONLY", "candidate"
        if call_share <= 0.35:
            return "PUT-HEAVY — CONTEXT ONLY", "blocked"
        return "BALANCED OPTIONS FLOW", "scanning"

    def _summarize(
        self,
        underlying: str,
        price: float,
        contracts: list[dict],
        bars: dict[str, list[dict]],
        now: datetime,
    ) -> dict[str, Any]:
        call_volume = put_volume = call_oi = put_oi = premium = 0.0
        busiest: dict[str, Any] | None = None
        active_contracts = 0
        for contract in contracts:
            symbol = str(contract.get("symbol") or "")
            current = (bars.get(symbol) or [{}])[0]
            volume = _number(current.get("v") or current.get("volume"))
            option_type = str(contract.get("type") or "").lower()
            open_interest = _number(contract.get("open_interest"))
            reference_price = _number(
                current.get("vw") or current.get("c") or contract.get("close_price")
            )
            if option_type == "call":
                call_volume += volume
                call_oi += open_interest
            elif option_type == "put":
                put_volume += volume
                put_oi += open_interest
            premium += volume * reference_price * 100.0
            if volume > 0:
                active_contracts += 1
            if busiest is None or volume > busiest["volume"]:
                busiest = {
                    "symbol": symbol,
                    "type": option_type,
                    "strike": _number(contract.get("strike_price")),
                    "expiration": contract.get("expiration_date"),
                    "volume": volume,
                    "open_interest": open_interest,
                    "volume_oi": volume / open_interest if open_interest > 0 else None,
                }
        total_volume = call_volume + put_volume
        total_oi = call_oi + put_oi
        label, kind = self._label(call_volume, put_volume)
        return {
            "symbol": underlying,
            "underlying_price": price,
            "contracts": len(contracts),
            "active_contracts": active_contracts,
            "call_volume": round(call_volume),
            "put_volume": round(put_volume),
            "total_volume": round(total_volume),
            "put_call_ratio": put_volume / call_volume if call_volume > 0 else None,
            "call_open_interest": round(call_oi),
            "put_open_interest": round(put_oi),
            "volume_oi": total_volume / total_oi if total_oi > 0 else None,
            "estimated_premium": premium,
            "busiest": busiest,
            "status": label,
            "status_kind": kind,
            "updated_at": now.astimezone(timezone.utc).isoformat(),
            "note": "Volume shows activity, not whether contracts were bought or sold.",
        }

    def refresh(self, prices: dict[str, float], now: datetime | None = None) -> None:
        now = now or datetime.now(timezone.utc)
        results: list[dict[str, Any]] = []
        observed = 0
        try:
            for symbol, price in prices.items():
                if price <= 0:
                    continue
                contracts = self._contracts(symbol, price, now)
                observed += len(contracts)
                bars = self.client.option_daily_bars(
                    [str(row.get("symbol")) for row in contracts if row.get("symbol")],
                    now.replace(hour=0, minute=0, second=0, microsecond=0),
                ) if contracts else {}
                results.append(self._summarize(symbol, price, contracts, bars, now))
        except Exception as exc:
            self.status = "unavailable"
            self.error = f"{type(exc).__name__}: {exc}"
            self.last_refresh_at = now
            return
        self.rows = sorted(results, key=lambda row: row["total_volume"], reverse=True)
        self.contracts_observed = observed
        self.last_refresh_at = now
        self.status = "live"
        self.error = None
