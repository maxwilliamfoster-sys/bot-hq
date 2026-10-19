import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSlot } from "../src/views.js";
import { parseGateLog } from "../src/watch/gate.js";
import { setState } from "../src/settings.js";
import { makeEnv, call, signIn } from "./helpers.js";

const Z = s => new Date(s);

test("chess next slot: 13:50 UTC -> 14:00; after 22:00 -> tomorrow 04:00", () => {
  assert.equal(nextSlot("chess", Z("2026-10-20T13:50:00Z")), "2026-10-20T14:00:00.000Z");
  assert.equal(nextSlot("chess", Z("2026-10-20T22:10:00Z")), "2026-10-21T04:00:00.000Z");
});

test("BuriedCasefiles next slot follows UK time across the clock change", () => {
  assert.equal(nextSlot("bcf", Z("2026-10-20T11:00:00Z")), "2026-10-20T11:45:00.000Z");   // 12:45 BST
  assert.equal(nextSlot("bcf", Z("2026-10-26T10:00:00Z")), "2026-10-26T12:45:00.000Z");   // 12:45 GMT
  assert.equal(nextSlot("bcf", Z("2026-10-20T15:00:00Z")), "2026-10-21T08:15:00.000Z");   // after 15:45 BST
});

test("Escape Cup next slot is the next scheduled Buffer post", () => {
  assert.equal(nextSlot("escape", Z("2026-10-20T10:00:00Z"), "2026-10-21T15:30:00.000Z"), "2026-10-21T15:30:00.000Z");
  assert.equal(nextSlot("escape", Z("2026-10-22T10:00:00Z"), "2026-10-21T15:30:00.000Z"), null);
  assert.equal(nextSlot("escape", Z("2026-10-22T10:00:00Z"), null), null);
});

test("parseGateLog keeps ok and real AI use", () => {
  const log = { entries: [
    { checked_at: "2026-10-20T09:00:00+00:00", ok: true, ai: { available: true } },
    { checked_at: "2026-10-20T09:30:00+00:00", ok: false, ai: { available: false } },
    { checked_at: "2026-10-20T10:00:00+00:00", ok: true },
  ] };
  assert.deepEqual(parseGateLog("bcf", log), [
    { bot: "bcf", at: "2026-10-20T09:00:00.000Z", ok: 1, ai_used: 1 },
    { bot: "bcf", at: "2026-10-20T09:30:00.000Z", ok: 0, ai_used: 0 },
    { bot: "bcf", at: "2026-10-20T10:00:00.000Z", ok: 1, ai_used: 0 },
  ]);
});

const NOW = "2026-10-20T13:50:00.000Z";
const minsAgo = m => new Date(Date.parse(NOW) - m * 60e3).toISOString();

async function seeded() {
  const env = await makeEnv({ NOW: () => new Date(NOW) });
  const post = (id, bot, at, title) => env.DB.prepare(
    "INSERT INTO posts (id, bot, platform, external_id, title, posted_at, url) VALUES (?, ?, 'x', ?, ?, ?, ?)")
    .bind(id, bot, id.split(":")[1], title, at, `https://example.com/${id}`).run();
  await post("chess:a", "chess", minsAgo(130), "Mate in 2");
  await post("chess:b", "chess", minsAgo(20), "Fork it");
  await post("chess:old", "chess", minsAgo(30 * 60), "Yesterday's");
  await post("escape:e1", "escape", minsAgo(300), "England v Brazil");
  for (const [m, v] of [[120, 50], [65, 100], [5, 180]]) {
    await env.DB.prepare("INSERT INTO snapshots (post_id, at, views) VALUES ('chess:a', ?, ?)").bind(minsAgo(m), v).run();
  }
  await env.DB.prepare("INSERT INTO runs (repo, run_id, workflow, conclusion, at, url) VALUES ('chess-puzzle-automation', 1, 'Post Chess Puzzle', 'success', ?, 'https://gh/1')").bind(minsAgo(60)).run();
  await env.DB.prepare("INSERT INTO runs (repo, run_id, workflow, conclusion, at, url) VALUES ('chess-puzzle-automation', 2, 'Post Chess Puzzle', 'failure', ?, 'https://gh/2')").bind(minsAgo(10)).run();
  await setState(env.DB, "escape_next_due", "2026-10-20T15:30:00.000Z");
  return env;
}

test("GET /api/live: today's counts, views, 1-hour change and sparkline", async () => {
  const env = await seeded();
  const cookie = await signIn(env);
  assert.equal((await call(env, "GET", "/api/live")).status, 401);
  const live = await (await call(env, "GET", "/api/live", { cookie })).json();
  assert.equal(live.updated_at, NOW);
  const chess = live.bots.find(b => b.bot === "chess");
  assert.deepEqual(chess.today, { posted: 2, planned: 3 });
  assert.equal(chess.next_slot, "2026-10-20T14:00:00.000Z");
  assert.deepEqual(chess.last_run, { conclusion: "failure", url: "https://gh/2", at: minsAgo(10), workflow: "Post Chess Puzzle" });
  assert.deepEqual(chess.posts.map(p => p.id), ["chess:b", "chess:a"]);         // newest first, last 24h only
  const a = chess.posts[1];
  assert.equal(a.views, 180);
  assert.equal(a.delta_1h, 80);
  assert.deepEqual(a.spark, [50, 100, 180]);
  assert.equal(chess.stats_at, minsAgo(5));
  assert.equal(chess.posts[0].views, null);
  const esc = live.bots.find(b => b.bot === "escape");
  assert.equal(esc.next_slot, "2026-10-20T15:30:00.000Z");
  assert.deepEqual(esc.today, { posted: 1, planned: 2 });
  assert.deepEqual(live.bots.map(b => b.bot), ["chess", "bcf", "escape"]);
});

test("GET /api/bots: workflows with last 5 runs, experiments from the digest, AI use vs cap", async () => {
  const env = await seeded();
  const cookie = await signIn(env);
  for (let i = 3; i < 10; i++) {
    await env.DB.prepare("INSERT INTO runs (repo, run_id, workflow, conclusion, at, url) VALUES ('chess-puzzle-automation', ?, 'Experiment Loop', 'success', ?, ?)")
      .bind(i, minsAgo(1000 - i), `https://gh/${i}`).run();
  }
  await env.DB.prepare("INSERT INTO events (at, last_at, bot, kind, severity, title, data_json, dedupe_key) VALUES (?, ?, 'chess', 'digest', 'info', 'Morning digest', ?, 'digest:2026-10-20')")
    .bind(minsAgo(400), minsAgo(400), JSON.stringify({ experiments: [{ bot: "escape", id: "escape-cup-format-1", metric: "views@72h", n: 9, min_n: 12 }] })).run();
  for (const [at, ai] of [[minsAgo(30), 1], [minsAgo(40), 1], [minsAgo(50), 0], ["2026-10-19T20:00:00.000Z", 1]]) {
    await env.DB.prepare("INSERT INTO gate (bot, at, ok, ai_used) VALUES ('bcf', ?, 1, ?)").bind(at, ai).run();
  }
  const out = await (await call(env, "GET", "/api/bots", { cookie })).json();
  const chess = out.bots.find(b => b.bot === "chess");
  const loop = chess.workflows.find(w => w.name === "Experiment Loop");
  assert.equal(loop.runs.length, 5);
  assert.equal(loop.runs[0].url, "https://gh/9");                      // newest first
  assert.equal(chess.workflows[0].name, "Post Chess Puzzle");           // most recent run first
  const bcf = out.bots.find(b => b.bot === "bcf");
  assert.deepEqual(bcf.ai, { used: 2, cap: 20, checks: 3 });          // UTC day only
  assert.deepEqual(chess.ai, { used: 0, cap: 10, checks: 0 });
  assert.deepEqual(out.experiments.map(x => x.id), ["escape-cup-format-1"]);
});
