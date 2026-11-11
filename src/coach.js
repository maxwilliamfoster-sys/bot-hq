// The coach: reads each account's view pattern, says what it means, and writes the message to paste
// into Claude when an account needs new work. Pure functions; schedule.js feeds them from D1.
//
// Source for every rule and every piece of advice here:
//   Content-Bots/analytics-check/research_notes/2026-11-10 view caps and shadowbans.md  (section 4 = these rules)
//   Content-Bots/analytics-check/reviews/2026-11-09/CHESS_2K_CEILING.md
//   Content-Bots/giftok-bot/research/audio_copyright_2026-11-10.md
// Neither TikTok nor YouTube publishes a view cap. A video gets a small test audience and is shown to
// more people only if that audience stays. So "stuck at the same number" is nearly always a test that
// keeps failing, not a ban. The rules below separate that from the rarer real restriction.
import { BOTS, localRepoPath } from "./bots.js";
import { RULES } from "./prompt.js";

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const round = n => Math.round(n);

export const RECENT = 5;          // videos judged
export const BASE_MIN = 10;       // older videos needed before anything is said
export const BASE_MAX = 20;
export const POOL = 15;           // videos used to measure how tightly views cluster

// What each verdict means, in plain words. `push` = worth a notification; `tone` = colour in the app.
export const VERDICTS = {
  learning: { label: "Still learning", tone: "info", push: false,
    means: "Not enough videos past 3 days old to judge yet." },
  healthy: { label: "Normal", tone: "good", push: false,
    means: "Views vary from video to video, which is what a working account looks like." },
  breakout: { label: "Breakout", tone: "good", push: true,
    means: "A video was shown far beyond the usual test audience. Whatever it did differently is worth repeating." },
  plateau: { label: "Stuck at one level", tone: "warn", push: false,
    means: "Every video gets about the same views. Each one is shown to one test audience and never to more people, because too few of them stay. This is not a ban: the opening of the videos has to change." },
  capped: { label: "Tiny audience every time", tone: "action", push: true,
    means: "Every video gets nearly the same very low number, whatever the video is like. That can be an account-level limit. Only the app's own notices can confirm it." },
  shift: { label: "Sudden drop", tone: "action", push: true,
    means: "Four of the last five videos did worse than nine in ten of the videos before them. That almost never happens by chance: something changed (posting rate, format, or a restriction)." },
  unserved: { label: "Not being shown", tone: "action", push: true,
    means: "The last two videos got almost no views in their first day. A video that is tested always gets some." },
};

// rows: one account's posts, newest first: { posted_at, v24, v72 } (views at 24 h / 72 h, null if too young).
export function viewHealth(rows, { platform = "tiktok" } = {}) {
  const matured = rows.filter(r => r.v72 != null);
  const base = matured.slice(RECENT, RECENT + BASE_MAX);
  if (matured.length < RECENT || base.length < BASE_MIN) return { code: "learning", n: matured.length };
  const recent = matured.slice(0, RECENT);
  const baseV = base.map(r => r.v72);
  const median = quantile(baseV, 0.5), p10 = quantile(baseV, 0.1);
  const recentMedian = quantile(recent.map(r => r.v72), 0.5);
  const out = { n: matured.length, median: round(median), recent: round(recentMedian) };

  const base24 = quantile(base.filter(r => r.v24 != null).map(r => r.v24), 0.5);
  const firstDay = rows.filter(r => r.v24 != null).slice(0, 2);
  if (base24 && firstDay.length === 2 && firstDay.every(r => r.v24 < Math.max(10, 0.05 * base24))) {
    return { ...out, code: "unserved", first_day: firstDay.map(r => round(r.v24)), usual_first_day: round(base24) };
  }
  const best = Math.max(...recent.map(r => r.v72));
  if (best >= 3 * median && best >= 300) return { ...out, code: "breakout", best: round(best) };
  if (recent.filter(r => r.v72 < p10).length >= RECENT - 1) return { ...out, code: "shift", p10: round(p10) };

  const pool = matured.slice(0, POOL).map(r => r.v72);
  const p25 = quantile(pool, 0.25), p75 = quantile(pool, 0.75), mid = quantile(pool, 0.5);
  const spread = p25 > 0 ? p75 / p25 : Infinity;
  if (pool.length >= POOL) {
    if (platform === "tiktok" && spread < 1.35 && mid < 150) return { ...out, code: "capped", low: round(p25), high: round(p75) };
    if (spread < 1.6) return { ...out, code: "plateau", low: round(p25), high: round(p75) };
  }
  return { ...out, code: "healthy" };
}

// Per account: why views stall on this kind of content and the changes that help, most useful first.
// `checks` are things only Max can see (TikTok and YouTube show restrictions in their own apps, nowhere else).
export const PLAYBOOK = {
  chess: {
    platform: "youtube",
    risk: "Every Short gets one test audience of about 1,000 plays and no second push, because only about a third of viewers stay past the first second.",
    steps: [
      "Judge every change on the share of viewers who stay (engaged views divided by views); aim for half or more. Nothing else has moved views.",
      "Finish the queued tests in order: new opening, full-screen layout, Pip the mascot.",
      "Add the 'Brilliant or blunder?' twist and a 10-second cut as a new format, so the channel rotates three or four clearly different formats.",
      "Drop to 1 or 2 Shorts a day once the tests are judged: more near-identical uploads only repeat a failed test.",
      "Give each Short one written verdict or teaching line of its own.",
    ],
    checks: ["YouTube Studio > Content: the Restrictions column should be empty.", "Studio > Analytics > Reach: 'Viewed vs swiped away' for the last 10 Shorts."],
  },
  bcf: {
    platform: "tiktok",
    risk: "True crime sits close to TikTok's sensitive-content rules, and narration over stock clips can count as content with little added.",
    steps: [
      "Open the 10 best and 10 worst recent posts in TikTok and look for a 'not eligible for For You' notice. The reason given says what to change.",
      "Open each video on something specific to the case in the first 3 seconds (a map pin and year, a timeline card, the court outcome).",
      "Never reuse the same first three words within 15 posts.",
      "Keep hooks and captions free of graphic detail, and keep the AI label on.",
      "Stay at 3 a day or fewer, at least 4 hours apart.",
    ],
    checks: ["TikTok > Settings > Account > Account status (or the system inbox) for violations.", "Each post's Analytics page: For You share, and any eligibility notice."],
  },
  escape: {
    platform: "tiktok",
    risk: "Views collapsed once before when the posting rate went up, and every video has the same layout.",
    steps: [
      "Never post more than 3 a day; go back to 2 if views drop after a change.",
      "Add variety a viewer can see: arena shape, ring rules, number of teams. Colour themes do not count.",
      "Keep the tournament story going (standings, champion, next fixture) so each video differs by content.",
      "Never raise the posting rate and change the format in the same week.",
    ],
    checks: ["TikTok Studio: the For You share of the last 5 posts.", "Account status page for any notice."],
  },
  space: {
    platform: "tiktok",
    risk: "Agency footage with text over it is the closest thing here to 'reused material with nothing new', which TikTok does not recommend.",
    steps: [
      "Every edit adds a named target and one specific fact or size comparison of its own.",
      "Never reuse a hook line within 20 posts.",
      "Never use a clip carrying another editor's or channel's watermark; keep the source credit.",
      "Stay at 3 a day or fewer.",
      "If any post shows 'sound removed', drop that track from the music list.",
    ],
    checks: ["Each post's Analytics page for an eligibility notice.", "Any 'sound removed' banner on recent posts."],
  },
  eagle: {
    platform: "tiktok",
    risk: "Every post lands in the same tiny band of views even when viewers watch three times longer, which fits an account-level limit or an opening that never earns a wider test.",
    steps: [
      "Do the manual checks below and tell Claude the result. Until then no format change can be credited or blamed.",
      "Try a speed round: 3 levels in about 12 seconds, hardest-looking first.",
      "Change the look between posts (colours, shapes, objects) so the grids are not identical.",
      "If three clearly different formats of 5 posts each all land in the same band, treat it as account-level and ask TikTok through 'Report a problem'.",
    ],
    checks: ["TikTok > Settings > Account > Account status.", "The date of birth on the account is correct.", "Each post's Analytics: For You share and any notice."],
  },
  perc: {
    platform: "tiktok",
    risk: "TikTok names 'short clips made from GIFs only' as content it does not recommend, GIFs often carry someone's watermark, and baked-in music can be muted.",
    steps: [
      "Music: only licensed (CC BY) producer beats, credited in the caption. Done 11 Nov 2026. If a post is still muted, tell Claude which one.",
      "Never post a single GIF: always the caption plus 2 to 4 GIFs with cuts, a speed change or a zoom.",
      "Only GIFs with no watermark or logo. Never crop a watermark off.",
      "Clean captions only: nothing sexual, no drugs, no insults.",
      "1 or 2 posts a day at most.",
      "For a sound TikTok itself licenses, post as a draft and add the sound in the app (one tap per post).",
    ],
    checks: ["Each post for a 'sound removed' or muted notice.", "Each post's Analytics for a 'not eligible for For You' notice.", "On the 4 posts from 6 to 10 Nov, use 'Change sound' if any is muted: they used unlicensed songs."],
  },
  bodge: {
    platform: "youtube",
    risk: "Too new to judge. One premise repeated daily is close to what YouTube calls templated content.",
    steps: [
      "Vary the mechanic, not only the object (doubling, halving, racing, queueing, stacking); no mechanic more than twice in 7 posts.",
      "Stay at 1 a day until 20 Shorts are 3 days old.",
      "Keep the title-similarity check as a hard block.",
    ],
    checks: ["YouTube Studio > Content: the Restrictions column."],
  },
};

const ASKS = {
  breakout: bot => `A ${BOTS[bot].name} video broke out. Find what it did differently from the ones around it (opening frame, length, title, topic, time posted), then make that the default or queue it as the next test.`,
  capped: () => "Work out whether this is an account-level limit or a format problem. Start from the manual checks I have filled in below, then change one thing at a time.",
  shift: () => "Find what changed just before the drop: posting rate first, then any format or code change in the change log, then platform notices. Undo the cause or queue a fix.",
  unserved: () => "Find out why the last two videos were not shown: check the posts really went out, their processing or review state, and the time they were posted.",
  review: () => "Do the full review of every account: what the last two weeks of numbers show, which tests can be judged, and the next change for each account.",
};

// The message Max pastes into Claude. `filled` = what he saw in the manual checks (optional).
export function buildCoachPrompt({ bot, code, numbers = {}, verdicts = null }) {
  if (code === "review") {
    const lines = ["Do the fortnightly review of my content bots.", "",
      "Read first: C:\\Users\\maxwi\\Projects\\Content-Bots\\analytics-check\\TRACKER.md, then run the analytics check.", ""];
    if (verdicts) {
      lines.push("What Bot HQ sees right now:");
      for (const [b, v] of Object.entries(verdicts)) {
        if (BOTS[b] && VERDICTS[v.code]) lines.push(`- ${BOTS[b].name}: ${VERDICTS[v.code].label}${v.median ? ` (usually ${v.median} views at 3 days, last five ${v.recent})` : ""}`);
      }
      lines.push("");
    }
    lines.push(ASKS.review(), "", "For each account, do the first step of its playbook that is not done yet (Bot HQ > Bots > the account's playbook; the same list is in bot-hq/src/coach.js).",
      "", RULES, "", "Log every change in the tracker and tell me what you changed, what you checked, and what I need to do myself.");
    return lines.join("\n");
  }
  const info = BOTS[bot], book = PLAYBOOK[bot], v = VERDICTS[code];
  const lines = [
    `Improve my ${info.name} account. Repo: ${localRepoPath(bot)}.`, "",
    `What Bot HQ found: ${v.label}. ${v.means}`,
  ];
  const facts = [];
  if (numbers.median != null) facts.push(`usual views at 3 days old: ${numbers.median}`);
  if (numbers.recent != null) facts.push(`last five: ${numbers.recent}`);
  if (numbers.best != null) facts.push(`best recent video: ${numbers.best}`);
  if (numbers.low != null) facts.push(`middle half of videos: ${numbers.low} to ${numbers.high}`);
  if (numbers.first_day) facts.push(`first-day views of the last two: ${numbers.first_day.join(" and ")} (usually ${numbers.usual_first_day})`);
  if (facts.length) lines.push(`Numbers: ${facts.join("; ")}.`);
  lines.push("", `What I need you to do: ${(ASKS[code] || ASKS.shift)(bot)}`);
  if (book) {
    lines.push("", `Known risk for this account: ${book.risk}`, "", "The playbook for this account, most useful first. Check the tracker for what is already done and do the first step that is not:");
    book.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("", "What I saw when I checked the app myself (I will fill these in before sending):");
    book.checks.forEach(c => lines.push(`- ${c} -> `));
  }
  lines.push("", `Read first: memory note ${info.note}.md and C:\\Users\\maxwi\\Projects\\Content-Bots\\analytics-check\\TRACKER.md`,
    "", RULES, "", "Work on the cause, not the symptom. Test it, push it, log it in the tracker, and tell me what to look for next.");
  return lines.join("\n");
}

// The event for one account's verdict, or null when it is not worth a notification.
export function coachEvent(bot, health) {
  const v = VERDICTS[health.code];
  if (!v || !v.push) return null;
  const name = BOTS[bot].name;
  const titles = {
    breakout: `${name}: a video broke out (${health.best} views). Time to build on it`,
    capped: `${name}: every video stops at ${health.low}-${health.high} views. Ask Claude to look`,
    shift: `${name}: views dropped to ${health.recent} from ${health.median}. Ask Claude to look`,
    unserved: `${name}: the last two videos were barely shown. Ask Claude to look`,
  };
  return {
    bot, kind: "coach", severity: health.code === "breakout" ? "good" : "action", title: titles[health.code].slice(0, 120),
    body: `${v.means}\n\nDo the checks listed in the message first (they take two minutes in the app), then tap Copy message and paste it into Claude.`,
    data: { code: health.code, numbers: health }, dedupe_key: `coach:${bot}:${health.code}`,
  };
}

export const REVIEW_EVERY_DAYS = 14;
export function reviewEvent(verdicts) {
  return {
    bot: "system", kind: "coach", severity: "action", title: "Time for the two-week review with Claude",
    body: "Two weeks of new numbers are in. Tap Copy message and paste it into Claude: it reviews every account and makes the next change for each.",
    data: { code: "review", verdicts }, dedupe_key: "coach:review",
  };
}
