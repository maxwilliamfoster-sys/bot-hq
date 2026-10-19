# Graphs tab check (Playwright MCP, iPhone 15 viewport 393x852)

Run against `npx wrangler dev --port 8787 --ip 127.0.0.1 --test-scheduled` with history
backfilled into the local D1 and a few cron ticks fired
(`curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"`) so milestones exist.

1. Resize to 393x852. Sign in. Go to `#/graphs`.
   Expect: heading "Graphs", a "New graph" button, the 4 preset tiles.
2. Tap "New graph".
   Expect: pickers Metric, Bots, Range, Group by, Chart, Split; a live preview.
3. Pick Metric "Views at 24h", Bots: only Chess, Range "All", Group by "Time of day", Chart "Bar".
   Expect: within ~1 s the preview shows a bar chart (canvas) and no "Not enough data" text.
4. Tap "Table".
   Expect: a table with hours 00:00..23:00 rows and a post count per row.
5. Type the name "Chess hours" and tap "Save graph".
   Expect: back on the tiles, a tile "Chess hours" is there (5 tiles).
6. Reload the page.
   Expect: the "Chess hours" tile is still there.
7. Tap the tile.
   Expect: full-screen chart with its name as the heading, "Edit" and "Back" controls.
8. Long-press the tile (pointerdown 600 ms) on the tiles screen.
   Expect: a sheet with "Rename", "Delete" and "Cancel". Tap "Delete": the tile is gone.
9. Console: no errors. `public/app.js` < 250 KB after `npm run build`.
