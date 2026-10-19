# End-to-end checks

Run with the Playwright MCP at iPhone 15 size (393x852, touch, DPR 3) in a fresh, signed-out
browser context. Screenshots go in `test/e2e/shots/` (git-ignored). Graph-specific steps are in
[graphs.md](graphs.md).

| # | Check | Pass when |
|---|---|---|
| 1 | Sign in | Wrong code shows "That code isn't right"; the right code opens the Inbox |
| 2 | Filter chips | Needs you / Failed / Doing well / Posted / Summary / All each show their events or the empty text |
| 3 | Open an event | The needs card opens `#/event/<id>` with What happened, What to do, Fix prompt |
| 4 | Copy fix prompt | The clipboard holds the whole prompt (starts "Fix my <bot> bot", includes the log tail) |
| 5 | Mark done | Back on the Inbox it says "All clear" and the tab badge count is gone |
| 6 | Live | Three bot cards: Chess, BuriedCasefiles, Escape Cup |
| 7 | Build a graph | Pick metric/group/chart/split, name it, Save: a new tile appears |
| 8 | Settings persist | Flip "Posted", reload: it stays flipped (flip it back after) |
| 9 | Console | No errors except the expected 401 from the signed-out session check |

## Only the real iPhone can check these (record the result and the date)

| Check | Done on | Result |
|---|---|---|
| Add to Home Screen, open, sign in, "Turn on notifications" | real iPhone | not yet |
| "Send test notification" arrives with the screen locked | real iPhone | not yet |
| Tapping the notification opens that event | real iPhone | not yet |
| Copy fix prompt works in the installed app | real iPhone | not yet |
| App icon badge shows the open "Needs you" count | real iPhone | not yet |

## Last run
2026-10-19 against local `wrangler dev` with the full real backfill (not yet the deployed app):
checks 1-9 passed in Playwright Chromium. Simulated only, no real-device checks yet.
