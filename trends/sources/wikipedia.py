"""Wikipedia page views (Wikimedia REST API: free, official, no key).

Two ways in: yesterday's 1,000 most-read English articles (discovery), and each account's seed articles. A page
only becomes a signal if its views rose against its own history: mean of the last 3 days against the median of
the 30 days before. A big article at its normal level is not a trend.
"""
import statistics
import urllib.parse
from datetime import timedelta

from . import iso, clamp01
from ..http import HttpError
from ..textmatch import normalise, phrase_index, term_hits

NAME = "wikipedia"
API = "https://wikimedia.org/api/rest_v1/metrics/pageviews"
SKIP_PREFIX = ("Special:", "Wikipedia:", "File:", "Portal:", "Talk:", "Help:", "Category:", "Template:", "User:", "Main_Page", "-")


def ratio_from(items):
    """(ratio, recent mean, baseline median, n baseline days) or None when there isn't enough history."""
    views = [i["views"] for i in sorted(items, key=lambda i: i["timestamp"])]
    if len(views) < 17:
        return None
    recent = statistics.mean(views[-3:])
    base_days = views[-33:-3]
    base = statistics.median(base_days)
    return recent / max(base, 1), recent, base, len(base_days)


def _any_anchor(text, profiles):
    idx = phrase_index(normalise(text))
    return [p["key"] for p in profiles if term_hits(idx, p["anchors"]) and not term_hits(idx, p["exclude"])]


def _signal(ctx, article, summary, r, scope, metric="views_3d_vs_30d"):
    ratio, recent, base, _ = r
    name = article.replace("_", " ")
    desc = (summary or {}).get("description") or ""
    extract = ((summary or {}).get("extract") or "").replace("\n", " ")
    return {
        "name": name, "source": NAME, "source_type": "wiki",
        "url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(article, safe="()_,'"),
        "title": f"{name}: {desc}. {extract}"[:300], "published_at": iso(ctx.now - timedelta(days=1)),
        "fetched_at": iso(ctx.now), "metric": metric, "value": round(ratio, 2),
        "_geo": None, "_for": scope, "_momentum": clamp01((ratio - 1) / 4), "_volume": round(recent),
        "_raw_ratio": round(ratio, 2), "_baseline": round(base),
    }


def history(ctx, article, days):
    """Daily views, or None when Wikimedia has none for this article (renamed, deleted, too new)."""
    end = ctx.now - timedelta(days=1)
    start = end - timedelta(days=days)
    url = (f"{API}/per-article/en.wikipedia/all-access/user/{urllib.parse.quote(article, safe='')}/daily/"
           f"{start:%Y%m%d}/{end:%Y%m%d}")
    try:
        return ctx.http.get(url, ttl=12 * 3600, as_json=True).get("items", [])
    except HttpError as e:
        if e.status != 404:
            raise
        return None


def summary(ctx, article):
    try:
        return ctx.http.get("https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(article, safe=""),
                            ttl=24 * 3600, as_json=True)
    except HttpError:
        return None


def top_articles(ctx):
    for back in (1, 2):
        d = ctx.now - timedelta(days=back)
        try:
            data = ctx.http.get(f"{API}/top/en.wikipedia/all-access/{d:%Y/%m/%d}", ttl=12 * 3600, as_json=True)
            return data["items"][0]["articles"]
        except HttpError as e:
            if e.status != 404:      # 404 = that day isn't published yet; try the day before
                raise
    return []


def run(ctx):
    cfg = ctx.config["wikipedia"]
    out, done = [], set()
    # 1. Discovery: most-read articles whose title already names some account's niche.
    picked = []
    for a in top_articles(ctx)[: cfg["top_articles_scan"]]:
        art = a.get("article", "")
        if not art or art.startswith(SKIP_PREFIX):
            continue
        if _any_anchor(art.replace("_", " "), ctx.profiles):
            picked.append(art)
    for art in picked[: cfg["max_summaries"]]:
        s = summary(ctx, art)
        text = f"{art.replace('_', ' ')} {(s or {}).get('description', '')} {(s or {}).get('extract', '')}"
        scope = _any_anchor(text, ctx.profiles)
        if not scope:
            continue
        h = history(ctx, art, cfg["history_days"])
        done.add(art)
        r = ratio_from(h) if h is not None else None
        if h is None:
            ctx.note(NAME, f"no page-view history for {art}")
            continue
        if r is None:
            # A brand-new article with no history: worth a look, but no growth number to claim.
            out.append({**_signal(ctx, art, s, (1.0, 0, 0, 0), scope, metric="new_article_no_history"),
                        "value": None, "_momentum": None, "_raw_ratio": None})
        elif r[0] >= cfg["min_ratio_top"]:
            out.append(_signal(ctx, art, s, r, scope))
    # 2. Seeds: each account's own reference articles, only when they rise.
    for p in ctx.profiles:
        for art in p.get("wiki_seeds", []):
            if art in done:
                continue
            done.add(art)
            h = history(ctx, art, cfg["history_days"])
            if h is None:
                ctx.note(NAME, f"seed article {art} has no page-view history (renamed?)")
                continue
            r = ratio_from(h)
            if r and r[0] >= cfg["min_ratio_seed"] and r[2] >= 20:
                out.append(_signal(ctx, art, summary(ctx, art), r, [p["key"]]))
    return out
