// Bots tab: each bot's workflows (last 5 runs as dots, tap opens the newest run),
// AI reviews used today against the bot's cap, and the A/B tests that are running.
import { api, el, ago, liveView, BOT_NAMES } from "./lib.js";

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

export async function botsTab() {
  const root = el("div", {});
  const fill = async () => {
    const data = await api("/api/bots");
    return [
      el("h1", {}, "Bots"),
      ...data.bots.map(b => el("section", { class: "panel section", dataset: { bot: b.bot } },
        el("div", { class: "panel-head" }, el("h2", {}, BOT_NAMES[b.bot])),
        aiMeter(b.ai),
        b.workflows.length ? b.workflows.map(workflow) : el("p", { class: "muted section" }, "No runs seen yet."))),
      el("section", { class: "section" },
        el("div", { class: "section-head" }, el("h2", {}, "Tests running")),
        data.experiments.length
          ? el("ul", { class: "feed" }, data.experiments.map(experiment))
          : el("p", { class: "muted" }, "No A/B tests running. The morning digest lists them when one starts.")),
    ];
  };
  const { ptr } = liveView(root, fill);
  root.append(ptr, ...(await fill()));
  return root;
}

