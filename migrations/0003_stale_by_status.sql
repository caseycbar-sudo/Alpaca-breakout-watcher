-- A job stopped looking stale whenever anyone touched it, so work that was
-- parked behind daily check-ins never showed up as parked. Measure staleness
-- from when the status last changed instead of from the last write of any kind.
ALTER TABLE tasks ADD COLUMN status_changed_at INTEGER NOT NULL DEFAULT 0;
UPDATE tasks SET status_changed_at = updated_at WHERE status_changed_at = 0;
