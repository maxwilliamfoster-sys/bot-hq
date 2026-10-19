"""Backfill parsers on trimmed real files from the bots. Offline.

    py -m unittest ingest.test_backfill -v      (from the bot-hq folder)
"""
import json
import os
import unittest

from ingest import backfill as bf

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fx(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return json.load(f) if name.endswith(".json") else f.read()


class TestIso(unittest.TestCase):
    def test_every_time_format_becomes_js_iso(self):
        self.assertEqual(bf.iso("2026-09-07T19:35:43.837260+00:00"), "2026-09-07T19:35:43.837Z")
        self.assertEqual(bf.iso("2026-10-09T17:55"), "2026-10-09T17:55:00.000Z")
        self.assertEqual(bf.iso("2026-10-15T20:30+00:00"), "2026-10-15T20:30:00.000Z")
        self.assertEqual(bf.iso("2026-08-28T13:47:48Z"), "2026-08-28T13:47:48.000Z")
        self.assertEqual(bf.iso("2026-10-20T00:30:00+01:00"), "2026-10-19T23:30:00.000Z")
        self.assertIsNone(bf.iso(""))
        self.assertIsNone(bf.iso(None))


class TestChess(unittest.TestCase):
    def setUp(self):
        self.out = bf.parse_chess(fx("chess_performance_history.json"), fx("chess_view_snapshots.json"))

    def test_posts(self):
        posts = {p["id"]: p for p in self.out["posts"]}
        self.assertEqual(len(posts), 2)
        new = posts["chess:YkkI7LMCkNg"]
        self.assertEqual(new["slot"], "15:00")                      # 14:00Z in BST
        self.assertEqual(new["format"], "v1-countdown")
        self.assertEqual(new["variant"], "chess-exp.choice-1=control,chess-exp.motion-1=control")
        self.assertEqual(new["posted_at"], "2026-10-19T16:41:39.829Z")
        self.assertEqual(new["platform"], "youtube")
        self.assertEqual(new["url"], "https://youtube.com/shorts/YkkI7LMCkNg")
        self.assertEqual(new["length_s"], 16.9)
        old = posts["chess:N7IA3y6RGcI"]
        self.assertIsNone(old["slot"])
        self.assertEqual(old["title"], "Mate in 2 — can you see it?")

    def test_snapshots_from_points_and_observed(self):
        snaps = self.out["snapshots"]
        self.assertEqual(len(snaps), 5)
        self.assertTrue(all(s["post_id"] == "chess:N7IA3y6RGcI" for s in snaps))
        last = max(snaps, key=lambda s: s["at"])
        self.assertEqual(last, {"post_id": "chess:N7IA3y6RGcI", "at": "2026-10-19T16:41:45.524Z",
                                "views": 1087, "likes": 4, "avg_watch_s": 14})

    def test_account(self):
        self.assertEqual(self.out["account"][0], {"bot": "chess", "at": "2026-10-16T00:47:08.029Z", "followers": 33})


class TestBcf(unittest.TestCase):
    def setUp(self):
        self.out = bf.parse_bcf(fx("bcf_posts_log.csv"), fx("bcf_buffer_metrics.csv"), fx("bcf_account.csv"))

    def test_posts_keyed_by_tiktok_id(self):
        p = self.out["posts"][0]
        self.assertEqual(p["id"], "bcf:7694727875798306080")
        self.assertEqual(p["external_id"], "7694727875798306080")
        self.assertEqual(p["platform"], "tiktok")
        self.assertEqual(p["title"], "Death of Keith Lyon")
        self.assertEqual(p["posted_at"], "2026-10-09T17:55:00.000Z")
        self.assertEqual(p["format"], "v2-energetic")
        self.assertEqual(p["length_s"], 37.8)
        self.assertEqual(len(self.out["posts"]), 2)

    def test_metrics_map_reactions_to_likes(self):
        self.assertEqual(len(self.out["snapshots"]), 4)
        s = self.out["snapshots"][0]
        self.assertEqual(s, {"post_id": "bcf:7694761939821464864", "at": "2026-10-13T11:07:00.000Z", "views": 805,
                             "likes": 28, "comments": 1, "shares": 0, "reach": 749, "avg_watch_s": 17.82})

    def test_account(self):
        self.assertEqual(self.out["account"][1],
                         {"bot": "bcf", "at": "2026-10-16T00:32:00.000Z", "followers": 350, "likes": 1575, "videos": 78})


class TestEscape(unittest.TestCase):
    def setUp(self):
        self.out = bf.parse_escape(fx("escape_tournament_state.json"), fx("escape_analytics.json"))

    def test_posts_from_analytics_and_state_log(self):
        posts = {p["external_id"]: p for p in self.out["posts"]}
        self.assertEqual(len(posts), 3)                              # scheduled entry excluded
        self.assertEqual(posts["6ace8429212d8766037262bf"]["variant"], "royale")
        self.assertEqual(posts["6abc2b89bc79f7218889713e"]["variant"], "cup")
        self.assertEqual(posts["6abc2e6fbc79f7218889ccd2"]["variant"], "cup")      # state log only
        self.assertEqual(posts["6abc2e6fbc79f7218889ccd2"]["title"], "pl v uy")
        self.assertEqual(posts["6abc2e6fbc79f7218889ccd2"]["posted_at"], "2026-09-30T18:30:00.000Z")
        roy = posts["6ace8429212d8766037262bf"]
        self.assertEqual(roy["id"], "escape:6ace8429212d8766037262bf")
        self.assertNotIn("?", roy["url"])
        self.assertTrue(roy["url"].endswith("/video/7696546539182886177"))
        self.assertEqual(roy["format"], "v2")

    def test_snapshots_and_account(self):
        self.assertEqual(len(self.out["snapshots"]), 4)
        s = [x for x in self.out["snapshots"] if x["post_id"] == "escape:6ace8429212d8766037262bf"][0]
        self.assertEqual(s["at"], "2026-10-15T12:52:00.000Z")
        self.assertIn("likes", s)
        self.assertEqual(len(self.out["account"]), 2)
        self.assertEqual(self.out["account"][0]["followers"], 18)


class TestGate(unittest.TestCase):
    def test_ai_used_only_when_available_is_true(self):
        rows = bf.parse_gate("escape", fx("escape_upload_gate_log.json"))
        self.assertEqual([(r["ok"], r["ai_used"]) for r in rows], [(1, 0), (0, 0), (1, 1)])
        self.assertEqual(rows[0], {"bot": "escape", "at": "2026-10-16T11:22:35.000Z", "ok": 1, "ai_used": 0})


class TestBatches(unittest.TestCase):
    def test_batches_keep_table_order_and_size(self):
        payload = {"posts": [{"i": i} for i in range(3)], "snapshots": [{"i": i} for i in range(5)],
                   "account": [], "gate": [{"i": 0}]}
        out = list(bf.batches(payload, 4))
        self.assertEqual([{k: len(v) for k, v in b.items()} for b in out],
                         [{"posts": 3, "snapshots": 1}, {"snapshots": 4}, {"gate": 1}])


if __name__ == "__main__":
    unittest.main()
