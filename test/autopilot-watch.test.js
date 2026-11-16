import { test } from "node:test";
import assert from "node:assert/strict";
import { autopilotAlerts, AUTOPILOT_LATE_H, AUTOPILOT_STUCK_H } from "../src/rules.js";
import { getState } from "../src/settings.js";
import { handle } from "../src/api.js";
import { makeEnv } from "./helpers.js";

// The evening Claude review (analytics-check/autopilot) checks in as bot "system" with a heartbeat:
// phase started -> finished / nothing_due, or failed. Bot HQ runs in the cloud, so it can tell Max when
// the PC-side review never ran, stopped half way, or reported a failure.
const now = new Date("2026-11-18T12:00:00Z");
const ago = h => new Date(now.getTime() - h * 3600e3).toISOString();
const kinds = out => out.map(e => [e.kind, e.severity]);

test("no check-in yet means not connected, so no alert", () => {
  assert.deepEqual(autopilotAlerts(null, now), []);
});

test("a run that finished or found nothing due last evening is quiet", () => {
  assert.deepEqual(autopilotAlerts({ at: ago(18), phase: "finished" }, now), []);
  assert.deepEqual(autopilotAlerts({ at: ago(18), phase: "nothing_due" }, now), []);
});

test("a run still going within a few hours is quiet", () => {
  assert.deepEqual(autopilotAlerts({ at: ago(1), phase: "started" }, now), []);
});

test("no check-in for over a day means the evening run didn't happen", () => {
  const out = autopilotAlerts({ at: ago(AUTOPILOT_LATE_H + 1), phase: "finished" }, now);
  assert.deepEqual(kinds(out), [["autopilot_missed", "action"]]);
  assert.equal(out[0].bot, "system");
  assert.match(out[0].title, /Autopilot hasn't run for 28h/);
  assert.match(out[0].body, /PC/);
});

test("a run that started but never finished is stuck", () => {
  const out = autopilotAlerts({ at: ago(AUTOPILOT_STUCK_H + 1), phase: "started", account: "buried" }, now);
  assert.deepEqual(kinds(out), [["autopilot_stuck", "action"]]);
  assert.match(out[0].body, /permission|usage/);
});

test("a run that reported a failure says why", () => {
  const out = autopilotAlerts({ at: ago(1), phase: "failed", detail: "tests failed in escape-cup" }, now);
  assert.deepEqual(kinds(out), [["autopilot_failed", "action"]]);
  assert.match(out[0].body, /tests failed in escape-cup/);
});

test("each problem alerts once per check-in, not every hour", () => {
  const beat = { at: ago(30), phase: "started" };
  const a = autopilotAlerts(beat, now)[0].dedupe_key;
  const b = autopilotAlerts(beat, new Date(now.getTime() + 3600e3))[0].dedupe_key;
  assert.equal(a, b);
});

test("the hourly tick turns a missed evening into one inbox alert with a fix prompt", async () => {
  const { runSchedule } = await import("../src/schedule.js");
  const { setState } = await import("../src/settings.js");
  const env = await makeEnv({ PUSH_FETCH: async () => new Response(null, { status: 201 }) });
  const tick = new Date("2026-11-18T12:01:00Z");
  await setState(env.DB, "heartbeat:system", JSON.stringify({ at: ago(40), phase: "finished" }));
  await runSchedule({}, env, { waitUntil() {} }, async () => new Response("{}", { status: 200 }), tick);
  await runSchedule({}, env, { waitUntil() {} }, async () => new Response("{}", { status: 200 }), new Date(tick.getTime() + 3600e3));
  const rows = (await env.DB.prepare("SELECT bot, kind, severity, title, count, fix_prompt FROM events WHERE kind LIKE 'autopilot_%'").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bot, "system");
  assert.equal(rows[0].kind, "autopilot_missed");
  assert.equal(rows[0].count, 2);                                   // the same problem grows, it isn't a new row
  assert.match(rows[0].fix_prompt, /list_task_runs/);
});

test("the autopilot's check-in is stored and never lands in the inbox", async () => {
  const env = await makeEnv();
  const req = new Request("https://x/api/event", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.APP_EVENTS_TOKEN}` },
    body: JSON.stringify({ bot: "system", kind: "heartbeat", severity: "info", title: "Autopilot started", data: { phase: "started" } }) });
  assert.equal((await handle(req, env)).status, 200);
  assert.equal(JSON.parse(await getState(env.DB, "heartbeat:system")).phase, "started");
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n"), 0);
});
