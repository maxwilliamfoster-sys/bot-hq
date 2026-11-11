import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./helpers.js";
import { checkCoach } from "../src/schedule.js";
import { getState } from "../src/settings.js";

const NOW = new Date("2026-11-20T08:02:00Z");
const day = n => new Date(NOW.getTime() - n * 86400e3);

async function seed(db, bot, v72s) {
  for (const [i, v] of v72s.entries()) {
    const id = `${bot}:${i}`;
    await db.prepare("INSERT INTO posts (id, bot, platform, external_id, posted_at) VALUES (?, ?, 'x', ?, ?)")
      .bind(id, bot, id, day(4 + i).toISOString()).run();
    await db.prepare("INSERT INTO milestones (post_id, h, views) VALUES (?, 24, ?), (?, 72, ?)").bind(id, v * 0.7, id, v).run();
  }
}
const coachEvents = db => db.prepare("SELECT bot, severity, title, fix_prompt, count FROM events WHERE kind = 'coach' ORDER BY id").all();

test("daily coach check: stores every verdict, alerts only for the account that needs Claude, and not twice", async () => {
  const env = await makeEnv();
  await seed(env.DB, "chess", Array.from({ length: 25 }, (_, i) => 900 + (i * 37) % 250));     // plateau: no alert
  await seed(env.DB, "eagle", Array.from({ length: 25 }, (_, i) => 66 + (i * 5) % 14));        // capped: alert
  const verdicts = await checkCoach(env, env.DB, NOW);
  assert.equal(verdicts.chess.code, "plateau");
  assert.equal(verdicts.eagle.code, "capped");
  assert.equal(verdicts.space.code, "learning");

  let { results } = await coachEvents(env.DB);
  assert.equal(results.length, 1);
  assert.equal(results[0].bot, "eagle");
  assert.equal(results[0].severity, "action");
  assert.match(results[0].fix_prompt, /^Improve my Eagle Eyes account/);
  assert.match(results[0].fix_prompt, /Account status/);

  const saved = JSON.parse(await getState(env.DB, "coach_latest"));
  assert.equal(saved.verdicts.chess.code, "plateau");

  await checkCoach(env, env.DB, new Date(NOW.getTime() + 86400e3));           // next day: same verdict, no second card
  ({ results } = await coachEvents(env.DB));
  assert.equal(results.length, 1);
  assert.equal(results[0].count, 1);
});

test("a review reminder every two weeks, never on the first day", async () => {
  const env = await makeEnv();
  await checkCoach(env, env.DB, NOW);
  assert.equal((await coachEvents(env.DB)).results.length, 0);
  await checkCoach(env, env.DB, new Date(NOW.getTime() + 13 * 86400e3));
  assert.equal((await coachEvents(env.DB)).results.length, 0);
  await checkCoach(env, env.DB, new Date(NOW.getTime() + 14 * 86400e3));
  const { results } = await coachEvents(env.DB);
  assert.equal(results.length, 1);
  assert.equal(results[0].bot, "system");
  assert.match(results[0].title, /two-week review/);
  assert.match(results[0].fix_prompt, /fortnightly review/);
});

test("GET /api/coach serves the latest verdicts to a signed-in device only", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "GET", "/api/coach")).status, 401);
});
