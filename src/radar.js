// Shorts Radar for the phone: reads the chess report the radar publishes on its public data branch.
import { OWNER, localRepoPath } from "./bots.js";
import { getState, setState } from "./settings.js";
import { processEvent } from "./events.js";

const RADAR_URL = `https://raw.githubusercontent.com/${OWNER}/shorts-radar/data/insights/chess.json`;
const MIN_LIFT = 1.1;

export async function radarData(fetchFn = fetch) {
  let d;
  try {
    const res = await fetchFn(RADAR_URL, { cf: { cacheTtl: 600 } });
    if (!res.ok) return { available: false };
    d = await res.json();
  } catch {
    return { available: false };
  }
  if (!d || typeof d !== "object" || !d.generated) return { available: false };
  return {
    available: true,
    generated: new Date(d.generated * 1000).toISOString(),
    n_videos: d.n_videos, n_scored: d.n_scored, n_channels: d.n_channels,
    you: d.you || null,
    winner_median_duration: d.winner_median_duration ?? null,
    breaking: d.breaking || [],
    top_outliers: d.top_outliers || [],
    levers: (d.feature_lift || []).filter(l => l.lift >= MIN_LIFT).slice(0, 8),
    winning_words: d.winning_words || [],
    gaps: d.gaps || [],
    hypotheses: d.hypotheses || [],
    prompt: d.claude_prompt ? d.claude_prompt.replaceAll("@@REPO@@", localRepoPath("chess")) : null,
  };
}

// ---- weekly reminder: "a week of data is ready, paste the prompt" ----------
const WEEK_MS = 7 * 24 * 3600e3;
const FRESH_MS = 30 * 3600e3;      // the daily 07:00 UTC report, with room for a late run

export async function weeklyRadarCheck(env, db, fetchFn, now) {
  const last = await getState(db, "radar_weekly_at");
  if (!last) return setState(db, "radar_weekly_at", now.toISOString());   // first look: start the clock
  if (now.getTime() - Date.parse(last) < WEEK_MS) return;
  const r = await radarData(fetchFn);
  if (!r.available || now.getTime() - Date.parse(r.generated) > FRESH_MS) return;   // retry next hour
  await setState(db, "radar_weekly_at", now.toISOString());
  await processEvent(env, {
    bot: "chess", kind: "radar_weekly", severity: "action",
    title: "Chess Radar: a week of data is ready",
    body: "Open the Radar tab, copy the prompt and paste it into Claude. It picks this week's A/B tests from the data.",
    data: {}, dedupe_key: `radar_weekly:${now.toISOString().slice(0, 10)}`,
  }, now);
}
