// Eagle Eyes posts through Zernio, not Buffer. Hourly: what went out, what failed, what is queued,
// so a scheduled post that never appears gets noticed (nothing in the bot checks after scheduling).
import { setState } from "../settings.js";
import { insertPost, snapshotStmt } from "./stats.js";

const API = "https://zernio.com/api/v1";
const DAY = 86400e3;
const WINDOW_D = 7;
const NEWS_H = 48;                     // a failure older than this is history, not news
const FAILED = new Set(["failed", "partial"]);
const UNSENT = new Set(["scheduled", "publishing"]);

async function zernioJson(env, fetchFn, path) {
  const res = await fetchFn(`${API}${path}`, { headers: { authorization: `Bearer ${env.ZERNIO_API_KEY}` } });
  if (!res.ok) throw new Error(`Zernio ${res.status}`);
  return res.json();
}

export function parseZernioPosts(json) {
  return (json?.posts || []).map(p => {
    const tiktok = (p.platforms || []).find(x => x.platform === "tiktok") || {};
    return { id: p._id, status: p.status, due: p.scheduledFor || null, text: typeof p.content === "string" ? p.content : "",
      url: tiktok.platformPostUrl || null, error: typeof tiktok.errorMessage === "string" ? tiktok.errorMessage : null };
  });
}

export async function pollZernio(env, db, fetchFn = fetch, now = new Date()) {
  if (!env.ZERNIO_API_KEY) return null;
  const q = new URLSearchParams({ limit: "100",
    fromDate: new Date(now.getTime() - WINDOW_D * DAY).toISOString(),
    toDate: new Date(now.getTime() + WINDOW_D * DAY).toISOString() });
  const posts = parseZernioPosts(await zernioJson(env, fetchFn, `/posts?${q}`));
  const newPosts = [];
  for (const p of posts.filter(x => x.status === "published" && x.due)) {
    const post = { bot: "eagle", platform: "tiktok", external_id: p.id, posted_at: new Date(p.due).toISOString(),
      url: p.url, title: p.text.split("\n")[0].slice(0, 120) };
    if (await insertPost(db, post)) newPosts.push(post);
    else if (p.url) await db.prepare("UPDATE posts SET url = COALESCE(url, ?) WHERE id = ?").bind(p.url, `eagle:${p.id}`).run();
  }
  const queued = posts.filter(p => UNSENT.has(p.status) && p.due);
  const ahead = queued.map(p => p.due).filter(d => Date.parse(d) > now.getTime()).sort();
  await setState(db, "eagle_next_due", ahead[0] || "");
  await setState(db, "eagle_polled_at", now.toISOString());
  const failed = posts.filter(p => FAILED.has(p.status) && p.due && now.getTime() - Date.parse(p.due) < NEWS_H * 3600e3);
  return { newPosts, failed, queued: queued.map(p => ({ bot: "eagle", due: p.due })) };
}

// Numbers for recent posts only; a separate step, so a views problem can't hide a failed post.
export async function pollZernioViews(env, db, fetchFn = fetch, now = new Date()) {
  if (!env.ZERNIO_API_KEY) return 0;
  const { results } = await db.prepare("SELECT id FROM posts WHERE bot = 'eagle' AND posted_at > ?")
    .bind(new Date(now.getTime() - WINDOW_D * DAY).toISOString()).all();
  if (!results.length) return 0;
  const ids = new Set(results.map(r => r.id));
  const json = await zernioJson(env, fetchFn, "/analytics?limit=100&page=1");
  const at = now.toISOString();
  const rows = (json.posts || []).map(p => ({ id: `eagle:${p.latePostId}`, a: p.analytics || {} }))
    .filter(r => ids.has(r.id) && r.a.views != null);
  if (rows.length) {
    await db.batch(rows.map(({ id, a }) => snapshotStmt(db, id, at, {
      views: a.views, likes: a.likes ?? null, comments: a.comments ?? null, shares: a.shares ?? null,
      avg_watch_s: a.igReelsAvgWatchTime != null ? a.igReelsAvgWatchTime / 1000 : null,
    })));
  }
  return rows.length;
}
