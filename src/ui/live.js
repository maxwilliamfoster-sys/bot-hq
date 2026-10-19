// Live tab: one card per bot - today's posts against plan, next post, last run, and the
// last 24 hours of posts with their views. Refreshes every minute and on pull-down.
import { api, el, ago, fmt, ukClock, liveView, BOT_NAMES } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";

function sparkline(values) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${26 - ((v - min) / (max - min || 1)) * 24}`);
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 100 28");
  s.setAttribute("preserveAspectRatio", "none");
  s.setAttribute("class", "spark");
  s.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  s.append(line);
  return s;
}

const RUN_TEXT = { success: ["ok", "Worked"], failure: ["bad", "Failed"], timed_out: ["bad", "Timed out"],
  startup_failure: ["bad", "Didn't start"], cancelled: ["", "Cancelled"] };

function lastRun(run) {
  if (!run) return el("dd", {}, "–");
  const [cls, text] = RUN_TEXT[run.conclusion] || ["", run.conclusion];
  return el("dd", {}, el("a", { href: run.url, target: "_blank", rel: "noopener", "aria-label": `${run.workflow}: ${text}, open the run` },
    el("span", { class: `dot ${cls}` }), text));
}

function post(p) {
  const delta = p.delta_1h > 0 ? `+${fmt(p.delta_1h)} in 1h` : p.delta_1h === 0 ? "no change in 1h" : "";
  const children = [
    el("span", { class: "title" }, p.title || "Untitled"),
    el("span", { class: "views" }, p.views === null ? "–" : fmt(p.views)),
    el("span", { class: "when" }, `Posted ${ago(p.posted_at)}`),
    el("span", { class: p.delta_1h > 0 ? "delta" : "delta muted" }, delta),
    sparkline(p.spark),
  ];
  return p.url ? el("a", { class: "post", href: p.url, target: "_blank", rel: "noopener" }, children) : el("div", { class: "post" }, children);
}

function card(b) {
  const next = b.next_slot ? ukClock(b.next_slot) : (b.bot === "escape" ? "Nothing booked" : "–");
  return el("section", { class: "panel", dataset: { bot: b.bot } },
    el("div", { class: "panel-head" },
      el("h2", {}, BOT_NAMES[b.bot]),
      el("span", { class: "updated" }, b.stats_at ? `Views from ${ago(b.stats_at)}` : "No views yet")),
    el("dl", { class: "facts" },
      el("div", {}, el("dt", {}, "Posted today"), el("dd", {}, `${b.today.posted} of ${b.today.planned}`)),
      el("div", {}, el("dt", {}, "Next post"), el("dd", {}, next)),
      el("div", {}, el("dt", {}, "Last run"), lastRun(b.last_run))),
    b.posts.length ? b.posts.map(post) : el("p", { class: "muted section" }, "No posts in the last 24 hours."));
}

export async function liveTab() {
  const root = el("div", {});
  const fill = async () => {
    const data = await api("/api/live");
    return [
      el("div", { class: "section-head" }, el("h1", {}, "Live"), el("span", { class: "updated" }, `Updated ${ukClock(data.updated_at)}`)),
      ...data.bots.map(card),
    ];
  };
  const { ptr } = liveView(root, fill);
  root.append(ptr, ...(await fill()));
  return root;
}
