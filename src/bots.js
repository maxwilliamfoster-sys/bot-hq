// The content bots (and Bot HQ itself) as the rest of the code refers to them.
export const OWNER = "maxwilliamfoster-sys";

export const BOTS = {
  chess: { name: "Chess", repo: "chess-puzzle-automation", note: "chess_puzzle_automation", planned: 3 },
  bcf: { name: "BuriedCasefiles", repo: "youtube-automation", note: "buriedcasefiles_automation", planned: 3 },
  escape: { name: "Escape Cup", repo: "escape-cup", note: "escape_cup_tiktok", planned: 3 },
  space: { name: "Space Edits", repo: "space-edits", note: "space_edits", planned: 3 },
  // Stopped by Max 18 Nov 2026 (its Zernio slot went to niche house; level-up-quiz workflows disabled). A stopped
  // bot never pushes and gets no "no posts" alerts; remove `stopped` to bring it back.
  eagle: { name: "Eagle Eyes", repo: "level-up-quiz", note: "level_up_quiz", planned: 3, stopped: "2026-11-18" },
  // @perc.cruncher giftok posts: 2 a day (16:00-17:45 / 19:00-21:45 UK) through Zernio, shared with Eagle Eyes.
  perc: { name: "Perc Cruncher", repo: "giftok-bot", note: "giftok_bot", planned: 2 },
  // Runs on Max's PC (Blender needs the GPU), so it has no GitHub runs; it checks in with a heartbeat.
  bodge: { name: "Bodge Delivers", repo: "bodge-delivers", dir: "what-if-shorts", note: "what_if_shorts", planned: 1 },
  // Instagram Reels made on Max's PC (GPU), posted at 18:00 by a Claude task. It sends its own posts, views
  // (kind "stats") and a heartbeat, because only the PC can reach the Instagram token (VaultBridge).
  gary: { name: "Gary the Bin Fox", repo: "gary-bin-fox", note: "gary_bin_fox", planned: 1, platform: "instagram" },
  // Old 10k TikTok @iluvgarry: one niche house edit a day through Zernio (same workspace as Perc), GitHub Actions.
  niche: { name: "Niche House", repo: "niche-house-edits", note: "niche_house_edits", planned: 1 },
  system: { name: "Bot HQ", repo: "bot-hq", note: "bot_hq", planned: 0 },
};

export const BOT_IDS = ["chess", "bcf", "escape", "space", "eagle", "perc", "bodge", "gary", "niche"];
// Bots that run on Max's PC: no GitHub Actions; they check in with a heartbeat and report their own posts.
export const PC_BOTS = ["bodge", "gary"];

export function localRepoPath(bot) {
  return bot === "system"
    ? "C:\\Users\\maxwi\\Projects\\Apps\\bot-hq"
    : `C:\\Users\\maxwi\\Projects\\Content-Bots\\${BOTS[bot].dir || BOTS[bot].repo}`;
}

export const botForRepo = repo => Object.keys(BOTS).find(b => BOTS[b].repo === repo);

export const clock = env => (env?.NOW ? env.NOW() : new Date());
