import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./helpers.js";

const BOT = { authorization: "Bearer bot-token" };
const payload = {
  posts: [
    { id: "chess:YkkI7LMCkNg", bot: "chess", platform: "youtube", external_id: "YkkI7LMCkNg", title: "Win material",
      posted_at: "2026-10-19T16:41:39.829Z", slot: "15:00", format: "v1-countdown", variant: "a=control", length_s: 16.9,
      url: "https://youtube.com/shorts/YkkI7LMCkNg" },
    { id: "bcf:7694727875798306080", bot: "bcf", platform: "tiktok", external_id: "7694727875798306080",
      title: "Death of Keith Lyon", posted_at: "2026-10-09T17:55:00.000Z", format: "v2-energetic", length_s: 37.8 },
  ],
  snapshots: [
    { post_id: "chess:YkkI7LMCkNg", at: "2026-10-19T17:00:00.000Z", views: 10, likes: 1 },
    { post_id: "bcf:7694727875798306080", at: "2026-10-13T11:07:00.000Z", views: 886, likes: 18, comments: 2, shares: 0, reach: 690, avg_watch_s: 11.96 },
  ],
  account: [{ bot: "bcf", at: "2026-10-15T20:28:00.000Z", followers: 350, likes: 1570, videos: 78 }],
  gate: [{ bot: "escape", at: "2026-10-16T11:22:35.000Z", ok: 1, ai_used: 0 }],
};
const counts = async env => Object.fromEntries(await Promise.all(["posts", "snapshots", "account", "gate"].map(
  async t => [t, await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first("n")])));

test("ingest needs the bot token", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "POST", "/api/ingest", { body: payload })).status, 401);
});

test("ingest twice gives the same counts", async () => {
  const env = await makeEnv();
  const a = await (await call(env, "POST", "/api/ingest", { body: payload, headers: BOT })).json();
  assert.deepEqual(a.inserted, { posts: 2, snapshots: 2, account: 1, gate: 1 });
  const before = await counts(env);
  const b = await (await call(env, "POST", "/api/ingest", { body: payload, headers: BOT })).json();
  assert.deepEqual(b.inserted, { posts: 0, snapshots: 0, account: 0, gate: 0 });
  assert.deepEqual(await counts(env), before);
});

test("history fills the gaps of a post the app already knows, without overwriting", async () => {
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at) VALUES ('chess:YkkI7LMCkNg','chess','youtube','YkkI7LMCkNg','Live title','2026-10-19T16:42:00.000Z')").run();
  await call(env, "POST", "/api/ingest", { body: payload, headers: BOT });
  const p = await env.DB.prepare("SELECT title, slot, format, length_s, url FROM posts WHERE id = 'chess:YkkI7LMCkNg'").first();
  assert.deepEqual(p, { title: "Live title", slot: "15:00", format: "v1-countdown", length_s: 16.9, url: "https://youtube.com/shorts/YkkI7LMCkNg" });
});

test("a BuriedCasefiles video already tracked by its Buffer id isn't added twice", async () => {
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at, url) VALUES ('bcf:65f0bbb2','bcf','tiktok','65f0bbb2','The case','2026-10-09T17:55:30.000Z','https://www.tiktok.com/@buriedcasefiles/video/7694727875798306080')").run();
  const r = await (await call(env, "POST", "/api/ingest", { body: payload, headers: BOT })).json();
  assert.equal(r.inserted.posts, 1);                                      // only the chess post
  assert.equal(await env.DB.prepare("SELECT COUNT(*) n FROM posts WHERE bot = 'bcf'").first("n"), 1);
  const s = await env.DB.prepare("SELECT post_id, views FROM snapshots WHERE views = 886").first();
  assert.deepEqual(s, { post_id: "bcf:65f0bbb2", views: 886 });
  assert.equal(await env.DB.prepare("SELECT format FROM posts WHERE id = 'bcf:65f0bbb2'").first("format"), "v2-energetic");
});

test("bad rows are rejected with 400, oversize batches with 413", async () => {
  const env = await makeEnv();
  const bad = await call(env, "POST", "/api/ingest", { body: { posts: [{ id: "x", bot: "reddit" }] }, headers: BOT });
  assert.equal(bad.status, 400);
  const many = { snapshots: Array.from({ length: 501 }, (_, i) => ({ post_id: "p", at: `t${i}`, views: i })) };
  assert.equal((await call(env, "POST", "/api/ingest", { body: many, headers: BOT })).status, 413);
});

test("snapshots for posts the app doesn't know yet are skipped (next night retries them)", async () => {
  const env = await makeEnv();
  const body = { ...payload, snapshots: [...payload.snapshots, { post_id: "bcf:7000000000000000001", at: "2026-10-13T11:07:00.000Z", views: 5 }] };
  const r = await (await call(env, "POST", "/api/ingest", { body, headers: BOT })).json();
  assert.equal(r.inserted.snapshots, 2);
  assert.equal(r.skipped.snapshots, 1);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) n FROM snapshots WHERE post_id NOT IN (SELECT id FROM posts)").first("n"), 0);
  // once the live poller knows the video by its Buffer id, the retry lands on that post
  await env.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, url) VALUES ('bcf:65f0cccc','bcf','tiktok','65f0cccc','https://www.tiktok.com/@x/video/7000000000000000001')").run();
  const again = await (await call(env, "POST", "/api/ingest", { body, headers: BOT })).json();
  assert.equal(again.inserted.snapshots, 1);
  assert.equal(await env.DB.prepare("SELECT post_id FROM snapshots WHERE views = 5").first("post_id"), "bcf:65f0cccc");
});
