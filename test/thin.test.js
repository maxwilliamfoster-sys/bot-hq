import { test } from "node:test";
import assert from "node:assert/strict";
import { thinPlan } from "../src/thin.js";

const NOW = new Date("2026-10-30T12:00:00Z");
const ago = days => new Date(NOW.getTime() - days * 86400e3);
const iso = d => d.toISOString();

test("12 rows within one hour at age 10 days keep 1 (the newest)", () => {
  const posted = { p: iso(ago(10.5)) };
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, post_id: "p", at: iso(new Date(ago(10).getTime() + i * 5 * 60e3)) }));
  rows.push({ id: 99, post_id: "p", at: iso(ago(1)) });           // newest overall stays
  const del = thinPlan(rows, posted, NOW);
  assert.equal(del.length, 11);
  assert.ok(!del.includes(12));                                    // newest in that hour kept
  assert.ok(!del.includes(99));
});

test("rows for a post under 7 days old are all kept", () => {
  const posted = { p: iso(ago(2)) };
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, post_id: "p", at: iso(new Date(ago(1).getTime() + i * 60e3)) }));
  assert.deepEqual(thinPlan(rows, posted, NOW), []);
});

test("rows older than 30 days keep one per day; the newest row per post is always kept", () => {
  const posted = { p: iso(ago(60)) };
  const day = ago(40);
  // all four on the same UTC day (12:00-23:00)
  const rows = [0, 3, 7, 11].map((h, i) => ({ id: i + 1, post_id: "p", at: iso(new Date(day.getTime() + h * 3600e3)) }));
  const del = thinPlan(rows, posted, NOW);
  assert.equal(del.length, 3);
  assert.deepEqual(thinPlan([{ id: 5, post_id: "q", at: iso(ago(50)) }], { q: iso(ago(60)) }, NOW), []);
});

test("unknown posts are left alone", () => {
  assert.deepEqual(thinPlan([{ id: 1, post_id: "x", at: iso(ago(40)) }, { id: 2, post_id: "x", at: iso(ago(40)) }], {}, NOW), []);
});
