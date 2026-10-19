import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, signIn } from "./helpers.js";

const NOW = new Date("2026-10-20T12:00:00Z");

async function seeded() {
  const env = await makeEnv({ NOW: () => NOW });
  const add = async (minsAgo, bot, kind, severity, title, extra = {}) => {
    const at = new Date(NOW.getTime() - minsAgo * 60e3).toISOString();
    const r = await env.DB.prepare(
      `INSERT INTO events (at, last_at, bot, kind, severity, title, body, data_json, fix_prompt, dedupe_key, count, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(at, at, bot, kind, severity, title, extra.body || "", JSON.stringify(extra.data || {}), extra.prompt || null,
        `${kind}:${title}`, extra.count || 1, extra.resolved ? at : null).run();
    return r.meta.last_row_id;
  };
  const ids = {
    openAction: await add(300, "chess", "run_failed", "action", "Chess: Post Chess Puzzle failed",
      { count: 3, prompt: "PROMPT TEXT", data: { run_url: "https://gh/run/1", step: "Render" } }),
    doneAction: await add(200, "bcf", "credential_expired", "action", "Old token", { resolved: true }),
    warn: await add(100, "escape", "slot_missed", "warn", "Escape Cup: 19:30 slot not filled yet"),
    good: await add(80, "chess", "doing_well", "good", "Chess: top 10% at 1h"),
    posted: await add(50, "bcf", "posted", "info", "BuriedCasefiles posted: The case"),
    summary: await add(40, "system", "summary", "info", "Yesterday: 7 of 8 posts"),
    digest: await add(30, "chess", "digest", "info", "Morning digest"),
  };
  return { env, ids, cookie: await signIn(env) };
}

const inbox = async (env, cookie, q = "") => (await call(env, "GET", `/api/inbox${q}`, { cookie })).json();

test("open actions come first in their own block; the feed has the rest, newest first", async () => {
  const { env, ids, cookie } = await seeded();
  assert.equal((await call(env, "GET", "/api/inbox")).status, 401);
  const r = await inbox(env, cookie);
  assert.equal(r.open_actions, 1);
  assert.deepEqual(r.needs.map(e => e.id), [ids.openAction]);
  assert.equal(r.needs[0].count, 3);
  assert.deepEqual(r.events.map(e => e.id), [ids.digest, ids.summary, ids.posted, ids.good, ids.warn, ids.doneAction]);
  assert.equal(r.events.at(-1).resolved, true);
  assert.equal(r.events[0].read, false);
});

test("filter chips map to severities and kinds", async () => {
  const { env, ids, cookie } = await seeded();
  const f = async name => (await inbox(env, cookie, `?filter=${name}`)).events.map(e => e.id);
  assert.deepEqual(await f("needs"), [ids.doneAction]);                  // open ones are in the block above
  assert.deepEqual(await f("failed"), [ids.warn]);
  assert.deepEqual(await f("good"), [ids.good]);
  assert.deepEqual(await f("posted"), [ids.posted]);
  assert.deepEqual(await f("summary"), [ids.digest, ids.summary]);
  assert.equal((await call(env, "GET", "/api/inbox?filter=bogus", { cookie })).status, 400);
});

test("event detail, read and resolve (resolving lowers the open count)", async () => {
  const { env, ids, cookie } = await seeded();
  const e = await (await call(env, "GET", `/api/events/${ids.openAction}`, { cookie })).json();
  assert.equal(e.fix_prompt, "PROMPT TEXT");
  assert.deepEqual(e.data, { run_url: "https://gh/run/1", step: "Render" });
  assert.equal(e.read, false);
  assert.equal((await call(env, "GET", "/api/events/99999", { cookie })).status, 404);
  await call(env, "POST", `/api/events/${ids.openAction}/read`, { cookie });
  assert.equal((await (await call(env, "GET", `/api/events/${ids.openAction}`, { cookie })).json()).read, true);
  const done = await (await call(env, "POST", `/api/events/${ids.openAction}/resolve`, { cookie })).json();
  assert.equal(done.open_actions, 0);
  const r = await inbox(env, cookie);
  assert.deepEqual(r.needs, []);
  assert.equal(r.open_actions, 0);
  assert.equal((await call(env, "POST", "/api/events/99999/resolve", { cookie })).status, 404);
});

test("pages of 30 with before=<id>", async () => {
  const env = await makeEnv({ NOW: () => NOW });
  for (let i = 0; i < 35; i++) {
    await env.DB.prepare("INSERT INTO events (at, last_at, bot, kind, severity, title, dedupe_key) VALUES (?, ?, 'chess', 'posted', 'info', ?, ?)")
      .bind(NOW.toISOString(), NOW.toISOString(), `Post ${i}`, `k${i}`).run();
  }
  const cookie = await signIn(env);
  const first = await inbox(env, cookie);
  assert.equal(first.events.length, 30);
  assert.equal(first.more, true);
  const next = await inbox(env, cookie, `?before=${first.events.at(-1).id}`);
  assert.equal(next.events.length, 5);
  assert.equal(next.more, false);
  assert.ok(next.events.every(e => e.id < first.events.at(-1).id));
});
