"""How crowded a topic already is on YouTube: recent Shorts about it, for the strongest candidates only.

One search.list call (100 quota units) per topic: Shorts uploaded in the last 7 days matching the topic name,
up to 50. competition = 1 - count/50 (a topic nobody has covered yet scores 1), and the count is stored in the
day's snapshot so the lifecycle can spot saturation. Without the free key this is skipped and competition stays
missing; it's never guessed.
"""
import urllib.parse
from datetime import timedelta

from .http import HttpError, Quota, QuotaExceeded
from .sources import iso

API = "https://www.googleapis.com/youtube/v3/search"
MAX_RESULTS = 50


def check(cands, ctx):
    key = ctx.env.get("YT_TREND_API_KEY")
    if not key:
        return {"status": "skipped", "reason": "no YT_TREND_API_KEY"}
    cfg = ctx.config["youtube"]
    quota = Quota(ctx.state, "youtube", int(ctx.env.get("YT_TREND_DAILY_CAP") or cfg["daily_cap_units"]), ctx.now)
    after = iso(ctx.now - timedelta(days=7))
    done = 0
    for c in sorted(cands, key=lambda c: -c["_best"])[: cfg.get("competition_checks", 8)]:
        url = API + "?" + urllib.parse.urlencode({"part": "id", "q": c["name"][:100], "type": "video",
                                                  "videoDuration": "short", "publishedAfter": after,
                                                  "maxResults": MAX_RESULTS, "key": key})
        try:
            if not ctx.http.is_cached(url, 24 * 3600):
                quota.spend(100)
            n = len(ctx.http.get(url, ttl=24 * 3600, as_json=True).get("items") or [])
        except QuotaExceeded as e:
            ctx.note("competition", str(e))
            break
        except HttpError as e:
            ctx.note("competition", f"search failed: {e}")
            continue
        c["components"]["competition"] = round(1 - min(n, MAX_RESULTS) / MAX_RESULTS, 3)
        c["snapshot"]["competitor_count"] = n
        done += 1
    return {"status": "ok", "checked": done, "quota_used": quota.used}
