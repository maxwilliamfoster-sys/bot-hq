import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraphQuery, runGraph, METRICS, GROUPS, PRESETS } from "../src/query.js";
import { makeEnv, call, signIn } from "./helpers.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const ALL = ["chess", "bcf", "escape"];

async function seeded() {
  const env = await makeEnv({ NOW: () => NOW });
  const db = env.DB;
  const posts = [
    ["chess:a", "chess", "2026-10-19T13:05:00.000Z", "v1-countdown", null, 20],
    ["chess:b", "chess", "2026-10-18T21:05:00.000Z", "v1-countdown", null, 20],
    ["escape:c", "escape", "2026-10-17T15:30:00.000Z", "v2", "cup", 35],
    ["escape:r", "escape", "2026-10-16T15:30:00.000Z", "v2", "royale", 38],
    ["bcf:d", "bcf", "2026-10-15T08:15:00.000Z", "v3-calm", null, 40],
  ];
  for (const [id, bot, at, format, variant, len] of posts) {
    await db.prepare("INSERT INTO posts (id, bot, platform, external_id, title, posted_at, format, variant, length_s) VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?)")
      .bind(id, bot, id.split(":")[1], `Post ${id}`, at, format, variant, len).run();
    await db.prepare("INSERT INTO snapshots (post_id, at, views, likes, comments, shares, avg_watch_s) VALUES (?, ?, 100, 5, 1, 0, 10)")
      .bind(id, new Date(Date.parse(at) + 3600e3).toISOString()).run();
    await db.prepare("INSERT INTO snapshots (post_id, at, views, likes, comments, shares, avg_watch_s) VALUES (?, ?, 900, 40, 3, 2, 12)")
      .bind(id, new Date(Date.parse(at) + 30 * 3600e3).toISOString()).run();
  }
  for (const [id, h, v] of [["chess:a", 24, 700], ["chess:b", 24, 300], ["escape:c", 72, 1000], ["escape:r", 72, 2500], ["escape:c", 24, 800]]) {
    await db.prepare("INSERT INTO milestones (post_id, h, views) VALUES (?, ?, ?)").bind(id, h, v).run();
  }
  for (const [bot, at, f] of [["chess", "2026-10-18T05:00:00.000Z", 30], ["chess", "2026-10-19T05:00:00.000Z", 33], ["bcf", "2026-10-19T05:00:00.000Z", 350]]) {
    await db.prepare("INSERT INTO account (bot, at, followers) VALUES (?, ?, ?)").bind(bot, at, f).run();
  }
  for (const [at, ok, ai] of [["2026-10-19T09:00:00.000Z", 1, 1], ["2026-10-19T10:00:00.000Z", 0, 1], ["2026-10-19T11:00:00.000Z", 1, 0]]) {
    await db.prepare("INSERT INTO gate (bot, at, ok, ai_used) VALUES ('bcf', ?, ?, ?)").bind(at, ok, ai).run();
  }
  return env;
}

test("every metric x groupBy combination runs", async () => {
  const env = await seeded();
  for (const metric of METRICS) {
    for (const groupBy of GROUPS) {
      for (const compare of [undefined, "bots", "variant"]) {
        const out = await runGraph(env.DB, { metric, bots: ALL, range: "30d", groupBy, chart: "bar", compare }, NOW);
        assert.ok(!out.error, `${metric}/${groupBy}/${compare}: ${out.error}`);
        assert.ok(Array.isArray(out.labels) && Array.isArray(out.series), `${metric}/${groupBy}`);
        for (const s of out.series) assert.equal(s.data.length, out.labels.length, `${metric}/${groupBy}/${compare}`);
      }
    }
  }
});

test("unknown or unsafe input is an error, never SQL", () => {
  assert.ok(buildGraphQuery({ metric: "views; DROP TABLE posts", bots: ALL, range: "7d", groupBy: "day", chart: "line" }).error);
  assert.ok(buildGraphQuery({ metric: "views", bots: ["reddit"], range: "7d", groupBy: "day", chart: "line" }).error);
  assert.ok(buildGraphQuery({ metric: "views", bots: ALL, range: "forever", groupBy: "day", chart: "line" }).error);
  assert.ok(buildGraphQuery({ metric: "views", bots: ALL, range: { from: "nope", to: "2026-10-20" }, groupBy: "day", chart: "line" }).error);
  assert.ok(buildGraphQuery({ metric: "views", bots: ALL, range: "7d", groupBy: "p.id", chart: "line" }).error);
  assert.ok(buildGraphQuery({ metric: "views", bots: ALL, range: "7d", groupBy: "day", chart: "pie" }).error);
  assert.ok(!buildGraphQuery({ metric: "views", bots: ALL, range: "7d", groupBy: "day", chart: "line" }).error);
});

test("views at 24h per post uses the settled milestone", async () => {
  const env = await seeded();
  const out = await runGraph(env.DB, { metric: "views_24h", bots: ["chess"], range: "7d", groupBy: "post", chart: "bar" }, NOW);
  assert.deepEqual(out.labels, ["Post chess:b", "Post chess:a"]);           // oldest first
  assert.deepEqual(out.series, [{ name: "Chess", data: [300, 700], n: [1, 1] }]);
  assert.equal(out.unit, "views");
});

test("compare by variant gives one series per arm", async () => {
  const env = await seeded();
  const out = await runGraph(env.DB, { metric: "views_72h", bots: ["escape"], range: "all", groupBy: "week", chart: "bar", compare: "variant" }, NOW);
  assert.deepEqual(out.series.map(s => s.name).sort(), ["cup", "royale"]);
  const byVariant = await runGraph(env.DB, { metric: "views_72h", bots: ["escape"], range: "all", groupBy: "variant", chart: "bar" }, NOW);
  assert.deepEqual(byVariant.labels, ["cup", "royale"]);
  assert.deepEqual(byVariant.series[0].data, [1000, 2500]);
  assert.deepEqual(byVariant.series[0].n, [1, 1]);                         // how many posts each bar averages
});

test("avg % watched, pass rate and followers", async () => {
  const env = await seeded();
  const pct = await runGraph(env.DB, { metric: "avg_watch_pct", bots: ["chess"], range: "7d", groupBy: "format", chart: "bar" }, NOW);
  assert.deepEqual(pct, { labels: ["v1-countdown"], series: [{ name: "Chess", data: [60], n: [2] }], unit: "%" });
  const gate = await runGraph(env.DB, { metric: "gate_pass_rate", bots: ["bcf"], range: "7d", groupBy: "day", chart: "line" }, NOW);
  assert.deepEqual(gate.series[0].data.filter(v => v !== null), [66.7]);
  const f = await runGraph(env.DB, { metric: "followers", bots: ["chess", "bcf"], range: "7d", groupBy: "day", chart: "line", compare: "bots" }, NOW);
  assert.deepEqual(f.labels, ["Sun 18 Oct", "Mon 19 Oct"]);
  assert.deepEqual(f.series.map(x => x.data), [[30, 33], [null, 350]]);
  assert.deepEqual(f.series.map(x => x.name), ["Chess", "BuriedCasefiles"]);
});

test("best posting hour groups by UK hour", async () => {
  const env = await seeded();
  const out = await runGraph(env.DB, PRESETS[2].spec, NOW);
  assert.equal(out.labels.length, 24);                                    // the whole day, gaps stay visible
  assert.equal(out.labels[0], "00:00");
  const d = out.series[0].data;
  assert.deepEqual([d[14], d[22], d[13]], [700, 300, null]);               // 13:05Z and 21:05Z in BST
  const wk = await runGraph(env.DB, { metric: "posts", bots: ["chess"], range: "all", groupBy: "weekday", chart: "bar" }, NOW);
  assert.deepEqual(wk.labels, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
});

test("GET /api/graph and saved graphs", async () => {
  const env = await seeded();
  const cookie = await signIn(env);
  const spec = encodeURIComponent(JSON.stringify({ metric: "posts", bots: ALL, range: "7d", groupBy: "day", chart: "bar" }));
  const g = await (await call(env, "GET", `/api/graph?spec=${spec}`, { cookie })).json();
  assert.equal(g.series[0].data.reduce((a, b) => a + (b || 0), 0), 5);
  assert.equal((await call(env, "GET", "/api/graph?spec=%7Bbad", { cookie })).status, 400);
  const saved = await (await call(env, "GET", "/api/graphs", { cookie })).json();
  assert.equal(saved.length, 4);                                           // presets until you save
  const mine = [{ name: "Mine", spec: { metric: "likes", bots: ["chess"], range: "7d", groupBy: "post", chart: "bar" } }];
  assert.equal((await call(env, "PUT", "/api/graphs", { cookie, body: mine })).status, 200);
  assert.deepEqual(await (await call(env, "GET", "/api/graphs", { cookie })).json(), mine);
  const tooMany = Array.from({ length: 31 }, () => mine[0]);
  assert.equal((await call(env, "PUT", "/api/graphs", { cookie, body: tooMany })).status, 400);
  const bad = [{ name: "x", spec: { metric: "nope" } }];
  assert.equal((await call(env, "PUT", "/api/graphs", { cookie, body: bad })).status, 400);
});
