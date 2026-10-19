// JSON API. Each route declares who may call it: "open", "session" (the phone) or "bot" (bearer token).
import { login, logout, hasSession, bearerOk, sessionCookie, clearCookie } from "./auth.js";
import { getSettings, putSettings } from "./settings.js";
import { saveSubscription, removeSubscription, pushAll } from "./push.js";
import { validateEvent, processEvent } from "./events.js";
import { clock } from "./bots.js";
import { recordPostFromEvent } from "./watch/stats.js";
import { ingest } from "./ingest.js";

const MAX_BODY = 512 * 1024;

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "too_large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, "bad_json"); }
}

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const pushFetch = env => env.PUSH_FETCH || fetch;

// [method, path (string or RegExp), access, handler(ctx)]
export const routes = [
  ["GET", "/api/me", "open", async ({ env, request }) =>
    json({ signedIn: await hasSession(env.DB, request) })],

  ["POST", "/api/login", "open", async ({ env, request, body }) => {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const r = await login(env.DB, env, body.code, ip);
    if (!r.ok) return json({ error: r.error }, r.error === "rate_limited" ? 429 : 401);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(r.token) });
  }],

  ["POST", "/api/logout", "open", async ({ env, request }) => {
    await logout(env.DB, request);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }],

  ["GET", "/api/push/key", "open", async ({ env }) => json({ key: env.VAPID_PUBLIC_KEY || "" })],

  ["POST", "/api/push/subscribe", "session", async ({ env, body }) => {
    try { await saveSubscription(env.DB, body); } catch { return json({ error: "bad_subscription" }, 400); }
    return json({ ok: true });
  }],

  ["POST", "/api/push/unsubscribe", "session", async ({ env, body }) => {
    await removeSubscription(env.DB, body.endpoint);
    return json({ ok: true });
  }],

  ["POST", "/api/push/test", "session", async ({ env }) =>
    json(await pushAll(env, env.DB, {
      title: "Bot HQ test ✅", body: "Notifications are working on this device.", url: "/#/settings", tag: "test",
    }, pushFetch(env)))],

  ["POST", "/api/event", "bot", async ({ env, body }) => {
    const v = validateEvent(body);
    if (!v.ok) return json({ error: v.error }, 400);
    const now = clock(env);
    await recordPostFromEvent(env.DB, v.event, now);
    const r = await processEvent(env, v.event, now);
    return json({ id: r.id, count: r.count, pushed: r.pushed });
  }],

  ["POST", "/api/ingest", "bot", async ({ env, body }) => json(await ingest(env.DB, body))],

  ["GET", "/api/settings", "session", async ({ env }) => json(await getSettings(env.DB))],
  ["PUT", "/api/settings", "session", async ({ env, body }) => json(await putSettings(env.DB, body))],
];

function match(method, pathname) {
  for (const [m, p, access, fn] of routes) {
    if (m !== method) continue;
    if (typeof p === "string" ? p === pathname : p.test(pathname)) {
      const params = typeof p === "string" ? [] : pathname.match(p).slice(1);
      return { access, fn, params };
    }
  }
  return null;
}

// Session writes must come from this site (CSRF guard on top of SameSite=Strict).
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const route = match(request.method, url.pathname);
  if (!route) return json({ error: "not_found" }, 404);
  try {
    if (route.access === "session") {
      if (!(await hasSession(env.DB, request))) return json({ error: "signed_out" }, 401);
      if (request.method !== "GET" && !sameOrigin(request)) return json({ error: "bad_origin" }, 403);
    }
    if (route.access === "bot" && !bearerOk(request, env.APP_EVENTS_TOKEN)) return json({ error: "unauthorized" }, 401);
    const body = request.method === "GET" ? {} : await readJson(request);
    return await route.fn({ request, env, ctx, url, body, params: route.params });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code }, e.status);
    console.error("api error", url.pathname, e?.stack || e);
    return json({ error: "server_error" }, 500);
  }
}
