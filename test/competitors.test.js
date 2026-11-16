import { test } from "node:test";
import assert from "node:assert/strict";
import { competitorView, borrowTally, safeUrl } from "../src/competitors.js";

const C = (over = {}) => ({
  channel: "@rival", url: "https://www.tiktok.com/@rival", platform: "TikTok", typical_views: "300k",
  followers: "120k", why: "same niche, a step above us", last_studied: "2026-11-16", studies: 2,
  what_they_do: ["face in frame 0", "15 s loop"],
  borrowed: [
    { idea: "loop ending", status: "testing", date: "2026-11-16", test: "short loop" },
    { idea: "bigger text", status: "fix", date: "2026-11-16" },
  ],
  ...over,
});

test("a competitor becomes a readable row with what we borrowed and how it went", () => {
  const [v] = competitorView([C()]);
  assert.equal(v.name, "@rival");
  assert.equal(v.url, "https://www.tiktok.com/@rival");
  assert.equal(v.meta, "TikTok · 120k followers · typical 300k views · studied 2 times, last 2026-11-16");
  assert.deepEqual(v.does, ["face in frame 0", "15 s loop"]);
  assert.deepEqual(v.borrowed.map(b => [b.label, b.tone]), [["Testing", "info"], ["Fixed", "good"]]);
  assert.equal(v.borrowed[0].text, "loop ending (test: short loop)");
});

test("never-studied competitors say so, and missing numbers are left out", () => {
  const [v] = competitorView([C({ last_studied: null, studies: 0, followers: "", typical_views: "unknown" })]);
  assert.equal(v.meta, "TikTok · not studied yet");
});

test("won and lost ideas get their own tags; unknown statuses fall back to Queued", () => {
  const [v] = competitorView([C({ borrowed: [{ idea: "a", status: "won" }, { idea: "b", status: "lost" }, { idea: "c", status: "?" }] })]);
  assert.deepEqual(v.borrowed.map(b => b.label), ["Worked here", "Didn't work here", "Queued"]);
});

test("the tally counts borrowed ideas across the watchlist", () => {
  const t = borrowTally([C(), C({ borrowed: [{ idea: "x", status: "won" }] })]);
  assert.deepEqual(t, { total: 3, won: 1, testing: 1, fix: 1, lost: 0, queued: 0 });
});

test("only http(s) links are clickable", () => {
  assert.equal(safeUrl("https://youtube.com/@x"), "https://youtube.com/@x");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl(""), null);
  assert.equal(safeUrl(undefined), null);
});

test("bad input gives an empty list, not a crash", () => {
  assert.deepEqual(competitorView(undefined), []);
  assert.deepEqual(competitorView([null, "x", { channel: "" }]), []);
});
