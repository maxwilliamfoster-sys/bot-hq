"""Phase 6: what the collector remembers between runs, the shared YouTube quota, and Bot HQ being down."""
import json
import tempfile
import unittest
import urllib.error
from datetime import timedelta
from pathlib import Path

from trends import collect, state as state_mod
from trends.http import Quota, QuotaExceeded
from trends.tests.test_collector import NOW, FakeHttp, Fine, sig


class StateFileTest(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "s" / "state.json"

    def test_round_trip(self):
        st = {"version": state_mod.VERSION, "quota": {"youtube": {"2026-11-27": 303}}, "days": {"jwst": ["2026-11-26"]}}
        state_mod.save(self.path, st)
        self.assertEqual(state_mod.load(self.path), st)
        self.assertFalse(self.path.with_suffix(".tmp").exists())     # written atomically, no half file left

    def test_missing_corrupt_or_old_state_starts_fresh(self):
        fresh = {"version": state_mod.VERSION}
        self.assertEqual(state_mod.load(self.path), fresh)
        self.path.parent.mkdir(parents=True)
        for text in ["{not json", "[1, 2]", json.dumps({"version": 0, "quota": {"youtube": {"2026-11-27": 1}}})]:
            self.path.write_text(text, encoding="utf-8")
            self.assertEqual(state_mod.load(self.path), fresh, text)


def spender(name, units, cap=150):
    """A source that spends YouTube units from the shared ledger, like youtube / competitors / competition do."""

    class Spender:
        NAME = name

        @staticmethod
        def run(ctx):
            try:
                Quota(ctx.state, "youtube", cap, ctx.now).spend(units)
            except QuotaExceeded:
                ctx.status_override[name] = "quota_capped"
                return []
            return [sig("New nebula image from Hubble telescope", "news", _for=["space"])]

    return Spender


class RunsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.state = Path(self.dir) / "s.json"

    def run_main(self, modules, now=NOW, argv=(), env=None, opener=None):
        code = collect.main(list(argv), env=env or {}, http=FakeHttp({}), modules=modules, now=now, out_dir=self.dir,
                            state_path=self.state, **({"opener": opener} if opener else {}))
        rep = json.loads((Path(self.dir) / "report.json").read_text(encoding="utf-8"))
        return code, rep

    def ledger(self):
        return state_mod.load(self.state)["quota"]["youtube"]

    def test_sources_share_one_daily_quota_and_never_pass_the_cap(self):
        _, rep = self.run_main([spender("a", 100), spender("b", 100)])
        self.assertEqual(rep["sources"]["a"]["status"], "ok")
        self.assertEqual(rep["sources"]["b"]["status"], "quota_capped")
        self.assertEqual(self.ledger()[NOW.strftime("%Y-%m-%d")], 100)

    def test_quota_spent_earlier_today_still_counts_in_the_next_run(self):
        self.run_main([spender("a", 100)])
        _, rep = self.run_main([spender("a", 100)])
        self.assertEqual(rep["sources"]["a"]["status"], "quota_capped")
        self.assertEqual(self.ledger()[NOW.strftime("%Y-%m-%d")], 100)

    def test_the_cap_resets_the_next_day_and_old_days_are_dropped_after_a_week(self):
        self.run_main([spender("a", 100)])
        _, rep = self.run_main([spender("a", 100)], now=NOW + timedelta(days=1))
        self.assertEqual(rep["sources"]["a"]["status"], "ok")
        for d in range(2, 12):
            self.run_main([spender("a", 100)], now=NOW + timedelta(days=d))
        self.assertLessEqual(len(self.ledger()), 8)
        self.assertNotIn(NOW.strftime("%Y-%m-%d"), self.ledger())

    def test_bot_hq_down_fails_the_run_without_leaking_the_token_and_keeps_the_state(self):
        def down(req, timeout):
            raise urllib.error.URLError("connection refused for Bearer TOK")

        code, rep = self.run_main([Fine, spender("a", 100)], argv=["--post"], opener=down,
                                  env={"APP_URL": "https://x.test", "APP_EVENTS_TOKEN": "TOK"})
        self.assertEqual(code, 1)
        self.assertFalse(rep["posted"])
        self.assertIn("URLError", rep["post"]["error"])
        self.assertNotIn("TOK", json.dumps(rep) + (Path(self.dir) / "report.md").read_text(encoding="utf-8"))
        self.assertEqual(self.ledger()[NOW.strftime("%Y-%m-%d")], 100)

    def test_a_failing_source_never_puts_a_key_in_the_report(self):
        class Leaky:
            NAME = "leaky"

            @staticmethod
            def run(ctx):
                ctx.note("leaky", "retrying with SECRETKEY123")
                raise RuntimeError("bad answer for SECRETKEY123 (Authorization: Bearer TOK123)")

        code, rep = self.run_main([Leaky, Fine], env={"YT_TREND_API_KEY": "SECRETKEY123", "APP_EVENTS_TOKEN": "TOK123"})
        self.assertEqual(rep["sources"]["leaky"]["status"], "failed")
        text = json.dumps(rep) + (Path(self.dir) / "report.md").read_text(encoding="utf-8")
        self.assertNotIn("SECRETKEY123", text)
        self.assertNotIn("TOK123", text)


if __name__ == "__main__":
    unittest.main()
