// Web Push to every connected device (VAPID, via @pushforge/builder).
import { buildPushHTTPRequest } from "@pushforge/builder";

const CONTACT = "https://bot-hq.maxwilliamfoster.workers.dev";

export async function saveSubscription(db, sub) {
  if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error("invalid subscription");
  }
  await db.prepare(
    "INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth")
    .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()).run();
}

export async function removeSubscription(db, endpoint) {
  await db.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(String(endpoint || "")).run();
}

// Never throws: a broken device or push service must not break the caller.
export async function pushAll(env, db, payload, fetchFn = fetch) {
  const out = { sent: 0, removed: 0 };
  let privateJWK;
  try { privateJWK = JSON.parse(env.VAPID_PRIVATE_JWK); } catch { return out; }
  const { results } = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subs").all();
  const urgency = payload.severity === "action" ? "high" : "normal";
  await Promise.all(results.map(async row => {
    try {
      const { endpoint, headers, body } = await buildPushHTTPRequest({
        privateJWK,
        subscription: { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        message: { payload, adminContact: CONTACT, options: { ttl: 86400, urgency } },
      });
      const res = await fetchFn(endpoint, { method: "POST", headers, body });
      if (res.status === 404 || res.status === 410) {
        await removeSubscription(db, row.endpoint);
        out.removed++;
      } else if (res.ok) {
        out.sent++;
      }
    } catch { /* one device failing never stops the others */ }
  }));
  return out;
}
