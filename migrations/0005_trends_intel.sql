-- Trend Intelligence phase 3: flags worked out by the Worker from the evidence (e.g. active_case: an allegation
-- or live court case with no verdict yet), stored as a JSON array.
ALTER TABLE trends ADD COLUMN flags TEXT;
CREATE INDEX opportunities_cleanup ON opportunities (class, status, updated_at);
