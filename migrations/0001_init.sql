-- Bot HQ schema. Times are ISO-8601 UTC strings.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  platform TEXT,
  external_id TEXT UNIQUE,
  title TEXT,
  posted_at TEXT,
  slot TEXT,
  format TEXT,
  variant TEXT,
  length_s REAL,
  url TEXT
);
CREATE INDEX posts_bot_posted ON posts (bot, posted_at);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL,
  at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  avg_watch_s REAL,
  reach INTEGER
);
CREATE UNIQUE INDEX snapshots_post_at ON snapshots (post_id, at);

CREATE TABLE account (
  bot TEXT NOT NULL,
  at TEXT NOT NULL,
  followers INTEGER,
  likes INTEGER,
  videos INTEGER,
  PRIMARY KEY (bot, at)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  bot TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data_json TEXT,
  fix_prompt TEXT,
  dedupe_key TEXT,
  count INTEGER DEFAULT 1,
  last_at TEXT,
  read_at TEXT,
  resolved_at TEXT
);
CREATE INDEX events_dedupe ON events (dedupe_key, last_at);
CREATE INDEX events_sev ON events (severity, resolved_at);

CREATE TABLE runs (
  repo TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  workflow TEXT,
  conclusion TEXT,
  at TEXT,
  url TEXT,
  alerted INTEGER DEFAULT 0,
  PRIMARY KEY (repo, run_id)
);

CREATE TABLE gate (
  bot TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER,
  ai_used INTEGER,
  PRIMARY KEY (bot, at)
);

CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires TEXT NOT NULL
);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX login_attempts_ip ON login_attempts (ip, at);
