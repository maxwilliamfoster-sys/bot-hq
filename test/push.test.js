import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1.js";
import { saveSubscription, pushAll } from "../src/push.js";
import { getSettings, putSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import { testVapidEnv, fakeSubscription } from "./helpers.js";


test("pushAll removes gone subscriptions", async () => {
  const db = makeD1();
  for (const n of [1, 2, 3]) await saveSubscription(db, await fakeSubscription(n));
  const codes = { "https://push.example/1": 201, "https://push.example/2": 410, "https://push.example/3": 201 };
  const seen = [];
  const fetchFn = async (url, init) => { seen.push([url, init.headers]); return new Response(null, { status: codes[url] }); };
  const r = await pushAll(await testVapidEnv(), db, { title: "t", body: "b", url: "/", tag: "x", badge: 1 }, fetchFn);
  assert.deepEqual(r, { sent: 2, removed: 1 });
  const left = (await db.prepare("SELECT endpoint FROM push_subs ORDER BY endpoint").all()).results.map(r => r.endpoint);
  assert.deepEqual(left, ["https://push.example/1", "https://push.example/3"]);
  assert.equal(seen.length, 3);
});

test("pushAll with no subscriptions", async () => {
  assert.deepEqual(await pushAll(await testVapidEnv(), makeD1(), { title: "t" }, async () => { throw new Error("no"); }),
    { sent: 0, removed: 0 });
});

test("pushAll never throws when the network fails or the key is missing", async () => {
  const db = makeD1();
  await saveSubscription(db, await fakeSubscription(1));
  assert.deepEqual(await pushAll(await testVapidEnv(), db, { title: "t" }, async () => { throw new Error("down"); }),
    { sent: 0, removed: 0 });
  assert.deepEqual(await pushAll({}, db, { title: "t" }, async () => new Response(null, { status: 201 })),
    { sent: 0, removed: 0 });
});

test("action pushes are high urgency", async () => {
  const db = makeD1();
  await saveSubscription(db, await fakeSubscription(1));
  let headers;
  await pushAll(await testVapidEnv(), db, { title: "t", severity: "action" }, async (u, init) => { headers = init.headers; return new Response(null, { status: 201 }); });
  const h = new Headers(headers);
  assert.equal(h.get("urgency"), "high");
});

test("saveSubscription upserts and settings merge defaults", async () => {
  const db = makeD1();
  const s = await fakeSubscription(1);
  await saveSubscription(db, s);
  await saveSubscription(db, { ...s, keys: { ...s.keys, auth: "new" } });
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM push_subs").first("n"), 1);
  assert.deepEqual(await getSettings(db), DEFAULT_SETTINGS);
  await putSettings(db, { notify_posted: false, bogus: 1 });
  const got = await getSettings(db);
  assert.equal(got.notify_posted, false);
  assert.equal("bogus" in got, false);
});
