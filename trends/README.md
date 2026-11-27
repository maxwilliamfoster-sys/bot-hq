# Trend collector

Finds trends inside each account's own niche from free, official sources, and builds candidates for Bot HQ's
Trends section. Design: `docs/superpowers/specs/2026-11-27-trend-intelligence-design.md`.

```
py -m trends.collect                 # dry run: writes trends/out/report.md and report.json, sends nothing
py -m trends.collect --only wikipedia,news_rss
py -m unittest discover -s trends/tests -t .
```

`--post` sends to `$APP_URL/api/trends/batch` with `$APP_EVENTS_TOKEN`, in batches of 5 (the Worker's free-plan
CPU limit). Source names for `--only`: `google_trends_rss`, `wikipedia`, `news_rss`, `youtube`, `shorts_radar`,
`youtube_competitors`.

## How it fits together

```
GitHub Action "Trend collector" (daily 05:30 UTC)            PC, every evening review (autopilot)
  trends/collect.py                                            kit.py pick --run  -> trends-pull
    free sources -> signals                                    kit.py trends KEY  -> work/<date>_KEY/trends.md
    candidates.py: group into topics, niche gate per account   kit.py trend-ideas ID FILE.json
    --post (only if repo variable TRENDS_POST = on)            kit.py trend-result ID testing|won|lost|no_difference
          |                                                                |  bot token
          v  bot token                                                     v
  Bot HQ Worker (src/trends/)  <---------------------------------------------
    store.js     gate again on arrival, score, keep evidence, snapshots
    intel.js     history fit, originality, lifecycle, live-case flag; daily upkeep 05:00 UTC
    pipeline.js  queue / handed / ideas / outcome for the autopilot; Inbox notice; Sunday summary
          |  session
          v
  Trends tab on the phone (src/ui/trends.js): Max approves or rejects
```

Max's decision is the only way a trend reaches an account's backlog. Nothing posts, edits a video or changes a bot
on its own.

## Switching it on

Each step needs Max's OK.

1. Merge the `trend-intelligence` branch into `main`. The deploy workflow runs the tests, applies migrations
   0004-0006 to the live D1 and deploys the Worker.
2. In GitHub, go to **Settings > Secrets and variables > Actions > Variables** and add the repository variable
   `TRENDS_POST` with the value `on`. Then run **Actions > Trend collector > Run workflow** once by hand, and check that
   the Trends tab fills up.
3. Optional: the YouTube key (below). Without it the "Similar videos" and "Room to stand out" parts stay empty.

To switch posting off again, delete the variable or set it to anything else. The Action goes back to a dry run.

## Environment variables

| Name | Where | Needed for |
|---|---|---|
| `APP_URL` | written in `trends.yml` (public anyway) | posting, and reading the competitor watchlist |
| `APP_EVENTS_TOKEN` | repository secret (the same bot token the other bots use) | posting and the watchlist; never logged |
| `TRENDS_POST` | repository **variable**, not a secret | `on` = post; anything else = dry run |
| `YT_TREND_API_KEY` | repository secret, or VaultBridge `youtube_trends` locally | YouTube sources; skipped without it |
| `YT_TREND_DAILY_CAP` | optional | lowers the 3,000-unit daily cap (`sources.json`) |

Nothing reads a `.env` file. The report (`trends/out/`, uploaded as the run's artifact) has every key, token and
`Bearer` value removed, because GitHub only masks secrets in logs, not in artifacts.

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
3. For the Action, add it as the repository secret `YT_TREND_API_KEY`. To copy it from VaultBridge without it ever
   showing, run a script under `vaultbridge run --service youtube_trends` that pipes `$YT_TREND_API_KEY` into
   `gh secret set YT_TREND_API_KEY`.

VaultBridge's built-in test for this service always says it failed (HTTP 400), because it sends no `part`
parameter and every YouTube endpoint needs one. To check the key, call `channel_by_handle` with `part=id` and
`forHandle=@YouTube` (1 unit). A good key answers 200.

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

The gate (`src/trends/gate.js`) is a pass or fail, not part of the score:
- The evidence (trend name, text and every signal title) must contain at least one of the account's `anchors`.
- One anchor alone gives a relevance of 0.55. Each extra anchor adds 0.15 and each `related` word adds 0.1 (at most
  0.3). The trend passes at 0.6, so one anchor needs a supporting word.
- Any `exclude` term rejects the trend for that account, and that exclusion stays even if later evidence
  doesn't mention it.
- Text that mixes alphabets inside a word (look-alike letters) fails, so it has to be checked by hand.
- A failed trend is stored as `rejected` with no score, and it is never shown by default. It is never moved to
  another account: a trend reaches a second account only if it passes that account's own gate.
- Approving a trend re-runs the gate. If the profile changed and the trend no longer fits, the approval is
  refused.

## How a trend is scored

Only trends that pass the gate get a score out of 100. Weights can be changed with `PUT /api/trends/weights`
(signed in; every stored item is rescored), but niche relevance can't go below 10. The names in brackets are
the Trends tab's labels.

| Part | Default weight | From |
|---|---|---|
| Niche relevance ("Fits the niche") | 25 | the gate |
| Momentum | 20 | growth against its own baseline (Wikipedia views against their 30-day median, Google traffic, days trending in a row) |
| Audience ("Audience interest") | 15 | how many people are searching or reading (log scale), plus history fit: up to ±3 points from how this account's own videos on the topic did |
| Performance ("Similar videos") | 15 | recent videos on it far above their usual views: YouTube search (needs the key), Shorts Radar for chess, competitors' feeds |
| Competition ("Room to stand out") | 10 | fewer Shorts uploaded on it in the last 7 days = more room (needs the YouTube key) |
| Timeliness ("Freshness") | 10 | 1 when the newest evidence is under a day old, falling to 0 at a week |
| Originality ("New for this account") | 5 | the account hasn't covered it recently or already planned it |

Classes: **80+ Strong**, **65+ Worth testing**, **45+ Watch**, below that Weak. A part with no data counts as zero
and is listed as missing, so nothing is guessed. Evidence from 2 or more independent kinds of source is
"confirmed", from 1 is "emerging", and a manual entry on its own is only a hypothesis.

## Adding an account

1. Add it to `analytics-check/autopilot/accounts.json` first (that file is the source of truth for the niche).
2. Add a profile to `profiles.json`. Copy `name`, `niche` and `audience` word for word from accounts.json, then
   add `anchors` (words that name the niche), `related`, `exclude` (look-alikes that must never get in),
   `category`, `geo`, `platform`, the search queries and `locked_rules`.
3. Add its feeds to `sources.json` (`feeds`, keyed by the account).
4. Add at least one headline for it to `test/fixtures/trend_samples.js`, and check the samples for the other accounts still
   reach only their own accounts.
5. Run `node trends/tests/make_parity.mjs`, then `npm test` and the Python tests. `trends_profiles.test.js`
   fails if the niche doesn't match accounts.json, or if an anchor is also an exclusion.

To stop an account, set `"active": false`. It then gets nothing, and its stored items stay as they are.

## Adding a source

A source is a module in `trends/sources/` with a `NAME` and a `run(ctx)` that returns signals:
`{name, source, source_type, url, title, published_at, fetched_at, metric, value}`. Add it to `REGISTRY()` in
`sources/__init__.py`, plus a fixture and a test in `tests/test_collector.py`. Rules:
- It must be an official API, an RSS feed or a public page meant for machines, with no login, CAPTCHA or
  workaround for a block. If the terms forbid automated access (TikTok, Reddit), add links to `manual_links.py`
  instead.
- It must be free with no card. Fetch through `ctx.http` (cache, retries, polite gaps) and count any quota with
  `Quota`.
- Raise `Skipped("why")` when a key is missing. Any other error marks only that source as failed, and the
  rest of the run carries on.
- `source_type` says which independent kind of evidence it is (search, wiki, news, video, ...). The Worker counts
  independent types to decide "confirmed".

## When something looks wrong

- **The Trends tab is empty:** check the collector posted. Open **Actions > Trend collector** and look at the
  run summary for "dry run". `TRENDS_POST` missing means it didn't post. Every source "failed" means the run
  exits 1. Then check the run's `trends-report` artifact: candidates with no niche aren't sent.
- **A source shows `failed`:** the reason is in the report. Usually that site was down for the day, so check it
  again tomorrow. Google Trends' RSS address has changed before, so check `sources/google_trends.py` if it
  keeps failing.
- **YouTube shows `quota_capped`:** today's units are used up. It resets at midnight UTC, and nothing goes over
  the cap.
- **"Competitors' feeds" fails with 404:** Bot HQ isn't deployed with the trends routes yet (step 1 above).
- **A trend that obviously fits was rejected:** open it, and the reason names what was missing. If the niche
  really covers it, add the missing word to that account's `anchors` or `related`, with a test. Never loosen
  `MIN_RELEVANCE` to let one trend in.
- **The evening review says "Bot HQ's trend queue didn't answer":** Bot HQ is down or not deployed. The review
  carries on without new trends, and the next run picks them up.
- **An idea is refused with `active_case_needs_risk`:** the trend is a live court case. Write the risk ("say
  accused, only what the court heard, wait for the verdict") in the idea's `risks`.

## Limits

- It runs once a day, so this is not real-time. A trend shows up the morning after it starts.
- Matching is on words, not meaning. A niche described in unusual words can be missed, and Max can add it by
  hand with the manual form (same gate).
- TikTok, Instagram and Reddit trends aren't collected, only linked. Their numbers come from Max's own manual
  entries.
- Lifecycle needs 3 or more daily readings, and history fit needs the account's own videos from the last 180
  days. Until then they say so, rather than guessing.
- Scores rank trends against each other. They don't predict views. The Sunday summary compares score bands
  with real test results, so the weights can be checked against what actually happened.
