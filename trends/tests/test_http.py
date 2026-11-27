import io
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone

from trends.http import Http, HttpError, Quota, QuotaExceeded, redact, MAX_BYTES


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def err(code, headers=None):
    return urllib.error.HTTPError("https://x.test/a?key=SECRET1", code, "x", headers or {}, None)


class Opener:
    def __init__(self, *results):
        self.results, self.calls = list(results), []

    def __call__(self, req, timeout):
        self.calls.append(req.full_url)
        r = self.results.pop(0)
        if isinstance(r, BaseException):
            raise r
        return Resp(r)


class HttpTest(unittest.TestCase):
    def make(self, *results, cache=None):
        self.slept = []
        o = Opener(*results)
        return Http(cache_dir=cache, opener=o, sleep=self.slept.append, clock=lambda: 0.0), o

    def test_retries_503_then_succeeds(self):
        h, o = self.make(err(503), b"ok")
        self.assertEqual(h.get("https://x.test/a", ttl=0), "ok")
        self.assertEqual(len(o.calls), 2)
        self.assertIn(2, self.slept)

    def test_honours_retry_after_but_caps_it(self):
        h, _ = self.make(err(429, {"Retry-After": "999"}), b"ok")
        h.get("https://x.test/a", ttl=0)
        self.assertIn(30, self.slept)

    def test_404_is_not_retried(self):
        h, o = self.make(err(404))
        with self.assertRaises(HttpError) as cm:
            h.get("https://x.test/a", ttl=0)
        self.assertEqual(cm.exception.status, 404)
        self.assertEqual(len(o.calls), 1)

    def test_gives_up_after_three(self):
        h, o = self.make(err(500), err(502), err(503))
        with self.assertRaises(HttpError):
            h.get("https://x.test/a", ttl=0)
        self.assertEqual(len(o.calls), 3)

    def test_network_error_retried(self):
        h, o = self.make(urllib.error.URLError("down"), b"ok")
        self.assertEqual(h.get("https://x.test/a", ttl=0), "ok")

    def test_cache_hit_skips_network(self):
        with tempfile.TemporaryDirectory() as d:
            h, o = self.make(b'{"a": 1}', cache=d)
            self.assertEqual(h.get("https://x.test/j?key=SECRET2", as_json=True), {"a": 1})
            self.assertTrue(h.is_cached("https://x.test/j?key=SECRET2", 3600))
            self.assertEqual(h.get("https://x.test/j?key=SECRET2", as_json=True), {"a": 1})
            self.assertEqual(len(o.calls), 1)
            import os
            for f in os.listdir(d):          # cache file names never carry the key
                self.assertNotIn("SECRET2", f)

    def test_too_large_refused(self):
        h, _ = self.make(b"x" * (MAX_BYTES + 1))
        with self.assertRaises(HttpError):
            h.get("https://x.test/a", ttl=0)

    def test_redaction(self):
        self.assertEqual(redact("https://a/b?q=1&key=abc&x=2"), "https://a/b?q=1&key=REDACTED&x=2")
        self.assertEqual(redact("https://a/b?token=t#f"), "https://a/b?token=REDACTED#f")
        h, _ = self.make(err(403))
        with self.assertRaises(HttpError) as cm:
            h.get("https://x.test/a?part=s&key=SECRET3", ttl=0)
        self.assertNotIn("SECRET3", str(cm.exception))


class QuotaTest(unittest.TestCase):
    def test_cap_and_ledger(self):
        st = {}
        now = datetime(2026, 11, 27, tzinfo=timezone.utc)
        q = Quota(st, "youtube", 250, now)
        q.spend(100)
        q.spend(100)
        with self.assertRaises(QuotaExceeded):
            q.spend(100)
        self.assertEqual(q.used, 200)
        self.assertEqual(Quota(st, "youtube", 250, now).used, 200)       # survives in the state

    def test_keeps_a_week(self):
        st = {"quota": {"youtube": {f"2026-11-{d:02d}": 5 for d in range(1, 27)}}}
        Quota(st, "youtube", 100, datetime(2026, 11, 27, tzinfo=timezone.utc))
        self.assertEqual(sorted(st["quota"]["youtube"]), [f"2026-11-{d}" for d in range(20, 27)])


if __name__ == "__main__":
    unittest.main()
