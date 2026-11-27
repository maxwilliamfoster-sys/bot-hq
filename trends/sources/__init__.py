"""Source adapters. Each module has NAME and run(ctx) -> list of signal dicts.

A signal carries what the API stores (source, source_type, url, title, published_at, fetched_at, metric, value)
plus collector-only fields starting with "_" (trend name, geo, the accounts whose query found it, 0..1 hints for
the score). Adding a source = a new module here with NAME and run(), listed in REGISTRY. A failing source never
stops the others (collect.py records it as failed and carries on).
"""
import math
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


class Skipped(Exception):
    """The source can't run (no key, nothing configured). Not a failure."""


def clamp01(v):
    return max(0.0, min(1.0, float(v)))


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_time(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def host(url):
    h = urllib.parse.urlsplit(url or "").netloc.lower()
    return h[4:] if h.startswith("www.") else h


def blocked(url, domains):
    h = host(url)
    return any(h == d or h.endswith("." + d) for d in domains)


def http_url(u):
    return isinstance(u, str) and u.startswith(("https://", "http://")) and len(u) <= 1000


def log_momentum(n, full=100_000):
    """0..1 on a log scale: 100 -> 0.4, 1,000 -> 0.6, 100,000+ -> 1."""
    return clamp01(math.log10(max(n, 1)) / math.log10(full)) if n else 0.0


def safe_xml(text):
    """Parse a feed. No feed needs a DOCTYPE, so any document with one (entity tricks like billion laughs or
    external entities) is refused before parsing. The HTTP layer already caps the size."""
    if "<!DOCTYPE" in text[:4096].upper() or "<!ENTITY" in text.upper():
        raise ValueError("feed has a DOCTYPE or ENTITY declaration; refused")
    return ET.fromstring(text)


def parse_feed(text):
    """RSS 2.0 or Atom -> [{title, link, published, source_url, source_name, el}]"""
    root = safe_xml(text)
    out = []
    atom = "{http://www.w3.org/2005/Atom}"
    for it in root.iter("item"):
        src = it.find("source")
        out.append({"title": (it.findtext("title") or "").strip(), "link": (it.findtext("link") or "").strip(),
                    "published": parse_time(it.findtext("pubDate")), "source_url": src.get("url") if src is not None else None,
                    "source_name": (src.text or "").strip() if src is not None else None, "el": it})
    for it in root.iter(f"{atom}entry"):
        link = it.find(f"{atom}link")
        out.append({"title": (it.findtext(f"{atom}title") or "").strip(), "link": link.get("href") if link is not None else "",
                    "published": parse_time(it.findtext(f"{atom}published") or it.findtext(f"{atom}updated")),
                    "source_url": None, "source_name": None, "el": it})
    return out


def REGISTRY():
    from . import google_trends, wikipedia, news, youtube, radar, competitors
    return [google_trends, wikipedia, news, youtube, radar, competitors]
