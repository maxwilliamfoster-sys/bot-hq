// Watches the bots' GitHub Actions runs. A new failed run becomes a "Needs you" event
// carrying the failed step and the end of its log, so the fix prompt is self-contained.
import { BOTS, OWNER, botForRepo } from "../bots.js";
import { processEvent } from "../events.js";

const API = "https://api.github.com";
const REPOS = ["chess-puzzle-automation", "youtube-automation", "escape-cup", "bot-hq"];
const ACTION = new Set(["failure", "timed_out", "startup_failure"]);
const LOG_BYTES = 16000;
const LOG_LINES = 60;
// Each alerted run costs 3 GitHub fetches plus one per phone; the free plan allows 50 a tick.
const DETAILS_PER_TICK = 3;
const RETRY_MS = 2 * 24 * 3600e3;      // an unalerted run older than this is history, not news

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
    if (log.status === 206) {
      const text = await log.text();
      // A ranged read starts mid-line; drop the partial first line.
      out.log_tail = tailLines(text.slice(text.indexOf("\n") + 1), LOG_LINES).slice(-6000);
    } else {
      await log.body?.cancel();    // Range ignored: the whole log could blow the CPU/memory budget
    }
  } catch { /* the alert still goes out, the prompt says the log was unavailable */ }
  return out;
}

// Stored runs have no trigger `event`; only alert-worthy runs are stored with alerted = 0.
function eventFor(repo, run) {
  const bot = botForRepo(repo) || "system";
  const name = BOTS[bot].name;
  const workflow = run.name || run.workflow || "workflow";
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
  let budget = DETAILS_PER_TICK;
  const stale = new Date(now.getTime() - RETRY_MS).toISOString();
  for (const repo of REPOS) {
    try {
      const seeding = !(await db.prepare("SELECT 1 AS x FROM runs WHERE repo = ? LIMIT 1").bind(repo).first("x"));
      const { workflow_runs = [] } = await ghJson(env, fetchFn,
        `/repos/${OWNER}/${repo}/actions/runs?per_page=10&status=completed`);
      if (workflow_runs.length) {
        const ids = workflow_runs.map(r => r.id);
        const { results: seen } = await db.prepare(
          `SELECT run_id FROM runs WHERE repo = ? AND run_id IN (${ids.map(() => "?").join(",")})`).bind(repo, ...ids).all();
        const seenIds = new Set(seen.map(r => Number(r.run_id)));
        const fresh = workflow_runs.filter(r => !seenIds.has(Number(r.id)));
        // Marked alerted only once the alert is recorded, so a tick that dies part-way retries next time.
        if (fresh.length) {
          await db.batch(fresh.map(run => db.prepare(
            "INSERT OR IGNORE INTO runs (repo, run_id, workflow, conclusion, at, url, alerted) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(repo, run.id, run.name, run.conclusion, run.updated_at || run.created_at, run.html_url,
              seeding || !eventFor(repo, run) ? 1 : 0)));
        }
      }
      if (seeding || budget <= 0) continue;
      const { results: pending } = await db.prepare(
        "SELECT run_id, workflow, conclusion, url FROM runs WHERE repo = ? AND alerted = 0 AND at > ? ORDER BY at, run_id LIMIT ?")
        .bind(repo, stale, budget).all();
      for (const run of pending) {
        budget--;
        const ev = eventFor(repo, run);
        const details = await failureDetails(env, fetchFn, repo, run.run_id);
        const r = await processEvent(env, {
          ...ev, kind: "run_failed", body: `Run finished: ${run.conclusion}.`,
          data: { run_url: run.url, repo, step: details.step, log_tail: details.log_tail },
          dedupe_key: `run:${repo}:${run.workflow}:${run.conclusion}`,
        }, now);
        await db.prepare("UPDATE runs SET alerted = 1 WHERE repo = ? AND run_id = ?").bind(repo, run.run_id).run();
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
