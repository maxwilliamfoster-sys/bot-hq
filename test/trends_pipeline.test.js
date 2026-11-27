// Trend Intelligence <-> the evening autopilot: queue, hand-off, ideas, test results, Inbox notice, weekly bands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, signIn } from "./helpers.js";
import { trendAlerts, trendWeekly, outcomeBands } from "../src/trends/pipeline.js";

const BOT = { authorization: "Bearer bot-token" };
const NOW = "2026-11-27T06:00:00.000Z";
const ALL = { momentum: 1, audience: 1, performance: 1, competition: 1, timeliness: 1, originality: 1 };
const sig = (source, source_type, url, title, extra = {}) =>
  ({ source, source_type, url, title, fetched_at: NOW, published_at: "2026-11-26T10:00:00Z", ...extra });

const crime = (extra = {}) => ({
  name: "The case of Joanna Yeates", category: "true crime", for_accounts: ["buried"],
  signals: [
    sig("google_trends_rss", "search", "https://trends.google.com/trending/rss?geo=GB#joanna", "joanna yeates", { metric: "approx_traffic", value: 2000 }),
    sig("wikipedia", "wiki", "https://en.wikipedia.org/wiki/Murder_of_Joanna_Yeates", "Murder of Joanna Yeates", { metric: "views_7d_vs_30d", value: 4.2 }),
  ],
  components: ALL, ...extra,
});
const live = () => crime({
  name: "Bristol murder trial", text: "A man accused of murder denies the charge, the jury was told",
  signals: [sig("news_rss", "news", "https://example.com/trial", "Man accused of murder denies charge, jury told"),
    sig("wikipedia", "wiki", "https://en.wikipedia.org/wiki/Bristol_murder", "Bristol murder")],
});

async function env0() {
  const env = await makeEnv({ NOW: () => new Date(NOW) });
  return { env, cookie: await signIn(env) };
}
const batch = (env, candidates) => call(env, "POST", "/api/trends/batch", { body: { candidates }, headers: BOT });
const bot = (env, method, path, body) => call(env, method, path, { body, headers: BOT });
async function seeded() {
  const { env, cookie } = await env0();
  await batch(env, [crime()]);
  const { items } = await (await call(env, "GET", "/api/trends?account=buried", { cookie })).json();
  return { env, cookie, o: items[0] };
}
const approve = (env, cookie, id) => call(env, "POST", `/api/trends/opportunities/${id}/approve`, { body: {}, cookie });

test("the autopilot routes need the bot credential, not a session", async () => {
  const { env, cookie, o } = await seeded();
  assert.equal((await call(env, "GET", "/api/trends/queue", { cookie })).status, 401);
  for (const p of ["handed", "ideas", "outcome"]) {
    assert.equal((await call(env, "POST", `/api/trends/opportunities/${o.id}/${p}`, { body: {}, cookie })).status, 401);
  }
  assert.equal((await bot(env, "GET", "/api/trends/queue?account=nope")).status, 400);
});

test("an approved trend is queued once, with its evidence and the account's rules, until it is handed over", async () => {
  const { env, cookie, o } = await seeded();
  let q = await (await bot(env, "GET", "/api/trends/queue")).json();
  assert.equal(q.approved.length, 0);
  assert.equal(q.analyse.length, 1, "a high scorer wants ideas");
  await approve(env, cookie, o.id);
  q = await (await bot(env, "GET", "/api/trends/queue?account=buried")).json();
  assert.equal(q.approved.length, 1);
  const a = q.approved[0];
  assert.equal(a.id, o.id);
  assert.ok(a.niche && Array.isArray(a.locked_rules) && a.locked_rules.length > 0);
  assert.equal(a.evidence.length, 2);
  assert.ok(a.evidence.every(e => e.url && Number.isInteger(e.id)));
  assert.equal((await (await bot(env, "GET", "/api/trends/queue?account=chess")).json()).approved.length, 0, "other accounts don't see it");

  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/handed`)).status, 200);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/handed`)).status, 200, "idempotent");
  q = await (await bot(env, "GET", "/api/trends/queue")).json();
  assert.equal(q.approved.length, 0);
  const d = await (await call(env, "GET", `/api/trends/${o.trend_id}`, { cookie })).json();
  assert.equal(d.opportunities[0].handed_at, NOW);
});

test("only approved trends can be handed over, and a later rejection is listed as withdrawn", async () => {
  const { env, cookie, o } = await seeded();
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/handed`)).status, 409);
  assert.equal((await bot(env, "POST", "/api/trends/opportunities/999/handed")).status, 404);
  await approve(env, cookie, o.id);
  await bot(env, "POST", `/api/trends/opportunities/${o.id}/handed`);
  await call(env, "POST", `/api/trends/opportunities/${o.id}/reject`, { body: { reason: "changed my mind" }, cookie });
  const q = await (await bot(env, "GET", "/api/trends/queue")).json();
  assert.deepEqual(q.withdrawn, [{ id: o.id, account: "buried" }]);
});

test("ideas are stored with the account's locked rules as risks, and cite only this trend's evidence", async () => {
  const { env, cookie, o } = await seeded();
  const q = await (await bot(env, "GET", "/api/trends/queue")).json();
  const ev = q.analyse[0].evidence[0].id;
  const idea = { title: "What the 2010 investigation missed", hook: "One clue changed the case", format: "story", duration: "45-60 s",
    why: "Search interest is up 4x", evidence_ids: [ev] };
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [idea] })).status, 200);
  const d = await (await call(env, "GET", `/api/trends/${o.trend_id}`, { cookie })).json();
  const stored = d.opportunities[0].ideas[0];
  assert.equal(stored.title, idea.title);
  for (const r of d.opportunities[0].locked_rules) assert.ok(stored.risks.includes(r), "locked rule shown as a risk");
  const after = await (await bot(env, "GET", "/api/trends/queue")).json();
  assert.equal(after.analyse.length, 0, "a trend with ideas isn't asked for again");

  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [{ ...idea, evidence_ids: [99999] }] })).status, 400);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [] })).status, 400);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [{ title: "" }] })).status, 400);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [idea, idea, idea, idea] })).status, 400);
  for (let i = 0; i < 2; i++) await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [idea, idea, idea] });
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [idea, idea] })).status, 200, "7 + 2 = 9");
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [idea] })).status, 409, "capped at 9");
});

test("an idea for a live case must name its risk", async () => {
  const { env, cookie } = await env0();
  await batch(env, [live()]);
  const { items } = await (await call(env, "GET", "/api/trends?account=buried&include_rejected=1", { cookie })).json();
  const o = items.find(i => i.flags.includes("active_case"));
  assert.ok(o, "the trial is flagged");
  assert.ok(o.class !== "rejected", "and passes the true-crime gate");
  const idea = { title: "What the jury has heard so far" };
  const r = await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [idea] });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, "active_case_needs_risk");
  const ok = await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`,
    { ideas: [{ ...idea, risks: ["Live case: say 'accused', only what the court heard, wait for the verdict"] }] });
  assert.equal(ok.status, 200);
});

test("a trend that failed the niche gate can't get ideas or results", async () => {
  const { env, cookie } = await env0();
  await batch(env, [{ name: "Fortnite season 9 live event", for_accounts: ["chess"],
    signals: [sig("news_rss", "news", "https://example.com/fn", "Fortnite live event breaks records")], components: ALL }]);
  const { items } = await (await call(env, "GET", "/api/trends?class=rejected", { cookie })).json();
  const o = items.find(i => i.account === "chess");
  assert.ok(o);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/ideas`, { ideas: [{ title: "x" }] })).status, 409);
  assert.equal((await bot(env, "POST", `/api/trends/opportunities/${o.id}/outcome`, { status: "testing" })).status, 409);
  const q = await (await bot(env, "GET", "/api/trends/queue")).json();
  assert.equal(q.analyse.length + q.approved.length, 0);
});

test("results follow approved -> testing -> won/lost/no difference, never from new", async () => {
  const { env, cookie, o } = await seeded();
  const out = (status, note) => bot(env, "POST", `/api/trends/opportunities/${o.id}/outcome`, { status, note });
  assert.equal((await out("testing")).status, 409, "not approved yet");
  assert.equal((await out("bogus")).status, 400);
  await approve(env, cookie, o.id);
  assert.equal((await out("testing")).status, 200);
  assert.equal((await out("testing")).status, 200, "idempotent");
  const r = await out("won", "Views 2.1x the median over 10 videos");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "won");
  assert.equal((await out("lost")).status, 409, "a finished test stays finished");
  const d = await (await call(env, "GET", `/api/trends/${o.trend_id}`, { cookie })).json();
  assert.equal(d.opportunities[0].status, "won");
  assert.equal(d.opportunities[0].outcome_note, "Views 2.1x the median over 10 videos");
  assert.equal((await call(env, "POST", `/api/trends/opportunities/${o.id}/reject`, { body: {}, cookie })).status, 409, "Max can't rewrite a result");
});

test("one Inbox item per batch of new strong trends, and it never pushes with 'only when needed' on", async () => {
  const { env, cookie } = await seeded();
  let pushes = 0;
  env.PUSH_FETCH = async () => { pushes++; return new Response(null, { status: 201 }); };
  const now = new Date(NOW);
  assert.equal((await trendAlerts(env, env.DB, now)).notified, 1);
  assert.equal((await trendAlerts(env, env.DB, now)).notified, 0, "told once");
  const inbox = await (await call(env, "GET", "/api/inbox", { cookie })).json();
  const ev = inbox.events.find(e => e.kind === "trend_waiting");
  assert.ok(ev, "in the Inbox");
  assert.equal(ev.severity, "info");
  assert.equal(pushes, 0);
});

test("the weekly summary compares score bands with results", async () => {
  const { env, cookie, o } = await seeded();
  await approve(env, cookie, o.id);
  await bot(env, "POST", `/api/trends/opportunities/${o.id}/outcome`, { status: "won" });
  const bands = await outcomeBands(env.DB);
  assert.deepEqual(bands.find(b => b.band === "80+"), { band: "80+", tested: 1, won: 1, lost: 0, no_difference: 0 });
  const r = await trendWeekly(env, env.DB, new Date(NOW));
  assert.equal(r.found, 1);
  assert.equal(r.approved, 1);
});
