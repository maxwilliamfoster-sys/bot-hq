# Bot HQ

A phone app (installable web app) for the three content bots: chess Shorts, BuriedCasefiles and Escape Cup.

- Push notifications when something needs you, a post fails, does well or goes out, plus a 07:30 daily summary.
- Live analytics and custom graphs.
- A copy-paste Claude fix prompt for every failure.

It runs on one Cloudflare Worker with a D1 database, on the free tier (£0). Secrets live only in `wrangler secret` / GitHub secrets — never in this repo.

```
npm install
npm test          # unit tests (D1 is faked with node:sqlite)
npm run build     # bundles src/ui -> public/app.js
npx wrangler dev  # local
```

## How it fits together
- **Bots → app:** each bot calls `app_events.emit(...)`, which POSTs to `/api/event` with the bearer `APP_EVENTS_TOKEN`. If the app can't be reached the alert falls back to Telegram, so nothing is lost. Videos still go to Telegram.
- **Watchers (cron every 5 min):** GitHub Actions runs (failed runs get the log tail in the fix prompt), YouTube stats, Buffer stats (hourly), posting gaps, upload-gate logs, "doing well" milestones, snapshot thinning (03:00 UTC) and the 07:30 UK summary.
- **Backfill:** `ingest/backfill.py` (GitHub Action, nightly 03:15 UTC) reads the history the bots commit and sends it to `/api/ingest`.
- **App:** `src/ui/` (vanilla JS + Chart.js, bundled by esbuild into `public/app.js`). Tabs: Inbox, Live, Graphs, Bots, Settings.

| Folder | What's in it |
|---|---|
| `src/` | Worker: API routes, auth, events, push, watchers (`src/watch/`), graphs (`query.js`) |
| `src/ui/` | The app screens |
| `migrations/` | D1 schema |
| `ingest/` | Backfill script + its tests (`py -m unittest ingest.test_backfill`) |
| `test/` | `node --test` suite; `test/e2e/` phone-size checklists |

How to use and run it day to day: [PLAYBOOK.md](PLAYBOOK.md). Plan: `docs/superpowers/plans/2026-10-19-bot-hq.md`.
