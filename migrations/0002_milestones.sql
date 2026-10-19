-- Views at fixed ages (1h/6h/24h/72h), computed once per post when it is old enough.
-- "Doing well" compares a new post with these; graphs read views@Nh from here.
CREATE TABLE milestones (
  post_id TEXT NOT NULL,
  h INTEGER NOT NULL,
  views REAL,
  PRIMARY KEY (post_id, h)
);
