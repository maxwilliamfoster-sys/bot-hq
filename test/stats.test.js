import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseYouTubeStats, parseBufferPosts, pollStats, recordPostFromEvent, BUFFER_DAILY_CAP } from "../src/watch/stats.js";
import { getState } from "../src/settings.js";
import { makeEnv } from "./helpers.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const NOW = new Date("2026-10-20T16:00:00Z");
const ENV = { YT_API_KEY: "yt", BUFFER_API_KEY: "buf", BUFFER_ORG_ID: "org", BUFFER_CHANNEL_BCF: "ch-bcf", BUFFER_CHANNEL_ESCAPE: "ch-escape" };

test("parseYouTubeStats reads string counts and missing likes", () => {
  assert.deepEqual(parseYouTubeStats(fixture("youtube_videos.json")), [
    { external_id: "YkkI7LMCkNg", views: 1534, likes: 41, comments: 3 },
    { external_id: "X-utS5CA2zU", views: 3, likes: null, comments: null },
  ]);
});

test("parseBufferPosts maps metrics and takes likes from reactions", () => {
  const { sent, scheduled } = parseBufferPosts(fixture("buffer_posts.json"));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], {
    external_id: "65f0aaa1", channel: "ch-escape", sent_at: "2026-10-20T15:30:12.000Z",
    text: "ENGLAND v BRAZIL - who escapes first? #escapecup",
    link: "https://www.tiktok.com/@5lmvill/video/7400000000000000001",
    metrics_at: "2026-10-20T18:00:00.000Z",
    views: 2310, likes: 188, comments: 12, shares: 4, reach: 2100, avg_watch_s: 9.4,
  });
  assert.equal(sent[1].views, null);
  assert.deepEqual(scheduled.map(s => s.channel), ["ch-escape", "ch-escape"]);
});

function fakeApis({ yt = fixture("youtube_videos.json"), buffer = fixture("buffer_posts.json") } = {}) {
  const calls = { yt: 0, buffer: 0 };
  const fn = async (url, init = {}) => {
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
      calls.yt++;
      const ids = new URL(url).searchParams.get("id").split(",");
      return Response.json({ items: yt.items.filter(i => ids.includes(i.id)) });
    }
    if (url === "https://api.buffer.com") {
      calls.buffer++;
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer buf");
      const body = JSON.parse(init.body);
      assert.deepEqual(body.variables.c, ["ch-bcf", "ch-escape"]);
      return Response.json(buffer);
    }
    return new Response("?", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

test("pollStats snapshots recent chess videos and inserts unknown sent Buffer posts", async () => {
  const env = await makeEnv(ENV);
  await env.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at) VALUES ('chess:YkkI7LMCkNg','chess','youtube','YkkI7LMCkNg','Mate in 2','2026-10-19T14:05:00Z')").run();
  await env.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at) VALUES ('chess:old','chess','youtube','old','Old','2026-10-01T14:05:00Z')").run();
  const apis = fakeApis();
  const r = await pollStats(env, env.DB, apis, NOW, { youtube: true, buffer: true });
  assert.equal(apis.calls.yt, 1);
  assert.equal(apis.calls.buffer, 1);
  assert.equal(r.snapshots, 2);       // 1 chess + 1 buffer (the BCF post has no metrics yet: no empty row)
  assert.deepEqual(r.newPosts.map(p => [p.bot, p.external_id]), [["escape", "65f0aaa1"], ["bcf", "65f0bbb2"]]);
  assert.deepEqual(r.pending, { bcf: 0, escape: 2 });
  const esc = await env.DB.prepare("SELECT * FROM posts WHERE external_id = '65f0aaa1'").first();
  assert.equal(esc.bot, "escape");
  assert.equal(esc.platform, "tiktok");
  assert.equal(esc.url, "https://www.tiktok.com/@5lmvill/video/7400000000000000001");
  const snap = await env.DB.prepare("SELECT views, likes FROM snapshots WHERE post_id = ?").bind(esc.id).first();
  assert.deepEqual(snap, { views: 2310, likes: 188 });
  assert.equal(await getState(env.DB, "escape_pending"), "2");
  assert.equal(await getState(env.DB, "escape_next_due"), "2026-10-21T15:30:00.000Z");
  // second poll: no new posts
  const again = await pollStats(env, env.DB, fakeApis(), new Date(NOW.getTime() + 3600e3), { youtube: false, buffer: true });
  assert.deepEqual(again.newPosts, []);
});

test("Buffer calls stop at the daily cap", async () => {
  const env = await makeEnv(ENV);
  const apis = fakeApis();
  for (let i = 0; i < BUFFER_DAILY_CAP + 3; i++) {
    await pollStats(env, env.DB, apis, new Date(NOW.getTime() + i * 60e3), { youtube: false, buffer: true });
  }
  assert.equal(apis.calls.buffer, BUFFER_DAILY_CAP);
});

test("missing keys skip that source quietly", async () => {
  const env = await makeEnv();
  const apis = fakeApis();
  const r = await pollStats(env, env.DB, apis, NOW, { youtube: true, buffer: true });
  assert.deepEqual(r, { snapshots: 0, newPosts: [], pending: null });
  assert.deepEqual(apis.calls, { yt: 0, buffer: 0 });
});

test("a posted event records the post for live tracking", async () => {
  const env = await makeEnv();
  await recordPostFromEvent(env.DB, { bot: "chess", kind: "posted", title: "Chess posted: Mate in 2",
    data: { video_url: "https://youtube.com/shorts/YkkI7LMCkNg", external_id: "YkkI7LMCkNg" } }, NOW);
  await recordPostFromEvent(env.DB, { bot: "bcf", kind: "posted", title: "BuriedCasefiles posted: The Case",
    data: { buffer_id: "65f0bbb2" } }, NOW);
  await recordPostFromEvent(env.DB, { bot: "bcf", kind: "posted", title: "dup", data: { buffer_id: "65f0bbb2" } }, NOW);
  await recordPostFromEvent(env.DB, { bot: "chess", kind: "post_failed", title: "x", data: { external_id: "z" } }, NOW);
  const { results } = await env.DB.prepare("SELECT id, bot, platform, title, url FROM posts ORDER BY id").all();
  assert.deepEqual(results, [
    { id: "bcf:65f0bbb2", bot: "bcf", platform: "tiktok", title: "The Case", url: null },
    { id: "chess:YkkI7LMCkNg", bot: "chess", platform: "youtube", title: "Mate in 2", url: "https://youtube.com/shorts/YkkI7LMCkNg" },
  ]);
});

test("a Buffer post whose TikTok video was backfilled reuses that post", async () => {
  const env = await makeEnv(ENV);
  await env.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at) VALUES ('bcf:7400000000000000002','bcf','tiktok','7400000000000000002','Backfilled','2026-10-20T11:45:30.000Z')").run();
  const r = await pollStats(env, env.DB, fakeApis(), NOW, { youtube: false, buffer: true });
  assert.deepEqual(r.newPosts.map(p => p.external_id), ["65f0aaa1"]);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) n FROM posts WHERE bot = 'bcf'").first("n"), 1);
  assert.equal(await env.DB.prepare("SELECT url FROM posts WHERE id = 'bcf:7400000000000000002'").first("url"),
    "https://www.tiktok.com/@buriedcasefiles/video/7400000000000000002");
});
