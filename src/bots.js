// The content bots (and Bot HQ itself) as the rest of the code refers to them.
export const OWNER = "maxwilliamfoster-sys";

export const BOTS = {
  chess: { name: "Chess", repo: "chess-puzzle-automation", note: "chess_puzzle_automation", planned: 3 },
  bcf: { name: "BuriedCasefiles", repo: "youtube-automation", note: "buriedcasefiles_automation", planned: 3 },
  escape: { name: "Escape Cup", repo: "escape-cup", note: "escape_cup_tiktok", planned: 3 },
  space: { name: "Space Edits", repo: "space-edits", note: "space_edits", planned: 3 },
  eagle: { name: "Eagle Eyes", repo: "level-up-quiz", note: "level_up_quiz", planned: 3 },
  // Runs on Max's PC (Blender needs the GPU), so it has no GitHub runs; it checks in with a heartbeat.
  bodge: { name: "Bodge Delivers", repo: "bodge-delivers", dir: "what-if-shorts", note: "what_if_shorts", planned: 1 },
  system: { name: "Bot HQ", repo: "bot-hq", note: "bot_hq", planned: 0 },
};

export const BOT_IDS = ["chess", "bcf", "escape", "space", "eagle", "bodge"];

export function localRepoPath(bot) {
  return bot === "system"
    ? "C:\\Users\\maxwi\\Projects\\Apps\\bot-hq"
    : `C:\\Users\\maxwi\\Projects\\Content-Bots\\${BOTS[bot].dir || BOTS[bot].repo}`;
}

export const botForRepo = repo => Object.keys(BOTS).find(b => BOTS[b].repo === repo);

export const clock = env => (env?.NOW ? env.NOW() : new Date());
