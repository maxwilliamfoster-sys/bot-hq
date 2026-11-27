// Trend context for judging tests fairly. For one account's recent videos: which were on a topic that was trending
// when they went out (by Bot HQ's own trend data), with each video's test arm and views against the account's
// median. The evening review compares a test's arms with and without those videos, so a trend isn't mistaken
// for the tested change working. Read-only; nothing here changes a test or a trend.
import { getProfile } from "./profiles.js";
import { distinctWords, topicJoins } from "./text.js";

const DAY = 864e5;
const SLACK_DAYS = 2;        // a trend counts from 2 days before Bot HQ first saw it to 2 days after it was last seen
const MEDIAN_DAYS = 90;
const MAX_DAYS = 60;
const MAX_TRENDS = 400;      // bounds the CPU (10 ms a request on the free plan)

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const round2 = v => Math.round(v * 100) / 100;

export async function videoContext(db, account, now, days = 28) {
  const p = getProfile(account);
  if (!p) return { status: 400, error: "bad_account" };
  const d = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(days)) || 28));
  const since = new Date(now - d * DAY).toISOString();
  const [posts, base, trends, first] = await Promise.all([
    db.prepare(`SELECT p.id, p.title, p.url, p.posted_at, p.variant, p.format, MAX(s.views) AS views
                FROM posts p LEFT JOIN snapshots s ON s.post_id = p.id
                WHERE p.bot = ? AND p.posted_at >= ? GROUP BY p.id ORDER BY p.posted_at DESC`).bind(p.bot, since).all(),
    // The account's usual views: videos past 72 h from the last 90 days.
    db.prepare(`SELECT MAX(s.views) AS views FROM posts p JOIN snapshots s ON s.post_id = p.id
                WHERE p.bot = ? AND p.posted_at >= ? AND p.posted_at <= ? GROUP BY p.id`)
      .bind(p.bot, new Date(now - MEDIAN_DAYS * DAY).toISOString(), new Date(now - 3 * DAY).toISOString()).all(),
    db.prepare(`SELECT o.id AS opportunity_id, t.id AS trend_id, t.name, t.first_seen, t.last_seen, o.score, o.class, o.status
                FROM opportunities o JOIN trends t ON t.id = o.trend_id
                WHERE o.account = ? AND o.gate_passed = 1 AND t.last_seen >= ?
                ORDER BY t.last_seen DESC LIMIT ?`)
      .bind(p.key, new Date(now - (d + SLACK_DAYS) * DAY).toISOString(), MAX_TRENDS).all(),
    db.prepare("SELECT MIN(first_seen) AS first FROM trends").first(),
  ]);
  const med = median(base.results.map(r => r.views).filter(Number.isFinite));
  const titleWords = new Map(posts.results.map(v => [v.id, distinctWords(v.title || "")]));
  const anyTitle = new Set();
  for (const ws of titleWords.values()) for (const w of ws) anyTitle.add(w);
  // A trend whose words appear in no title can't join any video: skip it before the per-video check (CPU).
  const topics = trends.results.map(t => ({ ...t, words: distinctWords(t.name),
    from: Date.parse(t.first_seen) - SLACK_DAYS * DAY, to: Date.parse(t.last_seen) + SLACK_DAYS * DAY }))
    .filter(t => topicJoins(t.words, anyTitle));
  const dataSince = first?.first || null;
  const checkFrom = dataSince ? Date.parse(dataSince) - SLACK_DAYS * DAY : Infinity;
  const videos = posts.results.map(v => {
    const at = Date.parse(v.posted_at);
    const words = titleWords.get(v.id);
    const hits = Number.isFinite(at) && words.size
      ? topics.filter(t => at >= t.from && at <= t.to && topicJoins(t.words, words)) : [];
    return {
      id: v.id, title: v.title, url: v.url, posted_at: v.posted_at, variant: v.variant, format: v.format,
      views: v.views ?? null, ratio: med && Number.isFinite(v.views) ? round2(v.views / Math.max(med, 1)) : null,
      age_hours: Number.isFinite(at) ? Math.floor((now - at) / 36e5) : null,
      checked: Number.isFinite(at) && at >= checkFrom,
      trends: hits.slice(0, 3).map(({ opportunity_id, trend_id, name, score, class: cls, status }) =>
        ({ opportunity_id, trend_id, name, score, class: cls, status })),
    };
  });
  return { account: p.key, days: d, median_views: med, trend_data_since: dataSince, videos };
}
