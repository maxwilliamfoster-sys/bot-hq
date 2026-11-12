import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./helpers.js";

const BOT = { authorization: "Bearer bot-token" };
const payload = {
  posts: [
    { id: "bodge:abc", bot: "bodge", platform: "youtube", external_id: "abc", title: "What if you got half as big?",
      posted_at: "2026-11-09T17:00:00.000Z" },
    { id: "chess:xyz", bot: "chess", platform: "youtube", external_id: "xyz", title: "Mate in 2", posted_at: "2026-11-09T12:00:00.000Z" },
  ],
  snapshots: [
    { post_id: "bodge:abc", at: "2026-11-10T17:00:00.000Z", views: 600 },
    { post_id: "bodge:abc", at: "2026-11-12T17:00:00.000Z", views: 1235 },
  ],
};

test("posts list needs the bot token and a known bot", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "GET", "/api/posts?bot=bodge")).status, 401);
  assert.equal((await call(env, "GET", "/api/posts?bot=nope", { headers: BOT })).status, 400);
});

test("posts list gives one bot's posts with the latest views", async () => {
  const env = await makeEnv();
  await call(env, "POST", "/api/ingest", { body: payload, headers: BOT });
  const r = await (await call(env, "GET", "/api/posts?bot=bodge", { headers: BOT })).json();
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].external_id, "abc");
  assert.equal(r.posts[0].views, 1235);
});
