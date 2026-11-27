// Trend context for fair test judging: which of an account's recent videos were on a topic trending when they
// went out, with each video's arm and views against the account's usual views.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, signIn } from "./helpers.js";
import { buildHistory } from "../src/trends/intel.js";

const DAY = 864e5;
const NOW = new Date("2026-11-27T06:00:00.000Z");
const BOT = { authorization: "Bearer bot-token" };
const ago = d => new Date(NOW - d * DAY).toISOString();
const ALL = { momentum: 1, audience: 1, performance: 1, competition: 1, timeliness: 1, originality: 1 };

async function post(env, id, bot, title, days, views, variant = null) {
  await env.DB.prepare("INSERT INTO posts (id, bot, title, posted_at, variant) VALUES (?, ?, ?, ?, ?)")
    .bind(id, bot, title, ago(days), variant).run();
  await env.DB.prepare("INSERT INTO snapshots (post_id, at, views) VALUES (?, ?, ?)").bind(id, ago(Math.max(0, days - 3)), views).run();
}
const cand = (name, account, title) => ({ name, for_accounts: [account], components: ALL,
  signals: [{ source: "news_rss", source_type: "news", url: `https://example.org/${encodeURIComponent(name)}`, title, fetched_at: ago(0) }] });

async function seeded() {
  let now = new Date(NOW - 10 * DAY);                       // Bot HQ first sees both trends 10 days ago
  const env = await makeEnv({ NOW: () => now });
  const cookie = await signIn(env);
  await call(env, "POST", "/api/trends/batch", { headers: BOT, body: { candidates: [
    cand("Magnus Carlsen", "chess", "Magnus Carlsen wins blitz chess title"),
    cand("James Webb telescope", "space", "James Webb telescope captures new image of the Pillars of Creation nebula"),
  ] } });
  now = NOW;
  for (let i = 0; i < 6; i++) await post(env, `base${i}`, "chess", `Mate in ${i + 2} puzzle`, 30 + i * 8, 1000, "A");
  await post(env, "boosted", "chess", "Magnus Carlsen blunders a rook in blitz", 9, 8000, "B");
  await post(env, "plain", "chess", "Find the move: knight fork", 9, 1000, "A");
  await post(env, "later", "chess", "Magnus Carlsen endgame trick", 2, 3000, "B");      // the trend wasn't seen then
  await post(env, "before", "chess", "Magnus Carlsen old interview", 20, 900, "A");     // before any trend data
  await post(env, "other", "chess", "James Webb telescope finds a chess board", 9, 5000, "B"); // a space trend
  return { env, cookie };
}
const ctx = async (env, q) => {
  const r = await call(env, "GET", `/api/trends/videos${q}`, { headers: BOT });
  return { status: r.status, body: await r.json() };
};

test("the trend context is for the bot credential only and needs a real account", async () => {
  const { env, cookie } = await seeded();
  assert.equal((await call(env, "GET", "/api/trends/videos?account=chess", { cookie })).status, 401);
  assert.equal((await ctx(env, "?account=nope")).status, 400);
  assert.equal((await ctx(env, "")).status, 400);
});

test("a video is marked only when its topic was trending for this account when it went out", async () => {
  const { env } = await seeded();
  const { status, body } = await ctx(env, "?account=chess");
  assert.equal(status, 200);
  assert.equal(body.median_views, 1000);
  assert.equal(body.trend_data_since, ago(10));
  const v = Object.fromEntries(body.videos.map(x => [x.id, x]));
  assert.deepEqual(v.boosted.trends.map(t => t.name), ["Magnus Carlsen"]);
  assert.equal(v.boosted.variant, "B");
  assert.equal(v.boosted.ratio, 8);
  assert.equal(v.boosted.checked, true);
  assert.deepEqual(v.plain.trends, []);
  assert.deepEqual(v.later.trends, [], "a trend counts only up to 2 days after it was last seen");
  assert.deepEqual(v.other.trends, [], "another account's trend never marks this account's videos");
  assert.equal(v.before.checked, false, "videos from before Bot HQ had trend data can't be checked");
  assert.ok(!("base0" in v), "only the window asked for (28 days by default)");
  assert.ok(body.videos.every(x => x.age_hours >= 0));
});

test("the window can be widened, up to 60 days", async () => {
  const { env } = await seeded();
  assert.ok((await ctx(env, "?account=chess&days=40")).body.videos.some(x => x.id === "base0"));
  assert.equal((await ctx(env, "?account=chess&days=999")).body.days, 60);
});

test("400 trends against 120 recent videos stays inside the CPU budget", async () => {
  const env = await makeEnv({ NOW: () => new Date(NOW - DAY) });
  for (let b = 0; b < 80; b++) {
    await call(env, "POST", "/api/trends/batch", { headers: BOT, body: { candidates: Array.from({ length: 5 }, (_, i) =>
      cand(`Chess grandmaster story ${b} ${i} Carlsen Gukesh Nakamura`, "chess", `Grandmaster ${b}-${i} wins blitz chess event`)) } });
  }
  for (let i = 0; i < 120; i++) await post(env, `p${i}`, "chess", `Grandmaster Carlsen blitz chess puzzle number ${i}`, i % 27, 1000 + i, i % 2 ? "A" : "B");
  await ctx(env, "?account=chess");                         // warm up (JIT)
  const t0 = performance.now();
  const { body } = await ctx(env, "?account=chess");
  const ms = performance.now() - t0;
  console.log(`trend context, 400 trends x 120 videos: ${ms.toFixed(1)} ms`);
  assert.equal(body.videos.length, 120);
  assert.ok(ms < 60, `took ${ms} ms`);
});

test("a trend's page shows how this account's own videos on the topic did", async () => {
  const { env, cookie } = await seeded();
  await buildHistory(env.DB, NOW);
  const { items } = await (await call(env, "GET", "/api/trends?account=chess", { cookie })).json();
  const d = await (await call(env, "GET", `/api/trends/${items[0].trend_id}`, { cookie })).json();
  const o = d.opportunities.find(x => x.account === "chess");
  assert.ok(o.topic_videos.length >= 3);
  assert.ok(o.topic_videos.some(x => x.ratio === 8));
  assert.ok(o.topic_videos.every((x, i, a) => i === 0 || a[i - 1].date >= x.date), "newest first");
});
