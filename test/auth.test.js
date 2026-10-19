import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1.js";
import { sha256Hex, login, sessionCookie, hasSession, bearerOk } from "../src/auth.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const env = async () => ({ ACCESS_CODE_HASH: await sha256Hex("amber river six") });
const withCookie = token => new Request("https://x/api/me", { headers: { cookie: `a=b; __Host-hq=${token}` } });

test("right code returns a token and the cookie signs you in", async () => {
  const db = makeD1();
  const r = await login(db, await env(), "amber river six", "1.2.3.4", NOW);
  assert.equal(r.ok, true);
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await hasSession(db, withCookie(r.token), NOW), true);
  assert.equal(await hasSession(db, withCookie("nope"), NOW), false);
  assert.equal(await hasSession(db, new Request("https://x/"), NOW), false);
  // only the hash is stored
  const stored = await db.prepare("SELECT token_hash FROM sessions").first("token_hash");
  assert.equal(stored, await sha256Hex(r.token));
});

test("wrong code is bad_code", async () => {
  const r = await login(makeD1(), await env(), "wrong", "1.2.3.4", NOW);
  assert.deepEqual(r, { ok: false, error: "bad_code" });
});

test("6th attempt in 15 minutes is rate_limited even with the right code", async () => {
  const db = makeD1();
  const e = await env();
  for (let i = 0; i < 5; i++) await login(db, e, "wrong", "9.9.9.9", new Date(NOW.getTime() + i * 60e3));
  const r = await login(db, e, "amber river six", "9.9.9.9", new Date(NOW.getTime() + 6 * 60e3));
  assert.deepEqual(r, { ok: false, error: "rate_limited" });
  // another IP is unaffected, and the limit lifts after 15 minutes
  assert.equal((await login(db, e, "amber river six", "5.5.5.5", NOW)).ok, true);
  assert.equal((await login(db, e, "amber river six", "9.9.9.9", new Date(NOW.getTime() + 30 * 60e3))).ok, true);
});

test("expired session is not signed in", async () => {
  const db = makeD1();
  const r = await login(db, await env(), "amber river six", "1.2.3.4", NOW);
  const later = new Date(NOW.getTime() + 181 * 86400e3);
  assert.equal(await hasSession(db, withCookie(r.token), later), false);
});

test("session cookie attributes", () => {
  assert.equal(sessionCookie("tok"),
    "__Host-hq=tok; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=15552000");
});

test("bearerOk rejects missing, wrong and empty-secret", () => {
  const req = h => new Request("https://x/api/event", { headers: h });
  assert.equal(bearerOk(req({ authorization: "Bearer s3cret" }), "s3cret"), true);
  assert.equal(bearerOk(req({}), "s3cret"), false);
  assert.equal(bearerOk(req({ authorization: "Bearer nope" }), "s3cret"), false);
  assert.equal(bearerOk(req({ authorization: "Bearer " }), ""), false);
  assert.equal(bearerOk(req({ authorization: "Bearer x" }), undefined), false);
});
