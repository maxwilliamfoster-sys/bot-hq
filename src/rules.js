// Time rules (UK local time) and which events get pushed.
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

export function shouldPush(event, settings, date) {
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

// Posting gaps, worded like chess-puzzle-automation needs_you.check_posting.
// lastPostAt: {chess, bcf} ISO or null; escapePending: scheduled Buffer posts, or null if unknown.
export function postingGaps(lastPostAt, escapePending, now = new Date()) {
  const out = [];
  const hoursSince = iso => (now.getTime() - Date.parse(iso)) / 3600e3;
  const gap = (bot, title, body) => out.push({ bot, kind: "no_posts", severity: "action", title, body, data: {}, dedupe_key: `no_posts:${bot}` });
  if (lastPostAt.chess) {
    const h = hoursSince(lastPostAt.chess);
    if (h > 14) gap("chess", `Chess: no upload for ${Math.round(h)}h`,
      "Normally 3 a day. Check the Chess posting runs; an expired YouTube token needs reauth_manual.py on the PC.");
  }
  if (lastPostAt.bcf) {
    const h = hoursSince(lastPostAt.bcf);
    if (h > 30) gap("bcf", `BuriedCasefiles: no TikTok post for ${Math.round(h)}h`,
      "Normally 3 a day. Check the BuriedCasefiles video runs and the inbox for blocked videos.");
  }
  if (escapePending === 0) gap("escape", "Escape Cup: nothing is scheduled in Buffer",
    "Check the Escape Cup scheduling runs (Buffer key, or every render failing the gates).");
  return out;
}
