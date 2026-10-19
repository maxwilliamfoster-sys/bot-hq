// Hourly copy of the bots' recent upload-gate checks, so "AI reviews used today" is
// current (the nightly backfill alone would always be a day behind).
import { BOTS, OWNER } from "../bots.js";

const toIso = s => new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`).toISOString();

export function parseGateLog(bot, log) {
  return (log?.entries || []).filter(e => e.checked_at).map(e => ({
    bot, at: toIso(e.checked_at), ok: e.ok ? 1 : 0, ai_used: e.ai?.available === true ? 1 : 0,
  }));
}

export async function refreshGate(env, db, fetchFn = fetch, now = new Date()) {
  if (!env.GH_READ_TOKEN) return 0;
  const since = new Date(now.getTime() - 48 * 3600e3).toISOString();
  const rows = [];
  for (const bot of ["chess", "bcf", "escape"]) {
    const res = await fetchFn(`https://api.github.com/repos/${OWNER}/${BOTS[bot].repo}/contents/upload_gate_log.json`, {
      headers: { authorization: `Bearer ${env.GH_READ_TOKEN}`, accept: "application/vnd.github.raw",
        "user-agent": "bot-hq", "x-github-api-version": "2022-11-28" },
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${bot} gate log`);
    rows.push(...parseGateLog(bot, await res.json()).filter(r => r.at >= since));
  }
  if (!rows.length) return 0;
  const out = await db.batch(rows.map(r =>
    db.prepare("INSERT OR IGNORE INTO gate (bot, at, ok, ai_used) VALUES (?, ?, ?, ?)").bind(r.bot, r.at, r.ok, r.ai_used)));
  return out.reduce((n, r) => n + (r.meta?.changes || 0), 0);
}
