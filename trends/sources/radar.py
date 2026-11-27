"""Shorts Radar (the existing chess niche tracker): its breaking and outlier Shorts, already scored against each
video's own channel. Chess only. Used as content-performance evidence, never as a trend by itself."""
import math
from datetime import datetime, timedelta, timezone

from . import iso, clamp01, http_url

NAME = "shorts_radar"
URL = "https://raw.githubusercontent.com/maxwilliamfoster-sys/shorts-radar/data/insights/chess.json"


def parse(d, now):
    gen = datetime.fromtimestamp(d.get("generated", 0), tz=timezone.utc) if d.get("generated") else now
    out = []
    for kind in ("breaking", "top_outliers"):
        for v in d.get(kind) or []:
            if not http_url(v.get("url")) or not v.get("title") or not v.get("ratio"):
                continue
            pub = gen - timedelta(hours=v.get("age_h") or 0)
            out.append({
                "name": v["title"][:200], "source": NAME, "source_type": "video", "url": v["url"],
                "title": f"{v['title']} ({v.get('channel', '')}, {kind.replace('_', ' ')})"[:300],
                "published_at": iso(pub), "fetched_at": iso(now), "metric": "views_vs_channel_median",
                "value": v["ratio"], "_geo": None, "_for": ["chess"], "_attach_only": True,
                "_performance": clamp01(math.log10(max(v["ratio"], 1)) / 1.5), "_raw_ratio": v["ratio"],
            })
    return out


def run(ctx):
    if not any(p["key"] == "chess" for p in ctx.profiles):
        return []
    return parse(ctx.http.get(URL, ttl=6 * 3600, as_json=True), ctx.now)
