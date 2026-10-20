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
