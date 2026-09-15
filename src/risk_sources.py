from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
import re
import xml.etree.ElementTree as ET

import requests


NASDAQ_HALT_FEED = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts"
SEC_TICKER_MAP = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
SEC_ARCHIVES = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}"

DIRECT_OFFERING_FORMS = {"S-1", "S-1/A", "F-1", "F-1/A", "1-A", "1-A/A"}
PROSPECTUS_PREFIXES = ("424B",)
DOCUMENT_FORMS = {"8-K", "8-K/A", "6-K", "6-K/A", "S-3", "S-3/A", "F-3", "F-3/A"}
RISK_PHRASES = (
    "at-the-market offering",
    "at the market offering",
    "registered direct offering",
    "underwritten public offering",
    "public offering of",
    "private placement",
    "convertible note",
    "convertible senior note",
    "warrant to purchase",
    "reverse stock split",
    "notice of delisting",
    "minimum bid price requirement",
)


def _tag_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower().replace("_", "").replace(" ", "")


def _item_fields(item: ET.Element) -> dict[str, str]:
    fields: dict[str, str] = {}
    for node in item.iter():
        if node is item:
            continue
        value = " ".join("".join(node.itertext()).split())
        if value:
            fields[_tag_name(node.tag)] = value
    return fields


def parse_nasdaq_halts(xml_text: str) -> dict[str, dict]:
    """Parse Nasdaq Trader's RSS feed into currently halted symbols."""
    root = ET.fromstring(xml_text)
    active: dict[str, dict] = {}
    for item in root.iter():
        if _tag_name(item.tag) != "item":
            continue
        fields = _item_fields(item)
        symbol = (
            fields.get("issuesymbol")
            or fields.get("symbol")
            or fields.get("ticker")
            or ""
        ).upper().strip()
        if not symbol:
            continue
        resumed = any(
            fields.get(key)
            for key in ("resumptiontradetime", "resumetradetime", "resumptiondate")
        )
        if resumed:
            continue
        active[symbol] = {
            "symbol": symbol,
            "reason": fields.get("reasoncode") or fields.get("reason") or "Nasdaq trading halt",
            "halt_date": fields.get("haltdate", ""),
            "halt_time": fields.get("halttime", ""),
            "source_url": fields.get("link") or NASDAQ_HALT_FEED,
        }
    return active


def _plain_text(html: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", html)
    return " ".join(without_tags.split()).lower()


@dataclass
class RiskAssessment:
    symbol: str
    allowed: bool
    complete: bool
    halt_check: str
    sec_check: str
    reasons: list[str] = field(default_factory=list)
    filings: list[dict] = field(default_factory=list)
    source_urls: list[str] = field(default_factory=list)

    def event(self, now: datetime) -> dict:
        if not self.complete:
            title = "Official risk verification unavailable"
            kind = "verification block"
        elif "halted" in self.halt_check:
            title = "Trading halt blocked the setup"
            kind = "halt block"
        else:
            title = "SEC filing risk blocked the setup"
            kind = "filing block"
        return {
            "time": now.astimezone(timezone.utc).isoformat(),
            "symbol": self.symbol,
            "kind": kind,
            "title": title,
            "detail": "; ".join(self.reasons) or "The setup did not pass official-source checks.",
            "source_url": self.source_urls[0] if self.source_urls else "",
        }


class OfficialRiskClient:
    """Read-only SEC EDGAR and Nasdaq Trader safety checks."""

    def __init__(self, user_agent: str = "", session=None):
        self.session = session or requests.Session()
        self.headers = {
            "User-Agent": user_agent.strip() or "DriftlineWatcher/1.0 contact@example.com",
            "Accept-Encoding": "gzip, deflate",
        }
        self.halts: dict[str, dict] = {}
        self.ticker_map: dict[str, str] | None = None
        self.status = {"nasdaq_halts": "not checked", "sec_edgar": "not checked"}

    def _get(self, url: str, timeout: int = 20):
        response = self.session.get(url, headers=self.headers, timeout=timeout)
        response.raise_for_status()
        return response

    def refresh_halts(self) -> None:
        try:
            response = self._get(NASDAQ_HALT_FEED)
            self.halts = parse_nasdaq_halts(response.text)
            self.status["nasdaq_halts"] = f"online · {len(self.halts)} active"
        except (requests.RequestException, ET.ParseError, ValueError):
            self.halts = {}
            self.status["nasdaq_halts"] = "unavailable"

    def _load_ticker_map(self) -> None:
        if self.ticker_map is not None:
            return
        response = self._get(SEC_TICKER_MAP)
        payload = response.json()
        self.ticker_map = {
            str(row.get("ticker", "")).upper(): str(row.get("cik_str", "")).zfill(10)
            for row in payload.values()
            if row.get("ticker") and row.get("cik_str") is not None
        }
        self.status["sec_edgar"] = "online"

    @staticmethod
    def _recent_filings(payload: dict, now: datetime, days: int = 30) -> list[dict]:
        recent = payload.get("filings", {}).get("recent", {})
        rows = []
        cutoff = now.astimezone(timezone.utc).date() - timedelta(days=days)
        forms = recent.get("form", [])
        for index, form in enumerate(forms):
            try:
                filed = date.fromisoformat(recent["filingDate"][index])
            except (KeyError, IndexError, TypeError, ValueError):
                continue
            if filed < cutoff:
                continue
            rows.append({
                "form": str(form).upper(),
                "filing_date": filed.isoformat(),
                "accession": recent.get("accessionNumber", [""] * len(forms))[index],
                "document": recent.get("primaryDocument", [""] * len(forms))[index],
            })
        return rows

    @staticmethod
    def _filing_url(cik: str, row: dict) -> str:
        return SEC_ARCHIVES.format(
            cik=str(int(cik)),
            accession=row["accession"].replace("-", ""),
            document=row["document"],
        )

    def assess(self, symbol: str, now: datetime) -> RiskAssessment:
        symbol = symbol.upper()
        reasons: list[str] = []
        urls: list[str] = []
        halt_status = self.status.get("nasdaq_halts", "not checked")
        if halt_status == "unavailable":
            return RiskAssessment(
                symbol, False, False, "unavailable", "not checked",
                ["Nasdaq halt feed could not be verified; alert suppressed."], [], [NASDAQ_HALT_FEED]
            )
        halt = self.halts.get(symbol)
        if halt:
            detail = f"Nasdaq lists {symbol} as halted ({halt['reason']})"
            when = " ".join(filter(None, (halt.get("halt_date"), halt.get("halt_time"))))
            reasons.append(f"{detail}{f' at {when}' if when else ''}.")
            urls.append(halt.get("source_url") or NASDAQ_HALT_FEED)
            return RiskAssessment(symbol, False, True, "halted", "not checked", reasons, [], urls)

        try:
            self._load_ticker_map()
            cik = (self.ticker_map or {}).get(symbol)
            if not cik:
                self.status["sec_edgar"] = "online"
                return RiskAssessment(
                    symbol, False, False, "clear", "CIK unavailable",
                    [f"SEC CIK mapping was unavailable for {symbol}; alert suppressed."], [], [SEC_TICKER_MAP]
                )
            submissions_url = SEC_SUBMISSIONS.format(cik=cik)
            payload = self._get(submissions_url).json()
            filings = self._recent_filings(payload, now)
            risky: list[dict] = []
            for row in filings:
                form = row["form"]
                url = self._filing_url(cik, row)
                row["url"] = url
                row["risk"] = ""
                if form in DIRECT_OFFERING_FORMS or form.startswith(PROSPECTUS_PREFIXES):
                    row["risk"] = f"recent {form} registration/prospectus"
                elif form in DOCUMENT_FORMS and row.get("document"):
                    try:
                        text = _plain_text(self._get(url).text)
                    except requests.RequestException:
                        return RiskAssessment(
                            symbol, False, False, "clear", "filing text unavailable",
                            [f"Could not verify the text of {form} filed {row['filing_date']}; alert suppressed."],
                            filings, [url]
                        )
                    phrase = next((value for value in RISK_PHRASES if value in text), "")
                    if phrase:
                        row["risk"] = f'{form} mentions "{phrase}"'
                if row["risk"]:
                    risky.append(row)

            self.status["sec_edgar"] = "online"
            if risky:
                reasons.extend(f"{row['risk']} filed {row['filing_date']}" for row in risky[:3])
                urls.extend(row["url"] for row in risky[:3])
                return RiskAssessment(symbol, False, True, "clear", "risk found", reasons, risky[:5], urls)
            return RiskAssessment(symbol, True, True, "clear", "clear", [], filings[:5], [submissions_url])
        except (requests.RequestException, ValueError, TypeError):
            self.status["sec_edgar"] = "unavailable"
            return RiskAssessment(
                symbol, False, False, "clear", "unavailable",
                ["SEC EDGAR could not be verified; alert suppressed."], [], [SEC_TICKER_MAP]
            )
