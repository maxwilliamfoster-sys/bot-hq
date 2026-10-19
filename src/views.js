// Data for the Live and Bots tabs. A handful of indexed queries per request: the Live tab
// refreshes every minute while open, and the free plan counts every row read.
import { BOTS, BOT_IDS } from "./bots.js";
import { ukParts } from "./rules.js";
import { getState } from "./settings.js";

const H = 3600e3;
const CHESS_SLOTS_UTC = [4, 14, 22];
const BCF_SLOTS_UK = ["09:15", "12:45", "15:45"];
const AI_CAPS = { chess: 10, bcf: 20, escape: 8 };   // AI_DAILY_CAP in each bot (per UTC day)
const SPARK_POINTS = 24;

// The UTC instant when UK clocks show `hhmm` on the UK date of `day`.
function ukTime(day, hhmm) {
  const { ymd } = ukParts(day);
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  for (const shift of [0, -1, 1]) {
    const t = new Date(guess.getTime() + shift * H);
    const p = ukParts(t);
    if (p.ymd === ymd && p.hhmm === hhmm) return t;
  }
  return guess;
}

export function nextSlot(bot, now = new Date(), escapeNextDue = null) {
  const after = t => t.getTime() > now.getTime();
  if (bot === "chess") {
    for (let d = 0; d < 2; d++) {
      for (const h of CHESS_SLOTS_UTC) {
        const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, h));
        if (after(t)) return t.toISOString();
      }
    }
  }
  if (bot === "bcf") {
    for (let d = 0; d < 2; d++) {
      for (const hhmm of BCF_SLOTS_UK) {
        const t = ukTime(new Date(now.getTime() + d * 24 * H), hhmm);
        if (after(t)) return t.toISOString();
      }
    }
  }
  if (bot === "escape" && escapeNextDue && after(new Date(escapeNextDue))) return new Date(escapeNextDue).toISOString();
  return null;
}

function spark(values) {
  if (values.length <= SPARK_POINTS) return values;
  const step = (values.length - 1) / (SPARK_POINTS - 1);
  return Array.from({ length: SPARK_POINTS }, (_, i) => values[Math.round(i * step)]);
}

async function latestRuns(db) {
  const { results } = await db.prepare(
    "SELECT repo, workflow, conclusion, url, at FROM runs ORDER BY at DESC LIMIT 300").all();
  return results;
}

export async function liveData(db, now = new Date()) {
  const since = new Date(now.getTime() - 24 * H).toISOString();
  const { results: posts } = await db.prepare(
    "SELECT id, bot, title, url, posted_at FROM posts WHERE posted_at > ? ORDER BY posted_at DESC").bind(since).all();
  const snaps = new Map(posts.map(p => [p.id, []]));
  if (posts.length) {
    const { results } = await db.prepare(
      `SELECT post_id, at, views FROM snapshots WHERE post_id IN (${posts.map(() => "?").join(",")}) AND views IS NOT NULL ORDER BY at`)
      .bind(...posts.map(p => p.id)).all();
    for (const s of results) snaps.get(s.post_id).push(s);
  }
  const runs = await latestRuns(db);
  const escapeDue = (await getState(db, "escape_next_due")) || null;
  const today = ukParts(now).ymd;
  const hourAgo = new Date(now.getTime() - H).toISOString();
  return {
    updated_at: now.toISOString(),
    bots: BOT_IDS.map(bot => {
      const mine = posts.filter(p => p.bot === bot);
      const run = runs.find(r => r.repo === BOTS[bot].repo);
      const lastSnaps = mine.map(p => snaps.get(p.id).at(-1)).filter(Boolean);
      return {
        bot,
        today: { posted: mine.filter(p => ukParts(new Date(p.posted_at)).ymd === today).length, planned: BOTS[bot].planned },
        next_slot: nextSlot(bot, now, escapeDue),
        last_run: run ? { conclusion: run.conclusion, url: run.url, at: run.at, workflow: run.workflow } : null,
        stats_at: lastSnaps.map(s => s.at).sort().at(-1) || null,
        posts: mine.map(p => {
          const s = snaps.get(p.id);
          const last = s.at(-1);
          const before = s.findLast(x => x.at <= hourAgo);
          return { id: p.id, title: p.title, url: p.url, posted_at: p.posted_at, views: last ? last.views : null,
            delta_1h: last && before ? last.views - before.views : null, spark: spark(s.map(x => x.views)) };
        }),
      };
    }),
  };
}

export async function botsData(db, now = new Date()) {
  const runs = await latestRuns(db);
  const dayStart = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
  const { results: gate } = await db.prepare(
    "SELECT bot, COUNT(*) AS checks, SUM(ai_used) AS used FROM gate WHERE at >= ? GROUP BY bot").bind(dayStart).all();
  const digest = await db.prepare("SELECT data_json FROM events WHERE kind = 'digest' ORDER BY id DESC LIMIT 1").first("data_json");
  let experiments = [];
  try { experiments = JSON.parse(digest || "{}").experiments || []; } catch { /* bad row: show none */ }
  return {
    updated_at: now.toISOString(),
    experiments,
    bots: BOT_IDS.map(bot => {
      const byWorkflow = new Map();
      for (const r of runs.filter(r => r.repo === BOTS[bot].repo)) {
        if (!byWorkflow.has(r.workflow)) byWorkflow.set(r.workflow, []);
        const list = byWorkflow.get(r.workflow);
        if (list.length < 5) list.push({ conclusion: r.conclusion, url: r.url, at: r.at });
      }
      const g = gate.find(x => x.bot === bot);
      return {
        bot,
        workflows: [...byWorkflow].map(([name, list]) => ({ name, runs: list })),
        ai: { used: Number(g?.used || 0), cap: AI_CAPS[bot], checks: Number(g?.checks || 0) },
      };
    }),
  };
}
