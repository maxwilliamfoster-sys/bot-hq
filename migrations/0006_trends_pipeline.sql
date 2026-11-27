-- Trend Intelligence phase 5: hand-off to the evening autopilot, test results, and the Inbox notice.
ALTER TABLE opportunities ADD COLUMN handed_at TEXT;      -- when kit.py trends-pull put the approved trend in the autopilot backlog
ALTER TABLE opportunities ADD COLUMN outcome_note TEXT;   -- the autopilot's one line on how the test went
ALTER TABLE opportunities ADD COLUMN notified_at TEXT;    -- when the Inbox was told this strong trend is waiting
-- (status lookups already use 0004's opportunities_status index)
