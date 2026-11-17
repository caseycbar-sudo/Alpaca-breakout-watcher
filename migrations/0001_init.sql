-- Driftline Trading Hub, milestone 1.
-- No broker credentials and no order-placing capability live in this database.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Casey's browser sessions. Only a hash of the session token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);

-- Chat. ids are monotonic and never reused, so ordering is by id.
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner','agent','system')),
  author_id   TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  idem_key    TEXT UNIQUE
);

CREATE TABLE read_marks (
  reader_id    TEXT PRIMARY KEY,
  last_read_id INTEGER NOT NULL,
  seen_at      INTEGER NOT NULL
);

-- Account snapshots reported by an AI. History is kept; nothing is overwritten.
CREATE TABLE snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  source        TEXT NOT NULL,
  observed_at   INTEGER NOT NULL,
  uploaded_at   INTEGER NOT NULL,
  completeness  TEXT NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
  total_value   REAL,
  cash          REAL,
  buying_power  REAL,
  day_change    REAL,
  positions     TEXT,   -- JSON array, or NULL when not reported
  open_orders   TEXT,   -- JSON array, or NULL when not reported
  note          TEXT,
  idem_key      TEXT UNIQUE
);

-- Trade plans: one row per idea, from draft to outcome.
CREATE TABLE plans (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  author_id         TEXT NOT NULL,
  author_name       TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  what_we_see       TEXT NOT NULL,
  why               TEXT,
  entry_price       REAL,
  target_price      REAL,
  stop_price        REAL,
  size_dollars      REAL,
  est_loss_at_stop  REAL,
  wrong_if          TEXT,
  good_until        TEXT,
  sources           TEXT,
  rules_version     INTEGER,
  review_state      TEXT NOT NULL DEFAULT 'draft'
                    CHECK (review_state IN ('draft','reviewed','objected','authorized','declined')),
  reviewed_by       TEXT,
  review_comment    TEXT,
  order_state       TEXT NOT NULL DEFAULT 'none'
                    CHECK (order_state IN ('none','submission_pending','working','partially_filled',
                                           'filled','rejected','expired','canceled','unknown','closed')),
  protection_state  TEXT NOT NULL DEFAULT 'not_applicable'
                    CHECK (protection_state IN ('not_applicable','pending','confirmed','degraded','unknown')),
  broker_status     TEXT,
  broker_order_ids  TEXT,
  filled_quantity   REAL,
  fill_price        REAL,
  exit_price        REAL,
  fees              REAL,
  result_dollars    REAL,
  expected_vs_happened TEXT,
  lesson            TEXT
);

-- Immutable history of every change to a plan.
CREATE TABLE plan_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX plan_events_plan ON plan_events (plan_id, id);

-- Rules. Each change is a new version; old versions are never edited.
CREATE TABLE rules (
  version        INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     INTEGER NOT NULL,
  max_per_trade  REAL NOT NULL,
  daily_trigger  REAL NOT NULL,
  max_positions  INTEGER NOT NULL,
  instruments    TEXT NOT NULL,
  notes          TEXT,
  change_note    TEXT NOT NULL
);

-- Questions waiting on Casey.
CREATE TABLE decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  author_kind TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  author_name TEXT NOT NULL,
  question    TEXT NOT NULL,
  context     TEXT,
  options     TEXT,            -- JSON array of short strings
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','withdrawn')),
  answer      TEXT,
  answered_at INTEGER,
  idem_key    TEXT UNIQUE
);

-- Which AIs have been seen, for the "last checked in" line.
CREATE TABLE agent_seen (
  agent_id   TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  last_seen  INTEGER NOT NULL,
  last_action TEXT
);

-- Rules version 1: the limits Casey approved on 2026-11-16.
INSERT INTO rules (created_at, max_per_trade, daily_trigger, max_positions, instruments, notes, change_note)
VALUES (
  1794879540000, 40, 20, 2, 'Stocks and ETFs only',
  'No borrowing. No options, crypto or shorting. A stop goes in as soon as a buy fills. The plan is posted before the order and the result after.',
  'First version. Approved by Casey on November 16, 2026.'
);
