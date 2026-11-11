import { test } from "node:test";
import assert from "node:assert/strict";
import { viewHealth, coachEvent, reviewEvent, buildCoachPrompt, PLAYBOOK, VERDICTS } from "../src/coach.js";
import { BOT_IDS } from "../src/bots.js";
import { validateEvent } from "../src/events.js";

// newest first; v24 defaults to 70% of v72
const rows = (v72s, v24s = null) => v72s.map((v, i) => ({
  posted_at: new Date(Date.UTC(2026, 10, 30 - i)).toISOString(), v72: v, v24: v24s ? v24s[i] : v == null ? null : v * 0.7,
}));
const spreadOut = n => Array.from({ length: n }, (_, i) => [400, 900, 1500, 2600, 650, 1200, 3100, 800][i % 8]);

test("too few videos: still learning", () => {
  assert.equal(viewHealth(rows(spreadOut(12))).code, "learning");
});

test("views that vary are healthy", () => {
  assert.equal(viewHealth(rows(spreadOut(25))).code, "healthy");
});

test("chess pattern: every Short near 1,000 is a plateau, not a restriction", () => {
  const v = Array.from({ length: 25 }, (_, i) => 900 + (i * 37) % 250);
  const h = viewHealth(rows(v), { platform: "youtube" });
  assert.equal(h.code, "plateau");
  assert.ok(h.low >= 900 && h.high <= 1150);
});

test("eagle pattern: a tiny identical audience on TikTok is flagged as capped", () => {
  const v = Array.from({ length: 25 }, (_, i) => 66 + (i * 5) % 14);
  assert.equal(viewHealth(rows(v)).code, "capped");
  assert.equal(viewHealth(rows(v), { platform: "youtube" }).code, "plateau");   // the low-pool rule is TikTok only
});

test("four of the last five under the old 10th percentile is a sudden drop", () => {
  const h = viewHealth(rows([120, 90, 700, 110, 80, ...spreadOut(20)]));
  assert.equal(h.code, "shift");
  assert.ok(h.recent < h.median);
});

test("one bad video is not a drop", () => {
  assert.equal(viewHealth(rows([120, 900, 1500, 2600, 650, ...spreadOut(20)])).code, "healthy");
});

test("a video at three times the usual level is a breakout", () => {
  const h = viewHealth(rows([1000, 5200, 980, 1010, 1040, ...Array.from({ length: 20 }, (_, i) => 950 + i * 8)]));
  assert.equal(h.code, "breakout");
  assert.equal(h.best, 5200);
});

test("two newest videos with almost no first-day views: not being shown", () => {
  const v72 = [null, null, ...spreadOut(25)];
  const v24 = [3, 6, ...spreadOut(25).map(x => x * 0.7)];
  assert.equal(viewHealth(rows(v72, v24)).code, "unserved");
});

test("only the verdicts that need Max produce an event, and it is a valid one", () => {
  assert.equal(coachEvent("chess", { code: "plateau", low: 900, high: 1100 }), null);
  assert.equal(coachEvent("chess", { code: "healthy" }), null);
  for (const [code, health] of [["shift", { median: 900, recent: 120 }], ["capped", { low: 66, high: 79 }],
    ["unserved", { first_day: [3, 6], usual_first_day: 600 }], ["breakout", { best: 5200, median: 1000 }]]) {
    const ev = coachEvent("escape", { code, ...health });
    const checked = validateEvent(ev);
    assert.equal(checked.ok, true, `${code}: ${checked.error}`);
    assert.equal(ev.severity, code === "breakout" ? "good" : "action");
    assert.equal(ev.dedupe_key, `coach:escape:${code}`);
  }
  assert.equal(validateEvent(reviewEvent({ chess: { code: "plateau" } })).ok, true);
});

test("every bot has a playbook with ranked steps and manual checks", () => {
  for (const bot of BOT_IDS) {
    assert.ok(PLAYBOOK[bot], bot);
    assert.ok(PLAYBOOK[bot].steps.length >= 3 && PLAYBOOK[bot].checks.length >= 1, bot);
    assert.match(PLAYBOOK[bot].platform, /^(tiktok|youtube)$/);
  }
});

test("the message for Claude says what was found, what to do, and keeps the safety rules", () => {
  const p = buildCoachPrompt({ bot: "eagle", code: "capped", numbers: { median: 74, recent: 71, low: 69, high: 79 } });
  assert.match(p, /^Improve my Eagle Eyes account\. Repo: C:\\Users\\maxwi\\Projects\\Content-Bots\\level-up-quiz/);
  assert.ok(p.includes(VERDICTS.capped.means));
  assert.ok(p.includes("middle half of videos: 69 to 79"));
  assert.ok(p.includes("1. " + PLAYBOOK.eagle.steps[0]));
  assert.ok(p.includes(PLAYBOOK.eagle.checks[0] + " -> "));
  assert.match(p, /Never weaken or bypass the upload gate/);
  const r = buildCoachPrompt({ code: "review", verdicts: { chess: { code: "plateau", median: 1014, recent: 990 }, nope: { code: "x" } } });
  assert.match(r, /fortnightly review/);
  assert.ok(r.includes("- Chess: Stuck at one level (usually 1014 views at 3 days, last five 990)"));
  assert.ok(!r.includes("nope"));
});

test("advice never tells anyone to dodge a platform rule", () => {
  const all = JSON.stringify(PLAYBOOK);
  assert.ok(!/new account|vpn|delete and repost|remove the watermark/i.test(all));
  assert.match(all, /Never crop a watermark off/);
});
