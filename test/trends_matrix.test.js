// Phase 6, end to end through the Worker: every account against every niche, a trend two accounts share kept
// apart per account, and Max's decisions and test results surviving re-collection and daily upkeep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, signIn } from "./helpers.js";
import { PROFILES, getProfile } from "../src/trends/profiles.js";
import { trendUpkeep } from "../src/trends/intel.js";
import { MAX_BATCH } from "../src/trends/store.js";
import { SAMPLES } from "./fixtures/trend_samples.js";

const BOT = { authorization: "Bearer bot-token" };
const NOW = "2026-11-27T06:00:00.000Z";
const DAY = 864e5;
const ALL = { momentum: 1, audience: 1, performance: 1, competition: 1, timeliness: 1, originality: 1 };
const KEYS = PROFILES.map(p => p.key);
const sig = (title, n = 0) => ({ source: "news_rss", source_type: "news", url: `https://example.com/${encodeURIComponent(title)}/${n}`,
  title, fetched_at: NOW, published_at: "2026-11-26T10:00:00Z" });
const cand = (name, extra = {}) => ({ name, for_accounts: KEYS, signals: [sig(name)], components: ALL, ...extra });

async function env0(now = NOW) {
  let t = Date.parse(now);
  const env = await makeEnv({ NOW: () => new Date(t) });
  return { env, cookie: await signIn(env), at: ms => { t = ms; } };
}
const batch = (env, candidates) => call(env, "POST", "/api/trends/batch", { body: { candidates }, headers: BOT });
const bot = async (env, method, path, body) => {
  const r = await call(env, method, path, { body, headers: BOT });
  return { status: r.status, body: await r.json() };
};
const list = async (env, cookie, q = "") => (await (await call(env, "GET", `/api/trends${q}`, { cookie })).json()).items;
const decide = (env, cookie, id, action, reason = "") =>
  call(env, "POST", `/api/trends/opportunities/${id}/${action}`, { body: { reason }, cookie });

test("every niche sample, offered to every account, is stored as usable for exactly its own accounts", async () => {
  const { env, cookie } = await env0();
  const all = SAMPLES.map(([text]) => cand(text));
  for (let i = 0; i < all.length; i += MAX_BATCH) assert.equal((await batch(env, all.slice(i, i + MAX_BATCH))).status, 200);
  for (const key of KEYS) {
    const usable = (await list(env, cookie, `?account=${key}`)).map(i => i.name).sort();
    const expected = SAMPLES.filter(([, ok]) => ok.includes(key)).map(([t]) => t).sort();
    assert.deepEqual(usable, expected, `${key} got the wrong trends`);
  }
  // Every other pairing is stored only as a refusal: no score, never in the default lists.
  for (const i of await list(env, cookie, "?include_rejected=1")) {
    const ok = SAMPLES.find(([t]) => t === i.name)[1].includes(i.account);
    if (!ok) { assert.equal(i.class, "rejected", `${i.name} -> ${i.account}`); assert.equal(i.score, null); }
  }
});

test("a trend two accounts share stays separate per account through the whole pipeline", async () => {
  const { env, cookie } = await env0();
  const [shared] = SAMPLES.find(([, ok]) => ok.length === 2);
  await batch(env, [cand(shared)]);
  const [n] = await list(env, cookie, "?account=niche");
  const [e] = await list(env, cookie, "?account=escape");
  assert.ok(n && e && n.id !== e.id && n.trend_id === e.trend_id, "one trend, one opportunity per account");

  assert.equal((await decide(env, cookie, n.id, "approve")).status, 200);
  const qe = (await bot(env, "GET", "/api/trends/queue?account=escape")).body;
  assert.equal(qe.approved.length, 0, "approving for one account approves nothing for the other");
  assert.ok([...qe.approved, ...qe.analyse, ...qe.withdrawn].every(x => x.account === "escape"));
  const qn = (await bot(env, "GET", "/api/trends/queue?account=niche")).body;
  assert.equal(qn.approved.length, 1);
  assert.equal(qn.approved[0].niche, getProfile("niche").niche, "the brief carries this account's own niche");
  assert.deepEqual(qn.approved[0].locked_rules, getProfile("niche").locked_rules || []);

  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${n.id}/handed`, {})).status, 200);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${e.id}/handed`, {})).status, 409, "escape's copy was never approved");
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${n.id}/ideas`, { ideas: [{ title: "Squad reveal as a pub quiz" }] })).status, 200);
  assert.equal((await decide(env, cookie, e.id, "reject", "not for this account")).status, 200);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${n.id}/outcome`, { status: "testing" })).status, 200);

  const detail = await (await call(env, "GET", `/api/trends/${n.trend_id}`, { cookie })).json();
  const byAcc = Object.fromEntries((detail.opportunities || detail.items).map(o => [o.account, o]));
  assert.equal(byAcc.niche.status, "testing");
  assert.equal(byAcc.niche.ideas.length, 1);
  assert.equal(byAcc.escape.status, "rejected");
  assert.equal(byAcc.escape.ideas.length, 0);
  assert.equal(byAcc.escape.handed_at, null);
  assert.equal((await bot(env, "GET", "/api/trends/queue?account=niche")).body.withdrawn.length, 0,
    "rejecting escape's copy withdraws nothing from niche");
});

test("Max's decision, the hand-off, ideas and the test survive re-collection and daily upkeep", async () => {
  const { env, cookie, at } = await env0();
  const name = SAMPLES[1][0];                                   // the true-crime sample, for buried
  await batch(env, [cand(name, { for_accounts: ["buried"] })]);
  const [o] = await list(env, cookie, "?account=buried");
  await decide(env, cookie, o.id, "approve", "fits");
  await bot(env, "POST", `/api/trends/opportunities/${o.id}/handed`, {});
  await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [{ title: "The DNA that waited 26 years" }] });
  await bot(env, "POST", `/api/trends/opportunities/${o.id}/outcome`, { status: "testing", note: "next main test" });

  at(Date.parse(NOW) + DAY);                                    // the collector sees it again the next day
  await batch(env, [cand(name, { for_accounts: ["buried"], signals: [sig(name, 1), sig(name, 2)] })]);
  let [again] = await list(env, cookie, "?account=buried");
  assert.equal(again.id, o.id, "still one opportunity");
  assert.equal(again.status, "testing");
  assert.equal(again.outcome_note, "next main test");
  assert.ok(again.handed_at);

  at(Date.parse(NOW) + 20 * DAY);                               // not seen for over 14 days
  await trendUpkeep(env.DB, new Date(Date.parse(NOW) + 20 * DAY));
  [again] = await list(env, cookie, "?account=buried");
  assert.equal(again.lifecycle, "expired");
  assert.equal(again.status, "testing", "expiry never undoes a decision or a running test");
  const q = (await bot(env, "GET", "/api/trends/queue?account=buried")).body;
  assert.equal(q.analyse.length, 0, "an expired trend asks for no new ideas");
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/outcome`, { status: "won", note: "2x median" })).status, 200,
    "a test that outlives its trend can still record its result");
  const detail = await (await call(env, "GET", `/api/trends/${o.trend_id}`, { cookie })).json();
  const mine = (detail.opportunities || detail.items).find(x => x.id === o.id);
  assert.equal(mine.status, "won");
  assert.equal(mine.ideas.length, 1);
});
