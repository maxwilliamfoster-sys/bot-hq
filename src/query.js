// Custom graphs. A graph spec picks from fixed lists only - every SQL fragment below is a
// constant from this file, user input only ever arrives as bound parameters.
import { BOTS, BOT_IDS } from "./bots.js";
import { ukParts } from "./rules.js";

const LATEST = col => `(SELECT s.${col} FROM snapshots s WHERE s.post_id = p.id AND s.${col} IS NOT NULL ORDER BY s.at DESC LIMIT 1)`;
const AT_AGE = h => `(SELECT m.views FROM milestones m WHERE m.post_id = p.id AND m.h = ${h})`;

// metric -> [family, value SQL, unit]
const METRIC_DEFS = {
  views: ["post", LATEST("views"), "views"],
  likes: ["post", LATEST("likes"), "likes"],
  comments: ["post", LATEST("comments"), "comments"],
  shares: ["post", LATEST("shares"), "shares"],
  avg_watch_pct: ["post", `(SELECT 100.0 * s.avg_watch_s / NULLIF(p.length_s, 0) FROM snapshots s
     WHERE s.post_id = p.id AND s.avg_watch_s IS NOT NULL ORDER BY s.at DESC LIMIT 1)`, "%"],
  views_1h: ["post", AT_AGE(1), "views"],
  views_6h: ["post", AT_AGE(6), "views"],
  views_24h: ["post", AT_AGE(24), "views"],
  views_72h: ["post", AT_AGE(72), "views"],
  posts: ["post", "1", "posts"],
  followers: ["account", "followers", "followers"],
  gate_pass_rate: ["gate", "ok", "%"],
  ai_reviews: ["gate", "ai_used", "reviews"],
};
export const METRICS = Object.keys(METRIC_DEFS);
export const GROUPS = ["post", "hour", "day", "week", "post_hour", "weekday", "variant", "format"];
export const CHARTS = ["line", "bar", "scatter", "table"];
const RANGES = { "24h": 1, "7d": 7, "30d": 30 };
const TIME_GROUPS = new Set(["hour", "day", "week", "post_hour", "weekday"]);

export const PRESETS = [
  { name: "Views at 24h per post, last 30 days", spec: { metric: "views_24h", bots: [...BOT_IDS], range: "30d", groupBy: "post", chart: "bar", compare: "bots" } },
  { name: "Cup vs Royale: views at 72h", spec: { metric: "views_72h", bots: ["escape"], range: "all", groupBy: "variant", chart: "bar" } },
  { name: "Best posting hour for chess", spec: { metric: "views_24h", bots: ["chess"], range: "all", groupBy: "post_hour", chart: "bar" } },
  { name: "Followers, last 30 days", spec: { metric: "followers", bots: [...BOT_IDS], range: "30d", groupBy: "day", chart: "line", compare: "bots" } },
];

function rangeOf(range, now) {
  if (range === "all") return ["0000", "9999"];
  if (RANGES[range]) return [new Date(now.getTime() - RANGES[range] * 86400e3).toISOString(), now.toISOString()];
  if (range && typeof range === "object") {
    const a = Date.parse(range.from), b = Date.parse(range.to);
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) return [new Date(a).toISOString(), new Date(b).toISOString()];
  }
  return null;
}

export function buildGraphQuery(spec, now = new Date()) {
  if (!spec || typeof spec !== "object") return { error: "bad_spec" };
  const def = METRIC_DEFS[spec.metric];
  if (!Object.hasOwn(METRIC_DEFS, spec.metric) || !def) return { error: "unknown_metric" };
  const bots = Array.isArray(spec.bots) ? [...new Set(spec.bots)] : [];
  if (!bots.length || !bots.every(b => BOT_IDS.includes(b))) return { error: "bad_bots" };
  if (!GROUPS.includes(spec.groupBy)) return { error: "bad_group" };
  if (!CHARTS.includes(spec.chart)) return { error: "bad_chart" };
  if (![undefined, null, "", "bots", "variant"].includes(spec.compare)) return { error: "bad_compare" };
  const range = rangeOf(spec.range, now);
  if (!range) return { error: "bad_range" };
  const [family, value, unit] = def;
  const marks = bots.map(() => "?").join(",");
  // Account and gate rows aren't posts: post-only groupings fall back to days.
  const group = family === "post" || TIME_GROUPS.has(spec.groupBy) ? spec.groupBy : "day";
  const compare = family === "post" ? spec.compare || null : spec.compare ? "bots" : null;
  const sql = {
    post: `SELECT p.id, p.bot, p.title, p.posted_at AS at, p.format, p.variant, ${value} AS value
           FROM posts p WHERE p.bot IN (${marks}) AND p.posted_at >= ? AND p.posted_at <= ? ORDER BY p.posted_at`,
    account: `SELECT bot, at, ${value} AS value FROM account WHERE bot IN (${marks}) AND at >= ? AND at <= ? ORDER BY at`,
    gate: `SELECT bot, at, ${value} AS value FROM gate WHERE bot IN (${marks}) AND at >= ? AND at <= ? ORDER BY at`,
  }[family];
  return { sql, params: [...bots, ...range], family, metric: spec.metric, unit, group, compare };
}

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
const SHORT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// -> [sortKey, label]
function bucket(row, group) {
  const d = new Date(row.at);
  const uk = ukParts(d);
  switch (group) {
    case "post": return [`${row.at}|${row.id}`, row.title || row.id];
    case "hour": return [`${uk.ymd} ${uk.hhmm.slice(0, 2)}`, `${DAY.format(d)} ${uk.hhmm.slice(0, 2)}:00`];
    case "day": return [uk.ymd, DAY.format(d)];
    case "week": {
      const idx = WEEKDAYS.indexOf(uk.weekday);
      const [y, m, dd] = uk.ymd.split("-").map(Number);
      const monday = new Date(Date.UTC(y, m - 1, dd - idx));
      return [monday.toISOString().slice(0, 10), `w/c ${SHORT.format(monday)}`];
    }
    case "post_hour": return [uk.hhmm.slice(0, 2), `${uk.hhmm.slice(0, 2)}:00`];
    case "weekday": return [String(WEEKDAYS.indexOf(uk.weekday)), uk.weekday];
    case "variant": return [row.variant || "none", row.variant || "none"];
    case "format": return [row.format || "none", row.format || "none"];
  }
}

const round1 = v => Math.round(v * 10) / 10;

function aggregate(values, metric, family) {
  if (!values.length) return null;
  if (metric === "posts" || metric === "ai_reviews") return values.reduce((a, b) => a + b, 0);
  if (metric === "gate_pass_rate") return round1(100 * values.reduce((a, b) => a + b, 0) / values.length);
  if (family === "account") return values[values.length - 1];            // latest reading in the bucket
  return round1(values.reduce((a, b) => a + b, 0) / values.length);       // average per post
}

export async function runGraph(db, spec, now = new Date()) {
  const q = buildGraphQuery(spec, now);
  if (q.error) return q;
  const { results } = await db.prepare(q.sql).bind(...q.params).all();
  const rows = results.filter(r => r.value !== null && r.value !== undefined);
  const seriesOf = r => (q.compare === "variant" ? r.variant || "none" : q.compare === "bots" ? BOTS[r.bot].name : null);
  const buckets = new Map();        // key -> label
  const cells = new Map();          // series -> key -> values[]
  const names = [];
  for (const r of rows) {
    const [key, label] = bucket(r, q.group);
    buckets.set(key, label);
    const name = seriesOf(r) ?? (spec.bots.length === 1 ? BOTS[spec.bots[0]].name : "All bots");
    if (!cells.has(name)) { cells.set(name, new Map()); names.push(name); }
    const c = cells.get(name);
    if (!c.has(key)) c.set(key, []);
    c.get(key).push(Number(r.value));
  }
  const keys = [...buckets.keys()].sort((a, b) =>
    (q.group === "post_hour" || q.group === "weekday" ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
  if (q.compare === "bots") names.sort((a, b) => spec.bots.indexOf(botId(a)) - spec.bots.indexOf(botId(b)));
  return {
    labels: keys.map(k => buckets.get(k)),
    series: names.map(name => ({
      name,
      data: keys.map(k => aggregate(cells.get(name).get(k) || [], q.metric, q.family)),
      n: keys.map(k => (cells.get(name).get(k) || []).length),      // rows behind each value
    })),
    unit: q.unit,
  };
}

const botId = name => BOT_IDS.find(b => BOTS[b].name === name);

export function validSaved(list) {
  if (!Array.isArray(list) || list.length > 30) return false;
  return list.every(g => g && typeof g.name === "string" && g.name.trim() && g.name.length <= 80 && !buildGraphQuery(g.spec).error);
}
