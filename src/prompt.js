// The copy-paste prompt the owner gives Claude to fix a failure. Pure function.
import { BOTS, localRepoPath } from "./bots.js";

export const RULES = "Rules: £0 only. Never weaken or bypass the upload gate, narration check, BCF compliance/legal review, fact-checking, the 08:00-22:00 UK window or Buffer channel pinning. Don't disturb running A/B tests.";
export const ASK = "Find the root cause, fix it with a failing test first, push, and confirm the next real run is green.";

// A fence longer than any backtick run inside the log, so the log can't close it early.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map(s => s.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

export function buildFixPrompt({ bot, kind, title, body, repo, runUrl, step, logTail }) {
  const info = BOTS[bot] || BOTS.system;
  const lines = [
    `Fix my ${info.name} bot. Repo: ${localRepoPath(BOTS[bot] ? bot : "system")} (GitHub: ${repo || info.repo}).`,
    "",
    `What happened: ${title}`,
  ];
  if (body) lines.push(body);
  lines.push(`Alert type: ${kind}`);
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  if (step) lines.push(`Failed step: ${step}`);
  lines.push("");
  if (logTail && logTail.trim()) lines.push("Last log lines:", fenced(logTail.trimEnd()));
  else lines.push("(log unavailable - open the run link)");
  lines.push("", `Read first: memory note ${info.note}.md`, "", RULES, "", ASK);
  return lines.join("\n");
}
