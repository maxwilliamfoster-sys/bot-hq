import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatAlerts } from "../src/rules.js";
import { validateEvent } from "../src/events.js";
import { recordPostFromEvent } from "../src/watch/stats.js";
import { localRepoPath } from "../src/bots.js";
import { getState } from "../src/settings.js";
import { handle } from "../src/api.js";
import { makeEnv } from "./helpers.js";

const now = new Date("2026-11-06T12:00:00Z");
const ago = h => new Date(now.getTime() - h * 3600e3).toISOString();

test("Bodge is a known bot and its folder is the what-if-shorts project", () => {
  assert.equal(validateEvent({ bot: "bodge", kind: "failed", severity: "action", title: "x" }).ok, true);
  assert.match(localRepoPath("bodge"), /Content-Bots\\what-if-shorts$/);
});

test("no heartbeat yet means not connected, so no alert", () => {
  assert.deepEqual(heartbeatAlerts("bodge", null, now), []);
});

test("a fresh heartbeat with a full queue is quiet", () => {
  assert.deepEqual(heartbeatAlerts("bodge", { at: ago(5), mode: "scheduled", waiting: 6 }, now), []);
});

test("a heartbeat older than 30h raises one action", () => {
  const out = heartbeatAlerts("bodge", { at: ago(31), mode: "scheduled", waiting: 4 }, now);
  assert.deepEqual(out.map(e => [e.kind, e.severity, e.dedupe_key]), [["no_heartbeat", "action", "no_heartbeat:bodge"]]);
  assert.match(out[0].title, /no daily run for 31h/);
});

test("a nearly empty queue warns only when uploads are switched on", () => {
  assert.deepEqual(heartbeatAlerts("bodge", { at: ago(2), mode: "scheduled", waiting: 1 }, now).map(e => e.kind), ["queue_low"]);
  assert.deepEqual(heartbeatAlerts("bodge", { at: ago(2), mode: "hold", waiting: 0 }, now), []);
});

test("a Bodge posted event records the post at its real publish time", async () => {
  const env = await makeEnv();
  await recordPostFromEvent(env.DB, { bot: "bodge", kind: "posted", title: "Bodge Delivers posted: He can see space",
    data: { external_id: "nCRYa8J48l0", video_url: "https://www.youtube.com/shorts/nCRYa8J48l0", posted_at: "2026-11-06T17:00:00Z" } },
  new Date("2026-11-07T02:10:00Z"));
  const { results } = await env.DB.prepare("SELECT id, bot, platform, title, posted_at FROM posts").all();
  assert.deepEqual(results, [{ id: "bodge:nCRYa8J48l0", bot: "bodge", platform: "youtube", title: "He can see space",
    posted_at: "2026-11-06T17:00:00.000Z" }]);
});

test("a future posted_at is not trusted", async () => {
  const env = await makeEnv();
  await recordPostFromEvent(env.DB, { bot: "bodge", kind: "posted", title: "x",
    data: { external_id: "abc", posted_at: "2027-01-01T00:00:00Z" } }, now);
  assert.equal(await env.DB.prepare("SELECT posted_at FROM posts").first("posted_at"), now.toISOString());
});

test("a heartbeat event is stored and never lands in the inbox", async () => {
  const env = await makeEnv();
  const req = new Request("https://x/api/event", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.APP_EVENTS_TOKEN}` },
    body: JSON.stringify({ bot: "bodge", kind: "heartbeat", severity: "info", title: "Bodge ran", data: { mode: "scheduled", waiting: 6 } }) });
  const res = await handle(req, env);
  assert.equal(res.status, 200);
  const beat = JSON.parse(await getState(env.DB, "heartbeat:bodge"));
  assert.equal(beat.waiting, 6);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n"), 0);
});

test("the Live tab shows Bodge's next scheduled post and the Runs tab its last PC run", async () => {
  const { setState } = await import("../src/settings.js");
  const { liveData, botsData } = await import("../src/views.js");
  const env = await makeEnv();
  await setState(env.DB, "heartbeat:bodge", JSON.stringify({ at: ago(3), mode: "scheduled", waiting: 5, next_publish: "2026-11-06T17:00:00+00:00" }));
  const live = (await liveData(env.DB, now)).bots.find(b => b.bot === "bodge");
  assert.equal(live.next_slot, "2026-11-06T17:00:00+00:00");
  const runs = (await botsData(env.DB, now)).bots.find(b => b.bot === "bodge");
  assert.equal(runs.heartbeat.waiting, 5);
});
