// Trend Intelligence <-> the evening autopilot (analytics-check/autopilot, on the PC). The Worker can't reach the
// PC's files, so the autopilot asks: kit.py reads the queue, marks what it put in an account's idea backlog, writes
// ideas and reports test results. Every route here uses the bot credential. Nothing here can change a niche, and an
// opportunity that failed the niche gate can't get ideas or results.
import { getProfile } from "./profiles.js";
import { processEvent } from "../events.js";

const DAY = 864e5;
const MAX_ANALYSE = 3;          // ideas for at most 3 trends a run (design: "at most 3 high-priority items")
const MAX_IDEAS = 3;            // per call
const MAX_STORED_IDEAS = 9;     // per opportunity, so one trend can't fill the table
const OUTCOMES = { testing: ["approved"], won: ["approved", "testing"], lost: ["approved", "testing"], no_difference: ["approved", "testing"] };

const parse = (s, fallback) => { try { return JSON.parse(s || "") ?? fallback; } catch { return fallback; } };
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const optText = (v, max) => v === undefined || v === null || (typeof v === "string" && v.length <= max);

async function evidence(db, trendIds) {
  if (!trendIds.length) return new Map();
  const { results } = await db.prepare(
    `SELECT id, trend_id, source, url, title, published_at FROM trend_signals
     WHERE trend_id IN (${trendIds.map(() => "?").join(",")}) AND source_type NOT IN ('manual', 'claude') ORDER BY fetched_at DESC, id DESC`)
    .bind(...trendIds).all();
  const out = new Map();
  for (const s of results) {
    const list = out.get(s.trend_id) || [];
    if (list.length < 5) list.push({ id: s.id, source: s.source, url: s.url, title: s.title, published_at: s.published_at });
    out.set(s.trend_id, list);
  }
  return out;
}

function brief(r, signals) {
  const p = getProfile(r.account);
  return {
    id: r.id, trend_id: r.trend_id, account: r.account, account_name: p?.name || r.account, platform: p?.platform || null,
    name: r.name, category: r.category, score: r.score, class: r.class, lifecycle: r.lifecycle, flags: parse(r.flags, []),
    niche: p?.niche || null, locked_rules: p?.locked_rules || [], notes: r.notes, reason: r.status_reason,
    analysis_requested: !!r.analysis_requested, evidence: signals.get(r.trend_id) || [], link: `/#/trends/${r.trend_id}`,
  };
}

// GET /api/trends/queue[?account=KEY]
//   approved: Max approved it and it isn't in the autopilot backlog yet.
//   analyse:  up to 3 that want ideas (Max asked for analysis, or scored 80+), newest score first, none with ideas yet.
export async function queue(db, account, now = new Date()) {
  const acc = account ? "AND o.account = ?" : "";
  const args = account ? [account] : [];
  const cols = "o.id, o.trend_id, o.account, o.score, o.class, o.notes, o.status_reason, o.analysis_requested, t.name, t.category, t.lifecycle, t.flags";
  const [approved, analyse] = await Promise.all([
    db.prepare(`SELECT ${cols} FROM opportunities o JOIN trends t ON t.id = o.trend_id
                WHERE o.status = 'approved' AND o.handed_at IS NULL AND o.gate_passed = 1 ${acc} ORDER BY o.decided_at`).bind(...args).all(),
    db.prepare(`SELECT ${cols} FROM opportunities o JOIN trends t ON t.id = o.trend_id
                WHERE o.status IN ('new', 'approved') AND o.gate_passed = 1 AND o.class != 'rejected' AND t.lifecycle != 'expired'
                  AND (o.analysis_requested = 1 OR o.class = 'high') ${acc}
                  AND NOT EXISTS (SELECT 1 FROM opportunity_ideas i WHERE i.opportunity_id = o.id)
                ORDER BY o.analysis_requested DESC, o.score DESC LIMIT ?`).bind(...args, MAX_ANALYSE).all(),
  ]);
  // Rejected after it reached the backlog (last 30 days): kit.py parks that idea. Re-sent each time; parking is idempotent.
  const withdrawn = await db.prepare(
    `SELECT id, account FROM opportunities WHERE status = 'rejected' AND handed_at IS NOT NULL AND decided_at >= ? ${account ? "AND account = ?" : ""}`)
    .bind(new Date(now - 30 * DAY).toISOString(), ...args).all();
  const ids = [...new Set([...approved.results, ...analyse.results].map(r => r.trend_id))];
  const signals = await evidence(db, ids);
  return { approved: approved.results.map(r => brief(r, signals)), analyse: analyse.results.map(r => brief(r, signals)),
    withdrawn: withdrawn.results.map(r => ({ id: r.id, account: r.account })) };
}

const opportunity = (db, id) => db.prepare(
  "SELECT o.id, o.account, o.status, o.class, o.gate_passed, o.trend_id, t.flags FROM opportunities o JOIN trends t ON t.id = o.trend_id WHERE o.id = ?")
  .bind(Number(id)).first();

// POST /api/trends/opportunities/:id/handed - kit.py put it in the account's idea backlog. Idempotent.
export async function markHanded(db, id, now) {
  const o = await opportunity(db, id);
  if (!o) return { status: 404, error: "not_found" };
  if (o.status !== "approved") return { status: 409, error: "not_approved" };
  await db.prepare("UPDATE opportunities SET handed_at = COALESCE(handed_at, ?), updated_at = ? WHERE id = ?")
    .bind(now.toISOString(), now.toISOString(), o.id).run();
  return { status: 200, id: o.id };
}

// One idea from the evening run. Ideas are never evidence (stored apart from the signals). The account's locked
// rules are added to its risks, and an idea for a live case must name its risk (accused, not guilty).
export function validIdea(i) {
  return !!i && typeof i === "object" && !Array.isArray(i) && text(i.title, 200).length > 0 && i.title.length <= 200 &&
    optText(i.hook, 300) && optText(i.format, 120) && optText(i.duration, 40) && optText(i.storytelling, 600) &&
    optText(i.why, 600) && optText(i.platform_notes, 400) &&
    (i.risks === undefined || (Array.isArray(i.risks) && i.risks.length <= 6 && i.risks.every(r => typeof r === "string" && r.length <= 300))) &&
    (i.evidence_ids === undefined || (Array.isArray(i.evidence_ids) && i.evidence_ids.length <= 10 && i.evidence_ids.every(Number.isInteger)));
}

// POST /api/trends/opportunities/:id/ideas {ideas: [...]}
export async function addIdeas(db, id, b, now) {
  const ideas = b?.ideas;
  if (!Array.isArray(ideas) || !ideas.length || ideas.length > MAX_IDEAS || !ideas.every(validIdea)) return { status: 400, error: "bad_ideas" };
  const o = await opportunity(db, id);
  if (!o) return { status: 404, error: "not_found" };
  if (!o.gate_passed || o.class === "rejected") return { status: 409, error: "niche_gate" };
  if (!["new", "approved", "testing"].includes(o.status)) return { status: 409, error: "already_" + o.status };
  const live = parse(o.flags, []).includes("active_case");
  if (live && ideas.some(i => !(i.risks || []).some(r => r.trim()))) return { status: 422, error: "active_case_needs_risk" };
  const stored = await db.prepare("SELECT COUNT(*) AS n FROM opportunity_ideas WHERE opportunity_id = ?").bind(o.id).first("n");
  if (stored + ideas.length > MAX_STORED_IDEAS) return { status: 409, error: "too_many_ideas" };
  // Evidence ids must be this trend's own signals.
  const cited = [...new Set(ideas.flatMap(i => i.evidence_ids || []))];
  if (cited.length) {
    const { results } = await db.prepare(`SELECT id FROM trend_signals WHERE trend_id = ? AND id IN (${cited.map(() => "?").join(",")})`)
      .bind(o.trend_id, ...cited).all();
    if (results.length !== cited.length) return { status: 400, error: "bad_evidence_ids" };
  }
  const rules = getProfile(o.account)?.locked_rules || [];
  const iso = now.toISOString();
  await db.batch(ideas.map(i => {
    const risks = [...(i.risks || []).map(r => r.trim()).filter(Boolean)];
    for (const r of rules) if (!risks.includes(r)) risks.push(r);
    const idea = { title: i.title.trim(), hook: text(i.hook, 300) || undefined, format: text(i.format, 120) || undefined,
      duration: text(i.duration, 40) || undefined, storytelling: text(i.storytelling, 600) || undefined, why: text(i.why, 600) || undefined,
      platform_notes: text(i.platform_notes, 400) || undefined, risks, evidence_ids: i.evidence_ids || [] };
    return db.prepare("INSERT INTO opportunity_ideas (opportunity_id, created_at, idea_json) VALUES (?, ?, ?)").bind(o.id, iso, JSON.stringify(idea));
  }));
  await db.prepare("UPDATE opportunities SET updated_at = ? WHERE id = ?").bind(iso, o.id).run();
  return { status: 200, id: o.id, stored: stored + ideas.length };
}

// POST /api/trends/opportunities/:id/outcome {status: testing|won|lost|no_difference, note?}
export async function setOutcome(db, id, b, now) {
  const to = b?.status;
  if (!Object.hasOwn(OUTCOMES, to) || !optText(b?.note, 300)) return { status: 400, error: "bad_outcome" };
  const o = await opportunity(db, id);
  if (!o) return { status: 404, error: "not_found" };
  if (o.status === to) return { status: 200, id: o.id, status_now: to };
  if (!OUTCOMES[to].includes(o.status)) return { status: 409, error: "from_" + o.status };
  const iso = now.toISOString();
  await db.prepare("UPDATE opportunities SET status = ?, outcome_note = COALESCE(?, outcome_note), handed_at = COALESCE(handed_at, ?), updated_at = ? WHERE id = ?")
    .bind(to, text(b.note, 300) || null, iso, iso, o.id).run();
  return { status: 200, id: o.id, status_now: to };
}

// ---- Inbox --------------------------------------------------------------------------------------------------
// Hourly: one Inbox item when new strong (80+) trends are waiting. Severity info, so with "only when I am needed"
// on it stays in the Inbox and doesn't buzz the phone (rules.js shouldPush).
export async function trendAlerts(env, db, now) {
  const { results } = await db.prepare(
    `SELECT o.id, o.account, o.score, t.name, t.id AS trend_id FROM opportunities o JOIN trends t ON t.id = o.trend_id
     WHERE o.class = 'high' AND o.status = 'new' AND o.gate_passed = 1 AND o.notified_at IS NULL AND t.lifecycle != 'expired'
     ORDER BY o.score DESC LIMIT 20`).all();
  if (!results.length) return { notified: 0 };
  const names = results.slice(0, 3).map(r => `${r.name} (${getProfile(r.account)?.name || r.account}, ${r.score})`);
  const n = results.length;
  await processEvent(env, {
    bot: "system", kind: "trend_waiting", severity: "info",
    title: n === 1 ? "A strong trend is waiting for you" : `${n} strong trends are waiting for you`,
    body: `Scored 80 or more inside the account's own niche: ${names.join("; ")}${n > 3 ? `; and ${n - 3} more` : ""}. Approve or reject them in the Trends tab.`,
    data: { opportunities: results.map(r => r.id) }, dedupe_key: `trend_waiting:${results[0].id}:${now.toISOString().slice(0, 13)}`,
  }, now);
  await db.prepare(`UPDATE opportunities SET notified_at = ? WHERE id IN (${results.map(() => "?").join(",")})`)
    .bind(now.toISOString(), ...results.map(r => r.id)).run();
  return { notified: n };
}

// Sundays: how each score band did once tested ("80+: won 2 of 5"), so the scoring can be judged on results.
export const BANDS = [["80+", 80, 101], ["65-79", 65, 80], ["under 65", 0, 65]];
export async function outcomeBands(db, since) {
  const { results } = await db.prepare(
    `SELECT score, status FROM opportunities WHERE status IN ('won', 'lost', 'no_difference') AND score IS NOT NULL ${since ? "AND updated_at >= ?" : ""}`)
    .bind(...(since ? [since] : [])).all();
  return BANDS.map(([label, lo, hi]) => {
    const rows = results.filter(r => r.score >= lo && r.score < hi);
    return { band: label, tested: rows.length, won: rows.filter(r => r.status === "won").length,
      lost: rows.filter(r => r.status === "lost").length, no_difference: rows.filter(r => r.status === "no_difference").length };
  });
}

export async function trendWeekly(env, db, now) {
  const since = new Date(now - 7 * DAY).toISOString();
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first("n");
  const [found, approved, rejected] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM trends WHERE first_seen >= ?", since),
    one("SELECT COUNT(*) AS n FROM opportunities WHERE status != 'new' AND status != 'rejected' AND decided_at >= ?", since),
    one("SELECT COUNT(*) AS n FROM opportunities WHERE status = 'rejected' AND decided_at >= ?", since),
  ]);
  const bands = await outcomeBands(db);
  const tested = bands.filter(b => b.tested);
  const lines = tested.length
    ? tested.map(b => `${b.band}: won ${b.won} of ${b.tested}`).join("; ")
    : "No trend has finished a test yet, so the scores can't be checked against results.";
  await processEvent(env, {
    bot: "system", kind: "trend_weekly", severity: "info", title: "Trends this week",
    body: `${found} new trends found, ${approved} approved, ${rejected} rejected. Results so far by score: ${lines}`,
    data: { found, approved, rejected, bands }, dedupe_key: `trend_weekly:${now.toISOString().slice(0, 10)}`,
  }, now);
  return { found, approved, rejected };
}
