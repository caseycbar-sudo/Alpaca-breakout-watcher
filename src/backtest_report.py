"""Standalone HTML report for the Mac "Run Backtest Lab" button.

The page reuses the Command Center's stylesheet and Backtest Lab renderer, with
the results embedded, so it opens straight from disk with no server.
"""

from __future__ import annotations

import json
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "docs" / "assets"


def _asset(name: str) -> str:
    try:
        return (ASSETS / name).read_text(encoding="utf-8")
    except OSError:
        return ""


def render_report(payload: dict) -> str:
    data = json.dumps(payload).replace("</", "<\\/")
    css = _asset("styles.css")
    js = _asset("backtest.js")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Driftline Backtest Lab</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>{css}
body{{padding-bottom:0}}main{{max-width:1400px}}.view{{display:block}}
</style>
</head>
<body>
<main id="main"><section class="view active"><div id="backtest-root"></div></section></main>
<script>{js}</script>
<script>window.DriftlineBacktest.render({data}, document.getElementById('backtest-root'));</script>
</body>
</html>
"""


def write_report(payload: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_report(payload), encoding="utf-8")
    return path

