// Every-5-minute watcher (Worker cron). Each step is isolated: one that throws becomes a
// single grouped "Bot HQ watcher error" warn and the rest still run.
import { BOTS, BOT_IDS } from "./bots.js";
import { processEvent, openActionCount } from "./events.js";
import { ukParts, valueAtAge, doingWell, postingGaps } from "./rules.js";
import { getState, setState } from "./settings.js";
import { checkRuns } from "./watch/runs.js";
import { pollStats } from "./watch/stats.js";
import { thinPlan } from "./thin.js";
import { refreshGate } from "./watch/gate.js";

const H = 3600e3;
const MILESTONES = [1, 6, 24, 72];      // 72h is stored for graphs; alerts use 1/6/24
const GOOD_AT = [1, 6, 24];
const SETTLE_H = 4;                      // a milestone is final this long after it passes
const BACKLOG_PER_TICK = 40;
const NEW_POST_WINDOW_H = 2;

async function step(env, now, name, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error("schedule step", name, e?.stack || e);
    try {
      await processEvent(env, {
        bot: "system", kind: "watcher_error", severity: "warn",
        title: `Bot HQ watcher error: ${name}`, body: String(e?.message || e).slice(0, 500),
        data: {}, dedupe_key: `watcher:${name}`,
      }, now);
    } catch (e2) { console.error("watcher_error event failed", e2?.message || e2); }
    return null;
  }
}

const ageH = (at, posted) => (Date.parse(at) - Date.parse(posted)) / H;

async function snapshotPoints(db, post) {
  const { results } = await db.prepare("SELECT at, views FROM snapshots WHERE post_id = ?").bind(post.id).all();
  return results.map(s => [ageH(s.at, post.posted_at), s.views]);
}

// Settle views@Nh for posts old enough that it can't change any more.
async function settleMilestones(db, now) {
  const { results } = await db.prepare(
    `SELECT p.id, p.posted_at FROM posts p
     WHERE p.posted_at IS NOT NULL AND p.posted_at < ?
       AND (SELECT COUNT(*) FROM milestones m WHERE m.post_id = p.id) < ?
     ORDER BY p.posted_at DESC LIMIT ?`)
    .bind(new Date(now.getTime() - (1 + SETTLE_H) * H).toISOString(), MILESTONES.length, BACKLOG_PER_TICK).all();
  for (const post of results) {
    const age = (now.getTime() - Date.parse(post.posted_at)) / H;
    const points = await snapshotPoints(db, post);
    for (const h of MILESTONES) {
      if (age < h + SETTLE_H) continue;
      await db.prepare("INSERT OR IGNORE INTO milestones (post_id, h, views) VALUES (?, ?, ?)")
        .bind(post.id, h, valueAtAge(points, h, true)).run();
    }
  }
}

async function checkDoingWell(env, db, now) {
  await settleMilestones(db, now);
  const { results: fresh } = await db.prepare(
    "SELECT id, bot, title, url, posted_at FROM posts WHERE posted_at > ? AND posted_at <= ?")
    .bind(new Date(now.getTime() - (24 + SETTLE_H) * H).toISOString(), new Date(now.getTime() - H).toISOString()).all();
  const history = new Map();
  for (const post of fresh) {
    const age = (now.getTime() - Date.parse(post.posted_at)) / H;
    const due = GOOD_AT.filter(h => age >= h && age < h + SETTLE_H);
    if (!due.length || !BOT_IDS.includes(post.bot)) continue;
    const points = await snapshotPoints(db, post);
    for (const h of due) {
      const key = `good:${post.id}:${h}`;
      if (await db.prepare("SELECT 1 AS x FROM events WHERE dedupe_key = ?").bind(key).first("x")) continue;
      const views = valueAtAge(points, h, true);
      if (views == null) continue;
      const hk = `${post.bot}|${h}`;
      if (!history.has(hk)) {
        const { results } = await db.prepare(
          `SELECT m.views FROM milestones m JOIN posts p ON p.id = m.post_id
           WHERE p.bot = ? AND m.h = ? AND m.views IS NOT NULL AND p.id != ?`).bind(post.bot, h, post.id).all();
        history.set(hk, results.map(r => r.views));
      }
      const hist = history.get(hk);
      if (!doingWell(views, hist)) continue;
      const rank = hist.filter(v => v > views).length + 1;
      await processEvent(env, {
        bot: post.bot, kind: "doing_well", severity: "good",
        title: `${BOTS[post.bot].name}: top 10% at ${h}h - ${post.title || "a post"}`.slice(0, 160),
        body: `${Math.round(views).toLocaleString("en-GB")} views at ${h}h: #${rank} of ${hist.length + 1} at this age.`,
        data: { post_id: post.id, video_url: post.url || undefined, views: Math.round(views), h },
        dedupe_key: key,
      }, now);
    }
  }
}

async function announceNewPosts(env, newPosts, now) {
  for (const p of newPosts) {
    // Escape Cup's own "scheduled" message isn't the publish; Buffer's sentAt is. Others announce themselves.
    if (p.bot !== "escape") continue;
    if (now.getTime() - Date.parse(p.posted_at) > NEW_POST_WINDOW_H * H) continue;   // first sync: history, not news
    await processEvent(env, {
      bot: "escape", kind: "posted", severity: "info", title: `Escape Cup posted: ${p.title}`.slice(0, 160),
      body: p.url || "", data: { buffer_id: p.external_id, video_url: p.url || undefined },
      dedupe_key: `posted:escape:${p.external_id}`,
    }, now);
  }
}

async function checkGaps(env, db, now) {
  const last = {};
  for (const bot of ["chess", "bcf"]) {
    last[bot] = await db.prepare("SELECT MAX(posted_at) AS t FROM posts WHERE bot = ?").bind(bot).first("t");
  }
  const at = await getState(db, "escape_pending_at");
  const fresh = at && now.getTime() - Date.parse(at) < 3 * H;      // stale count = unknown, not "empty"
  const pending = fresh ? Number(await getState(db, "escape_pending")) : null;
  for (const ev of postingGaps(last, pending, now)) await processEvent(env, ev, now);
}

async function thinSnapshots(db, now) {
  const { results } = await db.prepare(
    `SELECT s.id, s.post_id, s.at FROM snapshots s
     WHERE s.post_id IN (SELECT DISTINCT post_id FROM snapshots WHERE at < ?)`)
    .bind(new Date(now.getTime() - 7 * 24 * H).toISOString()).all();
  const postIds = [...new Set(results.map(r => r.post_id))];
  const postedAt = {};
  for (const id of postIds) postedAt[id] = await db.prepare("SELECT posted_at FROM posts WHERE id = ?").bind(id).first("posted_at");
  const doomed = thinPlan(results, postedAt, now);
  for (let i = 0; i < doomed.length; i += 100) {
    const chunk = doomed.slice(i, i + 100);
    await db.prepare(`DELETE FROM snapshots WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
  }
  return doomed.length;
}

async function sendSummary(env, db, now) {
  const yesterday = ukParts(new Date(now.getTime() - 24 * H)).ymd;
  const { results } = await db.prepare(
    `SELECT p.id, p.bot, p.title, p.posted_at, (SELECT MAX(views) FROM snapshots s WHERE s.post_id = p.id) AS views
     FROM posts p WHERE p.posted_at > ? AND p.posted_at <= ?`)
    .bind(new Date(now.getTime() - 50 * H).toISOString(), now.toISOString()).all();
  const posts = results.filter(p => ukParts(new Date(p.posted_at)).ymd === yesterday);
  const lines = BOT_IDS.map(b => `${BOTS[b].name}: ${posts.filter(p => p.bot === b).length} of ${BOTS[b].planned}`);
  const planned = BOT_IDS.reduce((n, b) => n + BOTS[b].planned, 0);
  const best = posts.filter(p => p.views != null).sort((a, b) => b.views - a.views)[0];
  if (best) lines.push(`Best: ${best.title || best.id} (${BOTS[best.bot].name}), ${best.views.toLocaleString("en-GB")} views`);
  const open = await openActionCount(db);
  lines.push(open ? `${open} thing${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you.` : "Nothing needs you.");
  await processEvent(env, {
    bot: "system", kind: "summary", severity: "info",
    title: `Yesterday: ${posts.length} of ${planned} posts`, body: lines.join("\n"),
    data: { day: yesterday, best_post: best?.id }, dedupe_key: `summary:${yesterday}`,
  }, now);
}

export async function runSchedule(event, env, ctx, fetchFn = fetch, now = new Date()) {
  const db = env.DB;
  const minute = now.getUTCMinutes();
  const hourly = minute < 5;

  await step(env, now, "GitHub runs", () => checkRuns(env, db, fetchFn, now));
  await step(env, now, "live stats", () => pollStats(env, db, fetchFn, now, { youtube: true, buffer: false }));
  if (hourly) {
    const r = await step(env, now, "TikTok stats", () => pollStats(env, db, fetchFn, now, { youtube: false, buffer: true }));
    if (r?.newPosts?.length) await step(env, now, "new posts", () => announceNewPosts(env, r.newPosts, now));
    await step(env, now, "posting gaps", () => checkGaps(env, db, now));
    await step(env, now, "gate logs", () => refreshGate(env, db, fetchFn, now));
  }
  await step(env, now, "doing well", () => checkDoingWell(env, db, now));
  if (now.getUTCHours() === 3 && hourly) await step(env, now, "thinning", () => thinSnapshots(db, now));

  const uk = ukParts(now);
  if (uk.hhmm >= "07:30" && uk.hhmm < "07:35") {
    await step(env, now, "daily summary", async () => {
      if ((await getState(db, "summary_sent")) === uk.ymd) return;
      await setState(db, "summary_sent", uk.ymd);
      await sendSummary(env, db, now);
    });
  }
}
