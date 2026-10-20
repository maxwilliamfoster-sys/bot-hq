// Bot HQ Worker: /api/* goes to the API; everything else is the static app (public/).
import { handle } from "./api.js";
import { runSchedule } from "./schedule.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handle(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    // The tick's own time, not the clock: a late start must not slip past the hourly/:30 checks.
    ctx.waitUntil(runSchedule(event, env, ctx, fetch, new Date(event.scheduledTime || Date.now())));
  },
};
