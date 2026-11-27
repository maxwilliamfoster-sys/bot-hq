// Trend Intelligence storage. Every way in (collector batch, manual research, approval) runs the niche gate here.
import { getState, setState } from "../settings.js";
import { PROFILES, getProfile, profileHash } from "./profiles.js";
import { nicheGate, gateText } from "./gate.js";
import { DEFAULT_WEIGHTS, COMPONENTS, validWeights, scoreOpportunity, evidenceLabel } from "./score.js";
import { dedupeKey } from "./dedupe.js";
import { normalise, phraseIndex, hasMixedScript } from "./text.js";

// Free plan: 10 ms CPU per request. The gate reads the stored text (TEXT_CAP) plus the full incoming text, so
// the batch is small. Measured worst case (every field at its limit, 8 accounts): 8 candidates 6.4-8.8 ms, so 5.
export const MAX_BATCH = 5;
const MAX_SIGNALS = 10;
const TEXT_CAP = 2000;
const SOURCE_TYPES = new Set(["search", "wiki", "news", "video", "social", "manual", "claude"]);
export const CLASSES = ["high", "test", "monitor", "low", "rejected"];
export const STATUSES = ["new", "approved", "rejected", "testing", "won", "lost", "no_difference"];
const PLATFORMS = ["youtube", "tiktok", "instagram"];

const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const optStr = (v, max) => v === undefined || v === null || (typeof v === "string" && v.length <= max);
const isDate = v => typeof v === "string" && !Number.isNaN(Date.parse(v));
const optDate = v => v === undefined || v === null || isDate(v);
export const httpUrl = v => {
  if (typeof v !== "string" || v.length > 1000) return false;
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
};

function validSignal(s) {
  return !!s && typeof s === "object" && str(s.source, 40) && SOURCE_TYPES.has(s.source_type) &&
    (s.url === "" || httpUrl(s.url)) && isDate(s.fetched_at) && optDate(s.published_at) &&
    optStr(s.title, 300) && optStr(s.metric, 40) && (s.value === undefined || s.value === null || Number.isFinite(s.value));
}

export function validCandidate(c) {
  return !!c && typeof c === "object" && str(c.name, 200) && !!dedupeKey(c.name) &&
    optStr(c.category, 60) && optStr(c.text, 1000) &&
    Array.isArray(c.signals) && c.signals.length > 0 && c.signals.length <= MAX_SIGNALS && c.signals.every(validSignal) &&
    (c.for_accounts === undefined || (Array.isArray(c.for_accounts) && c.for_accounts.every(k => typeof k === "string"))) &&
    (c.components === undefined || (c.components && typeof c.components === "object"));
}

// ---- weights ---------------------------------------------------------------
export async function getWeights(db) {
  try {
    const w = JSON.parse(await getState(db, "trend_weights"));
    return validWeights(w) ? w : { ...DEFAULT_WEIGHTS };
  } catch { return { ...DEFAULT_WEIGHTS }; }
}

export async function putWeights(db, w, now) {
  if (!validWeights(w)) return null;
  const clean = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(k => [k, w[k]]));
  await setState(db, "trend_weights", JSON.stringify(clean));
  const { results } = await db.prepare("SELECT id, gate_json, components_json FROM opportunities").all();
  const stmts = results.map(r => {
    const s = scoreOpportunity(JSON.parse(r.gate_json || "{}"), JSON.parse(r.components_json || "{}"), clean);
    return db.prepare("UPDATE opportunities SET score = ?, class = ?, updated_at = ? WHERE id = ?").bind(s.score, s.class, now.toISOString(), r.id);
  });
  if (stmts.length) await db.batch(stmts);
  return clean;
}

// ---- writes ------------------------------------------------------------------
function mergeText(old, add) {
  let t = old || "";
  for (const part of add) {
    if (part && !t.includes(part)) t = t ? `${t}\n${part}` : part;
  }
  return t.slice(0, TEXT_CAP);
}

async function upsertTrend(db, c, now) {
  const key = dedupeKey(c.name);
  const iso = now.toISOString();
  const row = await db.prepare("SELECT id, evidence_text, excluded_json FROM trends WHERE dedupe_key = ?").bind(key).first();
  const parts = gateText(c).split(" \n ");
  if (row) {
    const text = mergeText(row.evidence_text, parts);
    await db.prepare("UPDATE trends SET last_seen = ?, evidence_text = ?, category = COALESCE(?, category) WHERE id = ?")
      .bind(iso, text, c.category || null, row.id).run();
    return { id: row.id, text, excluded: parseList(row.excluded_json) };
  }
  const text = mergeText("", parts);
  const r = await db.prepare(
    "INSERT INTO trends (dedupe_key, name, category, first_seen, last_seen, evidence_text) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(key, c.name.trim(), c.category || null, iso, iso, text).run();
  return { id: r.meta.last_row_id, text, excluded: [] };
}

function parseList(s) {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "string") : []; }
  catch { return []; }
}

// Every exclusion any account's gate has hit is kept on the trend itself, apart from the capped text, so it can
// never be lost to the cap, and it counts for every account (the gate keeps only that account's own terms).
const excludedStmt = (db, trendId, terms) =>
  db.prepare("UPDATE trends SET excluded_json = ? WHERE id = ?").bind(JSON.stringify([...terms].sort()), trendId);

const signalStmt = (db, trendId, s, manual = 0) => db.prepare(
  `INSERT OR IGNORE INTO trend_signals (trend_id, source, source_type, url, title, published_at, fetched_at, metric, value, manual)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(trendId, s.source, s.source_type, s.url || "", s.title || null, s.published_at || null, s.fetched_at,
    s.metric || "", Number.isFinite(s.value) ? s.value : null, manual);

function cleanComponents(c = {}) {
  return Object.fromEntries(COMPONENTS.filter(k => Number.isFinite(c?.[k])).map(k => [k, c[k]]));
}

function opportunityStmt(db, { trendId, profile, gate, components, evidence, weights, now, notes = null, analysis = 0 }) {
  const s = scoreOpportunity(gate, components, weights);
  const iso = now.toISOString();
  // A user decision (status) is never overwritten by a new sighting; only the evidence and score refresh.
  return db.prepare(
    `INSERT INTO opportunities (trend_id, account, gate_passed, gate_json, profile_hash, components_json, score, class,
       evidence, notes, analysis_requested, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trend_id, account) DO UPDATE SET gate_passed = excluded.gate_passed, gate_json = excluded.gate_json,
       profile_hash = excluded.profile_hash, components_json = excluded.components_json, score = excluded.score,
       class = excluded.class, evidence = excluded.evidence, updated_at = excluded.updated_at,
       notes = COALESCE(excluded.notes, opportunities.notes),
       analysis_requested = MAX(opportunities.analysis_requested, excluded.analysis_requested)`)
    .bind(trendId, profile.key, gate.passed ? 1 : 0, JSON.stringify(gate), profileHash(profile), JSON.stringify(components),
      s.score, s.class, evidence, notes, analysis, iso, iso);
}

async function priorGates(db, trendId) {
  const { results } = await db.prepare("SELECT account, gate_json FROM opportunities WHERE trend_id = ?").bind(trendId).all();
  return new Map(results.map(r => {
    try { return [r.account, JSON.parse(r.gate_json || "{}")]; } catch { return [r.account, {}]; }
  }));
}

async function evidenceFor(db, trendId) {
  const { results } = await db.prepare("SELECT DISTINCT source_type FROM trend_signals WHERE trend_id = ?").bind(trendId).all();
  return evidenceLabel(results);
}

export async function ingestBatch(db, body, now) {
  const cands = body?.candidates;
  if (!Array.isArray(cands) || cands.length > MAX_BATCH) return null;
  const weights = await getWeights(db);
  const out = { trends: 0, invalid: 0, opportunities: 0, rejected: 0 };
  for (const c of cands) {
    if (!validCandidate(c)) { out.invalid++; continue; }
    const { id, text, excluded } = await upsertTrend(db, c, now);
    await db.batch(c.signals.map(s => signalStmt(db, id, s)));
    const evidence = await evidenceFor(db, id);
    const stmts = [];
    if (c.snapshot && typeof c.snapshot === "object") {
      const n = v => (Number.isFinite(v) ? v : null);
      stmts.push(db.prepare(
        `INSERT INTO trend_snapshots (trend_id, day, momentum, volume, competitor_count) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trend_id, day) DO UPDATE SET momentum = excluded.momentum, volume = excluded.volume,
           competitor_count = excluded.competitor_count`)
        .bind(id, now.toISOString().slice(0, 10), n(c.snapshot.momentum), n(c.snapshot.volume), n(c.snapshot.competitor_count)));
    }
    const asked = new Set(c.for_accounts || []);
    // Judge the stored (capped) text AND the whole incoming text, so the cap can never hide a new exclusion.
    const full = `${text}\n${gateText(c)}`;
    const index = phraseIndex(normalise(full));
    const mixed = hasMixedScript(full);
    const prior = await priorGates(db, id);
    const allExcluded = new Set(excluded);
    for (const profile of PROFILES) {
      const gate = nicheGate({ index, mixed, prior_excluded: [...excluded, ...(prior.get(profile.key)?.excluded || [])] }, profile);
      for (const t of gate.excluded) allExcluded.add(t);
      // Each account is judged on its own. A failed gate is recorded for the accounts the trend was found for
      // (so Max can see why) and for any account that already has a row (so a pass can't go stale); every
      // other account simply never hears of it.
      if (!gate.passed && !asked.has(profile.key) && !prior.has(profile.key)) continue;
      const components = cleanComponents(c.account_components?.[profile.key] ?? c.components);
      stmts.push(opportunityStmt(db, { trendId: id, profile, gate, components, evidence, weights, now }));
      gate.passed ? out.opportunities++ : out.rejected++;
    }
    if (allExcluded.size > excluded.length) stmts.push(excludedStmt(db, id, allExcluded));
    if (stmts.length) await db.batch(stmts);
    out.trends++;
  }
  return out;
}

export async function manualAdd(db, b, now) {
  const profile = getProfile(b?.account);
  if (!profile || !str(b?.name, 200) || !dedupeKey(b.name)) return { status: 400, error: "bad_manual" };
  if (!optStr(b.text, 2000) || !optStr(b.notes, 1000) || !(b.url === undefined || b.url === "" || httpUrl(b.url))) {
    return { status: 400, error: "bad_manual" };
  }
  // Max's notes are kept but never count towards the gate: the trend itself has to fit the niche.
  // The trend may already be known: its stored exclusions count too.
  const known = await db.prepare("SELECT excluded_json FROM trends WHERE dedupe_key = ?").bind(dedupeKey(b.name)).first("excluded_json");
  const gate = nicheGate({ name: b.name, text: b.text, prior_excluded: parseList(known) }, profile);
  if (!gate.passed) return { status: 422, error: "niche_gate", gate };
  const c = { name: b.name, text: b.text };
  const { id } = await upsertTrend(db, c, now);
  await signalStmt(db, id, { source: "manual", source_type: "manual", url: b.url || "", title: b.name, fetched_at: now.toISOString(), metric: "manual" }, 1).run();
  const evidence = await evidenceFor(db, id);
  await opportunityStmt(db, { trendId: id, profile, gate, components: {}, evidence, weights: await getWeights(db), now,
    notes: b.notes?.trim() || null, analysis: 1 }).run();
  const opp = await db.prepare("SELECT id FROM opportunities WHERE trend_id = ? AND account = ?").bind(id, profile.key).first("id");
  return { status: 200, trend_id: id, opportunity_id: opp };
}

export async function decide(db, id, action, b, now) {
  const o = await db.prepare(
    "SELECT o.id, o.account, o.status, o.gate_json, t.evidence_text, t.excluded_json FROM opportunities o JOIN trends t ON t.id = o.trend_id WHERE o.id = ?")
    .bind(Number(id)).first();
  if (!o) return { status: 404, error: "not_found" };
  const iso = now.toISOString();
  const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 300) || null : null;
  if (action === "reject") {
    // Once a test has started its record belongs to the feedback loop; rejecting it would rewrite history.
    if (!["new", "approved", "rejected"].includes(o.status)) return { status: 409, error: "already_" + o.status };
    await db.prepare("UPDATE opportunities SET status = 'rejected', status_reason = ?, decided_at = ?, updated_at = ? WHERE id = ?")
      .bind(reason, iso, iso, o.id).run();
    return { status: 200, id: o.id, status_now: "rejected" };
  }
  if (!["new", "approved", "rejected"].includes(o.status)) return { status: 409, error: "already_" + o.status };
  // Re-run the gate with the account's current profile: an approval can never send an off-niche trend on.
  const profile = getProfile(o.account);
  let prior = {};
  try { prior = JSON.parse(o.gate_json || "{}"); } catch { /* treat as none */ }
  const gate = nicheGate({ evidence_text: o.evidence_text || "",
    prior_excluded: [...parseList(o.excluded_json), ...(Array.isArray(prior.excluded) ? prior.excluded : [])] }, profile);
  if (!gate.passed) {
    await db.prepare("UPDATE opportunities SET gate_passed = 0, gate_json = ?, class = 'rejected', score = NULL, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(gate), iso, o.id).run();
    return { status: 409, error: "niche_gate", gate };
  }
  await db.prepare("UPDATE opportunities SET status = 'approved', status_reason = ?, decided_at = ?, updated_at = ? WHERE id = ?")
    .bind(reason, iso, iso, o.id).run();
  return { status: 200, id: o.id, status_now: "approved" };
}

// ---- reads -------------------------------------------------------------------
function itemOut(r) {
  const p = getProfile(r.account);
  const components = JSON.parse(r.components_json || "{}");
  return {
    id: r.id, trend_id: r.trend_id, account: r.account, account_name: p?.name || r.account, platform: p?.platform || null,
    name: r.name, category: r.category, lifecycle: r.lifecycle, first_seen: r.first_seen, last_seen: r.last_seen,
    score: r.score, class: r.class, evidence: r.evidence, status: r.status, status_reason: r.status_reason,
    notes: r.notes, analysis_requested: r.analysis_requested, updated_at: r.updated_at,
    missing: COMPONENTS.filter(k => !Number.isFinite(components[k])),
  };
}

export async function listOpportunities(db, q) {
  const where = [], args = [];
  const account = q.get("account");
  if (account) {
    if (!getProfile(account)) return null;
    where.push("o.account = ?"); args.push(account);
  }
  const platform = q.get("platform");
  if (platform) {
    if (!PLATFORMS.includes(platform)) return null;
    const keys = PROFILES.filter(p => p.platform === platform).map(p => p.key);
    where.push(`o.account IN (${keys.map(() => "?").join(",") || "''"})`); args.push(...keys);
  }
  const cls = q.get("class");
  if (cls) {
    if (!CLASSES.includes(cls)) return null;
    where.push("o.class = ?"); args.push(cls);
  } else if (!q.get("include_rejected")) where.push("o.class != 'rejected'");
  const status = q.get("status");
  if (status) {
    if (!STATUSES.includes(status)) return null;
    where.push("o.status = ?"); args.push(status);
  } else if (!q.get("include_rejected")) where.push("o.status != 'rejected'");
  const lifecycle = q.get("lifecycle");
  if (lifecycle) { where.push("t.lifecycle = ?"); args.push(lifecycle.slice(0, 20)); }
  const category = q.get("category");
  if (category) { where.push("t.category = ?"); args.push(category.slice(0, 60)); }
  const since = q.get("since");
  if (since) {
    if (!isDate(since)) return null;
    where.push("t.first_seen >= ?"); args.push(new Date(since).toISOString());
  }
  const min = q.get("min_score");
  if (min) {
    if (!/^\d{1,3}$/.test(min)) return null;
    where.push("o.score >= ?"); args.push(Number(min));
  }
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  const { results } = await db.prepare(
    `SELECT o.*, t.name, t.category, t.lifecycle, t.first_seen, t.last_seen
     FROM opportunities o JOIN trends t ON t.id = o.trend_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY o.score IS NULL, o.score DESC, o.updated_at DESC LIMIT ?`).bind(...args, limit).all();
  return { items: results.map(itemOut) };
}

export async function trendDetail(db, id, account) {
  const t = await db.prepare("SELECT id, name, category, lifecycle, first_seen, last_seen FROM trends WHERE id = ?").bind(Number(id)).first();
  if (!t) return null;
  const [signals, snapshots, opps] = await Promise.all([
    db.prepare(`SELECT id, source, source_type, url, title, published_at, fetched_at, metric, value, manual
                FROM trend_signals WHERE trend_id = ? ORDER BY fetched_at, id`).bind(t.id).all(),
    db.prepare("SELECT day, momentum, volume, competitor_count FROM trend_snapshots WHERE trend_id = ? ORDER BY day").bind(t.id).all(),
    db.prepare(`SELECT o.*, t.name, t.category, t.lifecycle, t.first_seen, t.last_seen FROM opportunities o
                JOIN trends t ON t.id = o.trend_id WHERE o.trend_id = ? ${account ? "AND o.account = ?" : ""}
                ORDER BY o.score IS NULL, o.score DESC`).bind(...(account ? [t.id, account] : [t.id])).all(),
  ]);
  const ideas = new Map();
  if (opps.results.length) {
    const ids = opps.results.map(o => o.id);
    const { results } = await db.prepare(
      `SELECT opportunity_id, created_at, idea_json FROM opportunity_ideas WHERE opportunity_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .bind(...ids).all();
    for (const r of results) {
      if (!ideas.has(r.opportunity_id)) ideas.set(r.opportunity_id, []);
      ideas.get(r.opportunity_id).push({ created_at: r.created_at, ...JSON.parse(r.idea_json) });
    }
  }
  return {
    trend: t, signals: signals.results, snapshots: snapshots.results,
    opportunities: opps.results.map(o => {
      const p = getProfile(o.account);
      return {
        ...itemOut(o), niche: p?.niche || null, locked_rules: p?.locked_rules || [],
        gate: JSON.parse(o.gate_json || "{}"), components: JSON.parse(o.components_json || "{}"),
        profile_changed: !!p && profileHash(p) !== o.profile_hash, ideas: ideas.get(o.id) || [],
      };
    }),
  };
}

export async function overview(db) {
  const one = sql => db.prepare(sql).first("n");
  const [discovered, high, emerging, accelerating, awaiting, testing, won, perAcc] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM trends"),
    one("SELECT COUNT(*) AS n FROM opportunities WHERE class = 'high' AND status = 'new'"),
    one("SELECT COUNT(*) AS n FROM trends WHERE lifecycle = 'emerging'"),
    one("SELECT COUNT(*) AS n FROM trends WHERE lifecycle = 'accelerating'"),
    one("SELECT COUNT(*) AS n FROM opportunities WHERE status = 'new' AND class IN ('high', 'test')"),
    one("SELECT COUNT(*) AS n FROM opportunities WHERE status = 'testing'"),
    one("SELECT COUNT(*) AS n FROM opportunities WHERE status = 'won'"),
    db.prepare("SELECT account, COUNT(*) AS n FROM opportunities WHERE status = 'new' AND class IN ('high', 'test') GROUP BY account").all(),
  ]);
  const waiting = Object.fromEntries(perAcc.results.map(r => [r.account, r.n]));
  return {
    discovered, high, emerging, accelerating, awaiting, testing, won,
    accounts: PROFILES.map(p => ({ key: p.key, name: p.name, platform: p.platform, niche: p.niche, category: p.category, waiting: waiting[p.key] || 0 })),
  };
}
