// /api/trends: the collector's batch, the phone's views, approval and manual research, all behind the niche gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, signIn } from "./helpers.js";

const BOT = { authorization: "Bearer bot-token" };
const NOW = "2026-11-27T06:00:00.000Z";
const ALL = { momentum: 1, audience: 1, performance: 1, competition: 1, timeliness: 1, originality: 1 };

const sig = (source, source_type, url, title, extra = {}) =>
  ({ source, source_type, url, title, fetched_at: NOW, published_at: "2026-11-26T10:00:00Z", ...extra });

const crime = (extra = {}) => ({
  name: "The case of Joanna Yeates",
  category: "true crime",
  for_accounts: ["buried"],
  signals: [
    sig("google_trends_rss", "search", "https://trends.google.com/trending/rss?geo=GB#joanna", "joanna yeates", { metric: "approx_traffic", value: 2000 }),
    sig("wikipedia", "wiki", "https://en.wikipedia.org/wiki/Murder_of_Joanna_Yeates", "Murder of Joanna Yeates", { metric: "views_7d_vs_30d", value: 4.2 }),
  ],
  components: ALL,
  snapshot: { momentum: 4.2, volume: 2000 },
  ...extra,
});

const gaming = { name: "Fortnite season 9 live event", for_accounts: ["chess"], signals: [sig("news_rss", "news", "https://example.com/fn", "Fortnite live event breaks records")], components: ALL };

async function env0() {
  const env = await makeEnv({ NOW: () => new Date(NOW) });
  return { env, cookie: await signIn(env) };
}
const batch = (env, candidates) => call(env, "POST", "/api/trends/batch", { body: { candidates }, headers: BOT });
const list = async (env, cookie, q = "") => (await call(env, "GET", `/api/trends${q}`, { cookie })).json();

test("the batch route needs the bot token and the read routes need a session", async () => {
  const { env } = await env0();
  assert.equal((await call(env, "POST", "/api/trends/batch", { body: { candidates: [] } })).status, 401);
  assert.equal((await call(env, "GET", "/api/trends")).status, 401);
  assert.equal((await call(env, "GET", "/api/trends/overview")).status, 401);
});

test("bad batches are refused", async () => {
  const { env } = await env0();
  assert.equal((await batch(env, "nope")).status, 400);
  assert.equal((await batch(env, Array.from({ length: 21 }, () => crime()))).status, 400);
  const r = await (await batch(env, [{ name: "" }, { name: "x", signals: [{ source: "a" }] }])).json();
  assert.equal(r.invalid, 2);
});

test("a niche trend is stored for its account with its evidence, score and class", async () => {
  const { env, cookie } = await env0();
  const r = await (await batch(env, [crime()])).json();
  assert.equal(r.trends, 1);
  const l = await list(env, cookie, "?account=buried");
  assert.equal(l.items.length, 1);
  const o = l.items[0];
  assert.equal(o.account, "buried");
  assert.equal(o.class, "high");
  const d0 = await (await call(env, "GET", `/api/trends/${o.trend_id}?account=buried`, { cookie })).json();
  const rel = d0.opportunities[0].gate.relevance;
  assert.ok(rel >= 0.6 && rel < 1);
  assert.equal(o.score, Math.round(25 * rel + 75), "niche points scale with relevance; the rest were full marks");
  assert.equal(o.evidence, "confirmed");
  assert.equal(o.status, "new");
  const d = await (await call(env, "GET", `/api/trends/${o.trend_id}`, { cookie })).json();
  assert.equal(d.signals.length, 2);
  assert.ok(d.signals.every(s => s.url && s.fetched_at && s.published_at));
  assert.equal(d.snapshots.length, 1);
  assert.ok(d.opportunities[0].locked_rules.some(x => /guilt/.test(x)), "the true-crime legal rule travels with it");
});

test("a true-crime trend never reaches the meme, fox, chess or space accounts", async () => {
  const { env, cookie } = await env0();
  await batch(env, [crime({ for_accounts: ["buried", "perc", "gary", "chess", "space"] })]);
  const l = await list(env, cookie, "?include_rejected=1");
  const byAcc = Object.fromEntries(l.items.map(i => [i.account, i.class]));
  assert.equal(byAcc.buried, "high");
  for (const k of ["perc", "gary", "chess", "space"]) assert.equal(byAcc[k], "rejected", k);
  for (const k of ["perc", "gary", "chess", "space"]) assert.equal((await list(env, cookie, `?account=${k}`)).items.length, 0, k);
});

test("an unrelated trend is rejected for the account it was found for, and created for nobody else", async () => {
  const { env, cookie } = await env0();
  await batch(env, [gaming]);
  const l = await list(env, cookie, "?include_rejected=1");
  assert.equal(l.items.length, 1);
  assert.equal(l.items[0].account, "chess");
  assert.equal(l.items[0].class, "rejected");
  assert.equal(l.items[0].score, null);
  assert.equal((await list(env, cookie)).items.length, 0, "rejected items are hidden by default");
});

test("the same trend twice updates one row, keeps one copy of each source, adds new sources", async () => {
  const { env, cookie } = await env0();
  await batch(env, [crime()]);
  await batch(env, [crime({ name: "Joanna Yeates case", signals: [...crime().signals, sig("news_rss", "news", "https://bbc.co.uk/x", "Joanna Yeates murder documentary")] })]);
  const l = await list(env, cookie, "?account=buried");
  assert.equal(l.items.length, 1);
  const d = await (await call(env, "GET", `/api/trends/${l.items[0].trend_id}`, { cookie })).json();
  assert.equal(d.signals.length, 3);
});

test("a rejection by Max sticks when the trend is seen again", async () => {
  const { env, cookie } = await env0();
  await batch(env, [crime()]);
  const id = (await list(env, cookie, "?account=buried")).items[0].id;
  const rej = await call(env, "POST", `/api/trends/opportunities/${id}/reject`, { cookie, body: { reason: "case too old" } });
  assert.equal(rej.status, 200);
  await batch(env, [crime()]);
  const l = await list(env, cookie, "?account=buried&status=rejected");
  assert.equal(l.items[0].status, "rejected");
  assert.equal(l.items[0].status_reason, "case too old");
});

test("approve re-runs the niche gate and refuses an item that fails it", async () => {
  const { env, cookie } = await env0();
  await batch(env, [crime(), gaming]);
  const all = (await list(env, cookie, "?include_rejected=1")).items;
  const good = all.find(i => i.account === "buried");
  const bad = all.find(i => i.account === "chess");
  const ok = await call(env, "POST", `/api/trends/opportunities/${good.id}/approve`, { cookie });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, "approved");
  const no = await call(env, "POST", `/api/trends/opportunities/${bad.id}/approve`, { cookie });
  assert.equal(no.status, 409);
  assert.equal((await no.json()).error, "niche_gate");
  assert.equal((await call(env, "POST", "/api/trends/opportunities/999/approve", { cookie })).status, 404);
  assert.equal((await call(env, "POST", `/api/trends/opportunities/${good.id}/approve`, { cookie })).status, 200, "approving twice is harmless");
});

test("an item already in a test can't be approved or rejected again", async () => {
  const { env, cookie } = await env0();
  await batch(env, [crime()]);
  const id = (await list(env, cookie, "?account=buried")).items[0].id;
  await env.DB.prepare("UPDATE opportunities SET status = 'testing' WHERE id = ?").bind(id).run();
  for (const a of ["approve", "reject"]) {
    const r = await call(env, "POST", `/api/trends/opportunities/${id}/${a}`, { cookie });
    assert.equal(r.status, 409, a);
    assert.equal((await r.json()).error, "already_testing");
  }
});

test("manual research goes through the same gate", async () => {
  const { env, cookie } = await env0();
  const bad = await call(env, "POST", "/api/trends/manual", { cookie, body: { name: "Fortnite chapter 7 trailer", account: "chess", url: "https://example.com/a" } });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error, "niche_gate");
  assert.equal((await list(env, cookie, "?include_rejected=1")).items.length, 0, "nothing stored");
  assert.equal((await call(env, "POST", "/api/trends/manual", { cookie, body: { name: "x", account: "eagle" } })).status, 400);
  assert.equal((await call(env, "POST", "/api/trends/manual", { cookie, body: { name: "Comet", account: "space", url: "javascript:alert(1)" } })).status, 400);

  const ok = await call(env, "POST", "/api/trends/manual", { cookie, body: {
    name: "Comet Lemmon tail", account: "space", url: "https://ads.tiktok.com/business/creativecenter/x",
    text: "Astronomers photograph the comet's tail through a telescope", notes: "seen on Creative Center, GB, 27 Nov" } });
  assert.equal(ok.status, 200);
  const o = (await list(env, cookie, "?account=space")).items[0];
  assert.equal(o.evidence, "hypothesis");
  assert.equal(o.analysis_requested, 1);
  assert.equal(o.notes, "seen on Creative Center, GB, 27 Nov");
  const d = await (await call(env, "GET", `/api/trends/${o.trend_id}`, { cookie })).json();
  assert.equal(d.signals[0].manual, 1);
});

test("list filters never mix accounts, and filter by platform, class and score", async () => {
  const { env, cookie } = await env0();
  await batch(env, [crime(), { name: "JWST new nebula image", for_accounts: ["space"], signals: [sig("news_rss", "news", "https://nasa.gov/x", "James Webb telescope nebula image")], components: { momentum: 0.5 } }]);
  assert.deepEqual((await list(env, cookie, "?account=space")).items.map(i => i.account), ["space"]);
  assert.deepEqual((await list(env, cookie, "?platform=tiktok")).items.map(i => i.account).sort(), ["buried", "space"]);
  assert.deepEqual((await list(env, cookie, "?class=high")).items.map(i => i.account), ["buried"]);
  assert.deepEqual((await list(env, cookie, "?min_score=50")).items.map(i => i.account), ["buried"]);
  assert.equal((await call(env, "GET", "/api/trends?account=nope", { cookie })).status, 400);
  assert.equal((await call(env, "GET", "/api/trends?class=nope", { cookie })).status, 400);
});

test("overview counts", async () => {
  const { env, cookie } = await env0();
  await batch(env, [crime(), gaming]);
  const o = await (await call(env, "GET", "/api/trends/overview", { cookie })).json();
  assert.equal(o.discovered, 2);
  assert.equal(o.high, 1);
  assert.equal(o.awaiting, 1);
  assert.equal(o.testing, 0);
  assert.equal(o.won, 0);
  assert.equal(o.accounts.length, 8);
  assert.ok(o.accounts.every(a => a.key && a.niche && a.platform));
});

test("weights can be changed, are validated, and rescore stored items", async () => {
  const { env, cookie } = await env0();
  await batch(env, [{ ...crime(), components: { momentum: 1 } }]);
  const before = (await list(env, cookie, "?account=buried")).items[0];
  const rel = (await (await call(env, "GET", `/api/trends/${before.trend_id}`, { cookie })).json()).opportunities[0].gate.relevance;
  assert.equal(before.score, Math.round(25 * rel + 20));
  assert.equal(before.class, "low");
  assert.deepEqual(await (await call(env, "GET", "/api/trends/weights", { cookie })).json(),
    { niche: 25, momentum: 20, audience: 15, performance: 15, competition: 10, timeliness: 10, originality: 5 });
  const w = { niche: 50, momentum: 50, audience: 0, performance: 0, competition: 0, timeliness: 0, originality: 0 };
  assert.equal((await call(env, "PUT", "/api/trends/weights", { cookie, body: { ...w, niche: 0 } })).status, 400);
  assert.equal((await call(env, "PUT", "/api/trends/weights", { cookie, body: w })).status, 200);
  const o = (await list(env, cookie, "?account=buried")).items[0];
  assert.equal(o.score, Math.round(50 * rel + 50));
  assert.equal(o.class, "high");
});
