// Events: validation, grouping of repeats, push decisions. Used by /api/event and the watchers.
import { shouldPush } from "./rules.js";
import { buildFixPrompt } from "./prompt.js";
import { getSettings } from "./settings.js";
import { pushAll } from "./push.js";
import { BOTS } from "./bots.js";

const SEVERITIES = ["action", "warn", "good", "info"];
const KIND = /^[a-z_]{2,40}$/;
const GROUP_MS = 24 * 3600e3;
const MAX_DATA = 8 * 1024;

export function validateEvent(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "not_an_object" };
  const { bot, kind, severity } = obj;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const body = obj.body == null ? "" : String(obj.body);
  const data = obj.data == null ? {} : obj.data;
  if (typeof bot !== "string" || !Object.hasOwn(BOTS, bot)) return { ok: false, error: "bad_bot" };
  if (typeof kind !== "string" || !KIND.test(kind)) return { ok: false, error: "bad_kind" };
  if (!SEVERITIES.includes(severity)) return { ok: false, error: "bad_severity" };
  if (title.length < 1 || title.length > 120) return { ok: false, error: "bad_title" };
  if (body.length > 4000) return { ok: false, error: "body_too_long" };
  if (typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "bad_data" };
  if (JSON.stringify(data).length > MAX_DATA) return { ok: false, error: "data_too_big" };
  const dedupe_key = obj.dedupe_key == null ? `${bot}:${kind}:${title}` : String(obj.dedupe_key);
  if (dedupe_key.length > 200) return { ok: false, error: "bad_dedupe_key" };
  return { ok: true, event: { bot, kind, severity, title, body, data, dedupe_key } };
}

// A reminder has no fix prompt: its prompt is the Radar tab's.
const promptFor = ev => ev.kind !== "radar_weekly" && (ev.severity === "action" || ev.severity === "warn")
  ? buildFixPrompt({
    bot: ev.bot, kind: ev.kind, title: ev.title, body: ev.body, repo: ev.data.repo,
    runUrl: ev.data.run_url, step: ev.data.step, logTail: ev.data.log_tail,
  })
  : null;

// Same dedupe_key, still open, seen within 24h -> one row with a growing count.
// pushCount counts within a 24h window that restarts, so a lasting problem pushes daily.
export async function recordEvent(db, event, now = new Date()) {
  const iso = now.toISOString();
  const since = new Date(now.getTime() - GROUP_MS).toISOString();
  const prev = await db.prepare(
    "SELECT id, at, count, window_at, window_count FROM events WHERE dedupe_key = ? AND last_at > ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1")
    .bind(event.dedupe_key, since).first();
  const data_json = JSON.stringify(event.data || {});
  const fix_prompt = promptFor(event);
  if (prev) {
    const count = prev.count + 1;
    const windowAt = prev.window_at || prev.at;
    const restart = Date.parse(windowAt) <= now.getTime() - GROUP_MS;
    const pushCount = restart ? 1 : (prev.window_count || prev.count) + 1;
    await db.prepare("UPDATE events SET count = ?, last_at = ?, window_at = ?, window_count = ?, body = ?, data_json = ?, fix_prompt = ?, read_at = NULL WHERE id = ?")
      .bind(count, iso, restart ? iso : windowAt, pushCount, event.body, data_json, fix_prompt, prev.id).run();
    return { id: prev.id, count, pushCount, isNew: false };
  }
  const r = await db.prepare(
    "INSERT INTO events (at, last_at, window_at, window_count, bot, kind, severity, title, body, data_json, fix_prompt, dedupe_key, count) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
    .bind(iso, iso, iso, event.bot, event.kind, event.severity, event.title, event.body, data_json, fix_prompt, event.dedupe_key).run();
  return { id: r.meta.last_row_id, count: 1, pushCount: 1, isNew: true };
}

export function pushDecision(event, count, settings, now) {
  if (!shouldPush(event, settings, now)) return false;
  if (count === 1) return true;
  return count === 3 && (event.severity === "action" || event.severity === "warn");
}

export async function openActionCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM events WHERE severity = 'action' AND resolved_at IS NULL").first("n");
}

export const pushUrl = (event, id) => (event.kind === "radar_weekly" ? "/#/radar" : `/#/event/${id}`);

// Record an already-validated event and push it if the rules say so.
export async function processEvent(env, event, now = new Date(), fetchFn) {
  const db = env.DB;
  const rec = await recordEvent(db, event, now);
  const settings = await getSettings(db);
  let pushed = false;
  if (pushDecision(event, rec.pushCount, settings, now)) {
    const title = rec.pushCount === 3 ? `${event.title} (3rd time in 24h)` : event.title;
    const r = await pushAll(env, db, {
      title,
      body: (event.body || "").slice(0, 140),
      url: pushUrl(event, rec.id),
      tag: event.dedupe_key,
      badge: await openActionCount(db),
      severity: event.severity,
    }, fetchFn || env.PUSH_FETCH || fetch);
    pushed = r.sent > 0;
  }
  return { ...rec, pushed };
}
