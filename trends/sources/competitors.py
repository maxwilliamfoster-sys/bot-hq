"""Competitors' recent YouTube videos (the autopilot watchlist, read from Bot HQ), as performance evidence.

The watchlist comes from GET /api/trends/context (bot credential; public channel links only). Each channel's
public upload feed (youtube.com/feeds/videos.xml, free, no key) lists its last 15 videos with view counts. A
video is a signal when it's under 14 days old and well above that channel's own median. Like every video, it
only ever supports a topic; it is never a topic by itself.

@handle links need one channels.list call (1 quota unit, with the free key) to find the channel id, cached for
good in the state. TikTok and Instagram competitors stay manual: neither has a free official feed.
"""
import re
import statistics
import urllib.parse
from datetime import timedelta

from . import Skipped, clamp01, iso, parse_time, safe_xml
from ..http import HttpError, Quota, QuotaExceeded

NAME = "youtube_competitors"
ATOM = "{http://www.w3.org/2005/Atom}"
YT = "{http://www.youtube.com/xml/schemas/2015}"
MEDIA = "{http://search.yahoo.com/mrss/}"
CHANNEL_RE = re.compile(r"youtube\.com/channel/(UC[\w-]{22})")
HANDLE_RE = re.compile(r"youtube\.com/(@[\w.-]{1,100})")
MAX_AGE_DAYS = 14
MIN_RATIO = 2.0


def parse_feed(text, channel, account, now):
    root = safe_xml(text)
    rows = []
    for e in root.iter(f"{ATOM}entry"):
        vid = e.findtext(f"{YT}videoId")
        pub = parse_time(e.findtext(f"{ATOM}published"))
        stats = e.find(f"{MEDIA}group/{MEDIA}community/{MEDIA}statistics")
        views = stats.get("views") if stats is not None else None
        if vid and pub and views and views.isdigit():
            rows.append((vid, (e.findtext(f"{ATOM}title") or "").strip(), pub, int(views)))
    if len(rows) < 5:
        return []
    typical = statistics.median(r[3] for r in rows) or 1
    out = []
    for vid, title, pub, views in rows:
        ratio = views / typical
        if not title or ratio < MIN_RATIO or now - pub > timedelta(days=MAX_AGE_DAYS):
            continue
        out.append({
            "name": title[:200], "source": NAME, "source_type": "video",
            "url": f"https://www.youtube.com/watch?v={vid}", "title": f"{title} ({channel}, competitor)"[:300],
            "published_at": iso(pub), "fetched_at": iso(now), "metric": "views_vs_channel_median", "value": round(ratio, 2),
            "_geo": None, "_for": [account], "_attach_only": True, "_performance": clamp01((ratio - 1) / 3),
            "_raw_ratio": round(ratio, 2),
        })
    return out


def channel_id(ctx, url, key, quota):
    m = CHANNEL_RE.search(url)
    if m:
        return m.group(1)
    h = HANDLE_RE.search(url)
    if not h:
        return None
    ids = ctx.state.setdefault("yt_channel_ids", {})
    handle = h.group(1).lower()
    if handle in ids:
        return ids[handle]
    if not key:
        return None
    quota.spend(1)
    data = ctx.http.get("https://www.googleapis.com/youtube/v3/channels?" + urllib.parse.urlencode(
        {"part": "id", "forHandle": handle, "key": key}), ttl=30 * 86400, as_json=True)
    cid = (data.get("items") or [{}])[0].get("id")
    ids[handle] = cid if isinstance(cid, str) and cid.startswith("UC") else None
    return ids[handle]


def run(ctx):
    app, token = ctx.env.get("APP_URL"), ctx.env.get("APP_EVENTS_TOKEN")
    if not app or not token:
        raise Skipped("needs APP_URL and APP_EVENTS_TOKEN to read the competitor watchlist from Bot HQ")
    key = ctx.env.get("YT_TREND_API_KEY")
    cap = int(ctx.env.get("YT_TREND_DAILY_CAP") or ctx.config["youtube"]["daily_cap_units"])
    quota = Quota(ctx.state, "youtube", cap, ctx.now)          # the same ledger as the YouTube search source
    watch = ctx.http.get(app.rstrip("/") + "/api/trends/context", ttl=6 * 3600, as_json=True,
                         headers={"Authorization": f"Bearer {token}"}).get("accounts", {})
    active = {p["key"] for p in ctx.profiles}
    out, unresolved, failed = [], 0, 0
    for account, chans in watch.items():
        if account not in active or not isinstance(chans, list):
            continue
        for c in chans[:6]:
            url = str(c.get("url") or "")
            try:
                cid = channel_id(ctx, url, key, quota)
            except QuotaExceeded as e:
                ctx.note(NAME, str(e))
                cid = None
            if not cid:
                unresolved += 1
                continue
            try:
                feed = ctx.http.get(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}", ttl=6 * 3600)
                out += parse_feed(feed, str(c.get("channel") or cid)[:80], account, ctx.now)
            except (HttpError, ValueError) as e:
                failed += 1
                ctx.note(NAME, f"{cid}: {type(e).__name__}")
    if unresolved:
        ctx.note(NAME, f"{unresolved} @handle channel(s) need the free YouTube key once to find their channel id")
    return out
