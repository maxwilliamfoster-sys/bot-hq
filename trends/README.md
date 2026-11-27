# Trend collector

Finds trends inside each account's own niche from free, official sources, and builds candidates for Bot HQ's
Trends section. Design: `docs/superpowers/specs/2026-11-27-trend-intelligence-design.md`.

```
py -m trends.collect                 # dry run: writes trends/out/report.md and report.json, sends nothing
py -m trends.collect --only wikipedia,news_rss
py -m unittest discover -s trends/tests -t .
```

`--post` sends to `$APP_URL/api/trends/batch` with `$APP_EVENTS_TOKEN`. It isn't switched on in the Action yet.

## Sources

| Source | What it gives | Cost / limit |
|---|---|---|
| Google Trends daily RSS | about 20 trending searches a day per country, Google's traffic bucket, linked stories | free, no key |
| Wikipedia page views (Wikimedia REST) | most-read articles, and each article's daily views against its own 30-day median | free, no key |
| Google News RSS + publisher feeds (`sources.json`) | stories from the last 3 days for each account's queries | free, no key |
| YouTube Data API v3 | recent Shorts far above their search's typical views per hour | free quota; capped at 3,000 of the 10,000 daily units |
| Shorts Radar (chess) | breaking and outlier chess Shorts | free (your own data) |
| Competitors' YouTube feeds | watchlist channels' last 15 videos and views (public upload feed); videos far above that channel's median | free; needs `APP_URL` + `APP_EVENTS_TOKEN` to read the watchlist, and the key once per @handle (1 unit) |
| Competition check | Shorts uploaded in the last 7 days on each of the 8 strongest topics | 100 units each, from the same daily cap |
| TikTok Creative Center, Reddit | no free official API, so **links only** in the report, to open by hand | free |

Nothing scrapes, logs in or gets around a block. Reddit and TikTok content is never fetched, and nothing here
trains a model.

## YouTube key (optional, free)

Without it, YouTube is skipped and everything else still runs.

1. In Google Cloud Console, make a **new** project (separate from the chess uploader's, so the two quotas can
   never collide), enable "YouTube Data API v3", and create an API key restricted to that API. No billing account
   is needed.
2. For local runs, store it in VaultBridge (service `youtube_trends`) and run
   `vaultbridge run --service youtube_trends -- py -m trends.collect`.
3. For the Action, add it as the repository secret `YT_TREND_API_KEY`.

The key is only ever sent to googleapis.com. URLs are redacted before any log line, and cache files are named
by a hash, so the key never lands in a log, a report or the cache.

## What the Worker adds (it has the data the collector doesn't)

- **History fit** (-1..1, up to ±3 points): this account's own videos from the last 180 days on the same topic,
  by views against the account's median, fading with age (half after 60 days). Plus autopilot approaches that won
  or lost. A single bad result never counts against a topic.
- **Originality** (0..1): 1 if the account never covered the topic, lower if it did recently or already plans it.
  The collector's own value is ignored.
- **Lifecycle** from the daily snapshots: new, emerging, accelerating, peak, flat, saturating, declining,
  re-emerging, expired. With fewer than 3 readings it says `not_enough_data`.
- **Flag `active_case`**: an allegation or live court case with no verdict in the evidence.
- The history is rebuilt daily at 05:00 UTC (the existing cron), stale trends expire after 14 days, and
  failed-gate rows go after 30. Max's own rejections are kept.

## How niches stay fixed

Profiles (`profiles.json`) are code, reviewed in git, and no API can change them. Every candidate is gated
locally (`textmatch.py`, identical to the Worker's gate; see `tests/parity.json`), and the Worker gates
everything again on arrival. Candidates no account passes are never sent.
