import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from trends import candidates, collect, manual_links
from trends.http import HttpError
from trends.sources import Skipped, google_trends, news, radar, safe_xml, wikipedia, youtube
from trends.textmatch import load_profiles

FIX = Path(__file__).resolve().parent / "fixtures"
NOW = datetime(2026, 11, 27, 9, 0, tzinfo=timezone.utc)
PROFILES = load_profiles()
CONFIG = json.loads((Path(collect.__file__).parent / "sources.json").read_text(encoding="utf-8"))


def fx(name):
    return (FIX / name).read_text(encoding="utf-8")


class FakeHttp:
    """Answers URLs containing a route key; anything else is a 404."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def is_cached(self, url, ttl):
        return False

    def get(self, url, ttl=0, as_json=False, headers=None):
        self.calls.append(url)
        for k, v in self.routes.items():
            if k in url:
                if isinstance(v, Exception):
                    raise v
                text = v if isinstance(v, str) else json.dumps(v)
                return json.loads(text) if as_json else text
        raise HttpError(404, url)


def ctx(routes, env=None, profiles=PROFILES, state=None):
    return collect.Ctx(profiles, FakeHttp(routes), state if state is not None else {}, CONFIG, env or {}, NOW)


def sig(name, source_type="news", title=None, **kw):
    s = {"name": name, "source": kw.pop("source", "news_rss"), "source_type": source_type, "url": "https://example.org/a",
         "title": title or name, "published_at": "2026-11-27T06:00:00.000Z", "fetched_at": "2026-11-27T09:00:00.000Z",
         "metric": "article", "value": 1}
    s.update(kw)
    return s


class SourceTest(unittest.TestCase):
    def test_google_trends_fixture(self):
        out = google_trends.parse(fx("google_trends_gb.xml"), "GB", "2026-11-27T09:00:00.000Z")
        self.assertEqual(len(out), 6)
        for s in out:
            self.assertEqual(s["source_type"], "search")
            self.assertTrue(s["url"].startswith("https://"))
            self.assertLessEqual(len(s["title"]), 300)
        self.assertTrue(any(isinstance(s["value"], int) for s in out))

    def test_google_trends_counts_days(self):
        st = {}
        c = ctx({"trending/rss": fx("google_trends_gb.xml")}, profiles=[p for p in PROFILES if p["key"] == "escape"], state=st)
        google_trends.run(c)
        c.now = NOW.replace(day=28)
        out = google_trends.run(c)
        self.assertTrue(all(s["_days_seen"] == 2 for s in out))

    def test_xml_with_doctype_refused(self):
        bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>'
        with self.assertRaises(ValueError):
            safe_xml(bomb)

    def test_google_news_fixture(self):
        c = ctx({})
        from trends.sources import parse_feed
        out = news.items_to_signals(parse_feed(fx("google_news_jwst.xml")), c, "google_news_rss", "GB", ["space"], google=True)
        self.assertTrue(out)
        for s in out:
            self.assertNotIn(" - ", s["name"][-25:])            # publisher stripped from the headline
            self.assertGreaterEqual(s["published_at"], "2026-11-24")

    def test_news_drops_old_and_blocked(self):
        c = ctx({})
        items = [
            {"title": "Fresh", "link": "https://good.test/1", "published": NOW.replace(hour=1), "source_url": None, "source_name": None},
            {"title": "Old", "link": "https://good.test/2", "published": NOW.replace(day=1), "source_url": None, "source_name": None},
            {"title": "Blocked", "link": "https://x.test/3", "published": NOW.replace(hour=2),
             "source_url": "https://www." + CONFIG["blocked_domains"][0], "source_name": "b"},
        ]
        self.assertEqual([s["name"] for s in news.items_to_signals(items, c, "news_rss", "GB", ["space"])], ["Fresh"])

    def test_news_one_feed_failing_keeps_others(self):
        c = ctx({"bbci.co.uk": fx("bbc_science.xml"), "news.google.com": HttpError(503, "https://news.google.com")},
                profiles=[p for p in PROFILES if p["key"] == "space"])
        out = news.run(c)
        self.assertTrue(out)
        self.assertIn("some feeds failed", c.notes["news_rss"][0])

    def test_wikipedia_ratio(self):
        items = [{"timestamp": f"2026{i:04d}00", "views": 100} for i in range(30)] + \
                [{"timestamp": f"2026{30 + i:04d}00", "views": 300} for i in range(3)]
        r = wikipedia.ratio_from(items)
        self.assertAlmostEqual(r[0], 3.0)
        self.assertIsNone(wikipedia.ratio_from(items[:10]))

    def test_wikipedia_run_fixture(self):
        hist = json.loads(fx("wiki_history_jwst.json"))
        c = ctx({"top/en.wikipedia/all-access/2026/11/25": fx("wiki_top.json"),
                 "per-article/en.wikipedia/all-access/user/James_Webb_Space_Telescope": hist,
                 "page/summary/James_Webb_Space_Telescope": fx("wiki_summary_jwst.json")},
                profiles=[p for p in PROFILES if p["key"] == "space"])
        out = wikipedia.run(c)                  # every other article answers 404 and is skipped, not fatal
        r = wikipedia.ratio_from(hist["items"])
        jw = [s for s in out if s["name"] == "James Webb Space Telescope"]
        self.assertEqual(bool(jw), r[0] >= CONFIG["wikipedia"]["min_ratio_seed"] and r[2] >= 20)
        for s in out:
            self.assertEqual(s["source_type"], "wiki")

    def test_radar_fixture(self):
        out = radar.parse(json.loads(fx("radar_chess.json")), NOW)
        self.assertTrue(out)
        self.assertTrue(all(s["_attach_only"] and s["_for"] == ["chess"] for s in out))
        self.assertTrue(all(0 <= s["_performance"] <= 1 for s in out))

    def test_youtube_skipped_without_key(self):
        with self.assertRaises(Skipped):
            youtube.run(ctx({}))

    def test_youtube_outliers_and_quota(self):
        items = [{"id": {"videoId": f"v{i}"}} for i in range(6)]
        vids = [{"id": f"v{i}", "snippet": {"title": f"chess puzzle {i}", "channelTitle": "c",
                                            "publishedAt": "2026-11-26T09:00:00Z"},
                 "statistics": {"viewCount": str(1000 if i else 50000)}} for i in range(6)]
        st = {}
        chess = [p for p in PROFILES if p["key"] == "chess"]
        c = ctx({"/search?": {"items": items}, "/videos?": {"items": vids}}, env={"YT_TREND_API_KEY": "K"},
                profiles=chess, state=st)
        out = youtube.run(c)
        self.assertEqual([s["url"] for s in out], ["https://www.youtube.com/shorts/v0"])
        self.assertEqual(out[0]["metric"], "avg_views_per_hour_since_upload")
        self.assertEqual(st["quota"]["youtube"]["2026-11-27"], 3 * 101)
        for call in c.http.calls:
            self.assertIn("key=K", call)                      # the key goes to Google only...
        self.assertNotIn("K", json.dumps(out))              # ...never into a signal

    def test_youtube_quota_cap_stops_cleanly(self):
        c = ctx({"/search?": {"items": []}}, env={"YT_TREND_API_KEY": "K", "YT_TREND_DAILY_CAP": "150"},
                profiles=[p for p in PROFILES if p["key"] == "chess"])
        self.assertEqual(youtube.run(c), [])
        self.assertEqual(c.status_override.get("youtube"), "quota_capped")


def yt_feed(views, days_ago=1):
    entries = "".join(
        f'<entry><yt:videoId>v{i}</yt:videoId><title>Magnus Carlsen trick {i}</title>'
        f'<published>{(NOW.replace(day=27 - days_ago)).strftime("%Y-%m-%dT%H:%M:%S+00:00")}</published>'
        f'<media:group><media:community><media:statistics views="{v}"/></media:community></media:group></entry>'
        for i, v in enumerate(views))
    return ('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" '
            'xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">'
            f'{entries}</feed>')


class CompetitorTest(unittest.TestCase):
    ENV = {"APP_URL": "https://hq.test", "APP_EVENTS_TOKEN": "TOK", "YT_TREND_API_KEY": "K"}

    def test_feed_outliers_only(self):
        from trends.sources import competitors
        out = competitors.parse_feed(yt_feed([1000, 1100, 900, 1000, 5000]), "Rival", "chess", NOW)
        self.assertEqual([s["url"] for s in out], ["https://www.youtube.com/watch?v=v4"])
        self.assertTrue(out[0]["_attach_only"])
        self.assertEqual(out[0]["_for"], ["chess"])
        self.assertEqual(competitors.parse_feed(yt_feed([1000, 9000]), "R", "chess", NOW), [], "too few videos to judge")
        self.assertEqual(competitors.parse_feed(yt_feed([1000, 1100, 900, 1000, 5000], days_ago=20), "R", "chess", NOW), [])

    def test_skipped_without_bot_hq(self):
        from trends.sources import competitors
        with self.assertRaises(Skipped):
            competitors.run(ctx({}))

    def test_watchlist_handles_resolved_once_and_quota_counted(self):
        from trends.sources import competitors
        st = {}
        routes = {"/api/trends/context": {"accounts": {"chess": [{"channel": "Nerd", "url": "https://www.youtube.com/@thechessnerd"}],
                                                       "eagle": [{"channel": "X", "url": "https://www.youtube.com/@x"}]}},
                  "forHandle=%40thechessnerd": {"items": [{"id": "UC" + "a" * 22}]},
                  "feeds/videos.xml?channel_id=UC": yt_feed([1000, 1100, 900, 1000, 5000])}
        c = ctx(routes, env=self.ENV, state=st)
        out = competitors.run(c)
        self.assertEqual(len(out), 1)
        self.assertEqual(st["yt_channel_ids"]["@thechessnerd"], "UC" + "a" * 22)
        self.assertEqual(st["quota"]["youtube"]["2026-11-27"], 1)
        self.assertFalse(any("@x" in u for u in c.http.calls), "stopped accounts (eagle) are ignored")
        competitors.run(ctx(routes, env=self.ENV, state=st))
        self.assertEqual(st["quota"]["youtube"]["2026-11-27"], 1, "a known handle costs nothing")
        self.assertNotIn("TOK", json.dumps(out) + json.dumps(st))

    def test_handle_without_key_is_noted_not_fatal(self):
        from trends.sources import competitors
        c = ctx({"/api/trends/context": {"accounts": {"chess": [{"url": "https://www.youtube.com/@thechessnerd"}]}}},
                env={"APP_URL": "https://hq.test", "APP_EVENTS_TOKEN": "TOK"})
        self.assertEqual(competitors.run(c), [])
        self.assertIn("free YouTube key", " ".join(c.notes["youtube_competitors"]))

    def test_competition_from_recent_shorts(self):
        from trends import competition
        cands, _ = candidates.build([sig("New nebula image from Hubble telescope", "news")], PROFILES, NOW)
        c = ctx({"youtube/v3/search": {"items": [{}] * 10}}, env={"YT_TREND_API_KEY": "K"}, state={})
        r = competition.check(cands, c)
        self.assertEqual(r["checked"], 1)
        self.assertEqual(cands[0]["components"]["competition"], 0.8)
        self.assertEqual(cands[0]["snapshot"]["competitor_count"], 10)
        self.assertEqual(competition.check(cands, ctx({}))["status"], "skipped")


class CandidateTest(unittest.TestCase):
    def test_story_attaches_only_on_two_words(self):
        sigs = [sig("James Webb Space Telescope", "wiki", source="wikipedia", _momentum=0.5, _volume=20000),
                sig("James Webb telescope finds water on exoplanet", "news"),
                sig("chess", "search", source="google_trends_rss"),
                sig("Unrelated chess video", "video", source="youtube", _attach_only=True, _performance=0.9)]
        cands, rep = candidates.build(sigs, PROFILES, NOW)
        jw = next(c for c in cands if c["name"] == "James Webb Space Telescope")
        self.assertEqual(len(jw["signals"]), 2)
        self.assertEqual(rep["videos_unmatched"], 1)        # one-word topic "chess" can't grab the video

    def test_shared_generic_words_dont_join(self):
        # Found in the first live run: a cricket "World Cup" story joined the football one, and a song-contest
        # story grouped with a NASA post through words like "have" and "been".
        topics = candidates._topics([sig("2026 FIFA U-17 World Cup", "wiki", source="wikipedia")])
        loose, _ = candidates._attach(topics, [sig("ICC Mens T20 World Cup Americas Qualifier 2026 Points Table", "news")])
        self.assertEqual(len(loose), 1)
        groups = candidates._story_groups([
            sig("Where have you been? The band have been disqualified from the 2027 National Selection", "news"),
            sig("Where have you been? NASA shares a photo of a barred galaxy", "news")])
        self.assertEqual(len(groups), 2)
        same = candidates._story_groups([sig("Gukesh and Sindarov draw game 3 in Berlin defence", "news"),
                                         sig("Game 3: Gukesh, Sindarov draw after 60 moves", "news")])
        self.assertEqual(len(same), 1)

    def test_no_niche_means_not_sent(self):
        cands, rep = candidates.build([sig("Black Friday sales", "search", source="google_trends_rss")], PROFILES, NOW)
        self.assertEqual(cands, [])
        self.assertEqual(rep["no_account_passed"], 1)

    def test_only_matching_accounts_named(self):
        cands, _ = candidates.build([sig("New nebula image from Hubble telescope", "news", _for=["space"])], PROFILES, NOW)
        self.assertEqual(cands[0]["for_accounts"], ["space"])

    def test_searching_account_named_even_when_rejected(self):
        s = sig("Hubble telescope horoscope special", "news", _for=["space", "chess"])
        cands, _ = candidates.build([s, sig("Magnus Carlsen wins chess tournament", "news", _for=["chess", "space"])],
                                    PROFILES, NOW)
        names = {c["name"]: c for c in cands}
        self.assertNotIn("Hubble telescope horoscope special", names)  # excluded for space, nobody passes
        # Passes for chess; space's own search found it too, so space is named and the Worker records why it failed.
        self.assertEqual(names["Magnus Carlsen wins chess tournament"]["for_accounts"], ["chess", "space"])
        self.assertFalse(names["Magnus Carlsen wins chess tournament"]["_gates"]["space"]["passed"])

    def test_one_anchor_alone_is_too_weak(self):
        cands, rep = candidates.build([sig("Magnus Carlsen wins again", "news", _for=["chess"])], PROFILES, NOW)
        self.assertEqual(cands, [])

    def test_components_only_from_data(self):
        cands, _ = candidates.build([sig("Hubble telescope nebula", "news")], PROFILES, NOW)
        self.assertEqual(set(cands[0]["components"]), {"timeliness"})
        self.assertEqual(cands[0]["components"]["timeliness"], 1)

    def test_api_shape_matches_worker_limits(self):
        sigs = [sig(f"Hubble telescope nebula photo number {i} " + "x" * 400, "news", url=f"https://e.org/{i}")
                for i in range(30)]
        cands, _ = candidates.build(sigs, PROFILES, NOW)
        batches = list(candidates.batches(cands))
        self.assertTrue(all(len(b) <= 5 for b in batches))
        for b in batches:
            for c in b:
                self.assertFalse([k for k in c if k.startswith("_")])
                self.assertLessEqual(len(c["name"]), 200)
                self.assertLessEqual(len(c["text"] or ""), 1000)
                self.assertTrue(0 < len(c["signals"]) <= 10)
                for s in c["signals"]:
                    self.assertEqual(set(s), set(candidates.API_FIELDS))
                    self.assertLessEqual(len(s["title"]), 300)

    def test_cut_counts_like_javascript(self):
        s = "a" * 199 + "\U0001F440" + "b"
        self.assertEqual(len(candidates.cut(s, 200).encode("utf-16-le")) // 2, 199)
        self.assertEqual(candidates.cut("short", 200), "short")

    def test_active_case_flag(self):
        self.assertEqual(candidates.flags("Man accused of murder, trial told", ""), ["active_case"])
        self.assertEqual(candidates.flags("Man jailed for life for murder", ""), [])
        cands, _ = candidates.build([sig("Jury hears murder trial evidence in Leeds court", "news", _for=["buried"])], PROFILES, NOW)
        self.assertEqual(cands[0]["_flags"], ["active_case"])

    def test_manual_links_are_links_only(self):
        links = manual_links.all_links(PROFILES)
        self.assertEqual(set(links), {p["key"] for p in PROFILES})
        for ls in links.values():
            self.assertTrue(all(l["url"].startswith("https://") for l in ls))


class Boom:
    NAME = "boom"

    @staticmethod
    def run(ctx):
        raise RuntimeError("boom")


class Fine:
    NAME = "fine"

    @staticmethod
    def run(ctx):
        return [sig("New nebula image from Hubble telescope", "news", _for=["space"])]


def no_network(*a, **k):
    raise AssertionError("dry run must not post")


class CollectTest(unittest.TestCase):
    def run_main(self, argv, modules, env=None, opener=no_network):
        d = tempfile.mkdtemp()
        code = collect.main(argv, env=env or {}, http=FakeHttp({}), modules=modules, now=NOW, out_dir=d,
                            state_path=Path(d) / "s.json", opener=opener)
        return code, json.loads((Path(d) / "report.json").read_text(encoding="utf-8")), (Path(d) / "report.md").read_text(encoding="utf-8")

    def test_dry_run_never_posts(self):
        code, rep, md = self.run_main([], [Fine], env={"APP_URL": "https://x.test", "APP_EVENTS_TOKEN": "TOK"})
        self.assertEqual(code, 0)
        self.assertFalse(rep["posted"])
        self.assertIn("dry run", md)

    def test_failing_source_does_not_stop_others(self):
        code, rep, _ = self.run_main([], [Boom, Fine])
        self.assertEqual(code, 0)
        self.assertEqual(rep["sources"]["boom"]["status"], "failed")
        self.assertEqual(rep["build"]["candidates"], 1)

    def test_all_failing_exits_1(self):
        code, _, _ = self.run_main([], [Boom])
        self.assertEqual(code, 1)

    def test_post_sends_batches_with_token(self):
        sent = []

        class R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"trends":1,"opportunities":1,"rejected":0,"invalid":0}'

        def opener(req, timeout):
            sent.append(req)
            return R()

        code, rep, md = self.run_main(["--post"], [Fine], env={"APP_URL": "https://x.test", "APP_EVENTS_TOKEN": "TOK"},
                                      opener=opener)
        self.assertEqual(code, 0)
        self.assertEqual(sent[0].full_url, "https://x.test/api/trends/batch")
        self.assertEqual(sent[0].get_header("Authorization"), "Bearer TOK")
        self.assertEqual(rep["post"]["opportunities"], 1)
        self.assertNotIn("TOK", json.dumps(rep) + md)

    def test_post_without_token_fails(self):
        code, rep, _ = self.run_main(["--post"], [Fine])
        self.assertEqual(code, 1)
        self.assertFalse(rep["posted"])


if __name__ == "__main__":
    unittest.main()
