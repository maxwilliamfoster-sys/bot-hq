import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, signIn, call } from "./helpers.js";

const BOT = { authorization: "Bearer bot-token" };
const TRACKER = {
  generated: "2026-11-03T09:53:00+00:00",
  accounts: [
    { key: "chess", name: "Chess", verdict: "Better", next_check: "2026-11-16" },
    { key: "escape", name: "Escape Cup", verdict: "Too early", next_check: "2026-11-09" },
    { key: "eagle", name: "Eagle Eyes", verdict: "Worse", next_check: "2026-11-09" },
  ],
  trend: [{ account: "chess", week: "2026-10-26", views: 933, videos: 15 }],
  tests: [{ id: "a", bot: "chess", status: "Collecting" }, { id: "b", bot: "escape", status: "No clear winner" }],
  updates: [{ id: "u1", bot: "chess", date: "2026-11-02", kind: "Change", what: "w", why: "y", commit: "abc" }],
  todos: [
    { id: "t1", owner: "You", task: "x", status: "Open" },
    { id: "t2", owner: "You", task: "x", status: "Done" },
    { id: "t3", owner: "Claude", task: "x", status: "Booked" },
  ],
};

test("before the first check has been sent, the tracker says so", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  assert.deepEqual(await (await call(env, "GET", "/api/tracker", { cookie })).json(), { available: false });
});

test("the check on the PC saves the tracker and the phone reads it with totals worked out", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  assert.equal((await call(env, "POST", "/api/tracker", { body: TRACKER, headers: BOT })).status, 200);
  const out = await (await call(env, "GET", "/api/tracker", { cookie })).json();
  assert.equal(out.available, true);
  assert.equal(out.generated, TRACKER.generated);
  assert.deepEqual(out.tests, TRACKER.tests);
  assert.deepEqual(out.summary, { better: 1, worse: 1, early: 1, collecting: 1, yours: 1, next_check: "2026-11-09" });
});

test("a newer check replaces the old numbers", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  await call(env, "POST", "/api/tracker", { body: TRACKER, headers: BOT });
  await call(env, "POST", "/api/tracker", { body: { ...TRACKER, generated: "2026-11-09T16:30:00Z", todos: [] }, headers: BOT });
  const out = await (await call(env, "GET", "/api/tracker", { cookie })).json();
  assert.equal(out.generated, "2026-11-09T16:30:00Z");
  assert.equal(out.summary.yours, 0);
});

const AUTOPILOT = {
  generated: "2026-11-16T18:40:00Z", health_at: "2026-11-16T18:31:00Z",
  next: { key: "buried", name: "Buried Case Files", why: "test results waiting" },
  health: [{ key: "chess", name: "Chess", last_post_h: 4, stalled: false, failed_runs: [], last_review: "2026-11-16", signals: [] }],
  accounts: [{ key: "chess", name: "Chess", stage: 4, stage_name: "Rethink", stage_rule: "r", weeks_since_high: 9, no_win_streak: 0,
    window_views: [1053], reviews_done: 1, last_review: { date: "2026-11-16", summary: "s" },
    latest: { date: "2026-11-16", account: "chess", watched: "w", numbers: "n", changes: "c", tests: "t", next: ["x"] },
    approaches: [], ideas_open: ["i"] }],
  reviews: [{ date: "2026-11-16", account: "chess", summary: "s" }],
};

test("the autopilot's reviews and stages travel with the tracker", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  await call(env, "POST", "/api/tracker", { body: { ...TRACKER, autopilot: AUTOPILOT }, headers: BOT });
  const out = await (await call(env, "GET", "/api/tracker", { cookie })).json();
  assert.deepEqual(out.autopilot, AUTOPILOT);
});

test("a tracker without the autopilot, or with a broken one, still saves", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  for (const autopilot of [undefined, null, "x", { accounts: "no" }]) {
    assert.equal((await call(env, "POST", "/api/tracker", { body: { ...TRACKER, autopilot }, headers: BOT })).status, 200);
    const out = await (await call(env, "GET", "/api/tracker", { cookie })).json();
    assert.equal(out.autopilot, null);
    assert.equal(out.accounts.length, 3);
  }
});

test("only the bot token can save and only a session can read", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  assert.equal((await call(env, "GET", "/api/tracker")).status, 401);
  assert.equal((await call(env, "POST", "/api/tracker", { body: TRACKER })).status, 401);
  assert.equal((await call(env, "POST", "/api/tracker", { body: TRACKER, cookie })).status, 401);
  assert.equal((await call(env, "GET", "/api/tracker", { headers: BOT })).status, 401);
});

test("a broken upload is refused and keeps the last good numbers", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  await call(env, "POST", "/api/tracker", { body: TRACKER, headers: BOT });
  for (const bad of [{}, { ...TRACKER, generated: "soon" }, { ...TRACKER, tests: "none" }, { ...TRACKER, accounts: [] }]) {
    assert.equal((await call(env, "POST", "/api/tracker", { body: bad, headers: BOT })).status, 400);
  }
  assert.equal((await (await call(env, "GET", "/api/tracker", { cookie })).json()).accounts.length, 3);
});
