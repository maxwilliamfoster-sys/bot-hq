// Progress view (Bots tab): is each account improving, which tests are running, what is waiting and what changed.
// All numbers come from the analytics check on Max's PC; this only draws them.
import { api, el, ago, fmt, BOT_NAMES } from "./lib.js";
import { drawChart, destroyCharts } from "./chart.js";

const APP_BOT = { buried: "bcf" };     // the tracker's name for an account -> this app's
const appBot = key => APP_BOT[key] || key;
const STALE_DAYS = 8;
const RECENT_CHANGES = 8;
const SEV = {
  Better: "good", Winner: "good", "Ready to compare": "good", Done: "good",
  Worse: "action", Losing: "action",
  "Too close to call": "warn", "Winner, with a catch": "warn", Open: "warn",
};
const sev = status => el("span", { class: `sev sev-${SEV[status] || "info"} status-tag` }, status);

const day = iso => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const mondayOf = iso => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
};

function meter(share, label) {
  const bar = el("span", {});
  bar.style.width = `${Math.min(100, Math.round(share))}%`;   // CSSOM: allowed by the CSP
  return el("div", { class: "meter", role: "img", "aria-label": label }, bar);
}

function viewsChart(a, trend) {
  const rows = trend.filter(r => r.account === a.key);
  if (!rows.length) return el("p", { class: "muted small section-sm" }, "No videos past 3 days old yet.");
  const weeks = rows.map(r => r.week);
  const changed = mondayOf(a.changed_on);
  if (changed > weeks[weeks.length - 1]) weeks.push(changed);
  const canvas = el("canvas", { role: "img", "aria-label": `${BOT_NAMES[appBot(a.key)]}: typical views each week` });
  const box = el("div", { class: "chart-box progress-chart" }, canvas);
  const at = week => rows.find(r => r.week === week);
  drawChart(canvas, {
    labels: weeks.map(day), unit: "views",
    series: [{ name: BOT_NAMES[appBot(a.key)], data: weeks.map(w => at(w)?.views ?? null), n: weeks.map(w => at(w)?.videos) }],
  }, "line", { mark: weeks.indexOf(changed), note: n => (n ? `, ${n} video${n === 1 ? "" : "s"}` : "") });
  return box;
}

function change(a) {
  if (a.change_pct === null) return "nothing older to compare yet";
  const tone = a.change_pct >= 25 ? "good" : a.change_pct <= -20 ? "action" : "info";
  return el("span", {}, el("span", { class: `sev-${tone}` }, `${a.change_pct > 0 ? "+" : ""}${a.change_pct}%`), " vs the 14 days before");
}

function account(a, trend) {
  return el("section", { class: "panel", dataset: { bot: appBot(a.key) } },
    el("div", { class: "panel-head" }, el("h2", {}, BOT_NAMES[appBot(a.key)]), sev(a.verdict)),
    el("p", { class: "progress-big" }, fmt(a.views_now)),
    el("p", { class: "muted small" }, "typical views, last 14 days · ", change(a)),
    viewsChart(a, trend),
    el("p", { class: "muted small" }, `Dashed line: changes went live ${day(a.changed_on)}`),
    el("dl", { class: "facts" },
      el("div", {}, el("dt", {}, `Posts a day (limit ${a.limit_per_day})`), el("dd", {}, fmt(a.posts_per_day))),
      el("div", {}, el("dt", {}, "Under 200 views"), el("dd", {}, a.dead_pct === null ? "–" : `${a.dead_pct}%`)),
      el("div", {}, el("dt", {}, a.watch_label), el("dd", {}, a.watch))),
    el("p", { class: "muted small section-sm" }, `Since ${day(a.changed_on)}: ${a.n_after} of the ${a.need_after} videos needed to judge the change`),
    meter(100 * a.n_after / a.need_after, `${a.n_after} of ${a.need_after} videos`),
    el("p", { class: "small section-sm" }, `Latest: ${a.latest_update}`),
    a.alert ? el("p", { class: "small sev-action section-sm" }, a.alert) : null);
}

function testRow(t) {
  const enough = t.lowest >= t.need;
  return el("li", {}, el("div", { class: "row is-static", dataset: { bot: appBot(t.bot) } },
    el("span", { class: "mark" }),
    el("div", { class: "progress-text" },
      el("div", { class: "title" }, t.name),
      el("div", { class: "muted small" }, [BOT_NAMES[appBot(t.bot)], t.started && `since ${day(t.started)}`].filter(Boolean).join(" · ")),
      el("div", { class: "small" }, t.question),
      t.need > 0 ? meter(t.progress, `${t.lowest} of ${t.need} videos`) : null,
      t.need > 0 ? el("div", { class: "muted small" }, enough ? `Has enough videos: ${t.lowest} in the smaller group, ${t.need} needed` : `${t.lowest} of ${t.need} videos in the smaller group`) : null,
      el("div", { class: "muted small" }, t.reading)),
    sev(t.status)));
}

function jobRow(t) {
  return el("li", {}, el("div", { class: "row is-static" },
    el("span", { class: "mark" }),
    el("div", { class: "progress-text" },
      el("div", { class: "title" }, t.task),
      el("div", { class: "muted small" }, t.why),
      el("div", { class: "muted small" }, `${t.owner} · ${/^\d{4}-/.test(t.due) ? day(t.due) : t.due}`)),
    sev(t.status)));
}

function changeRow(u) {
  return el("li", {}, el("div", { class: "row is-static", dataset: { bot: appBot(u.bot) } },
    el("span", { class: "mark" }),
    el("div", { class: "progress-text" },
      el("div", { class: "muted small" }, [day(u.date), BOT_NAMES[appBot(u.bot)], u.kind].join(" · ")),
      el("div", { class: "title" }, u.what),
      el("div", { class: "muted small" }, u.why),
      u.commit ? el("div", { class: "muted small" }, u.commit) : null)));
}

function section(title, hint, body) {
  return el("section", { class: "section" }, el("div", { class: "section-head" }, el("h2", {}, title)), hint ? el("p", { class: "muted small progress-hint" }, hint) : null, body);
}

function changes(list) {
  if (!list.length) return el("p", { class: "muted" }, "Nothing logged for this account yet.");
  const older = list.slice(RECENT_CHANGES);
  return el("div", {},
    el("ul", { class: "feed" }, list.slice(0, RECENT_CHANGES).map(changeRow)),
    older.length ? el("details", { class: "progress-more" }, el("summary", {}, `Show ${older.length} older`), el("ul", { class: "feed" }, older.map(changeRow))) : null);
}

export async function progressView(filter) {
  const d = await api("/api/tracker");
  destroyCharts();
  if (!d.available) {
    return [el("div", { class: "empty" }, el("p", {}, "No progress numbers yet. They arrive the next time the analytics check runs on your PC."))];
  }
  const s = d.summary;
  const keys = d.accounts.map(a => a.key);
  const only = keys.includes(filter) ? filter : null;
  const oldDays = (Date.now() - Date.parse(d.generated)) / 86400e3;
  const tests = d.tests.filter(t => !only || t.bot === only);
  const rank = t => (t.status === "Collecting" ? 0 : t.status === "Planned" ? 2 : 1);
  return [
    el("p", { class: "updated" }, `Updated ${ago(d.generated)}. A video only counts once it is 3 days old, and TikTok views jump in batches, so small changes mean little.`),
    oldDays > STALE_DAYS ? el("p", { class: "small sev-warn section-sm" }, `These numbers are ${Math.round(oldDays)} days old. Run the analytics check on your PC to refresh them.`) : null,
    el("dl", { class: "facts block" },
      el("div", {}, el("dt", {}, "Accounts better"), el("dd", {}, s.better)),
      el("div", {}, el("dt", {}, "Accounts worse"), el("dd", {}, s.worse)),
      el("div", {}, el("dt", {}, "Too early to call"), el("dd", {}, s.early)),
      el("div", {}, el("dt", {}, "Tests collecting"), el("dd", {}, s.collecting)),
      el("div", {}, el("dt", {}, "Jobs for you"), el("dd", {}, s.yours)),
      el("div", {}, el("dt", {}, "Next results check"), el("dd", {}, s.next_check ? day(s.next_check) : "–"))),
    el("nav", { class: "section-sm", "aria-label": "Show one account" }, el("div", { class: "chips" },
      el("a", { class: "chip", href: "#/bots", "aria-pressed": only ? "false" : "true" }, "All"),
      keys.map(k => el("a", { class: "chip", href: `#/bots/${k}`, "aria-pressed": k === only ? "true" : "false" }, BOT_NAMES[appBot(k)])))),
    el("div", { class: "section-sm" }, d.accounts.filter(a => !only || a.key === only).map(a => account(a, d.trend))),
    section("Tests", "Each bar fills as the smaller group reaches the number of videos a fair comparison needs.",
      tests.length ? el("ul", { class: "feed" }, [...tests].sort((a, b) => rank(a) - rank(b)).map(testRow)) : el("p", { class: "muted" }, "No tests on this account.")),
    section("Waiting to be done", null, d.todos.length ? el("ul", { class: "feed" }, d.todos.map(jobRow)) : el("p", { class: "muted" }, "Nothing waiting.")),
    section("What changed", null, changes(d.updates.filter(u => !only || u.bot === only))),
  ];
}
