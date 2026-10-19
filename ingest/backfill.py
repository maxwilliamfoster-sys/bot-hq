"""Nightly backfill: read the history the bots already commit and send it to Bot HQ.

Read-only on the bot repos (GitHub contents API with GH_READ_TOKEN). Sends rows to
$APP_URL/api/ingest with APP_EVENTS_TOKEN. Safe to re-run: the app ignores rows it has.

    py -m ingest.backfill            (env: GH_READ_TOKEN, APP_URL, APP_EVENTS_TOKEN)
"""
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

OWNER = "maxwilliamfoster-sys"
UK = ZoneInfo("Europe/London")
BATCH = 200      # rows per request: small enough for the free Worker's CPU budget


def iso(s):
    """Any time string the bots write -> JS toISOString form (UTC, milliseconds, Z)."""
    if not s:
        return None
    d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    d = d.astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def _num(v, cast=float):
    if v is None or v == "":
        return None
    try:
        return cast(float(v)) if cast is int else cast(v)
    except (TypeError, ValueError):
        return None


def _post(bot, external_id, **fields):
    row = {"id": f"{bot}:{external_id}", "bot": bot, "external_id": str(external_id),
           "platform": "youtube" if bot == "chess" else "tiktok"}
    for k in ("title", "posted_at", "slot", "format", "variant", "length_s", "url"):
        row[k] = fields.get(k)
    return row


def _clean_link(link):
    return link.split("?")[0] if link else None


def parse_chess(history, snaps):
    posts, snapshots, account = [], [], []
    for vid, p in (history.get("posts") or {}).items():
        slot = p.get("slot")
        arms = p.get("loop") or {}
        posts.append(_post(
            "chess", vid, title=p.get("title"), posted_at=iso(p.get("posted_at")),
            slot=datetime.fromisoformat(slot).astimezone(UK).strftime("%H:%M") if slot else None,
            format=p.get("format"),
            variant=",".join(f"{k}={arms[k]}" for k in sorted(arms)) or None,
            length_s=p.get("actual_seconds"), url=f"https://youtube.com/shorts/{vid}"))
    for vid, v in (snaps.get("videos") or {}).items():
        for at, views in v.get("points") or []:
            snapshots.append({"post_id": f"chess:{vid}", "at": iso(at), "views": _num(views, int)})
    for vid, o in (history.get("observed") or {}).items():
        if o.get("fetched_at") and o.get("views") is not None:
            snapshots.append({"post_id": f"chess:{vid}", "at": iso(o["fetched_at"]), "views": _num(o["views"], int),
                              "likes": _num(o.get("likes"), int), "avg_watch_s": o.get("avg_view_seconds")})
    for at, subs in snaps.get("channel") or []:
        account.append({"bot": "chess", "at": iso(at), "followers": _num(subs, int)})
    return {"posts": posts, "snapshots": snapshots, "account": account}


def _rows(text):
    return list(csv.DictReader(io.StringIO(text or "")))


def parse_bcf(posts_log, metrics, account_csv):
    posts = [_post("bcf", r["video_id"], title=r.get("case") or None, posted_at=iso(r.get("posted_utc")),
                   format=r.get("format") or None, length_s=_num(r.get("duration_s")))
             for r in _rows(posts_log) if r.get("video_id")]
    snapshots = [{"post_id": f"bcf:{r['video_id']}", "at": iso(r["snapshot_utc"]), "views": _num(r.get("views"), int),
                  "likes": _num(r.get("reactions"), int), "comments": _num(r.get("comments"), int),
                  "shares": _num(r.get("shares"), int), "reach": _num(r.get("reach"), int),
                  "avg_watch_s": _num(r.get("averageTimeWatched"))}
                 for r in _rows(metrics) if r.get("video_id") and r.get("snapshot_utc")]
    account = [{"bot": "bcf", "at": iso(r["snapshot_utc"]), "followers": _num(r.get("followers"), int),
                "likes": _num(r.get("likes_total"), int), "videos": _num(r.get("videos"), int)}
               for r in _rows(account_csv) if r.get("snapshot_utc")]
    return {"posts": posts, "snapshots": snapshots, "account": account}


def parse_escape(state, analytics):
    posts, snapshots = {}, []
    for bid, p in (analytics.get("posts") or {}).items():
        posts[bid] = _post("escape", bid, title=(p.get("caption") or p.get("match") or "").split("\n")[0][:120] or None,
                           posted_at=iso(p.get("due")), format=p.get("format"),
                           variant=p.get("variant") or "cup", length_s=p.get("length"), url=_clean_link(p.get("link")))
        for s in p.get("snapshots") or []:
            snapshots.append({"post_id": f"escape:{bid}", "at": iso(s.get("at")), "views": _num(s.get("views"), int),
                              "likes": _num(s.get("likes", s.get("reactions")), int),
                              "comments": _num(s.get("comments"), int), "shares": _num(s.get("shares"), int),
                              "reach": _num(s.get("reach"), int), "avg_watch_s": s.get("averageTimeWatched")})
    for e in state.get("log") or []:
        bid = e.get("buffer_id")
        if not bid or e.get("status") != "published" or bid in posts:
            continue
        royale = e.get("series") == "royale"
        posts[bid] = _post("escape", bid, title=f"royale {e.get('heat')}" if royale else f"{e.get('a')} v {e.get('b')}",
                           posted_at=iso(e.get("due")), variant="royale" if royale else "cup",
                           length_s=e.get("length"), url=_clean_link(e.get("link")))
    account = [{"bot": "escape", "at": iso(a.get("at")), "followers": a.get("followers"), "likes": a.get("likes"),
                "videos": a.get("videos")} for a in analytics.get("account") or [] if a.get("at")]
    return {"posts": list(posts.values()), "snapshots": [s for s in snapshots if s["at"]], "account": account}


def parse_gate(bot, log):
    return [{"bot": bot, "at": iso(e["checked_at"]), "ok": 1 if e.get("ok") else 0,
             "ai_used": 1 if (e.get("ai") or {}).get("available") is True else 0}
            for e in (log or {}).get("entries") or [] if e.get("checked_at")]


def batches(payload, size=BATCH):
    """Split {table: rows} into requests of <= size rows, keeping table order."""
    cur, n = {}, 0
    for table in ("posts", "snapshots", "account", "gate"):
        for row in payload.get(table) or []:
            cur.setdefault(table, []).append(row)
            n += 1
            if n == size:
                yield cur
                cur, n = {}, 0
    if cur:
        yield cur


# ---- I/O (not unit-tested: thin wrappers over HTTP) ----

def _get(repo, path):
    req = urllib.request.Request(f"https://api.github.com/repos/{OWNER}/{repo}/contents/{path}", headers={
        "Authorization": f"Bearer {os.environ['GH_READ_TOKEN']}", "Accept": "application/vnd.github.raw",
        "User-Agent": "bot-hq-backfill", "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"[backfill] {repo}/{path}: not found, skipped")
            return None
        raise


def _json(repo, path):
    text = _get(repo, path)
    return json.loads(text) if text else {}


def collect():
    out = {"posts": [], "snapshots": [], "account": [], "gate": []}

    def add(part):
        for k, v in part.items():
            out[k].extend(v)

    add(parse_chess(_json("chess-puzzle-automation", "performance_history.json"),
                    _json("chess-puzzle-automation", "view_snapshots.json")))
    add(parse_bcf(_get("youtube-automation", "analytics/posts_log.csv"),
                  _get("youtube-automation", "analytics/buffer_metrics.csv"),
                  _get("youtube-automation", "analytics/account.csv")))
    add(parse_escape(_json("escape-cup", "tournament_state.json"), _json("escape-cup", "analytics.json")))
    for bot, repo in (("chess", "chess-puzzle-automation"), ("bcf", "youtube-automation"), ("escape", "escape-cup")):
        add({"gate": parse_gate(bot, _json(repo, "upload_gate_log.json"))})
    return out


def send(payload):
    url = os.environ["APP_URL"].rstrip("/") + "/api/ingest"
    totals = {"posts": 0, "snapshots": 0, "account": 0, "gate": 0}
    waiting = 0
    for b in batches(payload):
        req = urllib.request.Request(url, data=json.dumps(b).encode(), method="POST", headers={
            "Authorization": f"Bearer {os.environ['APP_EVENTS_TOKEN']}", "Content-Type": "application/json",
            "User-Agent": "bot-hq-backfill"})
        with urllib.request.urlopen(req, timeout=60) as r:
            got = json.loads(r.read())
        for k in totals:
            totals[k] += got["inserted"].get(k, 0)
        waiting += (got.get("skipped") or {}).get("snapshots", 0)
    return totals, waiting


def main():
    for k in ("GH_READ_TOKEN", "APP_URL", "APP_EVENTS_TOKEN"):
        if not os.environ.get(k):
            sys.exit(f"[backfill] {k} is not set")
    payload = collect()
    print("[backfill] read:", {k: len(v) for k, v in payload.items()})
    totals, waiting = send(payload)
    print("[backfill] new rows in Bot HQ:", totals)
    print(f"[backfill] {waiting} snapshot rows wait for a post the app doesn't know yet (retried nightly)")


if __name__ == "__main__":
    main()
