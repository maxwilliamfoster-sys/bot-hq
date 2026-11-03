// Every-5-minute watcher (Worker cron). Each step is isolated: one that throws becomes a
// single grouped "Bot HQ watcher error" warn and the rest still run.
import { BOTS, BOT_IDS } from "./bots.js";
import { processEvent, openActionCount } from "./events.js";
import { ukParts, valueAtAge, doingWell, postingGaps, stuckPosts, lowPosting, viewsFall } from "./rules.js";
import { getState, setState } from "./settings.js";
import { checkRuns } from "./watch/runs.js";
import { pollStats } from "./watch/stats.js";
import { pollZernio, pollZernioViews } from "./watch/zernio.js";
import { thinPlan } from "./thin.js";
import { refreshGate } from "./watch/gate.js";
import { weeklyRadarCheck } from "./radar.js";

const H = 3600e3;
const MILESTONES = [1, 6, 24, 72];      // 72h is stored for graphs; alerts use 1/6/24
const GOOD_AT = [1, 6, 24];
const SETTLE_H = 4;                      // a milestone is final this long after it passes
const BACKLOG_PER_TICK = 40;
const NEW_POST_WINDOW_H = 2;
const RUNS_KEEP_D = 60;

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

// Settle views@Nh for posts old enough that it can't change any more. Every tick looks at
// recent posts only; the hourly tick also sweeps older ones (e.g. from the nightly backfill).
// Snapshots are read only when a milestone is due and missing (D1 bills every row read).
async function settleMilestones(db, now, sweep) {
  const last = MILESTONES[MILESTONES.length - 1];
  const from = sweep ? "" : new Date(now.getTime() - (last + 2 * SETTLE_H) * H).toISOString();
  const { results } = await db.prepare(
    `SELECT p.id, p.posted_at, (SELECT GROUP_CONCAT(m.h) FROM milestones m WHERE m.post_id = p.id) AS have
     FROM posts p
     WHERE p.posted_at > ? AND p.posted_at < ?
       AND (SELECT COUNT(*) FROM milestones m WHERE m.post_id = p.id) < ?
     ORDER BY p.posted_at DESC LIMIT ?`)
    .bind(from, new Date(now.getTime() - (1 + SETTLE_H) * H).toISOString(), MILESTONES.length, BACKLOG_PER_TICK).all();
  for (const post of results) {
    const age = (now.getTime() - Date.parse(post.posted_at)) / H;
    const have = new Set(String(post.have || "").split(",").filter(Boolean).map(Number));
    const due = MILESTONES.filter(h => age >= h + SETTLE_H && !have.has(h));
    if (!due.length) continue;
    const points = await snapshotPoints(db, post);
    await db.batch(due.map(h => db.prepare("INSERT OR IGNORE INTO milestones (post_id, h, views) VALUES (?, ?, ?)")
      .bind(post.id, h, valueAtAge(points, h, true))));
  }
}

async function checkDoingWell(env, db, now, sweep) {
  await settleMilestones(db, now, sweep);
  const { results: fresh } = await db.prepare(
    "SELECT id, bot, title, url, posted_at FROM posts WHERE posted_at > ? AND posted_at <= ?")
    .bind(new Date(now.getTime() - (24 + SETTLE_H) * H).toISOString(), new Date(now.getTime() - H).toISOString()).all();
  const history = new Map();
  for (const post of fresh) {
    const age = (now.getTime() - Date.parse(post.posted_at)) / H;
    const due = GOOD_AT.filter(h => age >= h && age < h + SETTLE_H);
    if (!due.length || !BOT_IDS.includes(post.bot)) continue;
    let points = null;
    for (const h of due) {
      const key = `good:${post.id}:${h}`;
      if (await db.prepare("SELECT 1 AS x FROM events WHERE dedupe_key = ?").bind(key).first("x")) continue;
      points ??= await snapshotPoints(db, post);
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
    if (p.bot !== "escape" && p.bot !== "space" && p.bot !== "eagle") continue;
    if (now.getTime() - Date.parse(p.posted_at) > NEW_POST_WINDOW_H * H) continue;   // first sync: history, not news
    await processEvent(env, {
      bot: p.bot, kind: "posted", severity: "info", title: `${BOTS[p.bot].name} posted: ${p.title}`.slice(0, 160),
      body: p.url || "", data: { buffer_id: p.external_id, video_url: p.url || undefined },
      dedupe_key: `posted:${p.bot}:${p.external_id}`,
    }, now);
  }
}

async function alertStuck(env, queued, now) {
  const stuck = stuckPosts(queued, now);
  for (const bot of new Set(stuck.map(s => s.bot))) {
    const n = stuck.filter(s => s.bot === bot).length;
    await processEvent(env, {
      bot, kind: "post_stuck", severity: "action",
      title: `${BOTS[bot].name}: ${n} post${n === 1 ? "" : "s"} stuck past ${n === 1 ? "its" : "their"} time`,
      body: "Still waiting to go out over 2 hours late. Check the scheduler's connection to TikTok.",
      data: {}, dedupe_key: `stuck:${bot}`,
    }, now);
  }
}

// Each failed post alerts once; the poll sees it again every hour until it is 2 days old.
async function alertFailed(env, db, failed, now) {
  for (const p of failed) {
    const key = `post_failed:eagle:${p.id}`;
    if (await db.prepare("SELECT 1 AS x FROM events WHERE dedupe_key = ?").bind(key).first("x")) continue;
    // Outside text: one line for reading here, and fenced as untrusted in the fix prompt.
    const reason = (p.error || "Zernio gave no reason.").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300);
    await processEvent(env, {
      bot: "eagle", kind: "post_failed", severity: "action", title: "Eagle Eyes: a post failed to publish",
      body: `${reason}\n${p.text.split("\n")[0]}`.slice(0, 500),
      data: { external_detail: reason }, dedupe_key: key,
    }, now);
  }
}

// Once a day, and at most once a week per bot while it stays down.
async function checkViewsFall(env, db, now) {
  const { results } = await db.prepare(
    `SELECT p.bot, p.posted_at, m.views FROM milestones m JOIN posts p ON p.id = m.post_id
     WHERE m.h = 72 AND m.views IS NOT NULL AND p.posted_at > ? ORDER BY p.posted_at DESC`)
    .bind(new Date(now.getTime() - 30 * 24 * H).toISOString()).all();
  for (const bot of BOT_IDS) {
    const fall = viewsFall(results.filter(r => r.bot === bot));
    if (!fall) continue;
    const key = `views_fall:${bot}`;
    const week = new Date(now.getTime() - 7 * 24 * H).toISOString();
    if (await db.prepare("SELECT 1 AS x FROM events WHERE dedupe_key = ? AND at > ?").bind(key, week).first("x")) continue;
    const recent = Math.round(fall.recent).toLocaleString("en-GB");
    const before = Math.round(fall.before).toLocaleString("en-GB");
    await processEvent(env, {
      bot, kind: "views_fall", severity: "warn", title: `${BOTS[bot].name}: typical views fell to ${recent} from ${before}`,
      body: "Last 5 videos at 3 days old, against the 14 days before. Check what changed: posting rate first, then the video format, then For You flags in TikTok Studio.",
      data: { recent: fall.recent, before: fall.before }, dedupe_key: key,
    }, now);
  }
}

// healthchecks.io raises the alarm when these stop. A failed ping is not an error here: the silence is the signal.
async function pingAlarm(env, db, fetchFn) {
  if (!env.HEALTHCHECK_URL) return;
  try {
    await db.prepare("SELECT 1 AS alive").first("alive");
    await fetchFn(env.HEALTHCHECK_URL);
  } catch (e) { console.error("dead-man ping", e?.message || e); }
}

async function checkGaps(env, db, now) {
  const last = {};
  for (const bot of ["chess", "bcf", "space", "eagle"]) {
    last[bot] = await db.prepare("SELECT MAX(posted_at) AS t FROM posts WHERE bot = ?").bind(bot).first("t");
  }
  const at = await getState(db, "escape_pending_at");
  const fresh = at && now.getTime() - Date.parse(at) < 3 * H;      // stale count = unknown, not "empty"
  const pending = fresh ? Number(await getState(db, "escape_pending")) : null;
  const chessLinked = !!(await db.prepare("SELECT 1 AS x FROM events WHERE bot = 'chess' AND at > ? LIMIT 1")
    .bind(new Date(now.getTime() - 7 * 24 * H).toISOString()).first("x"));
  const ctx = { chessLinked, bcfFeedAt: (await getState(db, "bcf_polled_at")) || null,
    bcfNextDue: (await getState(db, "bcf_next_due")) || null,
    spaceNextDue: (await getState(db, "space_next_due")) || null,
    eagleFeedAt: (await getState(db, "eagle_polled_at")) || null,
    eagleNextDue: (await getState(db, "eagle_next_due")) || null };
  for (const ev of postingGaps(last, pending, now, ctx)) await processEvent(env, ev, now);
}

async function thinSnapshots(db, now) {
  const { results } = await db.prepare(
    `SELECT s.id, s.post_id, s.at, p.posted_at FROM snapshots s JOIN posts p ON p.id = s.post_id
     WHERE s.post_id IN (SELECT DISTINCT post_id FROM snapshots WHERE at < ?)`)
    .bind(new Date(now.getTime() - 7 * 24 * H).toISOString()).all();
  const postedAt = Object.fromEntries(results.map(r => [r.post_id, r.posted_at]));
  const doomed = thinPlan(results, postedAt, now);
  const deletes = [];
  for (let i = 0; i < doomed.length; i += 100) {
    const chunk = doomed.slice(i, i + 100);
    deletes.push(db.prepare(`DELETE FROM snapshots WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  // Run history only feeds the Bots tab's recent list and the "seen" check.
  deletes.push(db.prepare("DELETE FROM runs WHERE at < ?").bind(new Date(now.getTime() - RUNS_KEEP_D * 24 * H).toISOString()));
  await db.batch(deletes);
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
  // Only bots seen posting this past week: one that isn't connected yet isn't a quiet day.
  const { results: active } = await db.prepare("SELECT DISTINCT bot FROM posts WHERE posted_at > ?")
    .bind(new Date(now.getTime() - 7 * 24 * H).toISOString()).all();
  const counts = Object.fromEntries(active.filter(r => BOT_IDS.includes(r.bot)).map(r => [r.bot, posts.filter(p => p.bot === r.bot).length]));
  for (const { bot, n } of lowPosting(counts)) {
    await processEvent(env, {
      bot, kind: "low_posts", severity: "warn", title: `${BOTS[bot].name}: only ${n} of ${BOTS[bot].planned} posts yesterday`,
      body: "Check its runs, and the inbox for blocked videos.", data: { day: yesterday }, dedupe_key: `low_posts:${bot}:${yesterday}`,
    }, now);
  }
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
    const z = await step(env, now, "Eagle Eyes posts", () => pollZernio(env, db, fetchFn, now));
    if (z) {
      await step(env, now, "new posts", () => announceNewPosts(env, z.newPosts, now));
      await step(env, now, "failed posts", () => alertFailed(env, db, z.failed, now));
    }
    await step(env, now, "Eagle Eyes stats", () => pollZernioViews(env, db, fetchFn, now));
    await step(env, now, "stuck posts", () => alertStuck(env, [...(r?.queued || []), ...(z?.queued || [])], now));
    await step(env, now, "posting gaps", () => checkGaps(env, db, now));
    await step(env, now, "gate logs", () => refreshGate(env, db, fetchFn, now));
    const ukH = ukParts(now).hhmm;
    if (ukH >= "08:00" && ukH < "21:00") await step(env, now, "radar reminder", () => weeklyRadarCheck(env, db, fetchFn, now));
  }
  await step(env, now, "doing well", () => checkDoingWell(env, db, now, hourly));
  if (now.getUTCHours() === 3 && hourly) await step(env, now, "thinning", () => thinSnapshots(db, now));
  if (now.getUTCHours() === 6 && hourly) await step(env, now, "views falling", () => checkViewsFall(env, db, now));

  // A whole hour, not one tick, so a late or failed 07:30 run still gets its summary out.
  const uk = ukParts(now);
  if (uk.hhmm >= "07:30" && uk.hhmm < "08:30") {
    await step(env, now, "daily summary", async () => {
      if ((await getState(db, "summary_sent")) === uk.ymd) return;
      await setState(db, "summary_sent", uk.ymd);
      await sendSummary(env, db, now);
    });
  }
  await pingAlarm(env, db, fetchFn);
}
