// Trend intelligence that needs what Bot HQ already knows: each account's own past videos and views (posts +
// snapshots), and the autopilot's approaches and open ideas (the tracker block kit.py posts). All numbers come from
// stored data; nothing here guesses. No history means the component is left out, never filled in.
import RULES from "../../trends/text_rules.json" with { type: "json" };
import { getState, setState } from "../settings.js";
import { PROFILES } from "./profiles.js";
import { normalise, phraseIndex, termHits, distinctWords, topicJoins, wordForms } from "./text.js";

const DAY = 864e5;
const HISTORY_DAYS = 180;
const HALF_LIFE_DAYS = 60;      // a video's lesson counts half after two months
const MAX_MATCHES = 30;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v => Math.round(v * 100) / 100;

// ---- allegations ----------------------------------------------------------------------------------------------
// A live case (accused, on trial, charged, and no verdict in the evidence) is flagged so no idea presents an
// allegation as fact and true-crime ideas wait for the court. A later verdict in the evidence clears it.
export function flagsFor(text) {
  const idx = phraseIndex(normalise(text));
  return termHits(idx, RULES.allegation.active).length && !termHits(idx, RULES.allegation.settled).length ? ["active_case"] : [];
}

// ---- lifecycle ----------------------------------------------------------------------------------------------
export const LIFECYCLES = ["new", "not_enough_data", "emerging", "accelerating", "peak", "flat", "saturating",
  "declining", "re_emerging", "expired"];

// From the daily snapshots (momentum 0..1, volume, competitor count). Fewer than 3 readings with a momentum
// number: "not_enough_data", never a guess.
export function lifecycle({ first_seen, last_seen, previous }, snapshots, now) {
  if (now - Date.parse(last_seen) > 14 * DAY) return "expired";
  if (now - Date.parse(first_seen) < 2 * DAY) return "new";
  const days = [...snapshots].sort((x, y) => (x.day < y.day ? -1 : 1));
  const m = days.filter(s => Number.isFinite(s.momentum)).map(s => s.momentum);
  if (m.length < 3) return "not_enough_data";
  const [a, b, c] = m.slice(-3);
  const d1 = c - b, d0 = b - a;
  const sat = days.filter(s => Number.isFinite(s.competitor_count) && s.competitor_count > 0 && Number.isFinite(s.volume)).slice(-2);
  if (sat.length === 2 && sat[1].competitor_count > sat[0].competitor_count &&
      sat[1].volume / sat[1].competitor_count < sat[0].volume / sat[0].competitor_count) return "saturating";
  if ((previous === "declining" || previous === "expired") && d1 > 0.05) return "re_emerging";
  if ((d1 < -0.02 && d0 < -0.02) || (d1 < -0.05 && c < 0.7 * Math.max(...m))) return "declining";
  if (d1 > 0.05 && d1 > d0) return "accelerating";
  if (d1 > 0.02) return "emerging";
  if (c >= 0.6) return "peak";
  return "flat";
}

// ---- account history ----------------------------------------------------------------------------------------
// Built once a day (schedule step) into settings state "trend_history": per account, the distinctive words of each
// video title from the last 180 days with its views against the account's median, plus approaches that won or
// lost and the open ideas. Ingest reads this one row instead of scanning posts.
const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// Stored shape per account (built once a day, so a batch only parses it and looks words up):
//   posts: [[ratio to median, "YYYY-MM-DD"], ...], index: { word: [post numbers] }; approaches and ideas as
//   [words, ratio, date] / words (a handful each).
export function indexPosts(rows) {
  const posts = [], index = {};
  for (const [title, ratio, date] of rows) {
    const words = distinctWords(title);
    if (!words.size || !Number.isFinite(ratio)) continue;
    const i = posts.push([ratio, date]) - 1;
    for (const w of words) (Object.hasOwn(index, w) ? index[w] : (index[w] = [])).push(i);
  }
  return { posts, index };
}

export async function buildHistory(db, now) {
  const since = new Date(now - HISTORY_DAYS * DAY).toISOString();
  const { results } = await db.prepare(
    `SELECT p.bot, p.title, p.posted_at, MAX(s.views) AS views FROM posts p JOIN snapshots s ON s.post_id = p.id
     WHERE p.posted_at >= ? AND p.title IS NOT NULL GROUP BY p.id`).bind(since).all();
  let autopilot = null;
  try { autopilot = JSON.parse(await getState(db, "tracker") || "null")?.autopilot || null; } catch { /* none */ }
  const accounts = {};
  for (const p of PROFILES) {
    const rows = results.filter(r => r.bot === p.bot && Number.isFinite(r.views));
    const med = median(rows.map(r => r.views));
    const ap = (autopilot?.accounts || []).find(a => a?.key === p.key);
    accounts[p.key] = {
      n: rows.length,
      ...indexPosts(med ? rows.map(r => [r.title, round2(r.views / Math.max(med, 1)), String(r.posted_at).slice(0, 10)]) : []),
      approaches: (Array.isArray(ap?.approaches) ? ap.approaches : [])
        .filter(x => x && (x.outcome === "won" || x.outcome === "lost") && !Number.isNaN(Date.parse(x.date)))
        .map(x => [[...distinctWords(`${x.family || ""} ${x.what || ""}`)].join(" "), x.outcome === "won" ? 2 : 0.5, String(x.date).slice(0, 10)]),
      ideas: (Array.isArray(ap?.ideas_open) ? ap.ideas_open : []).filter(i => typeof i === "string")
        .map(i => [...distinctWords(i)].join(" ")),
    };
  }
  await setState(db, "trend_history", JSON.stringify({ built: now.toISOString(), accounts }));
  return { posts: results.length };
}

// One row, parsed once per request. Nothing is rebuilt here (the Worker has 10 ms of CPU per request).
export async function loadHistory(db) {
  try {
    const h = JSON.parse(await getState(db, "trend_history") || "null");
    return new Map(Object.entries(h?.accounts || {}));
  } catch { return new Map(); }
}

const toSet = s => new Set(s ? s.split(" ") : []);

// Posts whose title has the topic's words (topicJoins' rule, through the index: plurals and possessives count).
export function matchingPosts(h, topicWords) {
  const k = topicWords.size;
  const need = k <= 3 ? k : Math.ceil((3 * k) / 4);
  const index = h.index || {};
  const hits = new Map();
  for (const w of topicWords) {
    const seen = new Set();
    for (const form of wordForms(w)) {
      if (!Object.hasOwn(index, form)) continue;
      for (const i of index[form]) if (!seen.has(i)) { seen.add(i); hits.set(i, (hits.get(i) || 0) + 1); }
    }
  }
  // The newest MAX_MATCHES only: older ones barely count after the fade, and it bounds the CPU.
  const out = [];
  for (const [i, c] of hits) if (c >= need) out.push(h.posts[i]);
  return out.length > MAX_MATCHES ? out.sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, MAX_MATCHES) : out;
}

// history_fit (-1..1, worth up to +-3 points inside audience interest) and originality (0..1) for one account.
// A matching past video counts by how it did against the account's median, fading with age; few matches are
// shrunk towards 0, and a single bad result can never push it below 0 (one failed test doesn't block a topic).
export function historyFor(h, topicWords, now) {
  if (!h || !h.n || topicWords.size < 2) return {};
  let w = 0, f = 0, n = 0, newestPost = null;
  const add = (ratio, date) => {
    const age = Math.max(0, (now - Date.parse(date)) / DAY);
    const weight = 0.5 ** (age / HALF_LIFE_DAYS);
    w += weight;
    f += weight * clamp(Math.log2(Math.max(ratio, 0.01)) / 2, -1, 1);
    n++;
  };
  for (const [r, d] of matchingPosts(h, topicWords)) {
    add(r, d);
    if (!newestPost || d > newestPost) newestPost = d;
  }
  for (const [words, r, d] of h.approaches || []) if (topicJoins(topicWords, toSet(words))) add(r, d);
  const out = {};
  if (n) {
    let fit = (f / w) * (n / (n + 2));
    if (n < 2 && fit < 0) fit = 0;
    out.history_fit = round2(fit);
    out.history_matches = n;
  }
  // Originality: how recently this account already covered the topic, and whether it's already a planned idea.
  let o = 1;
  if (newestPost) {
    const age = (now - Date.parse(newestPost)) / DAY;
    o = age < 30 ? 0.2 : age < 90 ? 0.5 : 0.8;
  }
  if ((h.ideas || []).some(i => topicJoins(topicWords, toSet(i)))) o = Math.min(o, 0.6);
  out.originality = o;
  return out;
}

// ---- daily upkeep -------------------------------------------------------------------------------------------
export async function trendUpkeep(db, now) {
  const hist = await buildHistory(db, now);
  const expired = await db.prepare("UPDATE trends SET lifecycle = 'expired' WHERE last_seen < ? AND lifecycle != 'expired'")
    .bind(new Date(now - 14 * DAY).toISOString()).run();
  // Failed-gate rows nobody decided on go after 30 days (the trend's exclusions are kept separately). Max's own
  // rejections stay, so a trend he turned down can't come back as new.
  const cleaned = await db.prepare("DELETE FROM opportunities WHERE class = 'rejected' AND status = 'new' AND updated_at < ?")
    .bind(new Date(now - 30 * DAY).toISOString()).run();
  return { ...hist, expired: expired.meta?.changes ?? 0, cleaned: cleaned.meta?.changes ?? 0 };
}

// ---- collector context ----------------------------------------------------------------------------------------
// What the collector may read with the bot credential: each active account's YouTube competitors from the
// autopilot watchlist. Public channel links only; nothing else from the tracker leaves the Worker this way.
const YT = /^https:\/\/(www\.|m\.)?youtube\.com\/(@[\w.-]{1,100}|channel\/UC[\w-]{22})(\/[a-z]*)?\/?$/i;
export async function collectorContext(db) {
  let autopilot = null;
  try { autopilot = JSON.parse(await getState(db, "tracker") || "null")?.autopilot || null; } catch { /* none */ }
  const accounts = {};
  for (const p of PROFILES) {
    const ap = (autopilot?.accounts || []).find(a => a?.key === p.key);
    accounts[p.key] = (Array.isArray(ap?.competitors) ? ap.competitors : [])
      .filter(c => typeof c?.url === "string" && YT.test(c.url.trim()))
      .slice(0, 6).map(c => ({ channel: String(c.channel || "").slice(0, 80), url: c.url.trim() }));
  }
  return { accounts };
}
