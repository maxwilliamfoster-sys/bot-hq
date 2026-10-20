import { test } from "node:test";
import assert from "node:assert/strict";
import { radarData } from "../src/radar.js";
import { makeEnv, signIn, call } from "./helpers.js";

const INSIGHTS = {
  generated: 1792500022, niche: "chess", n_videos: 1903, n_scored: 1230, n_channels: 82,
  breaking: [{ title: "Can u Explain", channel: "Catur Talk", views: 50536, ratio: 9.2, age_h: 28, duration: 12, subs: 493000, url: "https://youtube.com/shorts/aaa" }],
  top_outliers: [{ title: "Magnus TROLLS", channel: "Convoy", views: 1184830, ratio: 33.1, age_h: 174, duration: 25, subs: 809, url: "https://youtube.com/shorts/bbb" }],
  feature_lift: [
    { feature: "number", lift: 1.21, share_top: 0.17, share_all: 0.14, n: 168 },
    { feature: "emoji", lift: 0.95, share_top: 0.48, share_all: 0.51, n: 626 },
  ],
  winning_words: [{ word: "against", lift: 3.99, in_winners: 12 }],
  you: { videos: 24, median_v24: 946, niche_small_channels_median_v24: 4959, titles: ["a", "b"], durations: [21, 20] },
  winner_median_duration: 11,
  gaps: [{ feature: "posted_06-12utc", lift: 1.21, share_top: 0.35, own_share: 0.08 }],
  hypotheses: [{ change: "Add a number", why: "w", evidence: ["x", "y"], how_to_test: "t" }],
  claude_prompt: "Improve my chess Shorts channel (@CandidateMoves). Repo: @@REPO@@ (GitHub: chess-puzzle-automation).\n\nAsk.",
};

const ok = body => async () => new Response(JSON.stringify(body), { status: 200 });

test("radar data is read from the public data branch and trimmed for the phone", async () => {
  const urls = [];
  const r = await radarData(async url => { urls.push(String(url)); return new Response(JSON.stringify(INSIGHTS)); });
  assert.match(urls[0], /^https:\/\/raw\.githubusercontent\.com\/maxwilliamfoster-sys\/shorts-radar\/data\/insights\/chess\.json/);
  assert.equal(r.available, true);
  assert.equal(r.generated, "2026-10-20T12:40:22.000Z");
  assert.equal(r.n_scored, 1230);
  assert.equal(r.you.median_v24, 946);
  assert.equal(r.breaking[0].url, "https://youtube.com/shorts/aaa");
  assert.deepEqual(r.levers.map(l => l.feature), ["number"]);      // only features that over-index
  assert.equal(r.hypotheses.length, 1);
});

test("the prompt gets this PC's chess repo folder filled in", async () => {
  const r = await radarData(ok(INSIGHTS));
  assert.ok(r.prompt.includes("C:\\Users\\maxwi\\Projects\\Content-Bots\\chess-puzzle-automation"));
  assert.ok(!r.prompt.includes("@@REPO@@"));
});

test("a radar that has not written a prompt yet still shows the report", async () => {
  const r = await radarData(ok({ ...INSIGHTS, claude_prompt: undefined }));
  assert.equal(r.available, true);
  assert.equal(r.prompt, null);
});

test("an unreachable or empty data branch is reported, not thrown", async () => {
  assert.deepEqual(await radarData(async () => new Response("nope", { status: 404 })), { available: false });
  assert.deepEqual(await radarData(async () => { throw new Error("network"); }), { available: false });
  assert.deepEqual(await radarData(async () => new Response("<html>")), { available: false });
});

test("GET /api/radar needs the session and serves the trimmed data", async () => {
  const env = await makeEnv({ RADAR_FETCH: ok(INSIGHTS) });
  assert.equal((await call(env, "GET", "/api/radar")).status, 401);
  const cookie = await signIn(env);
  const res = await call(env, "GET", "/api/radar", { cookie });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).n_channels, 82);
});

// ---- weekly reminder -------------------------------------------------------
import { weeklyRadarCheck } from "../src/radar.js";
import { runSchedule } from "../src/schedule.js";
import { setState, getState } from "../src/settings.js";

const FRESH = { ...INSIGHTS, generated: Date.parse("2026-10-27T07:00:00Z") / 1000 };
const evs = env => env.DB.prepare("SELECT bot, kind, severity, title, fix_prompt FROM events WHERE kind = 'radar_weekly'").all().then(r => r.results);
const pushes = [];
const weeklyEnv = () => makeEnv({ PUSH_FETCH: async (u, o) => { pushes.push(u); return new Response(null, { status: 201 }); } });

test("weekly reminder: the first look only starts the clock", async () => {
  const env = await weeklyEnv();
  await weeklyRadarCheck(env, env.DB, ok(FRESH), new Date("2026-10-20T10:00:00Z"));
  assert.equal((await evs(env)).length, 0);
  assert.ok(await getState(env.DB, "radar_weekly_at"));
});

test("weekly reminder: nothing before a week has passed", async () => {
  const env = await weeklyEnv();
  await setState(env.DB, "radar_weekly_at", "2026-10-20T10:00:00.000Z");
  await weeklyRadarCheck(env, env.DB, ok(FRESH), new Date("2026-10-27T09:00:00Z"));   // 6d23h
  assert.equal((await evs(env)).length, 0);
});

test("weekly reminder: after a week it raises one 'needs you' alert, once", async () => {
  const env = await weeklyEnv();
  await setState(env.DB, "radar_weekly_at", "2026-10-20T10:00:00.000Z");
  await weeklyRadarCheck(env, env.DB, ok(FRESH), new Date("2026-10-27T10:00:00Z"));
  await weeklyRadarCheck(env, env.DB, ok(FRESH), new Date("2026-10-27T11:00:00Z"));
  const rows = await evs(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, "action");
  assert.equal(rows[0].bot, "chess");
  assert.equal(rows[0].fix_prompt, null);                       // the prompt lives on the Radar tab
  assert.match(rows[0].title, /Radar/);
});

test("weekly reminder: waits for a fresh report instead of nagging about a stale one", async () => {
  const env = await weeklyEnv();
  await setState(env.DB, "radar_weekly_at", "2026-10-20T10:00:00.000Z");
  await weeklyRadarCheck(env, env.DB, ok(INSIGHTS), new Date("2026-10-27T10:00:00Z"));    // report is a week old
  await weeklyRadarCheck(env, env.DB, async () => new Response("", { status: 404 }), new Date("2026-10-27T10:00:00Z"));
  assert.equal((await evs(env)).length, 0);
  await weeklyRadarCheck(env, env.DB, ok(FRESH), new Date("2026-10-27T12:00:00Z"));        // later it arrives
  assert.equal((await evs(env)).length, 1);
});

test("weekly reminder: runs from the hourly schedule, not at night", async () => {
  const env = await weeklyEnv();
  await setState(env.DB, "radar_weekly_at", "2026-10-20T04:00:00.000Z");
  const f = async url => String(url).includes("shorts-radar") ? new Response(JSON.stringify(FRESH)) : new Response(null, { status: 201 });
  await runSchedule({}, env, { waitUntil() {} }, f, new Date("2026-10-27T03:02:00Z"));    // 04:02 UK
  assert.equal((await evs(env)).length, 0);
  await runSchedule({}, env, { waitUntil() {} }, f, new Date("2026-10-27T08:02:00Z"));    // 09:02 UK
  assert.equal((await evs(env)).length, 1);
});

import { pushUrl } from "../src/events.js";

test("the weekly reminder's push opens the Radar tab; other alerts open their event", () => {
  assert.equal(pushUrl({ kind: "radar_weekly" }, 7), "/#/radar");
  assert.equal(pushUrl({ kind: "run_failed" }, 7), "/#/event/7");
});
