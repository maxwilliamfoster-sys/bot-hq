// Trends tab: trends found inside each account's own niche, scored out of 100, for Max to approve or reject.
// Niches are fixed. Nothing on this screen can change one, and a trend that doesn't fit is explained, never forced.
// Every number shown comes from the API; a part of the score with no data says so instead of showing a guess.
import { api, el, ago, fmt, toast, liveView } from "./lib.js";
import { drawChart, destroyCharts } from "./chart.js";

const APP_BOT = { buried: "bcf" };     // profile key -> this app's bot name (colour)
const botOf = key => APP_BOT[key] || key;

export const LIFE = {
  new: "New", not_enough_data: "Too early to tell", emerging: "Rising", accelerating: "Speeding up",
  peak: "At its peak", flat: "Steady", saturating: "Getting crowded", declining: "Fading",
  re_emerging: "Back again", expired: "Gone quiet",
};
const CLASS = { high: "Strong", test: "Worth testing", monitor: "Watch", low: "Weak", rejected: "Doesn't fit" };
const STATUS = {
  new: "Waiting for you", approved: "Approved", rejected: "Rejected", testing: "Testing", won: "Won",
  lost: "Lost", no_difference: "No difference",
};
const PARTS = [
  ["momentum", "Momentum", "How fast interest is growing"],
  ["audience", "Audience interest", "How many people are searching or reading"],
  ["performance", "Similar videos", "How recent videos on it did against their channel"],
  ["competition", "Room to stand out", "How few recent Shorts already cover it"],
  ["timeliness", "Freshness", "How new the newest evidence is"],
  ["originality", "New for this account", "Whether this account already covered or planned it"],
];
const SOURCES = {
  google_trends: "Google Trends", wikipedia: "Wikipedia", news_rss: "News", youtube: "YouTube", radar: "Shorts Radar",
  competitors: "Competitor channel", manual: "Added by you",
};
const DECIDABLE = ["new", "approved", "rejected"];

// The list's filters last while the app is open.
const filter = { account: "", view: "waiting", lifecycle: "", platform: "", min: "" };
const VIEWS = [
  ["waiting", "Waiting for you", { status: "new", min_score: "65" }],
  ["all", "All", {}],
  ["approved", "Approved", { status: "approved" }],
  ["testing", "Testing", { status: "testing" }],
  ["won", "Won", { status: "won" }],
  ["rejected", "Rejected", { status: "rejected", include_rejected: "1" }],
  ["unfit", "Didn't fit", { class: "rejected" }],
];

const fact = (k, v) => el("div", {}, el("dt", {}, k), el("dd", {}, v));
const chip = (label, pressed, onclick) => el("button", { class: "chip", "aria-pressed": String(pressed), onclick }, label);
const scoreText = s => (Number.isFinite(s) ? String(s) : "–");
const short = name => String(name).replace(/\s*\(.*\)$/, "");     // "Chess (@handle)" -> "Chess"

function sheet(title, build) {
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  const panel = el("div", { class: "sheet sheet-tall", role: "dialog", "aria-modal": "true", "aria-label": title });
  const wrap = el("div", { class: "sheet-wrap", onclick: e => { if (e.target === wrap) close(); } }, panel);
  panel.append(el("h2", {}, title), ...build(close));
  document.body.append(wrap);
  document.addEventListener("keydown", onKey);
  panel.querySelector("select, input, button")?.focus();
}

function gateText(gate, name) {
  if (!gate) return "";
  return `It doesn't fit the niche for ${name}: ${gate.reason || "no reason given"}.`;
}

// ---- the list --------------------------------------------------------------------------------------------
function query() {
  const q = new URLSearchParams(VIEWS.find(v => v[0] === filter.view)?.[2] || {});
  if (filter.account) q.set("account", filter.account);
  if (filter.platform) q.set("platform", filter.platform);
  if (filter.lifecycle) q.set("lifecycle", filter.lifecycle);
  if (filter.min && !q.has("min_score")) q.set("min_score", filter.min);
  q.set("limit", "100");
  return q;
}

function item(o) {
  const live = o.flags.includes("active_case");
  return el("li", {}, el("a", { class: "row trend-row", href: `#/trends/${o.trend_id}`, dataset: { bot: botOf(o.account) } },
    el("span", { class: "mark" }),
    el("span", { class: "trend-text" },
      el("span", { class: "title" }, o.name),
      el("span", { class: "when" }, [short(o.account_name), LIFE[o.lifecycle] || o.lifecycle, `seen ${ago(o.last_seen)}`].join(" · ")),
      live ? el("span", { class: "when sev-warn" }, "Live case or allegation") : null,
      filter.view === "unfit" || o.status !== "new" ? el("span", { class: "when" }, STATUS[o.status] || o.status) : null),
    el("span", { class: `trend-score is-${o.class}` },
      el("span", { class: "trend-num" }, scoreText(o.score)),
      el("span", { class: "trend-class" }, CLASS[o.class] || o.class))));
}

function filters(ov, refresh) {
  const set = (k, v) => { filter[k] = v; refresh(); };
  const select = (label, key, options) => el("label", { class: "trend-select" }, label,
    el("select", { class: "input", onchange: e => set(key, e.target.value) },
      options.map(([v, t]) => el("option", { value: v, selected: filter[key] === v }, t))));
  const platforms = [...new Set(ov.accounts.map(a => a.platform))];
  return [
    el("div", { class: "chips trend-filters", role: "group", "aria-label": "Account" },
      chip("All accounts", !filter.account, () => set("account", "")),
      ov.accounts.map(a => chip(a.waiting ? `${short(a.name)} (${a.waiting})` : short(a.name),
        filter.account === a.key, () => set("account", a.key)))),
    el("div", { class: "chips", role: "group", "aria-label": "Show" },
      VIEWS.map(([key, label]) => chip(label, filter.view === key, () => set("view", key)))),
    el("details", { class: "progress-more", open: !!(filter.lifecycle || filter.platform || filter.min) },
      el("summary", {}, "More filters"),
      el("div", { class: "trend-selects" },
        select("Stage", "lifecycle", [["", "Any"], ...Object.entries(LIFE)]),
        select("Platform", "platform", [["", "Any"], ...platforms.map(p => [p, p[0].toUpperCase() + p.slice(1)])]),
        select("Score", "min", [["", "Any"], ["45", "45 or more"], ["65", "65 or more"], ["80", "80 or more"]]))),
  ];
}

function emptyText() {
  if (filter.view === "waiting") return "Nothing is waiting for you. Trends that score 65 or more show up here.";
  if (filter.view === "unfit") return "No trends were turned away for being outside a niche.";
  return "No trends match these filters.";
}

export async function trendsTab() {
  const root = el("div", {});
  let view;
  const fill = async () => {
    const [ov, list] = await Promise.all([api("/api/trends/overview"), api(`/api/trends?${query()}`)]);
    return [
      el("div", { class: "section-head" }, el("h1", {}, "Trends"),
        el("button", { class: "btn btn-small", onclick: () => manualForm(ov.accounts) }, "Add one")),
      el("p", { class: "muted" }, "Trends found inside each account's own niche, scored out of 100. Approve the ones worth testing."),
      el("dl", { class: "facts" },
        fact("Waiting for you", fmt(ov.awaiting)), fact("Strong (80+)", fmt(ov.high)),
        fact("Rising", fmt(ov.emerging + ov.accelerating)), fact("Testing", fmt(ov.testing)),
        fact("Won", fmt(ov.won)), fact("Found so far", fmt(ov.discovered))),
      ...filters(ov, () => view.refresh()),
      list.items.length
        ? el("ul", { class: "feed" }, list.items.map(item))
        : el("div", { class: "empty" }, el("p", {}, emptyText())),
    ];
  };
  view = liveView(root, fill, { every: 300000 });
  return view.mount();
}

// ---- adding a trend by hand --------------------------------------------------------------------------------
function manualForm(accounts) {
  sheet("Add a trend", close => {
    const err = el("p", { class: "error", role: "alert", hidden: true });
    const account = el("select", { class: "input", id: "m-account" },
      accounts.map(a => el("option", { value: a.key, selected: a.key === filter.account }, a.name)));
    const niche = el("p", { class: "muted small" });
    const showNiche = () => { niche.textContent = `Niche: ${accounts.find(a => a.key === account.value)?.niche || ""}`; };
    account.addEventListener("change", showNiche);
    showNiche();
    const name = el("input", { class: "input", id: "m-name", maxlength: 200, required: true, autocomplete: "off" });
    const url = el("input", { class: "input", id: "m-url", type: "url", inputmode: "url", maxlength: 500, placeholder: "https://" });
    const text = el("textarea", { class: "input", id: "m-text", maxlength: 2000, rows: 3 });
    const notes = el("textarea", { class: "input", id: "m-notes", maxlength: 1000, rows: 2 });
    const save = el("button", { class: "btn btn-primary btn-block", type: "submit" }, "Add trend");
    const field = (id, label, input, hint) => el("div", { class: "field" }, el("label", { for: id }, label), hint ? el("p", { class: "muted small" }, hint) : null, input);
    const form = el("form", { class: "stack", novalidate: true, onsubmit: async e => {
      e.preventDefault();
      err.hidden = true;
      if (!name.value.trim()) { err.textContent = "Give the trend a name."; err.hidden = false; return name.focus(); }
      save.disabled = true;
      try {
        const r = await api("/api/trends/manual", { method: "POST", body: {
          account: account.value, name: name.value.trim(), url: url.value.trim(), text: text.value.trim() || undefined,
          notes: notes.value.trim() || undefined } });
        close();
        toast("Trend added");
        location.hash = `#/trends/${r.trend_id}`;
      } catch (x) {
        save.disabled = false;
        const acc = accounts.find(a => a.key === account.value);
        err.textContent = x.data?.error === "niche_gate"
          ? `${gateText(x.data.gate, short(acc?.name || "this account"))} The niche stays as it is. If it belongs to another account, pick that one.`
          : x.data?.error === "bad_manual" ? "Check the name and the link (it must start with https://)." : "Couldn't add it. Check your connection and try again.";
        err.hidden = false;
      }
    } },
    field("m-account", "Account", account), niche,
    field("m-name", "Trend", name),
    field("m-url", "Link (optional)", url),
    field("m-text", "What it's about (optional)", text, "Used to check it fits the niche."),
    field("m-notes", "Your notes (optional)", notes, "Kept with the trend. Not used to judge whether it fits."),
    err, save,
    el("button", { class: "btn btn-block", type: "button", onclick: close }, "Cancel"));
    return [form];
  });
}

// ---- one trend ---------------------------------------------------------------------------------------------
function breakdown(o, weights) {
  const total = Object.values(weights).reduce((s, w) => s + w, 0) || 1;
  const pts = v => Math.round((v / total) * 1000) / 10;
  const row = (label, hint, value, w) => {
    const has = Number.isFinite(value);
    const bar = el("span");
    bar.style.width = `${has ? Math.round(Math.max(0, Math.min(1, value)) * 100) : 0}%`;     // CSSOM: the CSP blocks style=""
    return el("li", { class: "part" },
      el("div", { class: "part-head" }, el("span", { class: "part-name" }, label),
        el("span", { class: "part-pts" }, has ? `${fmt(pts(w * value))} of ${fmt(pts(w))}` : "No data yet")),
      el("div", { class: "meter", "aria-hidden": "true" }, bar),
      el("span", { class: "muted small" }, has ? hint : `${hint}. Not measured yet, so it counts as 0.`));
  };
  const items = [row("Fits the niche", "From the niche words found in the evidence", o.gate?.relevance, weights.niche)];
  for (const [k, label, hint] of PARTS) items.push(row(label, hint, o.components[k], weights[k]));
  const fit = o.components.history_fit;
  const n = o.components.history_matches;
  const histPts = Number.isFinite(fit) ? pts(weights.audience * 0.2 * fit) : null;
  return el("section", { class: "section-sm" },
    el("h4", {}, "How the score adds up"),
    el("ul", { class: "parts" }, items),
    el("p", { class: "muted small" }, Number.isFinite(fit)
      ? `Your past videos on this: ${histPts > 0 ? "+" : ""}${fmt(histPts)} points (from ${n} of your own video${n === 1 ? "" : "s"} or tests).`
      : "Your past videos: none on this topic, so no change."));
}

function gateBlock(o) {
  const g = o.gate || {};
  const words = [...(g.anchors || []), ...(g.related || [])];
  return el("details", { class: "progress-more" },
    el("summary", {}, "Why it fits this niche"),
    el("p", {}, `Niche: ${o.niche || "unknown"}`),
    el("p", { class: "muted" }, `${g.reason ? g.reason[0].toUpperCase() + g.reason.slice(1) : ""}${Number.isFinite(g.relevance) ? ` (match ${Math.round(g.relevance * 100)}%)` : ""}.`),
    words.length ? el("p", { class: "muted" }, `Niche words found: ${words.join(", ")}`) : null,
    o.locked_rules.length ? el("div", {}, el("p", { class: "part-name" }, "Rules this account always keeps"),
      el("ul", { class: "coach-list" }, o.locked_rules.map(r => el("li", {}, r)))) : null);
}

// Written by the evening review (kit.py trend-ideas). Ideas are suggestions, never evidence.
function ideasBlock(o) {
  if (!o.ideas.length) return null;
  const s = v => (typeof v === "string" && v.trim() ? v : null);
  return el("section", { class: "section-sm" }, el("h4", {}, "Ideas from the evening review"),
    el("ul", { class: "coach-list" }, o.ideas.map(i => el("li", {},
      el("strong", {}, s(i.title) || "Idea"),
      s(i.hook) ? el("div", {}, `Hook: ${i.hook}`) : null,
      [s(i.format), s(i.duration)].some(Boolean) ? el("div", { class: "muted small" }, [s(i.format), s(i.duration)].filter(Boolean).join(", ")) : null,
      s(i.storytelling) ? el("div", { class: "muted small" }, i.storytelling) : null,
      s(i.why) ? el("div", { class: "muted small" }, `Why: ${i.why}`) : null,
      s(i.platform_notes) ? el("div", { class: "muted small" }, i.platform_notes) : null,
      Array.isArray(i.risks) && i.risks.length ? el("div", { class: "small sev-warn" }, "Watch out:",
        el("ul", { class: "coach-list" }, i.risks.map(r => el("li", {}, r)))) : null))));
}

function statusLine(o) {
  if (o.status === "approved" && o.handed_at) return `Approved, in the idea backlog since ${ago(o.handed_at)}`;
  if (o.status === "approved") return "Approved, goes to the next evening review";
  return STATUS[o.status] || o.status;
}

function decision(o, done) {
  if (o.class === "rejected") {
    return el("p", { class: "sev-warn" }, `${gateText(o.gate, short(o.account_name))} It can't be approved for this account.`);
  }
  if (o.status === "testing") return el("p", { class: "muted" }, "Being tested by the autopilot. The result shows here when the test is judged.");
  if (!DECIDABLE.includes(o.status)) return el("p", { class: "muted" }, `Tested: ${(STATUS[o.status] || o.status).toLowerCase()}. Results are kept, so this can't be changed.`);
  const reason = el("input", { class: "input", maxlength: 300, placeholder: "Reason (optional)", "aria-label": `Reason for ${o.account_name}` });
  const act = action => async () => {
    for (const b of buttons.querySelectorAll("button")) b.disabled = true;
    try {
      await api(`/api/trends/opportunities/${o.id}/${action}`, { method: "POST", body: { reason: reason.value.trim() || undefined } });
      toast(action === "approve" ? "Approved" : "Rejected");
    } catch (x) {
      toast(x.data?.error === "niche_gate" ? "It no longer fits this account's niche, so it wasn't approved"
        : x.data?.error?.startsWith("already_") ? `Already ${STATUS[x.data.error.slice(8)] || x.data.error.slice(8)}` : "Couldn't save. Try again.");
    }
    done();
  };
  const buttons = el("div", { class: "btn-row" },
    o.status !== "approved" ? el("button", { class: "btn btn-primary", onclick: act("approve") }, "Approve") : null,
    o.status !== "rejected" ? el("button", { class: "btn", onclick: act("reject") }, "Reject") : null);
  return el("div", { class: "stack trend-decide" }, o.status_reason ? el("p", { class: "muted" }, `Your reason: ${o.status_reason}`) : null, reason, buttons);
}

function opportunity(o, weights, done) {
  return el("section", { class: "panel", dataset: { bot: botOf(o.account) } },
    el("div", { class: "panel-head" }, el("h3", {}, short(o.account_name)), el("span", { class: "muted small" }, statusLine(o))),
    o.outcome_note ? el("p", { class: "muted" }, `Test: ${o.outcome_note}`) : null,
    el("div", { class: `trend-big is-${o.class}` },
      el("span", { class: "trend-num" }, scoreText(o.score)),
      el("span", {}, el("span", { class: "trend-class" }, CLASS[o.class] || o.class),
        el("span", { class: "muted small" }, o.evidence === "confirmed" ? "Seen in 2 or more kinds of source"
          : o.evidence === "emerging" ? "Seen in one kind of source so far" : "Not backed by outside evidence yet"))),
    o.profile_changed ? el("p", { class: "muted small" }, "This account's niche profile was edited after this was scored. Approving checks it again.") : null,
    o.notes ? el("p", { class: "muted" }, `Your notes: ${o.notes}`) : null,
    decision(o, done),
    o.class === "rejected" ? null : breakdown(o, weights),
    gateBlock(o),
    ideasBlock(o));
}

function evidence(signals) {
  if (!signals.length) return null;
  return el("section", { class: "block" }, el("h3", {}, "Evidence"),
    el("p", { class: "muted" }, "Where it was seen. Open a link to check it yourself."),
    el("ul", { class: "feed feed-flat" }, signals.map(s => {
      const when = s.published_at ? `published ${ago(s.published_at)}` : `found ${ago(s.fetched_at)}`;
      const meta = [SOURCES[s.source] || s.source, s.metric && s.metric !== "manual" && Number.isFinite(s.value) ? `${s.metric} ${fmt(s.value)}` : null, when]
        .filter(Boolean).join(" · ");
      const body = [el("span", { class: "mark" }), el("span", { class: "trend-text" }, el("span", { class: "title" }, s.title || s.url || "Untitled"), el("span", { class: "when" }, meta))];
      return el("li", {}, s.url ? el("a", { class: "row", href: s.url, target: "_blank", rel: "noopener noreferrer" }, body) : el("div", { class: "row is-static" }, body));
    })));
}

function history(snapshots) {
  const days = snapshots.filter(s => Number.isFinite(s.momentum));
  if (days.length < 2) {
    return el("section", { class: "block" }, el("h3", {}, "Over time"),
      el("p", { class: "muted" }, days.length ? "One daily reading so far. The chart starts after the second." : "No daily readings yet."));
  }
  const canvas = el("canvas", { role: "img", "aria-label": "Momentum each day" });
  drawChart(canvas, { labels: days.map(s => s.day.slice(5).split("-").reverse().join("/")), unit: "",
    series: [{ name: "Momentum", data: days.map(s => Math.round(s.momentum * 100)) }] }, "line");
  return el("section", { class: "block" }, el("h3", {}, "Over time"), el("p", { class: "muted" }, "Momentum each day, out of 100."),
    el("div", { class: "chart-box progress-chart" }, canvas));
}

export async function trendView({ arg, rerender }) {
  destroyCharts();
  const id = /^\d+$/.test(arg || "") ? arg : null;
  const [d, weights] = await Promise.all([
    id ? api(`/api/trends/${id}`).catch(e => { if (e.status === 404) return null; throw e; }) : null,
    api("/api/trends/weights"),
  ]);
  if (!d) {
    return el("div", { class: "empty" }, el("h2", {}, "This trend is gone"), el("p", {}, "It may have been cleared after going quiet."),
      el("p", { class: "section" }, el("a", { class: "btn btn-primary", href: "#/trends" }, "Back to Trends")));
  }
  const t = d.trend;
  return el("div", { class: "stack" },
    el("a", { class: "back", href: "#/trends" }, "‹ Trends"),
    el("div", {},
      el("p", { class: "muted" }, [t.category, LIFE[t.lifecycle] || t.lifecycle, `first seen ${ago(t.first_seen)}`].filter(Boolean).join(" · ")),
      el("h1", { class: "detail-title" }, t.name)),
    t.flags.includes("active_case") ? el("div", { class: "hint trend-warn", role: "note" },
      el("strong", {}, "Live case or allegation. "),
      "The evidence mentions an accusation, arrest or trial with no verdict. Any idea must say \"accused\" or \"alleged\", stick to what the court has heard, and never present anyone as guilty. True-crime videos wait for the verdict.") : null,
    d.opportunities.map(o => opportunity(o, weights, rerender)),
    history(d.snapshots),
    evidence(d.signals));
}
