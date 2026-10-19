// The three bots (and Bot HQ itself) as the rest of the code refers to them.
export const OWNER = "maxwilliamfoster-sys";

export const BOTS = {
  chess: { name: "Chess", repo: "chess-puzzle-automation", note: "chess_puzzle_automation", planned: 3 },
  bcf: { name: "BuriedCasefiles", repo: "youtube-automation", note: "buriedcasefiles_automation", planned: 3 },
  escape: { name: "Escape Cup", repo: "escape-cup", note: "escape_cup_tiktok", planned: 2 },
  system: { name: "Bot HQ", repo: "bot-hq", note: "bot_hq", planned: 0 },
};

export const BOT_IDS = ["chess", "bcf", "escape"];

export function localRepoPath(bot) {
  return bot === "system"
    ? "C:\\Users\\maxwi\\Projects\\Apps\\bot-hq"
    : `C:\\Users\\maxwi\\Projects\\Content-Bots\\${BOTS[bot].repo}`;
}

export const botForRepo = repo => Object.keys(BOTS).find(b => BOTS[b].repo === repo);

export const clock = env => (env?.NOW ? env.NOW() : new Date());
