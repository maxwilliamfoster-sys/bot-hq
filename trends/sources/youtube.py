"""YouTube Data API v3 (free quota, 10,000 units a day per Google Cloud project; this collector caps itself lower).

Needs YT_TREND_API_KEY from its OWN free Cloud project, so it can never use up the chess uploads' quota. Each
account's search queries find recent Shorts in its niche; the stats call gives views. Growth is measured, not
guessed: with an earlier reading of the same video, views per hour since that reading; without one, the
average since upload, and the metric name says which. Videos far above their search's typical rate are signals.
search.list costs 100 units, videos.list 1 per 50 videos; a cached response costs nothing.
"""
import os
import statistics
import urllib.parse
from datetime import timedelta

from . import Skipped, iso, parse_time, clamp01
from ..http import Quota, QuotaExceeded

NAME = "youtube"
API = "https://www.googleapis.com/youtube/v3"
SEARCH_COST, VIDEOS_COST = 100, 1
SEARCH_TTL = 12 * 3600


def _get(ctx, quota, url, cost, ttl):
    if not ctx.http.is_cached(url, ttl):
        quota.spend(cost)
    return ctx.http.get(url, ttl=ttl, as_json=True)


def run(ctx):
    key = ctx.env.get("YT_TREND_API_KEY") or os.environ.get("YT_TREND_API_KEY")
    if not key:
        raise Skipped("no YT_TREND_API_KEY (see trends/README.md: free key from a separate Google Cloud project)")
    cfg = ctx.config["youtube"]
    cap = int(ctx.env.get("YT_TREND_DAILY_CAP") or cfg["daily_cap_units"])
    quota = Quota(ctx.state, NAME, cap, ctx.now)
    hist = ctx.state.setdefault("youtube_views", {})
    after = iso(ctx.now - timedelta(hours=cfg["search_window_hours"]))
    out, capped, taken = [], False, set()
    for p in ctx.profiles:
        for q in p.get("youtube_queries", []):
            params = {"part": "snippet", "q": q, "type": "video", "order": "viewCount", "videoDuration": "short",
                      "publishedAfter": after, "maxResults": cfg["results_per_query"], "regionCode": p["geo"][0],
                      "relevanceLanguage": p.get("language", "en"), "key": key}
            try:
                found = _get(ctx, quota, f"{API}/search?" + urllib.parse.urlencode(params), SEARCH_COST, SEARCH_TTL)
                ids = [i["id"]["videoId"] for i in found.get("items", []) if i.get("id", {}).get("videoId")]
                if not ids:
                    continue
                vids = _get(ctx, quota, f"{API}/videos?" + urllib.parse.urlencode(
                    {"part": "snippet,statistics", "id": ",".join(ids[:50]), "key": key}), VIDEOS_COST, 3600)
            except QuotaExceeded as e:
                capped = True
                ctx.note(NAME, str(e))
                break
            rows = []
            for v in vids.get("items", []):
                pub = parse_time(v.get("snippet", {}).get("publishedAt"))
                views = v.get("statistics", {}).get("viewCount")
                if not pub or views is None:
                    continue
                views = int(views)
                h = hist.setdefault(v["id"], [])
                prev = next((x for x in reversed(h) if (ctx.now - parse_time(x[0])).total_seconds() >= 6 * 3600), None)
                if prev:
                    hours = (ctx.now - parse_time(prev[0])).total_seconds() / 3600
                    rate, metric = (views - prev[1]) / hours, "views_per_hour_recent"
                else:
                    hours = max(1.0, (ctx.now - pub).total_seconds() / 3600)
                    rate, metric = views / hours, "avg_views_per_hour_since_upload"
                if not h or h[-1][0][:13] != iso(ctx.now)[:13]:
                    h.append([iso(ctx.now), views])
                del h[:-10]
                rows.append((v, pub, rate, metric))
            if len(rows) < 3:
                continue
            typical = statistics.median(r[2] for r in rows) or 1
            for v, pub, rate, metric in sorted(rows, key=lambda r: -r[2])[: cfg["outliers_per_query"]]:
                ratio = rate / typical
                if ratio < 2:
                    break
                if (p["key"], v["id"]) in taken:      # the same video found by two of an account's searches
                    continue
                taken.add((p["key"], v["id"]))
                sn = v["snippet"]
                out.append({
                    "name": sn.get("title", "")[:200], "source": NAME, "source_type": "video",
                    "url": f"https://www.youtube.com/shorts/{v['id']}",
                    "title": f"{sn.get('title', '')} ({sn.get('channelTitle', '')})"[:300],
                    "published_at": iso(pub), "fetched_at": iso(ctx.now), "metric": metric, "value": round(rate, 1),
                    "_geo": p["geo"][0], "_for": [p["key"]], "_attach_only": True,
                    "_performance": clamp01((ratio - 1) / 3), "_raw_ratio": round(ratio, 2), "_query": q,
                })
        if capped:
            break
    # Forget videos not seen for 14 days.
    for vid in [k for k, h in hist.items() if h and h[-1][0] < ctx.cutoff(14)]:
        del hist[vid]
    ctx.note(NAME, f"quota used today: {quota.used} of {cap}")
    if capped and not out:
        ctx.status_override[NAME] = "quota_capped"
    return out
