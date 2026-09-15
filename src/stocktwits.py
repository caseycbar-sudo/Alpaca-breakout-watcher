from __future__ import annotations

from datetime import datetime, timedelta, timezone

import requests


API_URL = "https://api.stocktwits.com/api/2"
PUBLIC_URL = "https://stocktwits.com/symbol"


class StocktwitsClient:
    """Optional social-attention source. Never supplies executable market data."""

    def __init__(self, session=None, timeout: int = 8):
        self.session = session or requests
        self.timeout = timeout
        self.status = "not checked"

    def _get(self, path: str) -> dict:
        response = self.session.get(
            f"{API_URL}{path}",
            timeout=self.timeout,
            headers={"User-Agent": "DriftlineWatcher/1.0"},
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("response", {}).get("status", 200) >= 400:
            raise requests.RequestException(payload.get("response", {}).get("message", "Stocktwits API error"))
        return payload

    def trending_symbols(self, limit: int = 30) -> list[str]:
        try:
            payload = self._get("/trending/symbols.json")
        except (requests.RequestException, ValueError, TypeError):
            self.status = "unavailable — Alpaca-only discovery"
            return []

        symbols = []
        for row in payload.get("symbols", []):
            symbol = str(row.get("symbol") or "").upper().strip()
            if symbol and symbol.replace(".", "").replace("-", "").isalnum():
                symbols.append(symbol)
        self.status = "online — secondary discovery"
        return list(dict.fromkeys(symbols))[:limit]

    def symbol_pulse(self, symbol: str, now: datetime | None = None) -> dict | None:
        now = now or datetime.now(timezone.utc)
        try:
            payload = self._get(f"/streams/symbol/{symbol}.json")
        except (requests.RequestException, ValueError, TypeError):
            return None

        cutoff = now.astimezone(timezone.utc) - timedelta(hours=1)
        recent = []
        for message in payload.get("messages", [])[:30]:
            created = str(message.get("created_at") or "")
            try:
                timestamp = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except ValueError:
                continue
            if timestamp >= cutoff:
                recent.append(message)

        bullish = 0
        bearish = 0
        for message in recent:
            sentiment = (
                message.get("entities", {}).get("sentiment") or {}
            ).get("basic")
            if sentiment == "Bullish":
                bullish += 1
            elif sentiment == "Bearish":
                bearish += 1
        tagged = bullish + bearish
        return {
            "stocktwits_message_count_1h": len(recent),
            "stocktwits_bullish_pct": round(bullish / tagged * 100, 1) if tagged else None,
            "stocktwits_bearish_pct": round(bearish / tagged * 100, 1) if tagged else None,
            "stocktwits_url": f"{PUBLIC_URL}/{symbol}",
            "stocktwits_role": "secondary attention signal — never a catalyst or price source",
        }
