# Trend Intelligence for Bot HQ: audit and implementation plan

Status: **proposal, not built.** Nothing in any project has been changed. Written 2026-11-27.

---

## Stage 1: Audit of what already exists

### Where things are
| Piece | Location | What it is |
|---|---|---|
| **Bot HQ** (root) | `C:/Users/maxwi/Projects/Apps/bot-hq` | Cloudflare Worker + D1 (SQLite) on the free plan. Public GitHub repo `bot-hq`. Vanilla JS phone web app (`src/ui/`, bundled by esbuild), API in `src/api.js`, 205 `node --test` tests. Deploys from this PC with `npm run deploy`. |
| **Account and niche config** | `Content-Bots/analytics-check/autopilot/accounts.json` | Source of truth for every account's `niche`, `audience`, `platform`, `metric`, `cap`, `stopped`. Bot HQ has its own short list in `src/bots.js` (ids, repos, planned posts a day), with no niche text. |
| **Experiment system** | `analytics-check/autopilot/` | The evening Claude routine (`ROUTINE.md`, hard limits in `RULES.md`, `kit.py`, `runner.py`). Per account `state/KEY.json` holds `reviews`, `ideas` (ranked backlog: idea, evidence, expected, status), `research` (finding + sources + date), `approaches` (9 families with outcomes) and `competitors` (3-5 watchlist with what they do and ideas borrowed). Per-bot loops (`levers.json`, `EXPERIMENTS.md`, `growth-lab/experiment_loop.py`) run the actual A/B tests. |
| **Analytics store** | Bot HQ D1: `posts`, `snapshots`, `milestones` (views at 1/6/24/72 h), `account`, `events` | Filled by Worker watchers (YouTube, Buffer, Zernio, every 5 min to hourly), PC bots' `stats` events and the nightly backfill. `analytics-check/build_tracker.py` posts the tracker and autopilot block to `/api/tracker`. |
| **Learning memory** | Brain note per account, `## Autopilot` section | `Proven here` / `Didn't work here` / `Don't undo` / `Review log`. Lessons are per account and never generalised. |
| **Schedulers (four, all existing)** | Worker cron `*/5 * * * *` (`src/schedule.js`); GitHub Actions per repo (Bot HQ `ingest.yml` nightly 03:15 UTC); Windows task "Bot autopilot" (`runner.py check`, hourly); Claude desktop task `bot-autopilot` (18:30) | No new scheduler is needed. |
| **An existing trend tool** | `Content-Bots/shorts-radar` | Chess only. Daily GitHub Action: channel RSS (no quota), yt-dlp discovery, YouTube Data API capped at 700 units a day, outlier scoring against each channel's own median, and an "LLM may not produce numbers" rule. Bot HQ's Radar tab reads `insights/chess.json`. |
| **Dashboard** | Tabs: Inbox, Live, Graphs, Radar, Bots (Progress/Runs), Settings | Access code sign-in (`src/auth.js`), bot bearer token for write routes, CSP `style-src 'self'` (no inline styles). |

### Accounts and their niches (read from accounts.json, will never be changed)
| Key | Platform | Niche (locked) | Geo |
|---|---|---|---|
| chess | YouTube Shorts | Chess find-the-move puzzles, narrated | Global English |
| buried (bcf) | TikTok | True crime, narrated case files, mostly UK cases | UK |
| escape | TikTok | Physics sim: country flag balls escaping rings, 32-nation cup | UK (~91%) |
| space | TikTok | Real telescope footage, named targets, narrated | Global English |
| perc | TikTok | Relatable GIF memes cut to a beat | UK |
| bodge | YouTube Shorts | Animated "what if" shrink/grow/speed episodes | Global English |
| gary | Instagram Reels | Whispering bin fox, "send this to your..." (format locked by you, 20 Nov) | UK |
| niche | TikTok | World Cup football clips + niche house track | UK |
| eagle | TikTok | **Stopped 18 Nov**: gets no trend research until restarted |

### Constraints the audit found
- **Worker free plan:** 50 outside requests and 10 ms CPU per run, and D1 hard-fails after the daily free row reads. So heavy collection can't run in the Worker. It has to run in Python elsewhere and post results in batches, the same way `ingest/backfill.py` does.
- **Claude usage:** the autopilot has already failed twice on the Pro 5-hour limit. AI writing has to stay small and capped.
- **The free Groq model is already shared and tight** (Brain note `bot_shared_ai_quota`). Also, free Gemini may use inputs for training. I won't use either for trend analysis.
- **The Bot HQ repo is public:** keys go in GitHub or Worker secrets only.
- **Gates that must stay:** the true-crime legal rules ("accused/alleged", court outcomes), Niche House's music rules, Gary's locked format, one main test per account, and `RULES.md`.

### Source access, tested today (2026-11-27)
| Source | Result | Decision |
|---|---|---|
| Google Trends daily RSS `trends.google.com/trending/rss?geo=GB` | **200**: about 20 daily searches with approximate traffic and linked news | **Automate.** It's only the top daily searches per country (mostly news and sport). Explore and related queries have no free official API, and the 2025 Trends API alpha needs an application, so those get one-click links for manual research. |
| Wikipedia pageviews API (Wikimedia REST) | **200**, free, no key, daily history | **Automate (added).** Gives growth against history for named things: cases, telescope targets, players, chess events. |
| Google News RSS search (`hl=en-GB&gl=GB`) | **200** | **Automate**, plus a hand-picked list of reliable feeds per niche and a blocklist of content farms. |
| YouTube Data API v3 | Free 10,000 units a day per Google Cloud project | **Automate** with a new key from a **separate free Cloud project**, so it can't eat the chess uploads' quota. Channel RSS (0 units) for competitors. Ledger cap 3,000 units a day, cache, and growth = view change per hour between snapshots, never total views. |
| Reddit Data API | Unauthenticated JSON **403**. Since Nov 2025, new API access needs Reddit's approval under its Responsible Builder Policy, and reports say new public API requests closed 31 Oct 2026 and the free tier is going paid. | **Not built.** Instead: subreddit links per account and an "add source URL" box. Revisit only if Reddit grants you access. |
| TikTok Creative Center | No official API. Anonymous data routes are locked (reported by third parties), and the request failed from here. | **Manual workflow.** Per-account links (country GB, industry filter), and a paste or import form. Entries are labelled "manual, as of DATE" and are never shown as refreshed. |
| Instagram trends | Hashtag search needs Meta app review | **None.** Gary relies on Google Trends GB, news, seasonal dates and manual notes. |

---

## Stage 2: Design

### Data flow
```
GitHub Action "trends.yml" (Bot HQ repo, daily 05:30 UTC, free minutes)
  trends/collect.py  -> source adapters -> raw signals (cached, quota ledger)
  trends/analyse.py  -> cluster + dedupe -> trend candidates + per-account component scores
        |  POST /api/trends/batch (bot token, batches of 50)
        v
Bot HQ Worker (authoritative)
  niche gate (JS, the only write path) -> score + class -> lifecycle -> D1 tables
  cron (existing 5-min tick, hourly step): expire stale trends, push "high-priority waiting"
        |  GET /api/trends/... (session)            |  GET /api/trends/queue (bot token)
        v                                           v
  Trends tab (phone app)                Evening autopilot (existing Claude run)
  approve / reject / add manual         kit.py trends KEY: writes report + 3 ideas
        |  approve                                  for at most 3 high-priority items a run
        v
  approved -> autopilot state/KEY.json "ideas" (status queued, trend_id)
           -> autopilot's normal rules decide when it becomes a test (one main test)
           -> test result in bothq_payload -> Worker links outcome to the trend
```

### Niche enforcement (built into the code, not just the prompt)
1. **Profiles are read-only copies.** `trends/profiles/KEY.json` holds the trend profile: anchor terms (must match), related terms, exclusion terms, Wikipedia seed articles, feeds, YouTube queries, geo and language. The `niche` and `audience` text is copied from accounts.json with a hash. The trend system has **no code path that writes accounts.json or the bots' configs**, and a test checks that.
2. **One gate, on the server.** Every write (collector batch, manual add, Claude's analysis, approval) goes through `nicheGate(candidate, profile)` in the Worker. It passes only if the evidence text hits at least one anchor term, has no exclusion hits, and the candidate's relevance component is at least the threshold (default 0.6 of 25). A candidate that fails is stored as `rejected` with the reason and is **never** scored into a class, whatever its other numbers.
3. **Per-account evaluation.** A candidate found through account A's queries is gated separately for every other active account. It's assigned to B only if B's own gate passes.
4. **Claude can only lower.** In the analysis step Claude can reject or lower relevance, never raise it past the gate. Ideas that don't cite real evidence ids are refused by the API.
5. **Stopped accounts** (eagle) have no active profile and get nothing.
6. **Tests:** every cross-niche pair (for example a football trend to chess, or a gaming trend to true crime) must be refused, manual adds included. The tests also check that Gary's and Niche House's locked rules show up as risks on their ideas.

### Scoring (weights configurable in the `settings` table)
Niche relevance 25 (gate) · growth momentum 20 · audience interest 15 · content performance evidence 15 · competition/saturation 10 · timeliness 10 · originality 5.
- Every component is computed in Python from stored numbers. The LLM never produces a number (the same rule as shorts-radar).
- Momentum compares against history: Wikipedia views over the last 7 days against the 30-day median, YouTube view change per hour against each channel's own median, and the number of days a term has appeared in Google Trends.
- **History fit:** up to ±3 inside audience interest, taken from the account's `approaches` outcomes and `Proven here`. It fades over time, and one failed test is never enough to block a format.
- Classes: 80+ high priority, 65-79 worth testing, 45-64 monitor, under 45 low.
- Evidence label: **Confirmed** (2+ independent source types), **Emerging** (1 source type), **Hypothesis** (Claude or manual, no numbers yet).
- Every opportunity keeps every source URL, its fetch time and its published time.

### Lifecycle
Each trend gets a daily snapshot (momentum, volume, number of competitor videos). Rules: `new` (first 2 days), `emerging`, `accelerating` (growth rate rising), `peak` (flat at a high level), `saturating` (competitor count up, views per video down), `declining`, `re_emerging` (rising again after a decline), `expired` (no signal for 14 days). With fewer than 3 snapshots the status is "not enough data yet", never a guess.

### Database (new D1 tables, migration 0004; existing tables untouched)
`trend_profiles`, `trends` (dedupe key = normalised name), `trend_signals` (source, url, fetched_at, published_at, metric, value), `trend_snapshots`, `opportunities` (trend x account: components, score, class, evidence label, status new/approved/rejected/testing/won/lost/no_difference, reason), `opportunity_ideas` (title, hook, format, duration, storytelling, why, platform notes, risks, evidence ids), `trend_quota` (source, day, units), `manual_research`. Indexes on every hot WHERE column. Retention: rejected items deleted after 30 days, snapshots thinned after 90 days (the existing `thin.js` pattern).

### Dashboard: a new "Trends" tab in the existing style
Overview counters (discovered, high priority, emerging, accelerating, waiting for approval, testing, predictions that worked) · account picker (one account at a time) · explorer filters (account, platform, category, date, score, direction, lifecycle) · detail page (report, evidence with links and times, score breakdown, ideas, snapshot chart using the existing Chart.js) · history · a manual form (trend, source URL, account, notes, "analyse at next run", reject). Manual entries go through the same gate.

### Feedback loop
Approving writes the idea into the autopilot backlog through a new `kit.py` command that runs on the PC (the Worker can't reach local files): `kit.py trends-pull` fetches the approved items at the start of each evening run. When the linked test ends, `bothq_payload` carries `trend_id` and the outcome. The Worker marks the opportunity won, lost or no difference. The weekly report compares score bands with real outcomes ("80+ ideas won 2 of 5").

### Schedules (all on schedulers you already have)
| When | Where | What |
|---|---|---|
| Daily 05:30 UTC | GitHub Action `trends.yml` (Bot HQ repo) | Discover, update tracked trends, score, post |
| Hourly | Existing Worker tick | Lifecycle expiry, push alert when a new high-priority item is waiting (respects `notify_only_needed`) |
| Evening | Existing autopilot run | Pull approvals; write reports and ideas for at most 3 high-priority items |
| Sundays | Same Action (weekly mode) + autopilot | Weekly per-account report; check past predictions against results |
A failed source is recorded as `source_down` with the date, shown on the overview, and never fatal.

### Dependencies (all free)
Python standard library plus `feedparser` (MIT) and `requests`, both already used by shorts-radar. The YouTube API key comes from a free Google Cloud project (no card needed for the Data API). No new JS dependencies. GitHub Actions minutes are unlimited because the Bot HQ repo is public.

---

## Implementation phases (each is tested before the next)
1. **Core:** migration 0004, profiles for 8 accounts (drafted by me from accounts.json and Brain notes, for you to check), the JS niche gate with tests, the score and class engine, `/api/trends/*` routes, dedupe.
2. **Sources:** adapters for Google Trends RSS, Wikipedia, news RSS and YouTube (quota ledger, cache, retry with backoff, timeouts), plus the shorts-radar insights as a source. Adapter interface `fetch(profile, cache) -> [Signal]` so new sources plug in. The Action runs in dry-run mode first.
3. **Intelligence:** clustering, lifecycle, competitor patterns (YouTube channels via RSS and API; TikTok and Instagram competitors from the autopilot watchlist only), history fit from autopilot state.
4. **Interface:** the Trends tab, approve/reject, manual form. Checked at 375 px.
5. **Automation:** `trends.yml`, the hourly Worker step, `kit.py trends-pull` / `trends KEY`, and a `ROUTINE.md` addition (needs your OK, because ROUTINE changes how the autopilot behaves).
6. **Testing:** niche gate across every account pair, account separation, a source failing, quota cap, dedupe, scoring, persistence, and the existing 205 Bot HQ tests plus 61 kit tests still passing.
7. **Docs:** `trends/README.md` (architecture, setup, environment variables, adding an account or source, troubleshooting), plus updates to PLAYBOOK.md, the Brain notes and the README index.

## Your one manual setup step
Create a free Google Cloud project, turn on YouTube Data API v3 and make an API key. I'll set it up through VaultBridge so the key never appears in chat, and it goes into the `YT_TREND_API_KEY` GitHub secret. Everything except the YouTube adapter works without it.

---

## Progress

### Phase 1: core (done 2026-11-27, not deployed)
- `migrations/0004_trends.sql`: `trends` (with `evidence_text`, so the gate can be re-run), `trend_signals`, `trend_snapshots`, `opportunities`, `opportunity_ideas`, `trend_quota`. Changed from the design: there's no `trend_profiles` or `manual_research` table. Profiles live in code (below), and manual research is stored as a `manual` signal plus an opportunity with `analysis_requested = 1` and `notes`.
- `trends/profiles.json`: 8 active accounts (Eagle Eyes is stopped, so it has no profile). Niche, audience and name are copied word for word from accounts.json (generated by script, not retyped). `src/trends/profiles.js` deep-freezes them, and no API writes them.
- `src/trends/gate.js`: the niche gate. Relevance is 0.55 for one anchor, +0.15 per extra anchor, +0.1 per related word (related words add at most 0.3). It passes at 0.6 or more with no exclusions. That means one anchor needs a second anchor or a supporting word.
- `src/trends/score.js`: weights 25/20/15/15/10/10/5, configurable (`PUT /api/trends/weights`; niche weight must stay at 10 or more). A failed gate means class `rejected` and score `null`. Missing components count as 0 and are listed. Evidence labels: confirmed / emerging / hypothesis.
- `src/trends/dedupe.js`: the key is the name's words sorted, minus filler words ("The case of X" = "X case").
- `src/trends/store.js` + routes in `src/api.js`: `POST /api/trends/batch` (bot token, at most 20 candidates), `GET /api/trends` (filters: account, platform, class, status, lifecycle, category, since, min_score, include_rejected), `GET /api/trends/overview`, `GET /api/trends/:id[?account=]`, `POST /api/trends/opportunities/:id/approve|reject`, `POST /api/trends/manual`, `GET|PUT /api/trends/weights`.
- Rules in the code: a user decision is never overwritten by a new sighting; approval re-runs the gate; nothing can be approved or rejected once its test has started; a failed gate is recorded only for the accounts the collector named, and every other account never hears of it.
- CPU: the gate uses a phrase index (each term check is one lookup). Worst case, 20 candidates x 8 accounts at the 2,000-character cap, takes about 5.5 ms on this PC (the free plan allows 10 ms).
- Verified: 242/242 tests (205 existing + 37 new: 15 niche samples across every account, manual adds, approval, dedupe, filters, weights). The Wrangler dry-run bundle builds. Migration 0004 applied to the local D1. A batch sent twice to `wrangler dev` stored 2 trends, 2 opportunities and 3 sources (no duplicates), and the test rows were deleted afterwards.
- Not done: remote migration and deploy (waiting for phases 2-5, so the live app doesn't get routes with no data and no screen).

### Phase 2: collector (done 2026-11-27, dry run only)
- `trends/` (standard-library Python, 3.12+): `http.py` (disk cache, 3 retries with backoff and Retry-After capped at 30 s, 0.5 s gap per host, 5 MB cap, keys redacted from every message, hashed cache names, daily quota ledger), `sources/` (google_trends, wikipedia, news, youtube, radar; one failing never stops the others), `candidates.py`, `manual_links.py`, `state.py`, `collect.py`, `README.md`.
- Feeds with a DOCTYPE or ENTITY are refused before parsing (no entity tricks).
- Grouping favours precision: a story joins a topic only when it shares all of a short name's distinctive words (3/4 of a long one), and headlines group only when they share 3+ distinctive words, at least half the shorter's. Found in the first live run: a cricket "T20 World Cup" story joined "FIFA U-17 World Cup", and a song-contest story borrowed a NASA headline through "have" and "been".
- bodge's "giant", "tiny" and "faster than" moved from anchors to related words: alone they matched a Milky Way story. The niche itself is unchanged.
- Lengths are cut in UTF-16 units like the Worker (an emoji counts 2); one live headline was 201 by the Worker's count.
- True-crime candidates about live cases (accused / trial / charged, no verdict) are flagged `active_case` in the report. Phase 3 must carry the flag to the Worker, and ideas must wait for a verdict and use court-established facts only.
- Components only from numbers the signals carry; news-only topics have just timeliness, so they score low until other sources confirm them. Audience history-fit, competition and originality come in phase 3.
- Tests: 42 Python tests (fixtures saved from the real sources), 252 JS tests. The first live dry run gave 661 signals, 60 candidates (cap), and 0 invalid / 0 gate mismatches when checked against the Worker's own `validCandidate` and `nicheGate`. YouTube is skipped until the free key exists.
- `.github/workflows/trends.yml`: daily 05:30 UTC plus manual; tests, then a dry run; report in the job summary and as an artifact; state in the Actions cache. It sends nothing.
- Known: the same topic can appear twice when names differ by a year ("2026 FIFA U-17 World Cup" vs "FIFA U-17 World Cup"); the Wikipedia pass takes about 2 minutes uncached (serial, polite).

### Phase 3: intelligence (done 2026-11-27, not deployed)
- History comes from Bot HQ itself, not the PC: `posts` + `snapshots` (each account's own videos and views) and the autopilot block kit.py already posts (approaches, open ideas, competitor watchlist). So the GitHub collector needs no access to local files.
- `src/trends/intel.js`: `buildHistory` (daily 05:00 UTC cron step `trend upkeep`, stored as one settings row with a word index), `historyFor` (history fit -1..1, up to +-3 points inside audience; originality 0..1), `lifecycle` (rules above, `not_enough_data` under 3 readings, plus `flat`), `flagsFor` (`active_case`), `trendUpkeep` (expire after 14 days, delete failed-gate rows after 30; Max's rejections kept), `collectorContext` (GET `/api/trends/context`, bot credential, public YouTube competitor links only).
- Migration 0005: `trends.flags`, a cleanup index. Applied to the local D1 without problems.
- Originality and history fit are the Worker's to compute; the collector's originality is ignored. Missing history = component missing, never filled in.
- Shared word rules moved to `trends/text_rules.json` (`stop`, `allegation`); parity.json now also checks distinct words, topic joins (plurals and possessives both ways) and flags between JS and Python.
- Collector: `sources/competitors.py` (watchlist channels' public upload feeds; @handles resolved once with the key, 1 unit, cached), `competition.py` (recent Shorts on the 8 strongest topics, 100 units each, same cap). Both skip cleanly without the key or Bot HQ credentials.
- CPU: the history step parses about 80 KB (0.2-0.4 ms) and looks words up in a precomputed index, capped at the 30 newest matches per account. Pathological case (every video of all 8 accounts matching) about 3 ms; realistic well under 1 ms, because only the accounts being written are checked.
- Tests: 262 JS (10 new in trends_intel.test.js) and 50 Python. Live dry run: 60 candidates, 0 invalid, 0 gate mismatches; 11 flagged as allegations / live cases.
- Not yet: TikTok and Instagram competitor patterns (watchlist text only, no free feed); the Action doesn't pass APP_URL/token yet (the context route isn't deployed), so competitor feeds start in phase 5.

### Phase 4: interface (done 2026-11-27, not deployed)
- `src/ui/trends.js`, a 7th tab "Trends" (tab bar now 7 columns; fits at 375 px). Built only from the existing tokens and components (facts, chips, feed rows, panels, meters, sheet), no new look.
- List: counters (waiting, strong 80+, rising, testing, won, found), account chips with waiting counts, views (Waiting for you = new and 65+, All, Approved, Testing, Won, Rejected, Didn't fit), More filters (stage, platform, minimum score). Each row: account colour, name, account, stage, last seen, "Live case or allegation" in amber, score with its class.
- Detail `#/trends/<trend id>`: one panel per account with score and class, evidence level, approve/reject with an optional reason, how the score adds up (each part in points of its weight; a part with no data says "No data yet, counts as 0"), past-video effect, why it fits (niche, gate reason, words found, locked rules), ideas when the evening run writes them. Then momentum per day (chart from the second reading) and the evidence links. A failed-gate panel says why and offers no approve.
- Active-case warning on the detail page: say "accused"/"alleged", stick to what the court heard, never present anyone as guilty; true-crime videos wait for the verdict.
- Manual form (sheet): account, trend, link, what it's about, notes (notes never count for the gate). A trend outside the niche is refused with the gate's reason and "The niche stays as it is"; nothing offers a way round it.
- Fixes found in the browser check: the CSP (`style-src 'self'`) blocks `style=""`, so meter widths are set through `element.style`; long meta lines wrap instead of running under the score; long Wikipedia titles clamp to 3 lines. Manual trends now store the account's category.
- Checked at 375 x 812 in dark and light mode against the local dev Worker with 61 real candidates from the last dry run (scored by the real Worker code): list, filters, detail, chart, approve, reject, refusal of an off-niche trend, adding one that fits. Test rows and the test session removed afterwards. The local D1 had an old copy of migration 0004 (before the exclusions table); its empty trend tables were rebuilt from 0004 + 0005. Production D1 has neither yet.
- Tests: 262 JS and 50 Python still pass. No UI unit tests (none exist for the other tabs); phase 6 adds tests.

### Phase 5: automation (done 2026-11-27, not deployed)
- Worker `src/trends/pipeline.js`, bot credential only:
  - `GET /api/trends/queue[?account=]`: `approved` (approved, not yet handed over), `analyse` (up to 3 that want ideas: Max asked for analysis or scored 80+, no ideas yet, not expired), `withdrawn` (rejected after the hand-off, last 30 days). Each item carries the niche, locked rules, flags, Max's notes and reason, and up to 5 evidence links with ids (manual and Claude signals are never evidence).
  - `POST /api/trends/opportunities/:id/handed` (approved only, idempotent).
  - `POST .../ideas` {ideas: up to 3}: refused for a failed-gate trend; a live case needs a written risk; evidence ids must be this trend's signals; at most 9 per trend; the account's locked rules are added to every idea's risks.
  - `POST .../outcome` {status, note}: approved -> testing -> won / lost / no_difference. A finished result can't change, and Max can't reject a trend once it is being tested.
- Migration 0006: `opportunities.handed_at`, `outcome_note`, `notified_at`. Applied to the local D1 only.
- Hourly (08:00-21:00 UK): one Inbox item when new 80+ trends are waiting (`trend_waiting`, severity info, so with "only when I am needed" on it stays in the Inbox and never buzzes the phone). Sundays 09:00 UTC: `trend_weekly`, found / approved / rejected and results by score band ("80+: won 2 of 5"). Both open the Trends tab.
- Trends tab: "Approved, goes to the next evening review" / "in the idea backlog since ...", the test note, "Being tested by the autopilot", and ideas with hook, format, length, why and a "Watch out" list.
- Action `trends.yml`: same daily run; posts only when the repository variable `TRENDS_POST` is `on` (dry run until then). It now gets APP_URL (already public in ingest.yml) and the existing `APP_EVENTS_TOKEN` secret, so it can read the competitor watchlist once the Worker is deployed.
- PC `analytics-check/autopilot/kit.py` (no git repo; backup taken first): `trends-pull` (also run by `pick --run` at the start of each scheduled run, never fatal), `trends KEY` (brief: backlog trend ideas, approved, up to 3 wanting ideas, evidence ids, live-case warning, fixed niche and locked rules), `trend-ideas ID FILE.json`, `trend-result ID status ["note"]`. Approved trends become `queued (approved trend)` ideas with `trend_opportunity`; the autopilot's normal rules (one main test) decide when one is tested. A rejection after the hand-off parks the idea.
- Tests: 271 JS (9 new in `trends_pipeline.test.js`), 50 collector Python, 82 kit (12 new in `autopilot/tests/test_trends.py`). A contract check fed a real Worker queue into kit.apply_queue and the brief. Browser check at 375 px on the local Worker: hand-off status, test note, ideas with risks, live case.
- Change logged in `tracker_log.json` (Bot HQ Progress updated).

#### ROUTINE.md addition (Max approved it 2026-11-27; applied)
In step 1, after the dossier bullet:
> - `py autopilot/kit.py trends KEY`: trends Max approved in Bot HQ for this account (already queued in the idea backlog) and up to 3 strong trends that want ideas. They are inside this account's fixed niche; never change the niche to fit a trend. For each one under "Want ideas", write up to 3 original ideas in this account's own format from the listed evidence only (step 4's rules: never copy a video), save them as JSON and run `kit.py trend-ideas ID FILE.json`. A LIVE CASE idea must say "accused" or "alleged", use only what the court has heard, and true-crime videos wait for the verdict.

In step 5, after the idea-backlog bullet:
> - An approved trend is a backlog idea like any other: it never jumps the one-main-test rule or breaks a running test. When one becomes the test, `kit.py trend-result ID testing`; when the test is judged, `kit.py trend-result ID won|lost|no_difference "one line"`.

### To switch it on (each needs Max's OK)
1. Merge `trend-intelligence` into main: the deploy workflow runs the tests, applies migrations 0004-0006 to the live D1 and deploys.
2. Set the repository variable `TRENDS_POST` to `on` (Settings > Secrets and variables > Actions > Variables), then run the Trend collector once by hand.
3. Optional: the free YouTube key (`YT_TREND_API_KEY`), which fills "Similar videos" and "Room to stand out".

### Phase 6: testing (done 2026-11-27)
What already had tests (phases 1-5) was mapped first; phase 6 added what was missing:
- `test/trends_matrix.test.js`, end to end through the Worker: every niche sample offered to every account is usable for exactly its own accounts and stored only as a refusal (no score) for the rest; a trend two accounts share (niche + escape) stays separate through approve, queue, hand-off, ideas, reject and test result; Max's decision, the hand-off, ideas and a running test survive re-collection and daily upkeep, an expired trend asks for no new ideas, and a test that outlives its trend can still record its result. The samples now live in `test/fixtures/trend_samples.js`, shared with the gate test.
- `trends/tests/test_persistence.py`: state file round trip (atomic) and a missing, corrupt or old-version file starting fresh; the YouTube sources share one daily ledger and never pass the cap; quota spent earlier today counts in the next run; the cap resets the next day and the ledger keeps about a week; Bot HQ down fails the run (exit 1) but keeps the state; no key or token ever reaches the report.
- `autopilot/tests/test_trends.py` (+4): Bot HQ unreachable is status 0 with no token; `pick --run` carries on; `trends KEY` still writes the brief (with the backlog trend ideas) when the queue is down or not deployed; `trend-result ID testing` sends no note.
- Bugs the tests found, fixed:
  1. The collector's report (uploaded as an artifact on a public repo, where GitHub does not mask secrets) could include a token if an error message contained one. `redact` now hides `Bearer` values and the actual key and token values too.
  2. `kit.py` crashed with a traceback when Bot HQ couldn't be reached, and `trends KEY` stopped the review on any non-200. Until the deploy that is every run (the route is a 404), so step 1 of the routine would have failed nightly. Both now carry on.
  3. Verdicts reported in headline tense ("jury convicts", "judge jails", "jury acquits") were still flagged as live cases. Added `convicts`, `jails`, `acquits` to the settled words (Python and Worker share `text_rules.json`; parity regenerated). "guilty verdict" was deliberately left out: "verdict expected next week" must keep the warning, because a wrong "settled" removes the caution.
- Totals: 274 JS, 57 collector Python, 86 kit, all passing; UI bundle builds.

### Phase 7: docs (done 2026-11-27)
- `trends/README.md`: how it fits together (diagram), switching it on, environment variables, sources, the niche gate in numbers, how a trend is scored (with the Trends tab's labels), adding an account, adding a source (official, free, no scraping), when something looks wrong, limits.
- `PLAYBOOK.md`: the Trends alerts in the alert table, "Trends tab: approve or reject" (phone guide), the Trends data row, troubleshooting pointer.
- `README.md`: Trends in "How it fits together", the tab list and the folder table.
- `test/e2e/README.md`: four Trends checks for the phone-size run.
- Checked against the code as written; three wrong first-draft claims were corrected (what "Audience" measures, where history fit applies, and that weights are changed through the API, not in the app).

## Status
All 7 phases built on branch `trend-intelligence`, not deployed. Max's steps: merge to main (deploys, migrations 0004-0006), set `TRENDS_POST=on`, run the collector once, optional YouTube key. Not yet checked on a real iPhone: the Trends tab was checked at 375 px in the browser only.
