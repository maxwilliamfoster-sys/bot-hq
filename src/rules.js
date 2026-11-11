// Time rules (UK local time) and which events get pushed.
import { BOTS } from "./bots.js";

const UK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
});

export function ukParts(date) {
  const p = Object.fromEntries(UK.formatToParts(date).map(x => [x.type, x.value]));
  return { hhmm: `${p.hour}:${p.minute}`, ymd: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday };
}

export function inQuietHours(date, settings) {
  const t = ukParts(date).hhmm;
  const { quiet_start: a, quiet_end: b } = settings;
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

function toggleFor(event) {
  if (event.kind === "posted") return "notify_posted";
  if (event.kind === "summary" || event.kind === "digest") return "notify_summary";
  return { action: "notify_action", warn: "notify_warn", good: "notify_good" }[event.severity] || "notify_posted";
}

// "Only when I am needed" (Max, 2026-11-10): the bots should run themselves, so the phone stays quiet unless
// something broke (severity action) or it is time to go back to Claude (kind coach). Everything else is in the Inbox.
export function shouldPush(event, settings, date) {
  if (event.kind === "digest") return false;          // in the Inbox only; the 07:30 summary is the morning push
  if (event.kind === "coach") return event.severity === "action" ? !!settings.notify_action : !inQuietHours(date, settings);
  if (settings.notify_only_needed && event.severity !== "action") return false;
  if (event.severity === "action") return !!settings.notify_action;
  if (!settings[toggleFor(event)]) return false;
  return !inQuietHours(date, settings);
}

// Value of a cumulative metric at `hours` of age, linearly interpolated.
// Port of growth-lab growth_stats.value_at_age: null when too young or nothing brackets it.
export function valueAtAge(points, hours, zeroAtBirth = false, maxGap = 48) {
  let pts = points.filter(([a, v]) => a != null && v != null).map(([a, v]) => [Number(a), Number(v)])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (zeroAtBirth) pts = [[0, 0], ...pts.filter(p => p[0] > 0)];
  if (!pts.length || pts[pts.length - 1][0] < hours) return null;
  let prev = null;
  for (const [age, val] of pts) {
    if (age === hours) return val;
    if (age > hours) {
      if (!prev) return null;
      const [a0, v0] = prev;
      if (maxGap != null && age - a0 > maxGap) return null;
      return v0 + (val - v0) * (hours - a0) / (age - a0);
    }
    prev = [age, val];
  }
  return null;
}

// Top 10% of the bot's own history at the same age (nearest-rank 90th percentile).
export function doingWell(views, history, minN = 20) {
  if (views == null || history.length < minN) return false;
  const sorted = [...history].sort((a, b) => a - b);
  return views >= sorted[Math.ceil(0.9 * sorted.length) - 1];
}

const STUCK_H = 2;
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Posts still waiting to go out well after their time: the scheduler has quietly stalled.
export function stuckPosts(queued, now = new Date()) {
  return queued.filter(q => q.due && now.getTime() - Date.parse(q.due) > STUCK_H * 3600e3);
}

// counts: {bot: posts yesterday}, only for bots the app can see posting.
export function lowPosting(counts) {
  return Object.entries(counts).filter(([bot, n]) => n <= Math.floor(BOTS[bot].planned / 2)).map(([bot, n]) => ({ bot, n }));
}

// rows: one bot's {posted_at, views} at 72h, newest first. Typical views of the last 5 against the
// 14 days before them. Needs 10 older videos; half or less counts, as TikTok views jump in batches.
const FALL_RECENT = 5;
const FALL_BASE_MIN = 10;
const FALL_BASE_D = 14;
const FALL_RATIO = 0.5;
export function viewsFall(rows) {
  const recent = rows.slice(0, FALL_RECENT);
  if (recent.length < FALL_RECENT) return null;
  const from = Date.parse(recent[FALL_RECENT - 1].posted_at) - FALL_BASE_D * 86400e3;
  const base = rows.slice(FALL_RECENT).filter(r => Date.parse(r.posted_at) >= from);
  if (base.length < FALL_BASE_MIN) return null;
  const r = median(recent.map(x => x.views));
  const before = median(base.map(x => x.views));
  return r <= before * FALL_RATIO ? { recent: r, before } : null;
}

// A bot that runs on Max's PC checks in after every run. beat: {at, mode, waiting, ...} or null.
export const HEARTBEAT_LATE_H = 30;     // daily run, plus a missed night's slack
export function heartbeatAlerts(bot, beat, now = new Date()) {
  if (!beat || !beat.at) return [];     // never checked in: not connected yet, not broken
  const name = BOTS[bot].name;
  const h = (now.getTime() - Date.parse(beat.at)) / 3600e3;
  const out = [];
  if (h > HEARTBEAT_LATE_H) {
    out.push({ bot, kind: "no_heartbeat", severity: "action", title: `${name}: no daily run for ${Math.round(h)}h`,
      body: "The PC may be off, asleep or signed out, or the scheduled task stopped. Videos already scheduled on YouTube still go out.",
      data: { last: beat.at }, dedupe_key: `no_heartbeat:${bot}` });
  }
  if (beat.mode === "scheduled" && Number.isFinite(beat.waiting) && beat.waiting <= 1) {
    out.push({ bot, kind: "queue_low", severity: "warn", title: `${name}: only ${beat.waiting} video${beat.waiting === 1 ? "" : "s"} queued`,
      body: "New episodes aren't being made fast enough. Check the run log and the inbox for failed episodes.",
      data: { waiting: beat.waiting }, dedupe_key: `queue_low:${bot}:${String(beat.at).slice(0, 10)}` });
  }
  return out;
}

// Posting gaps, worded like chess-puzzle-automation needs_you.check_posting.
// lastPostAt: {chess, bcf} ISO or null; escapePending: scheduled Buffer posts, or null if unknown.
// ctx says whether the app can actually see each bot's posts; without that, "no recent post" may just
// mean "not connected yet" (20 Oct 2026: a queued 08:30 BuriedCasefiles post looked like a 39h gap):
//   chessLinked  the chess bot has reached the app, so its "posted" events are arriving
//   bcfFeedAt    when the Buffer poll last succeeded (trusted for BCF_FEED_FRESH_H)
//   bcfNextDue   due time of the next BuriedCasefiles post already queued in Buffer
const BCF_FEED_FRESH_H = 3;
const BCF_QUEUE_COVERS_H = 24;
const SPACE_GAP_H = 18;
const EAGLE_GAP_H = 20;                  // its slots leave a 17h gap overnight (19:30 to 12:45)
const PERC_GAP_H = 26;                   // 2 a day (16:00-17:45, 19:00-21:45): worst normal gap is 19:00 to 17:45 next day (~23h)
export function postingGaps(lastPostAt, escapePending, now = new Date(), ctx = {}) {
  const out = [];
  const hoursSince = iso => (now.getTime() - Date.parse(iso)) / 3600e3;
  const gap = (bot, title, body) => out.push({ bot, kind: "no_posts", severity: "action", title, body, data: {}, dedupe_key: `no_posts:${bot}` });
  if (lastPostAt.chess && ctx.chessLinked) {
    const h = hoursSince(lastPostAt.chess);
    if (h > 14) gap("chess", `Chess: no upload for ${Math.round(h)}h`,
      "Normally 3 a day. Check the Chess posting runs; an expired YouTube token needs reauth_manual.py on the PC.");
  }
  const bcfSeen = ctx.bcfFeedAt && hoursSince(ctx.bcfFeedAt) < BCF_FEED_FRESH_H;
  const untilDue = ctx.bcfNextDue ? -hoursSince(ctx.bcfNextDue) : null;          // hours until the queued post
  const bcfQueued = untilDue !== null && untilDue > 0 && untilDue < BCF_QUEUE_COVERS_H;
  if (lastPostAt.bcf && bcfSeen && !bcfQueued) {
    const h = hoursSince(lastPostAt.bcf);
    if (h > 30) gap("bcf", `BuriedCasefiles: no TikTok post for ${Math.round(h)}h`,
      "Normally 3 a day. Check the BuriedCasefiles video runs and the inbox for blocked videos.");
  }
  const queueGap = (bot, name, tool, feedAt, nextDue, limitH, normally = "3 a day") => {
    if (!lastPostAt[bot] || !feedAt || hoursSince(feedAt) >= BCF_FEED_FRESH_H) return;   // can't see it: unknown, not a gap
    const until = nextDue ? -hoursSince(nextDue) : null;
    if (until !== null && until > 0 && until < BCF_QUEUE_COVERS_H) return;
    const h = hoursSince(lastPostAt[bot]);
    if (h > limitH) gap(bot, `${name}: no TikTok post for ${Math.round(h)}h`,
      `Normally ${normally}, and nothing is queued in ${tool}. Check the ${name} runs and the ${tool} connection.`);
  };
  queueGap("space", "Space Edits", "Buffer", ctx.bcfFeedAt, ctx.spaceNextDue, SPACE_GAP_H);
  queueGap("eagle", "Eagle Eyes", "Zernio", ctx.eagleFeedAt, ctx.eagleNextDue, EAGLE_GAP_H);
  queueGap("perc", "Perc Cruncher", "Zernio", ctx.percFeedAt, ctx.percNextDue, PERC_GAP_H, "2 a day");
  if (escapePending === 0) gap("escape", "Escape Cup: nothing is scheduled in Buffer",
    "Check the Escape Cup scheduling runs (Buffer key, or every render failing the gates).");
  return out;
}
