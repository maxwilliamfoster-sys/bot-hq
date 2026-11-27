"""Google Trends daily trending searches, from the public RSS feed (no key, about 20 searches per country a day).

Only what the feed gives: the search term, Google's rough traffic bucket ("2000+") and the news stories Google
links to it (their original publisher URLs). Related queries and interest-over-time have no free official API,
so they're left to the manual research links. Each day a term appears is kept in the state, so "seen 3 days
running" can be told apart from a one-day spike.
"""
import urllib.parse

from . import parse_time, iso, log_momentum, http_url, safe_xml
from ..textmatch import dedupe_key

NAME = "google_trends_rss"
NS = "{https://trends.google.com/trending/rss}"


def explore_link(term, geo):
    return "https://trends.google.com/trends/explore?" + urllib.parse.urlencode({"date": "now 7-d", "geo": geo, "q": term})


def parse(text, geo, fetched):
    out = []
    for it in safe_xml(text).iter("item"):
        term = (it.findtext("title") or "").strip()
        if not term:
            continue
        raw = (it.findtext(f"{NS}approx_traffic") or "").replace(",", "").replace("+", "").strip()
        traffic = int(raw) if raw.isdigit() else None
        news = [(n.findtext(f"{NS}news_item_title") or "").strip() for n in it.iter(f"{NS}news_item")]
        urls = [(n.findtext(f"{NS}news_item_url") or "").strip() for n in it.iter(f"{NS}news_item")]
        url = next((u for u in urls if http_url(u)), explore_link(term, geo))
        pub = parse_time(it.findtext("pubDate"))
        out.append({
            "name": term, "source": NAME, "source_type": "search", "url": url,
            "title": (f"{term}: " + "; ".join(t for t in news[:3] if t))[:300],
            "published_at": iso(pub) if pub else None, "fetched_at": fetched,
            "metric": f"approx_traffic_{geo}", "value": traffic,
            "_geo": geo, "_momentum": log_momentum(traffic) if traffic else None, "_volume": traffic,
            "_explore": explore_link(term, geo),
        })
    return out


def run(ctx):
    geos = sorted({g for p in ctx.profiles for g in p["geo"]})
    fetched = iso(ctx.now)
    day = ctx.now.strftime("%Y-%m-%d")
    seen = ctx.state.setdefault("google_trends_days", {})
    out = []
    for geo in geos:
        text = ctx.http.get(f"https://trends.google.com/trending/rss?geo={geo}", ttl=3 * 3600)
        for s in parse(text, geo, fetched):
            days = seen.setdefault(dedupe_key(s["name"]), [])
            if day not in days:
                days.append(day)
            s["_days_seen"] = len(days)
            out.append(s)
    # Forget terms not seen for 30 days.
    for k in [k for k, v in seen.items() if v and v[-1] < ctx.cutoff(30)]:
        del seen[k]
    return out
