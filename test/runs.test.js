import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRuns, tailLines } from "../src/watch/runs.js";
import { makeEnv } from "./helpers.js";

const NOW = new Date("2026-10-20T10:00:00Z");
const run = (id, conclusion, extra = {}) => ({
  id, name: "Post Chess Puzzle", conclusion, event: "schedule", status: "completed",
  html_url: `https://github.com/maxwilliamfoster-sys/chess-puzzle-automation/actions/runs/${id}`,
  created_at: "2026-10-20T09:47:00Z", updated_at: "2026-10-20T09:55:00Z", ...extra,
});
const LOG = Array.from({ length: 100 }, (_, i) => `2026-10-20T09:5${i % 10}:00.0000000Z line ${i}`).join("\n");

// Routes GitHub API URLs to canned answers. runs: {repo: [run]}
function fakeGitHub({ runs = {}, logStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push(url);
    const u = new URL(url);
    let m;
    if ((m = u.pathname.match(/^\/repos\/[^/]+\/([^/]+)\/actions\/runs$/))) {
      return Response.json({ workflow_runs: runs[m[1]] || [] });
    }
    if (u.pathname.match(/\/actions\/runs\/\d+\/jobs$/)) {
      return Response.json({ jobs: [{ id: 77, name: "post", conclusion: "failure", steps: [
        { name: "Set up job", conclusion: "success", number: 1 },
        { name: "Render and upload", conclusion: "failure", number: 2 },
        { name: "Commit state", conclusion: "skipped", number: 3 }] }] });
    }
    if (u.pathname.endsWith("/actions/jobs/77/logs")) {
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://blob.example/log.txt" } });
    }
    if (u.host === "blob.example") {
      assert.equal(new Headers(init.headers).get("range"), "bytes=-16000");
      return logStatus === 200 ? new Response(LOG, { status: 206 }) : new Response("no", { status: logStatus });
    }
    return new Response("[]", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const env = async () => makeEnv({ GH_READ_TOKEN: "ghtok", PUSH_FETCH: async () => new Response(null, { status: 201 }) });

test("first run seeds and alerts nothing", async () => {
  const e = await env();
  const out = await checkRuns(e, e.DB, fakeGitHub({ runs: { "chess-puzzle-automation": [run(1, "failure")] } }), NOW);
  assert.deepEqual(out, []);
  assert.equal(await e.DB.prepare("SELECT COUNT(*) n FROM runs").first("n"), 1);
});

test("a new failure gives one action event with the step and a 60-line log", async () => {
  const e = await env();
  await checkRuns(e, e.DB, fakeGitHub({ runs: { "chess-puzzle-automation": [run(1, "success")] } }), NOW);
  const gh = fakeGitHub({ runs: { "chess-puzzle-automation": [run(2, "failure"), run(1, "success")] } });
  const out = await checkRuns(e, e.DB, gh, NOW);
  assert.equal(out.length, 1);
  const ev = await e.DB.prepare("SELECT * FROM events").first();
  assert.equal(ev.severity, "action");
  assert.equal(ev.kind, "run_failed");
  assert.equal(ev.bot, "chess");
  assert.equal(ev.title, "Chess: Post Chess Puzzle failed");
  const data = JSON.parse(ev.data_json);
  assert.equal(data.step, "Render and upload");
  assert.equal(data.run_url, run(2).html_url);
  assert.equal(data.repo, "chess-puzzle-automation");
  assert.equal(data.log_tail.split("\n").length, 60);
  assert.match(data.log_tail, /line 99$/);
  assert.doesNotMatch(data.log_tail, /^2026-10-20T/m);    // timestamps stripped
  assert.match(ev.fix_prompt, /Failed step: Render and upload/);
  // seen again: nothing new
  assert.deepEqual(await checkRuns(e, e.DB, gh, NOW), []);
});

test("log fetch failure still alerts", async () => {
  const e = await env();
  await checkRuns(e, e.DB, fakeGitHub({ runs: { "escape-cup": [run(1, "success")] } }), NOW);
  const out = await checkRuns(e, e.DB, fakeGitHub({ runs: { "escape-cup": [run(3, "failure"), run(1, "success")] }, logStatus: 500 }), NOW);
  assert.equal(out.length, 1);
  const ev = await e.DB.prepare("SELECT bot, fix_prompt FROM events").first();
  assert.equal(ev.bot, "escape");
  assert.match(ev.fix_prompt, /\(log unavailable/);
});

test("a success gives no event; a cancelled scheduled run is a warn; a cancelled manual run is ignored", async () => {
  const e = await env();
  await checkRuns(e, e.DB, fakeGitHub({ runs: { "youtube-automation": [run(1, "success")] } }), NOW);
  await checkRuns(e, e.DB, fakeGitHub({ runs: { "youtube-automation": [
    run(4, "success"), run(5, "cancelled"), run(6, "cancelled", { event: "workflow_dispatch" }), run(1, "success")] } }), NOW);
  const { results } = await e.DB.prepare("SELECT severity, title FROM events").all();
  assert.deepEqual(results, [{ severity: "warn", title: "BuriedCasefiles: Post Chess Puzzle was cancelled" }]);
});

test("a GitHub API error for one repo doesn't stop the others", async () => {
  const e = await env();
  const gh = fakeGitHub({ runs: { "escape-cup": [run(1, "success")] } });
  const flaky = async (url, init) => url.includes("chess-puzzle-automation") ? new Response("boom", { status: 502 }) : gh(url, init);
  await checkRuns(e, e.DB, flaky, NOW);
  assert.equal(await e.DB.prepare("SELECT COUNT(*) n FROM runs WHERE repo = 'escape-cup'").first("n"), 1);
});

test("no token means no calls", async () => {
  const e = await makeEnv();
  const gh = fakeGitHub();
  assert.deepEqual(await checkRuns(e, e.DB, gh, NOW), []);
  assert.equal(gh.calls.length, 0);
});

test("tailLines keeps the last n lines without timestamps", () => {
  assert.equal(tailLines("2026-01-01T00:00:00.1Z a\nb\n\n", 2), "a\nb");
  assert.equal(tailLines("", 5), "");
});
