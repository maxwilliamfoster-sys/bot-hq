// The checks that catch a post going missing: Eagle Eyes via Zernio, stuck posts, quiet days,
// views falling, and the outside alarm that notices if Bot HQ itself stops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSchedule } from "../src/schedule.js";
import { postingGaps, stuckPosts, lowPosting, viewsFall } from "../src/rules.js";
import { parseZernioPosts } from "../src/watch/zernio.js";
import { BOT_IDS } from "../src/bots.js";
import { makeEnv } from "./helpers.js";
import { getState } from "../src/settings.js";

const okFetch = async () => new Response(null, { status: 201 });
const ctx = { waitUntil() {} };
const env = extra => makeEnv({ PUSH_FETCH: okFetch, ...extra });
const NOW = new Date("2026-11-03T12:02:00Z");
const ago = h => new Date(NOW.getTime() - h * 3600e3).toISOString();
const events = async (e, where) => (await e.DB.prepare(`SELECT * FROM events WHERE ${where}`).all()).results;

function zernio({ posts = [], analytics = [] } = {}) {
  const calls = [];
  const fn = async url => {
    calls.push(url);
    if (url.includes("zernio.com/api/v1/posts")) return Response.json({ posts });
    if (url.includes("zernio.com/api/v1/analytics")) return Response.json({ posts: analytics, pagination: { pages: 1 } });
    return new Response(null, { status: 201 });
  };
  fn.calls = calls;
  return fn;
}
const post = (id, status, scheduledFor, extra = {}) => ({ _id: id, status, scheduledFor, content: `Quiz ${id}\n#tag`, platforms: [{ platform: "tiktok" }], ...extra });

test("Eagle Eyes is one of the watched bots", () => {
  assert.ok(BOT_IDS.includes("eagle"));
});

test("Eagle Eyes alerts when nothing has posted for 20h and nothing is queued", () => {
  const keys = ctx2 => postingGaps({ eagle: ago(21) }, null, NOW, ctx2).map(e => e.dedupe_key);
  assert.deepEqual(keys({ eagleFeedAt: ago(1) }), ["no_posts:eagle"]);
  assert.deepEqual(keys({ eagleFeedAt: ago(1), eagleNextDue: new Date(NOW.getTime() + 3600e3).toISOString() }), []);
  assert.deepEqual(keys({ eagleFeedAt: ago(5) }), []);
  assert.deepEqual(postingGaps({ eagle: ago(18) }, null, NOW, { eagleFeedAt: ago(1) }), []);
});

test("parseZernioPosts reads status, due time, link and error", () => {
  const [p] = parseZernioPosts({ posts: [post("a", "failed", ago(3), { platforms: [{ platform: "tiktok", platformPostUrl: "https://t/1", errorMessage: "rejected" }] })] });
  assert.deepEqual(p, { id: "a", status: "failed", due: ago(3), text: "Quiz a\n#tag", url: "https://t/1", error: "rejected" });
});

test("stuckPosts finds only posts over 2h past their time", () => {
  const list = [{ bot: "space", due: ago(3) }, { bot: "bcf", due: ago(1) }, { bot: "escape", due: new Date(NOW.getTime() + 3600e3).toISOString() }, { bot: "space", due: null }];
  assert.deepEqual(stuckPosts(list, NOW), [{ bot: "space", due: ago(3) }]);
});

test("lowPosting flags a bot at half its plan or less", () => {
  assert.deepEqual(lowPosting({ chess: 2, bcf: 1, escape: 0 }), [{ bot: "bcf", n: 1 }, { bot: "escape", n: 0 }]);
});

const rows = (recent, base) => [...Array(recent.n).fill(0).map((_, i) => ({ posted_at: ago(100 + i), views: recent.views })),
  ...Array(base.n).fill(0).map((_, i) => ({ posted_at: ago(150 + i * 10), views: base.views }))];

test("viewsFall spots typical views halving against the 14 days before", () => {
  assert.deepEqual(viewsFall(rows({ n: 5, views: 40 }, { n: 12, views: 700 })), { recent: 40, before: 700 });
});

test("viewsFall stays quiet on a small dip, too few videos, or old baselines", () => {
  assert.equal(viewsFall(rows({ n: 5, views: 500 }, { n: 12, views: 700 })), null);
  assert.equal(viewsFall(rows({ n: 4, views: 40 }, { n: 0, views: 700 })), null);
  assert.equal(viewsFall(rows({ n: 5, views: 40 }, { n: 9, views: 700 })), null);
  const old = [...Array(5).fill(0).map((_, i) => ({ posted_at: ago(100 + i), views: 40 })),
    ...Array(12).fill(0).map((_, i) => ({ posted_at: ago(100 + 24 * 15 + i), views: 700 }))];
  assert.equal(viewsFall(old), null);
});

test("hourly Zernio poll records published Eagle posts, the queue and views", async () => {
  const e = await env({ ZERNIO_API_KEY: "k" });
  const due = new Date(NOW.getTime() + 2 * 3600e3).toISOString();
  const fetchFn = zernio({
    posts: [post("p1", "published", ago(5), { platforms: [{ platform: "tiktok", platformPostUrl: "https://t/p1" }] }), post("q1", "scheduled", due)],
    analytics: [{ latePostId: "p1", scheduledFor: ago(5), analytics: { views: 72, likes: 1, comments: 0, shares: 2, igReelsAvgWatchTime: 12100 } }],
  });
  await runSchedule({}, e, ctx, fetchFn, NOW);
  const row = await e.DB.prepare("SELECT * FROM posts WHERE id = 'eagle:p1'").first();
  assert.equal(row.title, "Quiz p1");
  assert.equal(row.url, "https://t/p1");
  assert.equal(row.platform, "tiktok");
  const snap = await e.DB.prepare("SELECT * FROM snapshots WHERE post_id = 'eagle:p1'").first();
  assert.equal(snap.views, 72);
  assert.equal(snap.avg_watch_s, 12.1);
  assert.equal(await getState(e.DB, "eagle_next_due"), due);
  assert.equal(await getState(e.DB, "eagle_polled_at"), NOW.toISOString());
});

test("Zernio is not called off the hour or without a key", async () => {
  const withKey = zernio();
  await runSchedule({}, await env({ ZERNIO_API_KEY: "k" }), ctx, withKey, new Date("2026-11-03T12:22:00Z"));
  assert.equal(withKey.calls.filter(u => u.includes("zernio")).length, 0);
  const noKey = zernio();
  await runSchedule({}, await env(), ctx, noKey, NOW);
  assert.equal(noKey.calls.filter(u => u.includes("zernio")).length, 0);
});

test("a failed Eagle post alerts once, with the reason", async () => {
  const e = await env({ ZERNIO_API_KEY: "k" });
  const fetchFn = zernio({ posts: [post("f1", "failed", ago(3), { platforms: [{ platform: "tiktok", errorMessage: "video rejected" }] }), post("old", "failed", ago(60))] });
  await runSchedule({}, e, ctx, fetchFn, NOW);
  await runSchedule({}, e, ctx, fetchFn, new Date("2026-11-03T13:02:00Z"));
  const rows2 = await events(e, "kind = 'post_failed'");
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].count, 1);
  assert.equal(rows2[0].bot, "eagle");
  assert.equal(rows2[0].severity, "action");
  assert.match(rows2[0].body, /video rejected/);
});

test("an Eagle post stuck past its time alerts", async () => {
  const e = await env({ ZERNIO_API_KEY: "k" });
  await runSchedule({}, e, ctx, zernio({ posts: [post("s1", "publishing", ago(3))] }), NOW);
  const [ev] = await events(e, "kind = 'post_stuck'");
  assert.equal(ev.dedupe_key, "stuck:eagle");
  assert.equal(ev.severity, "action");
});

test("a Buffer post stuck past its time alerts", async () => {
  const e = await env({ BUFFER_API_KEY: "k", BUFFER_ORG_ID: "o", BUFFER_CHANNEL_BCF: "cb", BUFFER_CHANNEL_ESCAPE: "ce", BUFFER_CHANNEL_SPACE: "cs" });
  const fetchFn = async url => (url.includes("api.buffer.com")
    ? Response.json({ data: { sent: { edges: [] }, scheduled: { edges: [{ node: { id: "x", channelId: "cs", dueAt: ago(4) } }] } } })
    : new Response(null, { status: 201 }));
  await runSchedule({}, e, ctx, fetchFn, NOW);
  const [ev] = await events(e, "kind = 'post_stuck'");
  assert.equal(ev.bot, "space");
  assert.equal(ev.dedupe_key, "stuck:space");
});

async function seedPost(e, bot, ext, posted_at) {
  await e.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at) VALUES (?, ?, 'x', ?, ?, ?)")
    .bind(`${bot}:${ext}`, bot, ext, `Post ${ext}`, posted_at).run();
}

test("the morning summary warns about a bot that barely posted, not one that has never been seen", async () => {
  const e = await env();
  await seedPost(e, "bcf", "a", "2026-10-19T09:00:00.000Z");
  await seedPost(e, "bcf", "older", "2026-10-17T09:00:00.000Z");
  await seedPost(e, "chess", "c1", "2026-10-19T10:00:00.000Z");
  await seedPost(e, "chess", "c2", "2026-10-19T12:00:00.000Z");
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T06:31:00Z"));
  const rows2 = await events(e, "kind = 'low_posts'");
  assert.deepEqual(rows2.map(r => r.bot), ["bcf"]);
  assert.equal(rows2[0].severity, "warn");
  assert.equal(rows2[0].dedupe_key, "low_posts:bcf:2026-10-19");
});

async function seedMature(e, bot, n, views, startH) {
  for (let i = 0; i < n; i++) {
    const at = ago(startH + i * 6);
    await seedPost(e, bot, `${views}-${i}`, at);
    await e.DB.prepare("INSERT INTO milestones (post_id, h, views) VALUES (?, 72, ?)").bind(`${bot}:${views}-${i}`, views).run();
  }
}

test("views falling raises one warning a week, checked once a day", async () => {
  const e = await env();
  await seedMature(e, "escape", 5, 31, 80);
  await seedMature(e, "escape", 12, 724, 130);
  await runSchedule({}, e, ctx, okFetch, new Date("2026-11-03T12:02:00Z"));       // wrong hour
  assert.equal((await events(e, "kind = 'views_fall'")).length, 0);
  await runSchedule({}, e, ctx, okFetch, new Date("2026-11-03T06:02:00Z"));
  const rows2 = await events(e, "kind = 'views_fall'");
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].bot, "escape");
  assert.equal(rows2[0].severity, "warn");
  assert.match(rows2[0].title, /31/);
  await runSchedule({}, e, ctx, okFetch, new Date("2026-11-04T06:02:00Z"));
  const again = await events(e, "kind = 'views_fall'");
  assert.equal(again.length, 1);
  assert.equal(again[0].count, 1);
});

test("every tick pings the outside alarm once the database answers", async () => {
  const e = await env({ HEALTHCHECK_URL: "https://hc-ping.example/abc" });
  const calls = [];
  await runSchedule({}, e, ctx, async url => { calls.push(url); return new Response(null, { status: 200 }); }, new Date("2026-11-03T12:22:00Z"));
  assert.equal(calls.filter(u => u === "https://hc-ping.example/abc").length, 1);
});

test("no ping when the database fails, so the outside alarm goes off", async () => {
  const e = await env({ HEALTHCHECK_URL: "https://hc-ping.example/abc" });
  const real = e.DB.prepare.bind(e.DB);
  e.DB.prepare = sql => { if (sql === "SELECT 1 AS alive") throw new Error("D1 limit reached"); return real(sql); };
  const calls = [];
  await runSchedule({}, e, ctx, async url => { calls.push(url); return new Response(null, { status: 200 }); }, new Date("2026-11-03T12:22:00Z"));
  assert.equal(calls.filter(u => u.includes("hc-ping")).length, 0);
});

test("a failed ping does not raise a watcher error", async () => {
  const e = await env({ HEALTHCHECK_URL: "https://hc-ping.example/abc" });
  await runSchedule({}, e, ctx, async url => {
    if (url.includes("hc-ping")) throw new Error("network");
    return new Response(null, { status: 200 });
  }, new Date("2026-11-03T12:22:00Z"));
  assert.equal((await events(e, "kind = 'watcher_error'")).length, 0);
});
