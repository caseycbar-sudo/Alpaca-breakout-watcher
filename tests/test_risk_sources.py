import unittest
from datetime import datetime, timezone

import requests

from src.risk_sources import OfficialRiskClient, parse_nasdaq_halts


class FakeResponse:
    def __init__(self, *, text="", payload=None, status=200):
        self.text = text
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []

    def get(self, url, **kwargs):
        self.urls.append(url)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


HALT_XML = """<?xml version="1.0"?>
<rss xmlns:ndaq="http://www.nasdaqtrader.com/"><channel>
  <item><ndaq:IssueSymbol>STOP</ndaq:IssueSymbol><ndaq:HaltDate>09/15/2026</ndaq:HaltDate><ndaq:HaltTime>10:15:00</ndaq:HaltTime><ndaq:ReasonCode>T1</ndaq:ReasonCode><ndaq:ResumptionTradeTime /></item>
  <item><ndaq:IssueSymbol>BACK</ndaq:IssueSymbol><ndaq:ReasonCode>T1</ndaq:ReasonCode><ndaq:ResumptionTradeTime>10:45:00</ndaq:ResumptionTradeTime></item>
</channel></rss>"""


def submissions(form="10-Q", document="report.htm"):
    return {
        "filings": {
            "recent": {
                "form": [form],
                "filingDate": ["2026-09-14"],
                "accessionNumber": ["0000123456-26-000001"],
                "primaryDocument": [document],
            }
        }
    }


class RiskSourceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 15, 15, tzinfo=timezone.utc)

    def test_halt_feed_excludes_resumed_symbols(self):
        rows = parse_nasdaq_halts(HALT_XML)
        self.assertIn("STOP", rows)
        self.assertNotIn("BACK", rows)
        self.assertEqual(rows["STOP"]["reason"], "T1")

    def test_active_halt_blocks_before_sec_lookup(self):
        session = FakeSession([FakeResponse(text=HALT_XML)])
        client = OfficialRiskClient(session=session)
        client.refresh_halts()
        result = client.assess("STOP", self.now)
        self.assertFalse(result.allowed)
        self.assertTrue(result.complete)
        self.assertEqual(result.halt_check, "halted")
        self.assertEqual(len(session.urls), 1)

    def test_clean_sec_history_allows_symbol(self):
        session = FakeSession([
            FakeResponse(text="<rss><channel /></rss>"),
            FakeResponse(payload={"0": {"ticker": "SAFE", "cik_str": 123456}}),
            FakeResponse(payload=submissions()),
        ])
        client = OfficialRiskClient(session=session)
        client.refresh_halts()
        result = client.assess("SAFE", self.now)
        self.assertTrue(result.allowed)
        self.assertTrue(result.complete)
        self.assertEqual(result.sec_check, "clear")

    def test_recent_prospectus_blocks_symbol(self):
        session = FakeSession([
            FakeResponse(text="<rss><channel /></rss>"),
            FakeResponse(payload={"0": {"ticker": "RISK", "cik_str": 123456}}),
            FakeResponse(payload=submissions("424B5", "prospectus.htm")),
        ])
        client = OfficialRiskClient(session=session)
        client.refresh_halts()
        result = client.assess("RISK", self.now)
        self.assertFalse(result.allowed)
        self.assertTrue(result.complete)
        self.assertIn("424B5", result.reasons[0])

    def test_offering_language_in_8k_blocks_symbol(self):
        session = FakeSession([
            FakeResponse(text="<rss><channel /></rss>"),
            FakeResponse(payload={"0": {"ticker": "RISK", "cik_str": 123456}}),
            FakeResponse(payload=submissions("8-K", "event.htm")),
            FakeResponse(text="<html>Company announces a registered direct offering.</html>"),
        ])
        client = OfficialRiskClient(session=session)
        client.refresh_halts()
        result = client.assess("RISK", self.now)
        self.assertFalse(result.allowed)
        self.assertIn("registered direct offering", result.reasons[0])

    def test_source_failure_is_fail_closed(self):
        session = FakeSession([requests.Timeout("down")])
        client = OfficialRiskClient(session=session)
        client.refresh_halts()
        result = client.assess("SAFE", self.now)
        self.assertFalse(result.allowed)
        self.assertFalse(result.complete)
        self.assertEqual(client.status["nasdaq_halts"], "unavailable")


if __name__ == "__main__":
    unittest.main()
