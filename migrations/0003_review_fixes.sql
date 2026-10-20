-- A grouped event keeps one row while a problem lasts, but its push count restarts every
-- 24h (window_at = start of the current window) so a lasting outage pushes at least daily.
ALTER TABLE events ADD COLUMN window_at TEXT;
ALTER TABLE events ADD COLUMN window_count INTEGER;

-- Free-plan D1 hard-fails once the daily row-read limit is used: keep the hot reads indexed.
CREATE INDEX posts_posted ON posts (posted_at);
CREATE INDEX runs_at ON runs (at);
