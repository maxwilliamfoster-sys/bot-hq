// Shorts Radar for the phone: reads the chess report the radar publishes on its public data branch.
import { OWNER, localRepoPath } from "./bots.js";

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
