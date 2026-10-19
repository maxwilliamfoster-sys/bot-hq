import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1.js";
import { validateEvent, recordEvent, pushDecision, openActionCount } from "../src/events.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { makeEnv, call, fakeSubscription } from "./helpers.js";
import { saveSubscription } from "../src/push.js";

const base = { bot: "chess", kind: "post_failed", severity: "warn", title: "Chess: upload failed", body: "HTTP 500" };
const DAY = new Date("2026-10-26T12:00:00Z");
const hours = h => new Date(DAY.getTime() + h * 3600e3);

test("validation rejects unknown bot, empty title and oversize data", () => {
  assert.equal(validateEvent({ ...base, bot: "reddit" }).ok, false);
  assert.equal(validateEvent({ ...base, severity: "info", title: "" }).ok, false);
  assert.equal(validateEvent({ ...base, data: { log_tail: "x".repeat(9 * 1024) } }).ok, false);
  assert.equal(validateEvent({ ...base, kind: "Bad-Kind" }).ok, false);
  assert.equal(validateEvent({ ...base, severity: "panic" }).ok, false);
  assert.equal(validateEvent(null).ok, false);
});

test("validation fills the default dedupe key", () => {
  const r = validateEvent(base);
  assert.equal(r.ok, true);
  assert.equal(r.event.dedupe_key, "chess:post_failed:Chess: upload failed");
  assert.deepEqual(r.event.data, {});
});

test("repeat failures are grouped and pushed at 1st and 3rd", async () => {
  const db = makeD1();
  const ev = validateEvent(base).event;
  const pushes = [];
  for (let i = 0; i < 4; i++) {
    const r = await recordEvent(db, ev, hours(2 * i));
    pushes.push(pushDecision(ev, r.count, DEFAULT_SETTINGS, hours(2 * i)));
  }
  assert.deepEqual(pushes, [true, false, true, false]);
  const rows = (await db.prepare("SELECT count FROM events").all()).results;
  assert.deepEqual(rows, [{ count: 4 }]);
});

test("a new event after 25 hours starts a new row", async () => {
  const db = makeD1();
  const ev = validateEvent(base).event;
  const a = await recordEvent(db, ev, hours(0));
  const b = await recordEvent(db, ev, hours(25));
  assert.equal(a.isNew, true);
  assert.equal(b.isNew, true);
  assert.notEqual(a.id, b.id);
  assert.equal(b.count, 1);
});

test("a resolved event does not swallow the next occurrence", async () => {
  const db = makeD1();
  const ev = validateEvent(base).event;
  const a = await recordEvent(db, ev, hours(0));
  await db.prepare("UPDATE events SET resolved_at = ? WHERE id = ?").bind(hours(1).toISOString(), a.id).run();
  const b = await recordEvent(db, ev, hours(2));
  assert.equal(b.isNew, true);
});

test("info events are pushed once, never on repeats", () => {
  const ev = { ...base, severity: "info", kind: "posted" };
  assert.equal(pushDecision(ev, 1, DEFAULT_SETTINGS, hours(0)), true);
  assert.equal(pushDecision(ev, 3, DEFAULT_SETTINGS, hours(0)), false);
});

test("POST /api/event needs the bot token", async () => {
  const env = await makeEnv();
  const res = await call(env, "POST", "/api/event", { body: base, headers: { authorization: "Bearer wrong" } });
  assert.equal(res.status, 401);
});

test("POST /api/event records, builds a prompt and pushes", async () => {
  const env = await makeEnv();
  await saveSubscription(env.DB, await fakeSubscription(1));
  const sent = [];
  env.PUSH_FETCH = async (url, init) => { sent.push(url); return new Response(null, { status: 201 }); };
  env.NOW = () => new Date("2026-10-26T12:00:00Z");
  const body = { ...base, severity: "action", kind: "run_failed", data: { run_url: "https://github.com/x/runs/1", step: "Render" } };
  const res = await call(env, "POST", "/api/event", { body, headers: { authorization: "Bearer bot-token" } });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.count, 1);
  assert.equal(out.pushed, true);
  assert.equal(sent.length, 1);
  const row = await env.DB.prepare("SELECT fix_prompt, severity FROM events WHERE id = ?").bind(out.id).first();
  assert.match(row.fix_prompt, /chess-puzzle-automation/);
  assert.equal(await openActionCount(env.DB), 1);
  const bad = await call(env, "POST", "/api/event", { body: { ...base, bot: "x" }, headers: { authorization: "Bearer bot-token" } });
  assert.equal(bad.status, 400);
});

test("a posted event via the API puts the post on the Live list", async () => {
  const env = await makeEnv();
  const body = { bot: "chess", kind: "posted", severity: "info", title: "Chess posted: Mate in 2",
    data: { video_url: "https://youtube.com/shorts/YkkI7LMCkNg", external_id: "YkkI7LMCkNg" } };
  const res = await call(env, "POST", "/api/event", { body, headers: { authorization: "Bearer bot-token" } });
  assert.equal(res.status, 200);
  assert.equal(await env.DB.prepare("SELECT title FROM posts WHERE id = 'chess:YkkI7LMCkNg'").first("title"), "Mate in 2");
});

test("the morning digest is recorded but never pushed (the 07:30 summary is the morning push)", () => {
  const ev = { ...base, severity: "info", kind: "digest" };
  assert.equal(pushDecision(ev, 1, DEFAULT_SETTINGS, hours(0)), false);
});
