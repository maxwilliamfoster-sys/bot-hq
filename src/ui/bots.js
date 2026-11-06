// Bots tab. Progress: is each account improving (progress.js). Runs: each bot's workflows (last 5 runs
// as dots, tap opens the newest run), AI reviews used today against the bot's cap, and the bots' own A/B flags.
import { api, el, ago, liveView, BOT_NAMES } from "./lib.js";
import { progressView } from "./progress.js";

const DOT = { success: "ok", failure: "bad", timed_out: "bad", startup_failure: "bad" };
const WORD = { success: "worked", failure: "failed", timed_out: "timed out", startup_failure: "didn't start", cancelled: "was cancelled" };

function workflow(w) {
  const last = w.runs[0];
  return el("a", { class: "wf", href: last.url, target: "_blank", rel: "noopener" },
    el("span", { class: "name" }, w.name),
    el("span", { class: "dots", "aria-label": `Last ${w.runs.length} runs` },
      [...w.runs].reverse().map(r => el("span", { class: `dot ${DOT[r.conclusion] || ""}`, title: WORD[r.conclusion] || r.conclusion }))),
    el("span", { class: "when" }, `Last run ${WORD[last.conclusion] || last.conclusion} ${ago(last.at)}`));
}

function aiMeter(ai) {
  const bar = el("span", {});
  bar.style.width = `${Math.min(100, Math.round((ai.used / ai.cap) * 100))}%`;   // CSSOM: allowed by the CSP
  return el("div", {},
    el("p", { class: "muted" }, `AI reviews today: ${ai.used} of ${ai.cap}` + (ai.checks ? `, ${ai.checks} video${ai.checks === 1 ? "" : "s"} checked` : "")),
    el("div", { class: `meter${ai.used >= ai.cap ? " is-full" : ""}`, role: "img", "aria-label": `${ai.used} of ${ai.cap} AI reviews used` },
      bar));
}

function experiment(x) {
  const progress = x.n !== undefined && x.min_n ? `${x.n} of ${x.min_n} videos so far` : null;
  return el("li", {}, el("div", { class: "row", dataset: { bot: x.bot } },
    el("span", { class: "mark" }),
    el("div", {},
      el("div", { class: "title" }, x.id),
      el("div", { class: "muted" }, [x.metric && `Judged on ${x.metric}`, progress].filter(Boolean).join(". ")),
      x.verdict ? el("div", { class: "muted" }, `Latest verdict: ${x.verdict}`) : null)));
}

const switcher = runs => el("nav", { class: "section-sm", "aria-label": "Bots view" }, el("div", { class: "seg" },
  el("a", { class: "seg-link", href: "#/bots", "aria-pressed": runs ? "false" : "true" }, "Progress"),
  el("a", { class: "seg-link", href: "#/bots/runs", "aria-pressed": runs ? "true" : "false" }, "Runs")));

async function runsView() {
  const data = await api("/api/bots");
  return [
    ...data.bots.map(b => el("section", { class: "panel section", dataset: { bot: b.bot } },
      el("div", { class: "panel-head" }, el("h2", {}, BOT_NAMES[b.bot])),
      b.ai.cap ? aiMeter(b.ai) : null,
      b.heartbeat ? el("p", { class: "section" }, `Last run on the PC: ${ago(b.heartbeat.at)}`
        + (Number.isFinite(b.heartbeat.waiting) ? `, ${b.heartbeat.waiting} video${b.heartbeat.waiting === 1 ? "" : "s"} scheduled` : "")) : null,
      b.workflows.length ? b.workflows.map(workflow)
        : b.heartbeat ? null : el("p", { class: "muted section" }, "No runs seen yet."))),
    el("section", { class: "section" },
      el("div", { class: "section-head" }, el("h2", {}, "Test flags the bots report")),
      data.experiments.length
        ? el("ul", { class: "feed" }, data.experiments.map(experiment))
        : el("p", { class: "muted" }, "No A/B tests running. The morning digest lists them when one starts.")),
  ];
}

export async function botsTab({ arg } = {}) {
  const root = el("div", {});
  const runs = arg === "runs";
  const fill = async () => [
    el("h1", {}, "Bots"),
    switcher(runs),
    el("div", { class: "section-sm" }, await (runs ? runsView() : progressView(arg))),
  ];
  return liveView(root, fill, { every: runs ? 60000 : 600000 }).mount();
}

