// Live numbers: YouTube view counts for recent chess videos (every 5 min) and Buffer
// metrics for both TikTok channels (hourly, one combined call, hard daily cap - the
// Buffer key is shared with the bots, whose posting must never run out of calls).
import { getState, setState } from "../settings.js";

const YT = "https://www.googleapis.com/youtube/v3/videos";
const BUFFER = "https://api.buffer.com";
export const BUFFER_DAILY_CAP = 30;
const RECENT_DAYS = 7;

const num = v => (v === undefined || v === null || v === "" ? null : Number(v));

export function parseYouTubeStats(json) {
  return (json?.items || []).map(i => ({
    external_id: i.id,
    views: num(i.statistics?.viewCount),
    likes: num(i.statistics?.likeCount),
    comments: num(i.statistics?.commentCount),
  }));
}

const BUFFER_QUERY = `query($o: OrganizationId!, $c: [ChannelId!]) {
  sent: posts(first: 40, input: {organizationId: $o, filter: {status: [sent], channelIds: $c}}) {
    edges { node { id channelId dueAt sentAt text externalLink metricsUpdatedAt metrics { type value } } } }
  scheduled: posts(first: 40, input: {organizationId: $o, filter: {status: [scheduled], channelIds: $c}}) {
    edges { node { id channelId dueAt } } } }`;

export function parseBufferPosts(json) {
  const d = json?.data || {};
  const sent = (d.sent?.edges || []).map(({ node: n }) => {
    const m = Object.fromEntries((n.metrics || []).map(x => [x.type, x.value]));
    return {
      external_id: n.id, channel: n.channelId, sent_at: n.sentAt || n.dueAt, text: n.text || "",
      link: n.externalLink || null, metrics_at: n.metricsUpdatedAt || null,
      views: num(m.views), likes: num(m.likes ?? m.reactions), comments: num(m.comments),
      shares: num(m.shares), reach: num(m.reach), avg_watch_s: num(m.averageTimeWatched),
    };
  });
  const scheduled = (d.scheduled?.edges || []).map(({ node: n }) => ({ id: n.id, channel: n.channelId, due: n.dueAt }));
  return { sent, scheduled };
}

const postId = (bot, ext) => `${bot}:${ext}`;

async function insertPost(db, p) {
  const r = await db.prepare(
    "INSERT OR IGNORE INTO posts (id, bot, platform, external_id, title, posted_at, url) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(postId(p.bot, p.external_id), p.bot, p.platform, p.external_id, p.title, p.posted_at, p.url ?? null).run();
  return r.meta.changes > 0;
}

async function snapshot(db, post_id, at, s) {
  await db.prepare(
    "INSERT OR IGNORE INTO snapshots (post_id, at, views, likes, comments, shares, avg_watch_s, reach) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(post_id, at, s.views, s.likes, s.comments, s.shares ?? null, s.avg_watch_s ?? null, s.reach ?? null).run();
}

// A Buffer call allowed today? Counts calls per UTC day in settings.
async function takeBufferCall(db, now) {
  const day = now.toISOString().slice(0, 10);
  const [d, n] = String((await getState(db, "buffer_calls")) || "").split("|");
  const used = d === day ? Number(n) || 0 : 0;
  if (used >= BUFFER_DAILY_CAP) return false;
  await setState(db, "buffer_calls", `${day}|${used + 1}`);
  return true;
}

async function pollYouTube(env, db, fetchFn, now) {
  const since = new Date(now.getTime() - RECENT_DAYS * 86400e3).toISOString();
  const { results } = await db.prepare(
    "SELECT id, external_id FROM posts WHERE bot = 'chess' AND posted_at > ? ORDER BY posted_at DESC LIMIT 50")
    .bind(since).all();
  if (!results.length) return 0;
  const byExt = new Map(results.map(r => [r.external_id, r.id]));
  const url = `${YT}?part=statistics&id=${encodeURIComponent([...byExt.keys()].join(","))}&key=${encodeURIComponent(env.YT_API_KEY)}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  const at = now.toISOString();
  let n = 0;
  for (const s of parseYouTubeStats(await res.json())) {
    if (!byExt.has(s.external_id)) continue;
    await snapshot(db, byExt.get(s.external_id), at, s);
    n++;
  }
  return n;
}

async function pollBuffer(env, db, fetchFn, now) {
  const channels = { [env.BUFFER_CHANNEL_BCF]: "bcf", [env.BUFFER_CHANNEL_ESCAPE]: "escape" };
  const res = await fetchFn(BUFFER, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.BUFFER_API_KEY}` },
    body: JSON.stringify({ query: BUFFER_QUERY,
      variables: { o: env.BUFFER_ORG_ID, c: [env.BUFFER_CHANNEL_BCF, env.BUFFER_CHANNEL_ESCAPE] } }),
  });
  if (!res.ok) throw new Error(`Buffer ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Buffer: ${json.errors[0].message}`);
  const { sent, scheduled } = parseBufferPosts(json);
  const at = now.toISOString();
  const newPosts = [];
  let n = 0;
  for (const p of sent) {
    const bot = channels[p.channel];
    if (!bot) continue;
    const post = { bot, platform: "tiktok", external_id: p.external_id, posted_at: p.sent_at, url: p.link,
      title: p.text.split("\n")[0].slice(0, 120) };
    if (await insertPost(db, post)) newPosts.push(post);
    else if (p.link) await db.prepare("UPDATE posts SET url = COALESCE(url, ?) WHERE id = ?").bind(p.link, postId(bot, p.external_id)).run();
    if (p.views !== null) { await snapshot(db, postId(bot, p.external_id), at, p); n++; }
  }
  const pending = { bcf: 0, escape: 0 };
  for (const s of scheduled) if (channels[s.channel]) pending[channels[s.channel]]++;
  await setState(db, "escape_pending", pending.escape);
  await setState(db, "escape_pending_at", at);
  return { n, newPosts, pending };
}

export async function pollStats(env, db, fetchFn = fetch, now = new Date(), { youtube = true, buffer = false } = {}) {
  const out = { snapshots: 0, newPosts: [], pending: null };
  if (youtube && env.YT_API_KEY) out.snapshots += await pollYouTube(env, db, fetchFn, now);
  const bufferReady = env.BUFFER_API_KEY && env.BUFFER_ORG_ID && env.BUFFER_CHANNEL_BCF && env.BUFFER_CHANNEL_ESCAPE;
  if (buffer && bufferReady && await takeBufferCall(db, now)) {
    const b = await pollBuffer(env, db, fetchFn, now);
    out.snapshots += b.n;
    out.newPosts = b.newPosts;
    out.pending = b.pending;
  }
  return out;
}

// "posted" events from the bots put the post on the Live tab straight away.
export async function recordPostFromEvent(db, event, now = new Date()) {
  if (event.kind !== "posted") return false;
  const d = event.data || {};
  const external_id = d.external_id || d.buffer_id;
  if (!external_id) return false;
  return insertPost(db, {
    bot: event.bot,
    platform: event.bot === "chess" ? "youtube" : "tiktok",
    external_id,
    title: String(event.title).replace(/^[^:]*posted: /i, "").slice(0, 120),
    posted_at: now.toISOString(),
    url: d.video_url || null,
  });
}
