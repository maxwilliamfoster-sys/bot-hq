"""News: Google News RSS search for each account's news queries, plus hand-picked publisher feeds (sources.json).

Only stories from the last few days, never from a blocked domain, each with its publisher and publish time.
Google News links redirect to the publisher; the publisher's own address is kept in the title.
"""
import urllib.parse
from datetime import timedelta

from . import parse_feed, iso, blocked, host, http_url

NAME = "news_rss"
LOCALE = {"GB": ("en-GB", "GB", "GB:en"), "US": ("en-US", "US", "US:en")}


def google_news_url(query, geo, days):
    hl, gl, ceid = LOCALE.get(geo, LOCALE["GB"])
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": f"{query} when:{days}d", "hl": hl, "gl": gl, "ceid": ceid})


def items_to_signals(items, ctx, source, geo, scope, google=False):
    cfg = ctx.config
    oldest = ctx.now - timedelta(days=cfg["news_window_days"])
    out = []
    for it in items[: cfg["items_per_feed"]]:
        title, link, pub = it["title"], it["link"], it["published"]
        if not title or not http_url(link) or not pub or pub < oldest or pub > ctx.now + timedelta(hours=1):
            continue
        publisher_url = it.get("source_url") or link
        if blocked(publisher_url, cfg["blocked_domains"]) or blocked(link, cfg["blocked_domains"]):
            continue
        headline = title
        publisher = it.get("source_name") or host(publisher_url)
        if google and " - " in title:
            headline, _, publisher = title.rpartition(" - ")
        out.append({
            "name": headline.strip()[:200], "source": source, "source_type": "news", "url": link,
            "title": f"{headline.strip()} ({publisher or host(publisher_url)})"[:300],
            "published_at": iso(pub), "fetched_at": iso(ctx.now), "metric": "article", "value": 1,
            "_geo": geo, "_for": scope, "_publisher": host(publisher_url),
        })
    return out


def run(ctx):
    out = []
    days = ctx.config["news_window_days"]
    # Each feed is fetched once even when several accounts list it.
    feeds = {}
    for p in ctx.profiles:
        for f in ctx.config["feeds"].get(p["key"], []):
            feeds.setdefault(f, []).append(p["key"])
    errors = []
    for url, scope in feeds.items():
        try:
            out += items_to_signals(parse_feed(ctx.http.get(url, ttl=2 * 3600)), ctx, NAME, "GB", scope)
        except Exception as e:      # one broken feed doesn't stop the rest
            errors.append(f"{host(url)}: {type(e).__name__}")
    for p in ctx.profiles:
        geo = p["geo"][0]
        for q in p.get("news_queries", []):
            try:
                text = ctx.http.get(google_news_url(q, geo, days), ttl=2 * 3600)
                out += items_to_signals(parse_feed(text), ctx, "google_news_rss", geo, [p["key"]], google=True)
            except Exception as e:
                errors.append(f"google news '{q}': {type(e).__name__}")
    if errors:
        ctx.note(NAME, "some feeds failed: " + "; ".join(errors[:8]))
    if errors and not out:
        raise RuntimeError("every news feed failed")
    return out
