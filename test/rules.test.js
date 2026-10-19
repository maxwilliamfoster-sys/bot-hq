import { test } from "node:test";
import assert from "node:assert/strict";
import { valueAtAge, doingWell, postingGaps } from "../src/rules.js";

// Vectors copied from growth-lab/tests/test_growth_stats.py (TestValueAtAge).
test("valueAtAge matches growth_stats.value_at_age", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(valueAtAge([[10, 100], [34, 340], [82, 820]], 72), 720);
  assert.equal(valueAtAge([[24, 5], [72, 9]], 72), 9);
  assert.equal(valueAtAge([[10, 100], [50, 300]], 72), null);
  close(valueAtAge([[48, 480]], 24, true), 240);
  assert.equal(valueAtAge([[48, 480]], 24, false), null);
  assert.equal(valueAtAge([[3000, 293]], 72, true), null);
  assert.equal(valueAtAge([[10, 1], [200, 9]], 72), null);
  close(valueAtAge([[10, 1], [200, 9]], 72, false, null), 1 + 8 * 62 / 190);
  close(valueAtAge([[82, 820], [34, 340]], 58), 580);
  assert.equal(valueAtAge([], 72), null);
});

test("doingWell needs 20 past posts and the 90th percentile", () => {
  const hist = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);   // 100..2000
  assert.equal(doingWell(5000, hist.slice(0, 19)), false);
  assert.equal(doingWell(1800, hist), true);                           // nearest-rank p90 = 1800
  assert.equal(doingWell(1799, hist), false);
  assert.equal(doingWell(null, hist), false);
});

test("postingGaps thresholds", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const h = n => new Date(now.getTime() - n * 3600e3).toISOString();
  assert.deepEqual(postingGaps({ chess: h(13), bcf: h(29) }, 2, now), []);
  const out = postingGaps({ chess: h(15), bcf: h(31) }, 0, now);
  assert.deepEqual(out.map(e => [e.bot, e.severity, e.kind]),
    [["chess", "action", "no_posts"], ["bcf", "action", "no_posts"], ["escape", "action", "no_posts"]]);
  assert.match(out[0].title, /Chess: no upload for 15h/);
  assert.match(out[2].title, /Escape Cup: nothing is scheduled/);
  assert.deepEqual(postingGaps({ chess: null, bcf: null }, null, now), []);  // unknown -> no alert
});
