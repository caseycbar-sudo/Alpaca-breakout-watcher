import json
from datetime import datetime, timezone

import pytest

from src import live_journal
from src.live_journal import close_trade, load, open_trade, save, summary

NOW = datetime(2026, 10, 1, 14, 0, tzinfo=timezone.utc)


def test_open_and_close_round_trip(tmp_path):
    rows = []
    row = open_trade(rows, symbol="sofi", asset_class="stock", quantity=3, entry=10.0, stop=9.5,
                     target=11.0, order_id="o1", setup="A", now=NOW)
    assert row["trade_id"] == "20261001-SOFI-1"
    second = open_trade(rows, symbol="SOFI", asset_class="stock", quantity=1, entry=10.0, stop=9.5,
                        target=11.0, now=NOW)
    assert second["trade_id"] == "20261001-SOFI-2"
    closed = close_trade(rows, trade_id=row["trade_id"], exit_price=11.0, reason="target", order_id="o2", now=NOW)
    assert closed["status"] == "closed"
    assert float(closed["gross_pl"]) == pytest.approx(3.0)
    assert float(closed["return_pct"]) == pytest.approx(10.0)

    path = tmp_path / "live.csv"
    save(rows, path)
    assert load(path) == rows


def test_crypto_ids_drop_the_slash():
    rows = []
    row = open_trade(rows, symbol="BTC/USD", asset_class="crypto", quantity=0.0004, entry=60000,
                     stop=57000, target=66000, now=NOW)
    assert row["trade_id"] == "20261001-BTCUSD-1"


@pytest.mark.parametrize("kwargs", [
    {"asset_class": "options"},
    {"stop": 10.5},
    {"target": 9.0},
    {"quantity": 0},
])
def test_bad_entries_are_refused(kwargs):
    base = {"symbol": "SOFI", "asset_class": "stock", "quantity": 1, "entry": 10.0, "stop": 9.5, "target": 11.0}
    with pytest.raises(ValueError):
        open_trade([], **{**base, **kwargs})


def test_close_errors():
    rows = []
    row = open_trade(rows, symbol="SOFI", asset_class="stock", quantity=1, entry=10.0, stop=9.5, target=11.0, now=NOW)
    with pytest.raises(ValueError):
        close_trade(rows, trade_id="nope", exit_price=10, reason="stop")
    with pytest.raises(ValueError):
        close_trade(rows, trade_id=row["trade_id"], exit_price=10, reason="because")
    close_trade(rows, trade_id=row["trade_id"], exit_price=9.5, reason="stop", now=NOW)
    with pytest.raises(ValueError):
        close_trade(rows, trade_id=row["trade_id"], exit_price=9.5, reason="stop")


def test_summary_splits_stock_and_crypto_and_compares_with_research():
    rows = []
    a = open_trade(rows, symbol="SOFI", asset_class="stock", quantity=2, entry=10.0, stop=9.5, target=11.0, now=NOW)
    b = open_trade(rows, symbol="ETH/USD", asset_class="crypto", quantity=0.01, entry=2000, stop=1900, target=2200, now=NOW)
    open_trade(rows, symbol="PLTR", asset_class="stock", quantity=1, entry=20.0, stop=19.0, target=22.0, now=NOW)
    close_trade(rows, trade_id=a["trade_id"], exit_price=11.0, reason="target", now=NOW)
    close_trade(rows, trade_id=b["trade_id"], exit_price=1900, reason="stop", now=NOW)
    backtest = {"summary": {"learning": {"trades": 100, "win_rate": 15.0, "avg_r": -0.8}}}
    crypto = {"summary": {"all": {"trades": 12, "win_rate": 30.0, "avg_return_pct": -0.5}}}
    out = summary(rows, now=NOW, backtest=backtest, crypto=crypto)
    assert out["summary"]["all"]["trades"] == 2
    assert out["summary"]["all"]["net_pl"] == pytest.approx(1.0)
    assert out["summary"]["stocks"]["win_rate"] == 100.0
    assert out["summary"]["crypto"]["net_pl"] == pytest.approx(-1.0)
    assert out["summary"]["open"] == 1
    assert out["by_day"] == [{"date": "2026-10-01", "net_pl": 1.0}]
    assert out["research"]["stocks"]["avg_r"] == -0.8
    assert out["research"]["crypto"]["trades"] == 12


def test_cli_writes_journal_and_dashboard(tmp_path, monkeypatch):
    journal, out = tmp_path / "j.csv", tmp_path / "j.json"
    monkeypatch.setattr(live_journal, "BACKTEST_JSON", tmp_path / "missing.json")
    monkeypatch.setattr(live_journal, "CRYPTO_JSON", tmp_path / "missing2.json")
    common = ["--journal", str(journal), "--out", str(out)]
    live_journal.main(common + ["open", "--symbol", "SOFI", "--asset-class", "stock", "--quantity", "2",
                                "--entry", "10", "--stop", "9.5", "--target", "11"])
    trade_id = load(journal)[0]["trade_id"]
    live_journal.main(common + ["close", "--trade-id", trade_id, "--exit", "10.5", "--reason", "end of day"])
    data = json.loads(out.read_text())
    assert data["summary"]["all"]["trades"] == 1
    assert data["summary"]["all"]["net_pl"] == pytest.approx(1.0)
