// Watches the bots' GitHub Actions runs. A new failed run becomes a "Needs you" event
// carrying the failed step and the end of its log, so the fix prompt is self-contained.
import { BOTS, OWNER, botForRepo } from "../bots.js";
import { processEvent } from "../events.js";

const API = "https://api.github.com";
const REPOS = ["chess-puzzle-automation", "youtube-automation", "escape-cup", "bot-hq"];
const ACTION = new Set(["failure", "timed_out", "startup_failure"]);
const LOG_BYTES = 16000;
const LOG_LINES = 60;

const ghHeaders = env => ({
  authorization: `Bearer ${env.GH_READ_TOKEN}`,
  accept: "application/vnd.github+json",
  "user-agent": "bot-hq",
  "x-github-api-version": "2022-11-28",
});

async function ghJson(env, fetchFn, path) {
  const res = await fetchFn(`${API}${path}`, { headers: ghHeaders(env) });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;

export function tailLines(text, n) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(l => l.replace(TS, ""));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).join("\n");
}

// The failed step's name and the last lines of its job log. Any failure -> blanks.
async function failureDetails(env, fetchFn, repo, runId) {
  const out = { step: "", log_tail: "" };
  try {
    const { jobs = [] } = await ghJson(env, fetchFn, `/repos/${OWNER}/${repo}/actions/runs/${runId}/jobs`);
    const job = jobs.find(j => j.conclusion === "failure") || jobs.find(j => j.conclusion && j.conclusion !== "success");
    if (!job) return out;
    out.step = (job.steps || []).find(s => s.conclusion === "failure")?.name || job.name || "";
    const redirect = await fetchFn(`${API}/repos/${OWNER}/${repo}/actions/jobs/${job.id}/logs`,
      { headers: ghHeaders(env), redirect: "manual" });
    const location = redirect.headers.get("location");
    if (!location) return out;
    const log = await fetchFn(location, { headers: { range: `bytes=-${LOG_BYTES}` } });
    if (log.ok) {
      const text = await log.text();
      // A ranged read starts mid-line; drop the partial first line.
      out.log_tail = tailLines(log.status === 206 ? text.slice(text.indexOf("\n") + 1) : text, LOG_LINES).slice(-6000);
    }
  } catch { /* the alert still goes out, the prompt says the log was unavailable */ }
  return out;
}

function eventFor(repo, run) {
  const bot = botForRepo(repo) || "system";
  const name = BOTS[bot].name;
  const workflow = run.name || "workflow";
  if (ACTION.has(run.conclusion)) {
    return { bot, severity: "action", title: `${name}: ${workflow} failed` };
  }
  if (run.conclusion === "cancelled" && run.event !== "workflow_dispatch") {
    return { bot, severity: "warn", title: `${name}: ${workflow} was cancelled` };
  }
  return null;
}

export async function checkRuns(env, db, fetchFn = fetch, now = new Date()) {
  if (!env.GH_READ_TOKEN) return [];
  const created = [];
  const errors = [];
  for (const repo of REPOS) {
    try {
      const seeding = !(await db.prepare("SELECT 1 AS x FROM runs WHERE repo = ? LIMIT 1").bind(repo).first("x"));
      const { workflow_runs = [] } = await ghJson(env, fetchFn,
        `/repos/${OWNER}/${repo}/actions/runs?per_page=10&status=completed`);
      if (!workflow_runs.length) continue;
      // Free-plan Workers have a small per-invocation query budget: one lookup + one batch per repo.
      const ids = workflow_runs.map(r => r.id);
      const { results: seen } = await db.prepare(
        `SELECT run_id FROM runs WHERE repo = ? AND run_id IN (${ids.map(() => "?").join(",")})`).bind(repo, ...ids).all();
      const seenIds = new Set(seen.map(r => Number(r.run_id)));
      const fresh = workflow_runs.filter(r => !seenIds.has(Number(r.id))).reverse();   // oldest first
      if (!fresh.length) continue;
      await db.batch(fresh.map(run => db.prepare(
        "INSERT OR IGNORE INTO runs (repo, run_id, workflow, conclusion, at, url, alerted) VALUES (?, ?, ?, ?, ?, ?, 0)")
        .bind(repo, run.id, run.name, run.conclusion, run.updated_at || run.created_at, run.html_url)));
      if (seeding) continue;
      for (const run of fresh) {
        const ev = eventFor(repo, run);
        if (!ev) continue;
        const details = await failureDetails(env, fetchFn, repo, run.id);
        const r = await processEvent(env, {
          ...ev, kind: "run_failed", body: `Run finished: ${run.conclusion}.`,
          data: { run_url: run.html_url, repo, step: details.step, log_tail: details.log_tail },
          dedupe_key: `run:${repo}:${run.name}:${run.conclusion}`,
        }, now);
        await db.prepare("UPDATE runs SET alerted = 1 WHERE repo = ? AND run_id = ?").bind(repo, run.id).run();
        created.push(r);
      }
    } catch (e) {
      console.error("checkRuns", repo, e?.message || e);
      errors.push(e);
    }
  }
  // One flaky repo is noise; all of them failing (bad token, GitHub down) needs reporting.
  if (errors.length === REPOS.length) throw errors[0];
  return created;
}
