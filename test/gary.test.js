import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatAlerts } from "../src/rules.js";
import { validateEvent } from "../src/events.js";
import { recordPostFromEvent, recordStatsFromEvent } from "../src/watch/stats.js";
import { localRepoPath, BOT_IDS, PC_BOTS } from "../src/bots.js";
import { handle } from "../src/api.js";
import { makeEnv } from "./helpers.js";

const now = new Date("2026-11-17T19:00:00Z");
const ago = h => new Date(now.getTime() - h * 3600e3).toISOString();
const post = (env, body) => handle(new Request("https://x/api/event", { method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${env.APP_EVENTS_TOKEN}` },
  body: JSON.stringify(body) }), env);

test("Gary is a known PC bot and its folder is gary-bin-fox", () => {
  assert.ok(BOT_IDS.includes("gary"));
  assert.ok(PC_BOTS.includes("gary") && PC_BOTS.includes("bodge"));
  assert.equal(validateEvent({ bot: "gary", kind: "failed", severity: "action", title: "x" }).ok, true);
  assert.match(localRepoPath("gary"), /Content-Bots\\gary-bin-fox$/);
});

test("Gary's missing check-in says the PC is off, not that YouTube still posts", () => {
  const out = heartbeatAlerts("gary", { at: ago(31), mode: "scheduled", waiting: 4 }, now);
  assert.deepEqual(out.map(e => [e.kind, e.dedupe_key]), [["no_heartbeat", "no_heartbeat:gary"]]);
  assert.doesNotMatch(out[0].body, /YouTube/);
  assert.match(out[0].body, /Instagram/);
});

test("a Gary posted event records an Instagram post at its real time", async () => {
  const env = await makeEnv();
  await recordPostFromEvent(env.DB, { bot: "gary", kind: "posted", title: "Gary the Bin Fox posted: mate missed bin day again",
    data: { external_id: "17954736003304205", video_url: "https://www.instagram.com/reel/Df0R9SfB6OZ/", posted_at: "2026-11-16T21:06:04Z" } }, now);
  const { results } = await env.DB.prepare("SELECT id, bot, platform, title, posted_at, url FROM posts").all();
  assert.deepEqual(results, [{ id: "gary:17954736003304205", bot: "gary", platform: "instagram", title: "mate missed bin day again",
    posted_at: "2026-11-16T21:06:04.000Z", url: "https://www.instagram.com/reel/Df0R9SfB6OZ/" }]);
});

test("a stats event adds a snapshot to each known post and ignores unknown ones", async () => {
  const env = await makeEnv();
  await recordPostFromEvent(env.DB, { bot: "gary", kind: "posted", title: "x",
    data: { external_id: "111", posted_at: "2026-11-16T21:06:04Z" } }, now);
  const n = await recordStatsFromEvent(env.DB, { bot: "gary", kind: "stats", data: { posts: [
    { external_id: "111", views: 250, likes: 12, comments: 3, shares: 4, avg_watch_s: 6.5, reach: 200 },
    { external_id: "999", views: 5 }] } }, now);
  assert.equal(n, 1);
  const s = await env.DB.prepare("SELECT post_id, views, likes, comments, shares, avg_watch_s, reach FROM snapshots").first();
  assert.deepEqual({ ...s }, { post_id: "gary:111", views: 250, likes: 12, comments: 3, shares: 4, avg_watch_s: 6.5, reach: 200 });
});

test("a stats event with junk numbers stores nulls, not junk", async () => {
  const env = await makeEnv();
  await recordPostFromEvent(env.DB, { bot: "gary", kind: "posted", title: "x", data: { external_id: "111" } }, now);
  await recordStatsFromEvent(env.DB, { bot: "gary", kind: "stats", data: { posts: [{ external_id: "111", views: "lots", likes: -3 }] } }, now);
  const s = await env.DB.prepare("SELECT views, likes FROM snapshots").first();
  assert.deepEqual({ ...s }, { views: null, likes: null });
});

test("stats and heartbeat events from Gary never land in the inbox", async () => {
  const env = await makeEnv();
  for (const kind of ["stats", "heartbeat"]) {
    const res = await post(env, { bot: "gary", kind, severity: "info", title: "Gary", data: { posts: [], mode: "scheduled", waiting: 3 } });
    assert.equal(res.status, 200);
  }
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n"), 0);
});

test("only PC bots may send stats", async () => {
  const env = await makeEnv();
  const res = await post(env, { bot: "chess", kind: "stats", severity: "info", title: "x", data: { posts: [] } });
  assert.equal(res.status, 400);
});
