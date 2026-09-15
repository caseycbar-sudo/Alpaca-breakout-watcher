import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from src import hub


class FakeLab:
    rows = []

    @staticmethod
    def balance():
        return 50.0


class HubTests(unittest.TestCase):
    def test_publish_hub_redacts_account_details(self):
        with tempfile.TemporaryDirectory() as directory:
            original = hub.HUB_DATA_PATH
            hub.HUB_DATA_PATH = Path(directory) / "dashboard.json"
            try:
                hub.publish_hub(
                    now=datetime(2026, 9, 15, tzinfo=timezone.utc),
                    phase="closed",
                    clock={"is_open": False, "next_open": "2026-09-15T13:30:00Z"},
                    candidates=[],
                    events=[],
                    lab=FakeLab(),
                    paper_account={
                        "account_number": "SECRET",
                        "equity": "99999",
                        "buying_power": "99999",
                        "positions": [],
                        "open_orders": [],
                        "trading_blocked": False,
                    },
                    source_status={
                        "sec_edgar": "online",
                        "nasdaq_halts": "online · 0 active",
                    },
                )
                raw = hub.HUB_DATA_PATH.read_text(encoding="utf-8")
                payload = json.loads(raw)
                self.assertNotIn("SECRET", raw)
                self.assertNotIn("99999", raw)
                self.assertEqual(payload["system"]["paper_account"], "healthy")
                self.assertEqual(payload["paper_lab"]["balance"], 50.0)
                self.assertEqual(payload["system"]["sec_edgar"], "online")
                self.assertEqual(payload["system"]["nasdaq_halts"], "online · 0 active")
                self.assertTrue(any(gate["label"] == "SEC filing" for gate in payload["gates"]))
            finally:
                hub.HUB_DATA_PATH = original

    def test_static_asset_links_exist(self):
        root = Path(__file__).resolve().parents[1] / "docs"
        html = (root / "index.html").read_text(encoding="utf-8")
        for relative in ("assets/styles.css", "assets/app.js", "data/dashboard.json"):
            self.assertTrue((root / relative).exists(), relative)
        self.assertIn('href="assets/styles.css"', html)
        self.assertIn('src="assets/app.js"', html)
        self.assertNotIn("ALPACA_API_SECRET", html)
        self.assertNotIn("GMAIL_APP_PASSWORD", html)


if __name__ == "__main__":
    unittest.main()
