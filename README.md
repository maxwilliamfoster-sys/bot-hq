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

Plan: `docs/superpowers/plans/2026-10-19-bot-hq.md`.
