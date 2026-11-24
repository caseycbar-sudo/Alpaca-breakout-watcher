-- SEC EDGAR 8-K filings, with the three clocks that let us measure how late
-- Casey actually is rather than guessing.
--
--   accepted_at : when the SEC accepted the filing. Their clock, not ours.
--   received_at : when this hub first saw it. Ours.
--   opened_at   : when Casey first opened the hub with it on screen. His.
--
-- The whole point of this table is the gap between those three. A filing nobody
-- opened keeps opened_at NULL, which is a real measurement, not missing data.
CREATE TABLE IF NOT EXISTS filings (
  accession   TEXT PRIMARY KEY,
  cik         TEXT NOT NULL,
  company     TEXT NOT NULL,
  symbol      TEXT,
  form        TEXT NOT NULL,
  items       TEXT,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  opened_at   INTEGER
);

CREATE INDEX IF NOT EXISTS filings_by_accepted ON filings (accepted_at DESC);
CREATE INDEX IF NOT EXISTS filings_unopened ON filings (opened_at) WHERE opened_at IS NULL;
