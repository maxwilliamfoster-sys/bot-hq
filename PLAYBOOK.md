# Bot HQ playbook

How to run Bot HQ day to day. Everything here costs £0. Never paste a secret into this repo;
secrets go in `npx wrangler secret put <NAME>` or the GitHub repo secrets only.

## What each alert means

| In the app | Kinds | What to do |
|---|---|---|
| **Needs you** (red, always pushed, even in quiet hours) | `run_failed`, `credential_expired`, `needs_you`, `no_posts`, `orphan_post`, `post_lost`, `no_videos`, `ai_down` | Open it, tap **Copy fix prompt**, paste into Claude. When it's fixed, tap **Mark done**. |
| **Failed** (warn) | `post_failed`, `gate_blocked`, `delivery_failed`, `slot_missed`, `post_rewound`, `watcher_error` | Usually fixes itself on the next run. Repeats are grouped ("3× in 24h"); act if it keeps coming back. |
| **Doing well** (good) | `doing_well` | A post is in its bot's top 10% at 1h, 6h or 24h. Sent once per post per age. |
| **Posted** (quiet) | `posted` | Nothing. Every publish. |
| **Summary** | `summary` (07:30 UK, pushed), `digest` (chess loop_nightly text, Inbox only) | Read it. |

The same failure inside 24 hours becomes one card with a count, pushed on the 1st and 3rd time only.
`watcher_error` means Bot HQ itself couldn't read GitHub, YouTube or Buffer for one step; it retries every 5 minutes.

## Add a device (iPhone, iOS 16.4 or newer)
1. Open the app link in **Safari**, then Share → **Add to Home Screen**.
2. Open it from the home screen (push only works there, not in a Safari tab).
3. Enter the access code, then go to **Settings → Turn on notifications** and allow them.
4. Tap **Send test notification**.

To remove a device: Settings → **Disconnect this device** on that device. Expired devices are removed automatically.

## Rotate the access code
1. Pick a new code (6 random words is plenty).
2. Store only its SHA-256 hash:
   ```
   py -c "import hashlib,getpass;print(hashlib.sha256(getpass.getpass('code: ').strip().encode()).hexdigest())" | npx wrangler secret put ACCESS_CODE_HASH
   ```
3. Sign everyone out (optional): `npx wrangler d1 execute bot-hq-db --remote --command "DELETE FROM sessions"`.

## Rotate the bot token (`APP_EVENTS_TOKEN`)
The same random token lives in 4 places. Generate one, then set it everywhere in one go:
```
py -c "import secrets;print(secrets.token_urlsafe(32))" > .secrets.local
for r in chess-puzzle-automation youtube-automation escape-cup bot-hq; do gh secret set APP_EVENTS_TOKEN -R maxwilliamfoster-sys/$r < .secrets.local; done
npx wrangler secret put APP_EVENTS_TOKEN < .secrets.local
```
`.secrets.local` is git-ignored; local tests read it. Until all 4 match, bot alerts fall back to Telegram, so nothing is lost.

## Add a new event kind
1. In the bot, call `app_events.emit(bot, "<new_kind>", "<action|warn|good|info>", title, body, data)`.
   Use the shared `app_events.py` (master in growth-lab, copied byte-identical; check md5 after copying).
2. Write a plain-English title the user can act on ("Chess: no upload for 16h", not "check_posting failed").
3. If it should never push, add it to `shouldPush` in `src/rules.js` with a test first.
4. Add it to the table above.

## Where the numbers come from
| Data | Source | How fresh |
|---|---|---|
| Chess views/likes | YouTube Data API, every 5 min for videos under 7 days old | ~5 min |
| TikTok views (BCF, Escape) | Buffer GraphQL, hourly | as fresh as Buffer's own metrics |
| History, followers, gate logs | `ingest/backfill.py`, nightly at 03:15 UTC (GitHub Action) | daily |
| Run results | GitHub Actions API, every 5 min | ~5 min |

Each screen shows "Updated …" or "Views from N ago", so you can see how fresh it is.

## When something looks wrong
- **No pushes at all:** Settings shows "Not connected"? Reconnect. Still nothing: `npx wrangler tail` and fire a test.
- **Graphs empty:** check the "Nightly backfill" Action ran (`gh run list -w "Nightly backfill"`). Views at 1h/6h/24h/72h fill about 4 hours after each age.
- **"Bot HQ watcher error":** open it; the step name says which source failed. A rotated key (`YT_API_KEY`, `BUFFER_API_KEY`, `GH_READ_TOKEN`) is the usual cause; re-set it with `wrangler secret put`.
- **Free-tier limits:** `npx wrangler tail` and look for "Too many subrequests" or "exceeded CPU". The design stays well under them; if they appear, copy the log into Claude.
