import assert from "node:assert/strict";
import { makeD1 } from "./d1.js";
import { handle } from "../src/api.js";
import { sha256Hex } from "../src/auth.js";
// Shared test helpers (real WebCrypto keys so push encryption really runs).
const b64u = buf => Buffer.from(buf).toString("base64url");

export async function testVapidEnv() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)) };
}

export async function fakeSubscription(n) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

export async function makeEnv(extra = {}) {
  return {
    DB: makeD1(),
    ACCESS_CODE_HASH: await sha256Hex("amber river six"),
    APP_EVENTS_TOKEN: "bot-token",
    VAPID_PUBLIC_KEY: "BPUB",
    ...(await testVapidEnv()),
    ...extra,
  };
}

export const call = (env, method, path, { body, cookie, headers = {} } = {}) =>
  handle(new Request(`https://hq.test${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": "1.1.1.1", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {} });

export async function signIn(env) {
  const res = await call(env, "POST", "/api/login", { body: { code: "amber river six" } });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}
