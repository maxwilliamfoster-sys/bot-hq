// Opportunity scoring: the niche gate is mandatory; other components can never make up for failing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WEIGHTS, validWeights, scoreOpportunity, classify, evidenceLabel } from "../src/trends/score.js";

const ALL = { momentum: 1, audience: 1, performance: 1, competition: 1, timeliness: 1, originality: 1 };
const PASS = { passed: true, relevance: 1 };

test("default weights are the agreed 25/20/15/15/10/10/5", () => {
  assert.deepEqual(DEFAULT_WEIGHTS, { niche: 25, momentum: 20, audience: 15, performance: 15, competition: 10, timeliness: 10, originality: 5 });
});

test("full marks score 100 and class high", () => {
  const r = scoreOpportunity(PASS, ALL);
  assert.equal(r.score, 100);
  assert.equal(r.class, "high");
  assert.deepEqual(r.missing, []);
});

test("failing the gate is rejected with no score, even with perfect other components", () => {
  const r = scoreOpportunity({ passed: false, relevance: 0.55 }, ALL);
  assert.equal(r.class, "rejected");
  assert.equal(r.score, null);
});

test("missing components count as zero and are listed", () => {
  const r = scoreOpportunity(PASS, { momentum: 1 });
  assert.equal(r.score, 45);           // 25 niche + 20 momentum
  assert.equal(r.class, "monitor");
  assert.deepEqual(r.missing, ["audience", "performance", "competition", "timeliness", "originality"]);
});

test("components are clamped to 0..1 and bad values are treated as missing", () => {
  const r = scoreOpportunity(PASS, { ...ALL, momentum: 7, audience: -3, performance: "lots" });
  assert.equal(r.score, 100 - 15 - 15);
  assert.deepEqual(r.missing, ["performance"]);
});

test("class bands are 80 / 65 / 45", () => {
  assert.deepEqual([80, 79, 65, 64, 45, 44, 0].map(classify), ["high", "test", "test", "monitor", "monitor", "low", "low"]);
});

test("custom weights are normalised to 100", () => {
  const w = { niche: 50, momentum: 50, audience: 0, performance: 0, competition: 0, timeliness: 0, originality: 0 };
  assert.equal(scoreOpportunity(PASS, { momentum: 0.5 }, w).score, 75);
});

test("weights must have every key, be 0-100 and keep niche relevance at 10 or more", () => {
  assert.equal(validWeights(DEFAULT_WEIGHTS), true);
  assert.equal(validWeights({ ...DEFAULT_WEIGHTS, extra: 1 }), false);
  assert.equal(validWeights({ ...DEFAULT_WEIGHTS, momentum: 101 }), false);
  assert.equal(validWeights({ ...DEFAULT_WEIGHTS, niche: 5 }), false);
  const { originality, ...short } = DEFAULT_WEIGHTS;
  assert.equal(validWeights(short), false);
});

test("evidence: 2+ independent source types confirmed, 1 emerging, manual or Claude only a hypothesis", () => {
  assert.equal(evidenceLabel([{ source_type: "search" }, { source_type: "wiki" }]), "confirmed");
  assert.equal(evidenceLabel([{ source_type: "news" }, { source_type: "news" }]), "emerging");
  assert.equal(evidenceLabel([{ source_type: "manual" }, { source_type: "claude" }]), "hypothesis");
  assert.equal(evidenceLabel([]), "hypothesis");
});
