// Progress view (Bots tab): is each account improving, which tests are running, what is waiting and what changed.
// All numbers come from the analytics check on Max's PC; this only draws them.
import { api, el, ago, fmt, BOT_NAMES } from "./lib.js";
import { drawChart, destroyCharts } from "./chart.js";
import { PLAYBOOK, VERDICTS } from "../coach.js";
import { competitorView, borrowTally } from "../competitors.js";

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

// Why views stall on this account and what helps, from coach.js (the same text Claude is sent).
function playbook(bot, health) {
  const book = PLAYBOOK[bot];
  if (!book) return null;
  const v = health && VERDICTS[health.code];
  return el("details", { class: "progress-more" },
    el("summary", {}, "Why views stall here, and the plan", v ? el("span", { class: `sev sev-${v.tone} status-tag coach-tag` }, v.label) : null),
    v ? el("p", { class: "small" }, v.means, health.median ? ` Usually ${fmt(health.median)} views at 3 days old; the last five, ${fmt(health.recent)}.` : "") : null,
    el("p", { class: "small section-sm" }, el("strong", {}, "The risk: "), book.risk),
    el("p", { class: "small section-sm" }, el("strong", {}, "What helps, most useful first")),
    el("ol", { class: "small coach-list" }, book.steps.map(s => el("li", {}, s))),
    el("p", { class: "small section-sm" }, el("strong", {}, "Only you can check these (in the app)")),
    el("ul", { class: "small coach-list" }, book.checks.map(s => el("li", {}, s))));
}

// ---- Autopilot: the daily Claude review (analytics-check/autopilot). It reviews one account a day,
// watches its videos, changes what needs changing and runs the next test; this shows what it did.
const STAGE_TONE = { 1: "good", 2: "info", 3: "warn", 4: "action" };
const text = (t, cls = "small pre-line") => (t ? el("p", { class: cls }, t) : null);
const more = (title, ...body) => (body.some(Boolean) ? el("details", { class: "progress-more" }, el("summary", {}, title), ...body) : null);
const list = items => (items?.length ? el("ul", { class: "small coach-list" }, items.map(s => el("li", {}, s))) : null);

// Competitors: 3-5 channels in the same niche with strong views. Each review studies two of them and borrows
// techniques that might work here (never their content); borrowed ideas then go through our own tests.
function competitorsFor(x) {
  const rows = competitorView(x.competitors);
  const t = borrowTally(x.competitors);
  const tally = t.total
    ? `${t.total} idea${t.total === 1 ? "" : "s"} borrowed: ${t.won} worked here, ${t.testing} in a test, ${t.fix} fixed straight away, ${t.lost} didn't work, ${t.queued} queued`
    : "Nothing borrowed yet. Each review studies two of them and borrows what might work here, never copying their videos.";
  return el("div", { class: "competitors section-sm" },
    el("div", { class: "panel-head" }, el("h3", {}, "Competitors we learn from"),
      rows.length ? el("span", { class: "muted small" }, `${rows.length} watched`) : null),
    el("p", { class: "muted small" }, rows.length ? tally
      : "None yet. This account's next review picks 3 to 5 channels in the same niche that get strong views."),
    rows.map(v => el("details", { class: "progress-more" },
      el("summary", {}, v.name, el("span", { class: "muted small competitor-meta" }, v.meta)),
      text(v.why),
      v.url ? el("p", { class: "small" }, el("a", { href: v.url, target: "_blank", rel: "noopener noreferrer" }, "Open their channel")) : null,
      v.does.length ? el("p", { class: "small section-sm" }, el("strong", {}, "What they do")) : null,
      list(v.does),
      v.borrowed.length ? el("p", { class: "small section-sm" }, el("strong", {}, "What we borrowed")) : null,
      v.borrowed.length ? el("ul", { class: "small coach-list" }, v.borrowed.map(b =>
        el("li", {}, el("span", { class: `sev sev-${b.tone}` }, b.label), " ", b.text))) : null)));
}

function autopilotFor(ap, a) {
  const x = ap?.accounts?.find(r => r.key === a.key);
  if (!x) return null;
  const r = x.latest;
  return el("div", { class: "autopilot-box section-sm" },
    el("div", { class: "panel-head" }, el("h3", {}, "Autopilot"),
      x.stage ? el("span", { class: `sev sev-${STAGE_TONE[x.stage]} status-tag` }, `Stage ${x.stage}: ${x.stage_name}`) : null),
    el("p", { class: "muted small" }, [
      x.weeks_since_high == null ? "Not enough history to judge growth yet" : x.weeks_since_high === 0 ? "Views at a new high"
        : `${x.weeks_since_high} weeks without a new high (best 2 weeks ${fmt(Math.max(...x.window_views))}, now ${fmt(x.window_views[0])})`,
      `${x.no_win_streak} test${x.no_win_streak === 1 ? "" : "s"} in a row without a winner`,
      `${x.reviews_done} review${x.reviews_done === 1 ? "" : "s"} so far`].join(" · ")),
    x.stage ? more("What it does at this stage", text(x.stage_rule)) : null,
    x.last_review ? el("p", { class: "small section-sm" }, el("strong", {}, `Last review ${day(x.last_review.date)}: `), x.last_review.summary)
      : el("p", { class: "muted small section-sm" }, "Not reviewed yet. It gets reviewed once its test has enough data."),
    r ? more("What it saw and heard", text(r.watched)) : null,
    r ? more("The numbers it read", text(r.numbers)) : null,
    r ? more("What it changed", text(r.changes), text(r.tests)) : null,
    r?.next?.length ? more("What the next review will check", list(r.next)) : null,
    competitorsFor(x),
    x.approaches?.length ? more("Approaches tried", list(x.approaches.map(p => `${day(p.date)} · ${p.family}: ${p.what}${p.outcome ? ` (${p.outcome})` : ""}`))) : null,
    x.ideas_open?.length ? more("Ideas waiting", list(x.ideas_open)) : null);
}

function healthRow(h) {
  const bad = h.failed_runs?.length || h.stalled;
  return el("li", {}, el("div", { class: "row is-static", dataset: { bot: appBot(h.key) } },
    el("span", { class: "mark" }),
    el("div", { class: "progress-text" },
      el("div", { class: "title" }, BOT_NAMES[appBot(h.key)] || h.name),
      el("div", { class: "muted small" }, [
        h.last_post_h == null ? "last post unknown" : `last post ${h.last_post_h} h ago`,
        h.last_review ? `reviewed ${day(h.last_review)}` : "not reviewed yet"].join(" · ")),
      h.failed_runs?.length ? el("div", { class: "small sev-action" }, h.failed_runs.join("; ")) : null,
      h.signals?.length ? el("div", { class: "muted small" }, h.signals.join("; ")) : null),
    el("span", { class: `sev sev-${bad ? "action" : "good"} status-tag` }, bad ? (h.stalled ? "Stalled" : "Failed run") : "OK")));
}

function autopilotTop(ap, only) {
  if (!ap) return null;
  const health = (ap.health || []).filter(h => !only || h.key === only);
  const reviews = (ap.reviews || []).filter(r => !only || r.account === only);
  return el("section", { class: "panel section-sm" },
    el("div", { class: "panel-head" }, el("h2", {}, "Autopilot"), el("span", { class: "muted small" }, `updated ${ago(ap.generated)}`)),
    el("p", { class: "small" }, "Every evening Claude checks every bot. When an account's test has enough data, it reviews that account in depth: watches its videos like a viewer, reads the numbers, studies competitors in the same niche, keeps what worked and starts the next test."),
    ap.next?.name ? el("p", { class: "small section-sm" }, el("strong", {}, "Next review: "), `${ap.next.name}. ${ap.next.why}`) : null,
    reviews.length ? el("p", { class: "small section-sm" }, el("strong", {}, `Latest review (${day(reviews[0].date)}, ${BOT_NAMES[appBot(reviews[0].account)]}): `), reviews[0].summary) : null,
    health.length ? more(`Health check, ${ago(ap.health_at)}`, el("ul", { class: "feed" }, health.map(healthRow))) : null,
    reviews.length > 1 ? more(`All reviews (${reviews.length})`, el("ul", { class: "feed" }, reviews.map(r =>
      el("li", {}, el("div", { class: "row is-static", dataset: { bot: appBot(r.account) } }, el("span", { class: "mark" }),
        el("div", { class: "progress-text" }, el("div", { class: "muted small" }, `${day(r.date)} · ${BOT_NAMES[appBot(r.account)]}`), el("div", { class: "small" }, r.summary))))))) : null);
}

function account(a, trend, coach, ap) {
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
    a.alert ? el("p", { class: "small sev-action section-sm" }, a.alert) : null,
    autopilotFor(ap, a),
    playbook(appBot(a.key), coach.verdicts?.[appBot(a.key)]));
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
  const coach = await api("/api/coach").catch(() => ({ verdicts: {} }));
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
    autopilotTop(d.autopilot, only),
    el("div", { class: "section-sm" }, d.accounts.filter(a => !only || a.key === only).map(a => account(a, d.trend, coach, d.autopilot))),
    section("Tests", "Each bar fills as the smaller group reaches the number of videos a fair comparison needs.",
      tests.length ? el("ul", { class: "feed" }, [...tests].sort((a, b) => rank(a) - rank(b)).map(testRow)) : el("p", { class: "muted" }, "No tests on this account.")),
    section("Waiting to be done", null, d.todos.length ? el("ul", { class: "feed" }, d.todos.map(jobRow)) : el("p", { class: "muted" }, "Nothing waiting.")),
    section("What changed", null, changes(d.updates.filter(u => !only || u.bot === only))),
  ];
}
