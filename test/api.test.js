import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { fakeSubscription, makeEnv, signIn, call } from "./helpers.js";

test("me without a cookie is signed out", async () => {
  const res = await call(await makeEnv(), "GET", "/api/me");
  assert.deepEqual(await res.json(), { signedIn: false });
});

test("settings need a session", async () => {
  const res = await call(await makeEnv(), "GET", "/api/settings");
  assert.equal(res.status, 401);
});

test("login then settings returns the defaults", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  assert.deepEqual(await (await call(env, "GET", "/api/me", { cookie })).json(), { signedIn: true });
  const res = await call(env, "GET", "/api/settings", { cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), DEFAULT_SETTINGS);
  const put = await call(env, "PUT", "/api/settings", { cookie, body: { notify_good: false } });
  assert.equal((await put.json()).notify_good, false);
});

test("wrong code is 401, unknown route is 404 JSON", async () => {
  const env = await makeEnv();
  const bad = await call(env, "POST", "/api/login", { body: { code: "nope" } });
  assert.equal(bad.status, 401);
  const res = await call(env, "GET", "/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("subscribe, test push, unsubscribe", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  const sub = await fakeSubscription(1);
  assert.equal((await call(env, "POST", "/api/push/subscribe", { body: sub })).status, 401);
  assert.equal((await call(env, "POST", "/api/push/subscribe", { cookie, body: sub })).status, 200);
  assert.deepEqual(await (await call(env, "GET", "/api/push/key")).json(), { key: "BPUB" });
  const pushed = [];
  env.PUSH_FETCH = async url => { pushed.push(url); return new Response(null, { status: 201 }); };
  const t = await call(env, "POST", "/api/push/test", { cookie });
  assert.deepEqual(await t.json(), { sent: 1, removed: 0 });
  assert.equal((await call(env, "POST", "/api/push/unsubscribe", { cookie, body: { endpoint: sub.endpoint } })).status, 200);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) n FROM push_subs").first("n"), 0);
});

test("logout ends the session", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  const out = await call(env, "POST", "/api/logout", { cookie });
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await call(env, "GET", "/api/settings", { cookie })).status, 401);
});

test("cross-site POST with a session is refused", async () => {
  const env = await makeEnv();
  const cookie = await signIn(env);
  const res = await call(env, "PUT", "/api/settings", { cookie, body: {}, headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});
