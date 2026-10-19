// Inbox data: the open "needs you" block, a filtered feed in pages of 30, event detail,
// read and resolve. Filter chips map to severities/kinds (plan Global Constraints).
import { openActionCount } from "./events.js";

export const PAGE = 30;
const FILTERS = {
  all: ["1 = 1", []],
  needs: ["severity = ?", ["action"]],
  failed: ["severity = ?", ["warn"]],
  good: ["severity = ?", ["good"]],
  posted: ["kind = ?", ["posted"]],
  summary: ["kind IN (?, ?)", ["summary", "digest"]],
};
const COLS = "id, at, last_at, bot, kind, severity, title, count, read_at, resolved_at";
const OPEN_ACTION = "(severity = 'action' AND resolved_at IS NULL)";

const row = e => ({
  id: e.id, at: e.at, last_at: e.last_at, bot: e.bot, kind: e.kind, severity: e.severity, title: e.title,
  count: e.count, read: !!e.read_at, resolved: !!e.resolved_at,
});

export async function inboxData(db, filter = "all", before = null) {
  if (!Object.hasOwn(FILTERS, filter)) return null;
  const [where, args] = FILTERS[filter];
  const { results: needs } = await db.prepare(`SELECT ${COLS} FROM events WHERE ${OPEN_ACTION} ORDER BY last_at DESC LIMIT 50`).all();
  const page = before ? " AND id < ?" : "";
  const { results } = await db.prepare(
    `SELECT ${COLS} FROM events WHERE ${where} AND NOT ${OPEN_ACTION}${page} ORDER BY id DESC LIMIT ?`)
    .bind(...args, ...(before ? [Number(before)] : []), PAGE + 1).all();
  return {
    open_actions: needs.length,
    needs: needs.map(row),
    events: results.slice(0, PAGE).map(row),
    more: results.length > PAGE,
  };
}

export async function eventDetail(db, id) {
  const e = await db.prepare("SELECT * FROM events WHERE id = ?").bind(Number(id)).first();
  if (!e) return null;
  let data = {};
  try { data = JSON.parse(e.data_json || "{}"); } catch { /* keep {} */ }
  return { ...row(e), body: e.body || "", data, fix_prompt: e.fix_prompt || null };
}

export async function markEvent(db, id, what, now = new Date()) {
  const iso = now.toISOString();
  const r = what === "resolve"
    ? await db.prepare("UPDATE events SET resolved_at = COALESCE(resolved_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ?")
      .bind(iso, iso, Number(id)).run()
    : await db.prepare("UPDATE events SET read_at = COALESCE(read_at, ?) WHERE id = ?").bind(iso, Number(id)).run();
  if (!r.meta.changes) return null;
  return { ok: true, open_actions: await openActionCount(db) };
}
