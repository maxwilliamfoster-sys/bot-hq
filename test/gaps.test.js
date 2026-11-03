import { test } from "node:test";
import assert from "node:assert/strict";
import { postingGaps } from "../src/rules.js";

const now = new Date("2026-11-03T12:00:00Z");
const hoursAgo = h => new Date(now.getTime() - h * 3600e3).toISOString();
const keys = (last, ctx) => postingGaps(last, null, now, ctx).map(e => e.dedupe_key);

test("Space Edits alerts when nothing has posted for 18h and nothing is queued", () => {
  assert.deepEqual(keys({ space: hoursAgo(19) }, { bcfFeedAt: hoursAgo(1) }), ["no_posts:space"]);
});

test("Space Edits stays quiet when a post is queued within 24h", () => {
  assert.deepEqual(keys({ space: hoursAgo(19) }, { bcfFeedAt: hoursAgo(1), spaceNextDue: new Date(now.getTime() + 3600e3).toISOString() }), []);
});

test("Space Edits stays quiet when the Buffer feed is stale", () => {
  assert.deepEqual(keys({ space: hoursAgo(19) }, { bcfFeedAt: hoursAgo(5) }), []);
});

test("Space Edits stays quiet when it posted recently", () => {
  assert.deepEqual(keys({ space: hoursAgo(10) }, { bcfFeedAt: hoursAgo(1) }), []);
});
