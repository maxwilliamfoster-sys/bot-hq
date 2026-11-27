// Trend intelligence: lifecycle, allegation flags, history fit and originality from the account's own videos,
// the collector context route, and the daily upkeep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, signIn } from "./helpers.js";
import { flagsFor, lifecycle, historyFor, buildHistory, loadHistory, trendUpkeep, indexPosts } from "../src/trends/intel.js";
import { distinctWords } from "../src/trends/text.js";
import { setState } from "../src/settings.js";
import { scoreOpportunity } from "../src/trends/score.js";

const DAY = 864e5;
const NOW = new Date("2026-11-27T06:00:00.000Z");
const BOT = { authorization: "Bearer bot-token" };
const ago = d => new Date(NOW - d * DAY).toISOString();

test("allegations are flagged until the evidence has a verdict", () => {
  assert.deepEqual(flagsFor("Man accused of murdering pensioner, jury told"), ["active_case"]);
  assert.deepEqual(flagsFor("Grandmaster accused of cheating"), ["active_case"]);
  assert.deepEqual(flagsFor("Man accused of murder.\nMan found guilty of murder and jailed for life"), []);
  assert.deepEqual(flagsFor("Woman acquitted of all charges"), []);
  assert.deepEqual(flagsFor("New nebula photo from Hubble"), []);
});

test("lifecycle comes from the snapshots and never guesses", () => {
  const t = (first, last, previous = "flat") => ({ first_seen: ago(first), last_seen: ago(last), previous });
  const s = (...m) => m.map((momentum, i) => ({ day: `2026-11-${String(10 + i).padStart(2, "0")}`, momentum }));
  assert.equal(lifecycle(t(20, 15), s(0.1, 0.5, 0.9), NOW), "expired");
  assert.equal(lifecycle(t(1, 0), s(0.1, 0.5, 0.9), NOW), "new");
  assert.equal(lifecycle(t(5, 0), s(0.4, 0.6), NOW), "not_enough_data");
  assert.equal(lifecycle(t(5, 0), [...s(0.2, 0.3), { day: "2026-11-12", momentum: null }], NOW), "not_enough_data");
  assert.equal(lifecycle(t(5, 0), s(0.2, 0.3, 0.6), NOW), "accelerating");
  assert.equal(lifecycle(t(5, 0), s(0.2, 0.5, 0.55), NOW), "emerging");
  assert.equal(lifecycle(t(5, 0), s(0.8, 0.81, 0.8), NOW), "peak");
  assert.equal(lifecycle(t(5, 0), s(0.2, 0.21, 0.2), NOW), "flat");
  assert.equal(lifecycle(t(5, 0), s(0.9, 0.7, 0.5), NOW), "declining");
  assert.equal(lifecycle(t(5, 0, "declining"), s(0.9, 0.5, 0.6), NOW), "re_emerging");
  const sat = [{ day: "2026-11-10", momentum: 0.5 }, { day: "2026-11-11", momentum: 0.6, volume: 1000, competitor_count: 10 },
    { day: "2026-11-12", momentum: 0.7, volume: 1100, competitor_count: 30 }];
  assert.equal(lifecycle(t(5, 0), sat, NOW), "saturating");
});

const hist = (posts, extra = {}) => ({
  n: posts.length || 1, ...indexPosts(posts.map(([title, r, d]) => [title, r, ago(d).slice(0, 10)])),
  approaches: [], ideas: [], ...extra,
});
const topic = distinctWords("Magnus Carlsen");

test("history fit: past videos on the topic count by how they did, fading with age", () => {
  const good = historyFor(hist([["Magnus Carlsen blunders a rook", 4, 10], ["Magnus Carlsen's best trick", 4, 20]]), topic, NOW);
  assert.ok(good.history_fit > 0.3 && good.history_fit <= 1);
  assert.equal(good.history_matches, 2);
  const old = historyFor(hist([["Magnus Carlsen blunders a rook", 4, 170], ["Magnus Carlsen's best trick", 4, 175]]), topic, NOW);
  assert.ok(old.history_fit === good.history_fit, "age weights the average; one-sided evidence stays one-sided");
  const mixed = historyFor(hist([["Magnus Carlsen blunders", 4, 150], ["Magnus Carlsen wins", 0.25, 5]]), topic, NOW);
  assert.ok(mixed.history_fit < 0, "the recent flop outweighs the old hit");
  const bad = historyFor(hist([["Magnus Carlsen blunders", 0.1, 5], ["Mate in 2", 3, 5]]), topic, NOW);
  assert.equal(bad.history_fit, 0, "one bad video alone never counts against a topic");
  const none = historyFor(hist([["Mate in 2 puzzle", 3, 5]]), topic, NOW);
  assert.equal(none.history_fit, undefined, "no matching video: no fit claimed");
  assert.deepEqual(historyFor(undefined, topic, NOW), {}, "no history at all: nothing claimed");
  assert.deepEqual(historyFor(hist([["Chess", 3, 5]]), distinctWords("Chess"), NOW), {}, "one-word topics can't match");
});

test("originality drops when the account covered the topic recently or already plans it", () => {
  assert.equal(historyFor(hist([["Mate in 2", 1, 5]]), topic, NOW).originality, 1);
  assert.equal(historyFor(hist([["Magnus Carlsen trick", 1, 10]]), topic, NOW).originality, 0.2);
  assert.equal(historyFor(hist([["Magnus Carlsen trick", 1, 60]]), topic, NOW).originality, 0.5);
  assert.equal(historyFor(hist([["Magnus Carlsen trick", 1, 120]]), topic, NOW).originality, 0.8);
  const planned = hist([["Mate in 2", 1, 5]], { ideas: [[...distinctWords("Do a Magnus Carlsen speedrun short")].join(" ")] });
  assert.equal(historyFor(planned, topic, NOW).originality, 0.6);
});

test("history fit moves the score by at most 3 points at default weights", () => {
  const gate = { passed: true, relevance: 1 };
  const base = { momentum: 0.5, audience: 0.5, performance: 0.5, competition: 0.5, timeliness: 0.5, originality: 0.5 };
  const s0 = scoreOpportunity(gate, base).score;
  assert.equal(scoreOpportunity(gate, { ...base, history_fit: 1 }).score, s0 + 3);
  assert.equal(scoreOpportunity(gate, { ...base, history_fit: -1 }).score, s0 - 3);
  assert.equal(scoreOpportunity(gate, { ...base, history_fit: 9 }).score, s0 + 3, "clamped");
  assert.equal(scoreOpportunity({ passed: false }, { ...base, history_fit: 1 }).score, null, "never rescues a failed gate");
});

async function seedPosts(env, bot, rows) {
  for (const [i, [title, views, days]] of rows.entries()) {
    const id = `${bot}-${i}`;
    await env.DB.prepare("INSERT INTO posts (id, bot, title, posted_at) VALUES (?, ?, ?, ?)").bind(id, bot, title, ago(days)).run();
    await env.DB.prepare("INSERT INTO snapshots (post_id, at, views) VALUES (?, ?, ?)").bind(id, ago(days - 1), views).run();
  }
}

test("the daily history is built from stored posts and the autopilot block, per account", async () => {
  const env = await makeEnv({ NOW: () => NOW });
  await seedPosts(env, "chess", [["Magnus Carlsen blunders a rook", 8000, 10], ["Mate in 2", 1000, 12], ["Mate in 3", 1000, 14],
    ["Old video", 500, 400]]);
  await seedPosts(env, "space", [["Magnus Carlsen in space", 100000, 3]]);
  await setState(env.DB, "tracker", JSON.stringify({ autopilot: { accounts: [{ key: "chess",
    approaches: [{ date: "2026-11-01", family: "hook", what: "Magnus Carlsen face on frame 0", outcome: "won" },
      { date: "2026-11-02", family: "slot", what: "x", outcome: "running" }],
    ideas_open: ["Magnus Carlsen speedrun"] }] } }));
  const r = await buildHistory(env.DB, NOW);
  assert.equal(r.posts, 4, "the 400-day-old video is outside the window");
  const h = await loadHistory(env.DB);
  assert.equal(h.get("chess").n, 3);
  assert.equal(h.get("chess").approaches.length, 1, "only finished approaches count");
  const out = historyFor(h.get("chess"), topic, NOW);
  assert.ok(out.history_fit > 0);
  assert.equal(out.originality, 0.2);
  assert.equal(h.get("space").n, 1, "each account only sees its own videos");
});

test("ingest adds history fit, originality, lifecycle and flags, and exposes them", async () => {
  let now = NOW;
  const env = await makeEnv({ NOW: () => now });
  const cookie = await signIn(env);
  await seedPosts(env, "bcf", [["The Joanna Yeates case explained", 50000, 120], ["Other case", 10000, 20], ["Another", 10000, 30]]);
  await buildHistory(env.DB, NOW);
  const cand = (day, momentum, title) => ({
    name: "Joanna Yeates case", for_accounts: ["buried"],
    signals: [{ source: "news_rss", source_type: "news", url: `https://example.org/${day}`, title, fetched_at: now.toISOString() },
      { source: "wikipedia", source_type: "wiki", url: "https://en.wikipedia.org/wiki/Murder_of_Joanna_Yeates", title: "Murder of Joanna Yeates", fetched_at: now.toISOString() }],
    components: { momentum, originality: 1 }, snapshot: { momentum },
  });
  await call(env, "POST", "/api/trends/batch", { body: { candidates: [cand(1, 0.2, "Man accused of murder in Joanna Yeates case, trial told")] }, headers: BOT });
  let l = await (await call(env, "GET", "/api/trends?account=buried", { cookie })).json();
  const o = l.items[0];
  assert.deepEqual(o.flags, ["active_case"]);
  assert.equal(o.lifecycle, "new");
  const d = await (await call(env, "GET", `/api/trends/${o.trend_id}?account=buried`, { cookie })).json();
  assert.equal(d.opportunities[0].components.originality, 0.8, "covered 120 days ago; the collector's 1 is ignored");
  assert.ok(d.opportunities[0].components.history_fit === 0 || d.opportunities[0].components.history_fit > 0);
  assert.deepEqual(d.trend.flags, ["active_case"]);
  for (const [i, m] of [[3, 0.4], [4, 0.7]]) {
    now = new Date(NOW.getTime() + i * DAY);
    await call(env, "POST", "/api/trends/batch", { body: { candidates: [cand(i, m, "Joanna Yeates killer found guilty and sentenced")] }, headers: BOT });
  }
  l = await (await call(env, "GET", "/api/trends?account=buried", { cookie })).json();
  assert.equal(l.items[0].lifecycle, "accelerating");
  assert.deepEqual(l.items[0].flags, [], "a verdict in the evidence clears the flag");
});

test("the collector context gives YouTube competitor links only, with the bot token only", async () => {
  const env = await makeEnv({ NOW: () => NOW });
  await setState(env.DB, "tracker", JSON.stringify({ autopilot: { accounts: [
    { key: "chess", ideas_open: ["secret plan"], competitors: [
      { channel: "A", url: "https://www.youtube.com/@thechessnerd", why: "private notes" },
      { channel: "B", url: "https://www.youtube.com/channel/UCprx6INCbO8JPF257qN3qSQ" },
      { channel: "C", url: "https://www.tiktok.com/@someone" },
      { channel: "D", url: "javascript:alert(1)" }] }] } }));
  assert.equal((await call(env, "GET", "/api/trends/context")).status, 401);
  const r = await (await call(env, "GET", "/api/trends/context", { headers: BOT })).json();
  assert.deepEqual(r.accounts.chess.map(c => c.channel), ["A", "B"]);
  assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes("private"));
  assert.deepEqual(r.accounts.space, []);
});

test("daily upkeep expires stale trends and drops old failed-gate rows, but keeps Max's rejections", async () => {
  const env = await makeEnv({ NOW: () => NOW });
  const db = env.DB;
  await db.prepare("INSERT INTO trends (id, dedupe_key, name, first_seen, last_seen) VALUES (1, 'a', 'A', ?, ?), (2, 'b', 'B', ?, ?)")
    .bind(ago(40), ago(20), ago(3), ago(1)).run();
  const opp = (id, trend, account, cls, status, updated) => db.prepare(
    `INSERT INTO opportunities (id, trend_id, account, gate_passed, profile_hash, class, evidence, status, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'h', ?, 'emerging', ?, ?, ?)`).bind(id, trend, account, cls, status, updated, updated).run();
  await opp(1, 1, "chess", "rejected", "new", ago(40));
  await opp(2, 1, "space", "low", "rejected", ago(40));
  await opp(3, 2, "chess", "rejected", "new", ago(2));
  const r = await trendUpkeep(db, NOW);
  assert.equal(r.expired, 1);
  assert.equal(r.cleaned, 1);
  const left = (await db.prepare("SELECT id FROM opportunities ORDER BY id").all()).results.map(x => x.id);
  assert.deepEqual(left, [2, 3]);
  assert.equal(await db.prepare("SELECT lifecycle FROM trends WHERE id = 1").first("lifecycle"), "expired");
});

test("a full batch with a large history stays inside the CPU budget", async () => {
  const env = await makeEnv({ NOW: () => NOW });
  const titles = Array.from({ length: 200 }, (_, i) => `Video number ${i} about chess tactics and Magnus Carlsen ideas`);
  for (const bot of ["chess", "bcf", "space", "escape", "perc", "bodge", "gary", "niche"]) {
    await seedPosts(env, bot, titles.map((t, i) => [t, 1000 + i, 5 + (i % 150)]));
  }
  await buildHistory(env.DB, NOW);
  const big = "Magnus Carlsen chess grandmaster checkmate gambit nebula telescope murder ".repeat(12).slice(0, 1000);
  const cands = Array.from({ length: 5 }, (_, i) => ({ name: `Magnus Carlsen chess story ${i}`, text: big,
    signals: Array.from({ length: 10 }, (_, j) => ({ source: "news_rss", source_type: "news", url: `https://e.org/${i}/${j}`,
      title: big.slice(0, 300), fetched_at: NOW.toISOString() })), components: { momentum: 0.5 }, snapshot: { momentum: 0.5 } }));
  // Warm up (JIT), then time the work the Worker would do. The D1 fake's own time is included, so this is an
  // upper bound on the Worker's CPU.
  await call(env, "POST", "/api/trends/batch", { body: { candidates: cands }, headers: BOT });
  const t0 = performance.now();
  await call(env, "POST", "/api/trends/batch", { body: { candidates: cands }, headers: BOT });
  const ms = performance.now() - t0;
  console.log(`batch of 5 with 8 x 200-video histories: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 60, `took ${ms} ms`);
});
