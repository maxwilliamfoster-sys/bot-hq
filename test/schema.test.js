import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1.js";

const TABLES = ["account", "events", "gate", "login_attempts", "milestones", "posts", "push_subs",
  "runs", "sessions", "settings", "snapshots"];

test("makeD1 creates all 11 tables", async () => {
  const db = makeD1();
  const { results } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.deepEqual(results.map(r => r.name), TABLES);
});

test("posts.external_id is unique", async () => {
  const db = makeD1();
  const ins = id => db.prepare("INSERT INTO posts (id, bot, external_id) VALUES (?, 'chess', 'yt1')").bind(id).run();
  await ins("a");
  await assert.rejects(() => ins("b"));
});

test("events insert returns last_row_id 1", async () => {
  const db = makeD1();
  const r = await db.prepare("INSERT INTO events (at, bot, kind, severity, title) VALUES (?, ?, ?, ?, ?)")
    .bind("2026-10-19T00:00:00Z", "chess", "posted", "info", "x").run();
  assert.equal(r.meta.last_row_id, 1);
  assert.equal(await db.prepare("SELECT count FROM events").first("count"), 1);
});
