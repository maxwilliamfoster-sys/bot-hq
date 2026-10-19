import { test } from "node:test";
import assert from "node:assert/strict";
import { runSchedule } from "../src/schedule.js";
import { makeEnv } from "./helpers.js";

const okFetch = async () => new Response(null, { status: 201 });
const ctx = { waitUntil() {} };
const env = extra => makeEnv({ PUSH_FETCH: okFetch, ...extra });
const count = async (e, where) => e.DB.prepare(`SELECT COUNT(*) n FROM events WHERE ${where}`).first("n");

async function seedPosts(e, rows) {
  for (const [bot, ext, posted_at] of rows) {
    await e.DB.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at) VALUES (?, ?, 'x', ?, ?, ?)")
      .bind(`${bot}:${ext}`, bot, ext, `Post ${ext}`, posted_at).run();
  }
}

test("07:31 UK sends the summary once; 07:36 does not send it again", async () => {
  const e = await env();
  await seedPosts(e, [["chess", "a", "2026-10-19T04:10:00.000Z"], ["chess", "b", "2026-10-19T14:10:00.000Z"]]);
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T06:31:00Z"));   // 07:31 BST
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T06:33:00Z"));
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T06:36:00Z"));
  assert.equal(await count(e, "kind = 'summary'"), 1);
  const s = await e.DB.prepare("SELECT title, body FROM events WHERE kind = 'summary'").first();
  assert.match(s.title, /2 of 8 posts/);
  assert.match(s.body, /Chess: 2 of 3/);
});

test("summary after the clock change: 07:31 GMT is 07:31Z", async () => {
  const e = await env();
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-25T06:31:00Z"));    // 06:31 GMT: too early
  assert.equal(await count(e, "kind = 'summary'"), 0);
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-25T07:31:00Z"));
  assert.equal(await count(e, "kind = 'summary'"), 1);
});

test("a thrown poller still runs checkRuns and records one system warn", async () => {
  const e = await env({ GH_READ_TOKEN: "t", YT_API_KEY: "k" });
  await seedPosts(e, [["chess", "v1", "2026-10-20T09:00:00.000Z"]]);
  const fetchFn = async url => {
    if (url.includes("googleapis")) throw new Error("youtube exploded");
    if (url.includes("/actions/runs?")) return Response.json({ workflow_runs: [{ id: 1, name: "W", conclusion: "success", event: "schedule" }] });
    return new Response(null, { status: 201 });
  };
  await runSchedule({}, e, ctx, fetchFn, new Date("2026-10-20T10:12:00Z"));
  await runSchedule({}, e, ctx, fetchFn, new Date("2026-10-20T10:17:00Z"));
  assert.ok(await e.DB.prepare("SELECT COUNT(*) n FROM runs").first("n") >= 1);
  const w = (await e.DB.prepare("SELECT bot, severity, title, count FROM events WHERE kind = 'watcher_error'").all()).results;
  assert.equal(w.length, 1);
  assert.equal(w[0].bot, "system");
  assert.equal(w[0].severity, "warn");
  assert.match(w[0].title, /Bot HQ watcher error: live stats/);
  assert.equal(w[0].count, 2);
});

test("hourly gap check alerts when chess stops posting", async () => {
  const e = await env();
  await seedPosts(e, [["chess", "a", "2026-10-19T18:00:00.000Z"], ["bcf", "b", "2026-10-20T08:00:00.000Z"]]);
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T10:02:00Z"));    // 16h since chess
  const ev = await e.DB.prepare("SELECT bot, severity FROM events WHERE kind = 'no_posts'").all();
  assert.deepEqual(ev.results, [{ bot: "chess", severity: "action" }]);
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T10:22:00Z"));    // not on the hour: no recheck
  assert.equal(await e.DB.prepare("SELECT count FROM events WHERE kind = 'no_posts'").first("count"), 1);
});

test("doing well fires once per post per milestone against the same bot's history", async () => {
  const e = await env();
  const base = Date.parse("2026-10-01T00:00:00Z");
  const rows = [];
  for (let i = 0; i < 25; i++) {
    const posted = new Date(base + i * 8 * 3600e3);
    rows.push(["chess", `h${i}`, posted.toISOString()]);
  }
  await seedPosts(e, rows);
  for (let i = 0; i < 25; i++) {      // history: views at 1h = 100..2500
    const at = new Date(base + i * 8 * 3600e3 + 65 * 60e3).toISOString();
    await e.DB.prepare("INSERT INTO snapshots (post_id, at, views) VALUES (?, ?, ?)").bind(`chess:h${i}`, at, (i + 1) * 100).run();
  }
  const posted = "2026-10-20T09:00:00.000Z";
  await seedPosts(e, [["chess", "new", posted]]);
  for (const [min, views] of [[30, 1500], [62, 3000]]) {
    await e.DB.prepare("INSERT INTO snapshots (post_id, at, views) VALUES (?, ?, ?)")
      .bind("chess:new", new Date(Date.parse(posted) + min * 60e3).toISOString(), views).run();
  }
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T10:07:00Z"));
  await runSchedule({}, e, ctx, okFetch, new Date("2026-10-20T10:12:00Z"));
  const good = (await e.DB.prepare("SELECT title, dedupe_key, count FROM events WHERE severity = 'good'").all()).results;
  assert.equal(good.length, 1);
  assert.equal(good[0].dedupe_key, "good:chess:new:1");
  assert.equal(good[0].count, 1);
  assert.match(good[0].title, /^Chess: top 10% at 1h/);
});

test("new Escape Cup Buffer posts become 'posted' events; old ones don't", async () => {
  const e = await env({ BUFFER_API_KEY: "b", BUFFER_ORG_ID: "o", BUFFER_CHANNEL_BCF: "cb", BUFFER_CHANNEL_ESCAPE: "ce" });
  const node = (id, sentAt) => ({ node: { id, channelId: "ce", sentAt, text: `Match ${id}`, metrics: [] } });
  const fetchFn = async url => url === "https://api.buffer.com"
    ? Response.json({ data: { sent: { edges: [node("new", "2026-10-20T09:40:00.000Z"), node("old", "2026-10-18T09:40:00.000Z")] }, scheduled: { edges: [] } } })
    : new Response(null, { status: 201 });
  await runSchedule({}, e, ctx, fetchFn, new Date("2026-10-20T10:01:00Z"));
  const posted = (await e.DB.prepare("SELECT bot, title FROM events WHERE kind = 'posted'").all()).results;
  assert.deepEqual(posted, [{ bot: "escape", title: "Escape Cup posted: Match new" }]);
});

test("hourly tick refreshes today's gate checks from the bots' gate logs", async () => {
  const e = await env({ GH_READ_TOKEN: "t" });
  const log = { entries: [{ checked_at: "2026-10-20T09:10:00+00:00", ok: true, ai: { available: true } },
    { checked_at: "2026-10-17T09:10:00+00:00", ok: true, ai: { available: true } }] };
  const fetchFn = async url => {
    if (url.includes("/contents/upload_gate_log.json")) return new Response(JSON.stringify(log));
    if (url.includes("/actions/runs?")) return Response.json({ workflow_runs: [] });
    return new Response(null, { status: 201 });
  };
  await runSchedule({}, e, ctx, fetchFn, new Date("2026-10-20T10:02:00Z"));
  const rows = (await e.DB.prepare("SELECT bot, at FROM gate ORDER BY bot").all()).results;
  assert.deepEqual(rows.map(r => r.bot), ["bcf", "chess", "escape"]);   // only the recent entry, once per bot
  await runSchedule({}, e, ctx, fetchFn, new Date("2026-10-20T11:02:00Z"));
  assert.equal(await e.DB.prepare("SELECT COUNT(*) n FROM gate").first("n"), 3);
});
