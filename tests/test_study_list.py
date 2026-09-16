import json
from datetime import datetime, timedelta, timezone

from src.study_list import manual_symbols, picked_symbols, record_picks, study_symbols


def test_record_and_merge_picks(tmp_path):
    now = datetime(2026, 9, 15, 15, tzinfo=timezone.utc)
    scanner = tmp_path / "study_picks.json"
    stream = tmp_path / "stream_picks.json"
    assert record_picks(["SOFI", "spy", "BTC/USD", "SOFI"], "scanner", now, scanner) == 1
    before = scanner.read_text()
    assert record_picks(["SOFI"], "scanner", now + timedelta(minutes=5), scanner) == 0
    assert scanner.read_text() == before  # no rewrite (and no git commit) for a repeat pick
    record_picks(["SOFI"], "scanner", now + timedelta(days=1), scanner)
    record_picks(["SOFI", "PLTR"], "stream", now + timedelta(minutes=5), stream)
    record_picks(["OLD"], "scanner", now - timedelta(days=90), scanner)
    data = json.loads(scanner.read_text())
    assert data["symbols"]["SOFI"]["days_flagged"] == 2
    picks = dict(picked_symbols([scanner, stream], now + timedelta(days=1, hours=1)))
    assert set(picks) == {"SOFI", "PLTR"}
    assert picks["SOFI"]["count"] == 2
    assert sorted(picks["SOFI"]["sources"]) == ["scanner", "stream"]


def test_manual_list_comes_first(tmp_path):
    now = datetime(2026, 9, 15, tzinfo=timezone.utc)
    manual = tmp_path / "study_list.txt"
    manual.write_text("# comment\nrivn, aapl  # inline\n\nBTC/USD\n")
    picks = tmp_path / "p.json"
    record_picks(["AAPL", "NVDA"], "scanner", now, picks)
    assert manual_symbols([manual]) == ["RIVN", "AAPL"]
    rows = study_symbols(10, now, [manual], [picks])
    assert [r["symbol"] for r in rows] == ["RIVN", "AAPL", "NVDA"]
    assert rows[1]["source"] == "my list + watcher"
    assert study_symbols(2, now, [manual], [picks])[-1]["symbol"] == "AAPL"


def test_missing_files_are_harmless(tmp_path):
    assert study_symbols(5, None, [tmp_path / "nope.txt"], [tmp_path / "nope.json"]) == []


def test_malformed_picks_file_never_raises(tmp_path):
    now = datetime(2026, 9, 15, tzinfo=timezone.utc)
    for content in ('{"symbols":{"AAA":{"count":null}}}', '{"AAA":"x"}', '[1,2]', '{"symbols":{"AAA":{"sources":"x","count":"z"}}}', "not json"):
        path = tmp_path / "bad.json"
        path.write_text(content)
        record_picks(["AAA"], "scanner", now, path)
        picked_symbols([path], now)
    assert record_picks(["AAA"], "scanner", now, tmp_path) == 0  # a directory, not a file

