// Nightly history from the bots' repos (ingest/backfill.py). Idempotent: rows are keyed
// on natural keys and re-sent every night, so only genuinely new rows are written.
// A post the app already knows only has its empty fields filled, never overwritten.
import { BOT_IDS } from "./bots.js";
import { HttpError } from "./api.js";

export const MAX_ROWS = 500;
const POST_COLS = ["platform", "title", "posted_at", "slot", "format", "variant", "length_s", "url"];
const SNAP_COLS = ["views", "likes", "comments", "shares", "avg_watch_s", "reach"];

const str = v => typeof v === "string" && v.length > 0 && v.length <= 300;
const val = v => (v === undefined ? null : v);

function validate(body) {
  const t = { posts: [], snapshots: [], account: [], gate: [], ...(body || {}) };
  for (const k of ["posts", "snapshots", "account", "gate"]) {
    if (!Array.isArray(t[k])) throw new HttpError(400, `bad_${k}`);
  }
  if (t.posts.length + t.snapshots.length + t.account.length + t.gate.length > MAX_ROWS) throw new HttpError(413, "too_many_rows");
  const ok = (cond, what) => { if (!cond) throw new HttpError(400, `bad_${what}`); };
  for (const p of t.posts) ok(p && str(p.id) && BOT_IDS.includes(p.bot) && str(p.external_id), "post");
  for (const s of t.snapshots) ok(s && str(s.post_id) && str(s.at), "snapshot");
  for (const a of t.account) ok(a && BOT_IDS.includes(a.bot) && str(a.at), "account");
  for (const g of t.gate) ok(g && BOT_IDS.includes(g.bot) && str(g.at), "gate");
  return t;
}

// BuriedCasefiles' own files name videos by TikTok id; the app may already track the same
// video by its Buffer id (url ends /video/<tiktok id>). Map tiktok id -> existing post id.
async function bcfAliases(db) {
  const { results } = await db.prepare("SELECT id, url FROM posts WHERE bot = 'bcf'").all();
  const ids = new Set(results.map(r => r.id));
  const byTikTok = new Map();
  for (const r of results) {
    const m = /\/video\/(\d+)/.exec(r.url || "");
    if (m) byTikTok.set(m[1], r.id);
  }
  return id => {
    if (ids.has(id) || !id.startsWith("bcf:")) return id;
    return byTikTok.get(id.slice(4)) || id;
  };
}

export async function ingest(db, body) {
  const t = validate(body);
  const resolve = await bcfAliases(db);
  const stmts = [];
  const kinds = [];
  for (const p of t.posts) {
    const id = resolve(p.id);
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO posts (id, bot, external_id, ${POST_COLS.join(", ")}) VALUES (?, ?, ?, ${POST_COLS.map(() => "?").join(", ")})`)
      .bind(id, p.bot, p.external_id, ...POST_COLS.map(c => val(p[c]))));
    kinds.push("posts");
    stmts.push(db.prepare(`UPDATE posts SET ${POST_COLS.map(c => `${c} = COALESCE(${c}, ?)`).join(", ")} WHERE id = ?`)
      .bind(...POST_COLS.map(c => val(p[c])), id));
    kinds.push(null);
  }
  // Only attach snapshots to posts that exist (or arrive in this batch); the rest wait for
  // tomorrow's run, when the live poller may know the video under its Buffer id.
  const known = new Set(t.posts.map(p => resolve(p.id)));
  const ask = [...new Set(t.snapshots.map(s => resolve(s.post_id)))].filter(id => !known.has(id));
  for (let i = 0; i < ask.length; i += 90) {
    const chunk = ask.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT id FROM posts WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    results.forEach(r => known.add(r.id));
  }
  const skipped = { snapshots: 0 };
  for (const s of t.snapshots) {
    if (!known.has(resolve(s.post_id))) { skipped.snapshots++; continue; }
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO snapshots (post_id, at, ${SNAP_COLS.join(", ")}) VALUES (?, ?, ${SNAP_COLS.map(() => "?").join(", ")})`)
      .bind(resolve(s.post_id), s.at, ...SNAP_COLS.map(c => val(s[c]))));
    kinds.push("snapshots");
  }
  for (const a of t.account) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO account (bot, at, followers, likes, videos) VALUES (?, ?, ?, ?, ?)")
      .bind(a.bot, a.at, val(a.followers), val(a.likes), val(a.videos)));
    kinds.push("account");
  }
  for (const g of t.gate) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO gate (bot, at, ok, ai_used) VALUES (?, ?, ?, ?)")
      .bind(g.bot, g.at, g.ok ? 1 : 0, g.ai_used ? 1 : 0));
    kinds.push("gate");
  }
  const inserted = { posts: 0, snapshots: 0, account: 0, gate: 0 };
  if (!stmts.length) return { inserted, skipped };
  const results = await db.batch(stmts);          // one round-trip, one transaction
  results.forEach((r, i) => { if (kinds[i]) inserted[kinds[i]] += r.meta?.changes || 0; });
  return { inserted, skipped };
}
