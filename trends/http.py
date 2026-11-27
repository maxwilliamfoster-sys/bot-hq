"""HTTP for the collector: on-disk cache, retries with backoff, a polite gap per host, and a daily quota ledger.

Only the standard library. Secrets (an API key in a query string) never reach a log line, an error message or a
cache file name: URLs are redacted before they are printed, and cache files are named by a hash.
"""
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UA = "bot-hq-trends/1.0 (personal non-commercial research)"
TIMEOUT = 20
RETRIES = 3
MAX_WAIT = 30          # never sleep longer than this for a Retry-After
HOST_GAP = 0.5         # seconds between two requests to the same host
MAX_BYTES = 5_000_000  # refuse a response bigger than this


class HttpError(Exception):
    def __init__(self, status, url):
        super().__init__(f"HTTP {status} for {redact(url)}")
        self.status = status


class QuotaExceeded(Exception):
    pass


_SECRET = re.compile(r"(?i)([?&](?:key|api_key|apikey|token|access_token)=)[^&#]*")


def redact(url):
    return _SECRET.sub(r"\1REDACTED", str(url))


class Http:
    def __init__(self, cache_dir=None, opener=None, sleep=time.sleep, clock=time.monotonic):
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.opener = opener or urllib.request.urlopen
        self.sleep = sleep
        self.clock = clock
        self._last = {}
        self.requests = 0

    def _cache_path(self, url):
        return self.cache_dir / (hashlib.sha256(url.encode()).hexdigest()[:32] + ".cache") if self.cache_dir else None

    def is_cached(self, url, ttl):
        path = self._cache_path(url)
        return bool(path and ttl and path.exists() and time.time() - path.stat().st_mtime < ttl)

    def get(self, url, ttl=6 * 3600, as_json=False, headers=None):
        path = self._cache_path(url)
        if path and ttl and path.exists() and time.time() - path.stat().st_mtime < ttl:
            text = path.read_text(encoding="utf-8")
        else:
            text = self._fetch(url, headers or {})
            if path:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
        return json.loads(text) if as_json else text

    def _polite(self, url):
        host = urllib.parse.urlsplit(url).netloc
        wait = HOST_GAP - (self.clock() - self._last.get(host, -1e9))
        if wait > 0:
            self.sleep(wait)
        self._last[host] = self.clock()

    def _fetch(self, url, headers):
        last = None
        for attempt in range(RETRIES):
            self._polite(url)
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity", **headers})
            try:
                self.requests += 1
                with self.opener(req, timeout=TIMEOUT) as r:
                    body = r.read(MAX_BYTES + 1)
                    if len(body) > MAX_BYTES:
                        raise HttpError("too_large", url)
                    return body.decode("utf-8", errors="replace")
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    last = HttpError(e.code, url)
                    retry_after = e.headers.get("Retry-After") if e.headers else None
                    delay = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** (attempt + 1)
                    if attempt < RETRIES - 1:
                        self.sleep(min(delay, MAX_WAIT))
                    continue
                raise HttpError(e.code, url) from None       # 4xx: retrying won't help
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = HttpError(type(e).__name__, url)
                if attempt < RETRIES - 1:
                    self.sleep(2 ** (attempt + 1))
        raise last or HttpError("no_attempt", url)


class Quota:
    """Units spent per source per UTC day, kept in the collector state. Spending past the cap raises first."""

    def __init__(self, state, source, cap, now=None):
        self.state, self.source, self.cap = state, source, cap
        self.day = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
        ledger = state.setdefault("quota", {}).setdefault(source, {})
        for d in sorted(d for d in ledger if d < self.day)[:-7]:      # keep a week of history
            ledger.pop(d, None)
        self.ledger = ledger

    @property
    def used(self):
        return self.ledger.get(self.day, 0)

    def spend(self, units):
        if self.used + units > self.cap:
            raise QuotaExceeded(f"{self.source}: {self.used}+{units} would pass the daily cap of {self.cap}")
        self.ledger[self.day] = self.used + units
