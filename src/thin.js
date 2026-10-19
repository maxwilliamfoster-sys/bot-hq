// Which snapshot rows to delete so storage stays small but graphs stay accurate.
// Rows under 7 days old: all kept. 7-30 days: newest per hour. Older: newest per day,
// except a post's first 72h, which always keeps hourly detail (views@1h/6h/24h/72h).
// The newest row of every post is always kept. Posts we don't know are left alone.
const H = 3600e3;
const D = 24 * H;

export function thinPlan(rows, postedAt, now = new Date()) {
  const newest = new Map();
  for (const r of rows) {
    const cur = newest.get(r.post_id);
    if (!cur || r.at > cur.at) newest.set(r.post_id, r);
  }
  const keepers = new Map();                       // bucket -> newest row in it
  const doomed = [];
  for (const r of rows) {
    const posted = postedAt[r.post_id];
    if (!posted) continue;
    const t = Date.parse(r.at);
    const age = now.getTime() - t;
    if (age < 7 * D) continue;
    const sincePost = t - Date.parse(posted);
    const size = age < 30 * D || sincePost < 72 * H ? H : D;
    const key = `${r.post_id}|${size}|${Math.floor(t / size)}`;
    const cur = keepers.get(key);
    if (!cur) { keepers.set(key, r); continue; }
    if (r.at > cur.at) { doomed.push(cur); keepers.set(key, r); } else doomed.push(r);
  }
  return doomed.filter(r => newest.get(r.post_id) !== r).map(r => r.id);
}
