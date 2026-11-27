-- Trend Intelligence. Account niches are NOT stored here: they live in trends/profiles.json (code-reviewed,
-- read-only at runtime), so nothing that reaches the API can change an account's niche.

-- One row per distinct trend (dedupe_key = normalised name, see src/trends/dedupe.js).
CREATE TABLE trends (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'new',
  evidence_text TEXT,            -- name + evidence titles (capped), so the gate can be re-run on approval
  excluded_json TEXT,            -- every exclusion term any account's gate ever hit (kept apart from the cap)
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX trends_last_seen ON trends (last_seen);

-- Evidence: every source a trend was seen in, with the original link and its times. Never edited after insert.
CREATE TABLE trend_signals (
  id INTEGER PRIMARY KEY,
  trend_id INTEGER NOT NULL,
  source TEXT NOT NULL,          -- adapter name, e.g. google_trends_rss, wikipedia, youtube, news_rss, manual
  source_type TEXT NOT NULL,     -- search | wiki | news | video | social | manual | claude
  url TEXT NOT NULL DEFAULT '',
  title TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  metric TEXT,
  value REAL,
  manual INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX trend_signals_unique ON trend_signals (trend_id, source, url, metric);
CREATE INDEX trend_signals_trend ON trend_signals (trend_id, fetched_at);

-- A daily reading per trend, for lifecycle tracking.
CREATE TABLE trend_snapshots (
  trend_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  momentum REAL,
  volume REAL,
  competitor_count INTEGER,
  PRIMARY KEY (trend_id, day)
);

-- A trend judged for one account. One row per (trend, account): repeats update it, never duplicate it.
CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY,
  trend_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  gate_passed INTEGER NOT NULL,
  gate_json TEXT,                -- anchor/related/exclusion hits and the reason
  profile_hash TEXT NOT NULL,
  components_json TEXT,          -- 0..1 per component; null = missing data
  score INTEGER,
  class TEXT NOT NULL,           -- high | test | monitor | low | rejected
  evidence TEXT NOT NULL,        -- confirmed | emerging | hypothesis
  status TEXT NOT NULL DEFAULT 'new',  -- new | approved | rejected | testing | won | lost | no_difference
  status_reason TEXT,
  notes TEXT,
  analysis_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX opportunities_trend_account ON opportunities (trend_id, account);
CREATE INDEX opportunities_account_class ON opportunities (account, class, score);
CREATE INDEX opportunities_status ON opportunities (status, updated_at);

-- Original content ideas for an opportunity (written later by the evening Claude run, citing evidence ids).
CREATE TABLE opportunity_ideas (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  idea_json TEXT NOT NULL
);
CREATE INDEX opportunity_ideas_opp ON opportunity_ideas (opportunity_id);

-- Units spent per source per UTC day (YouTube Data API quota protection), written by the collector.
CREATE TABLE trend_quota (
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, day)
);
