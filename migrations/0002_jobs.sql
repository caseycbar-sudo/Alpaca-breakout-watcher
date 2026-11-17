-- Project work is separate from trade plans. An assignment is a proposal until accepted.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL DEFAULT 'Hub improvements',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL CHECK(priority IN ('high','normal','low')),
  status TEXT NOT NULL CHECK(status IN ('proposed','ready','in_progress','blocked','review','done','canceled')),
  next_action TEXT NOT NULL,
  blocker TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  dependencies TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  idem_key TEXT UNIQUE
);
CREATE INDEX tasks_queue ON tasks(owner_id,status,priority,id);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  UNIQUE(task_id,version)
);
