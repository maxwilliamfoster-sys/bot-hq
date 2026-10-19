// Inbox (home): one loud sentence, the red "needs you" stack, filter chips, then the feed.
import { api, el, ago, botTag, liveView, setBadge } from "./lib.js";

const CHIPS = [["all", "All"], ["needs", "Needs you"], ["failed", "Failed"], ["good", "Doing well"], ["posted", "Posted"], ["summary", "Summary"]];
const EMPTY = {
  all: "Alerts from your bots will appear here.",
  needs: "Nothing has needed you yet.",
  failed: "No failed or blocked posts.",
  good: "No standout posts yet. Posts in the top 10% for their age show up here.",
  posted: "No posts yet.",
  summary: "The daily summary arrives at 07:30.",
};

const times = n => (n > 1 ? `${n}× in 24h, ` : "");

function needCard(e) {
  return el("a", { class: "need", href: `#/event/${e.id}` },
    el("span", { class: "title" }, e.title),
    el("span", { class: "meta" }, el("span", { dataset: { bot: e.bot } }, botTag(e.bot)), el("span", { class: "when" }, `${times(e.count)}${ago(e.last_at)}`)),
    el("span", { class: "go", "aria-hidden": "true" }, "›"));
}

function feedRow(e) {
  return el("li", { dataset: { id: e.id } }, el("a", { class: `row${e.read || e.resolved ? " is-read" : ""}`, href: `#/event/${e.id}`, dataset: { bot: e.bot, sev: e.severity } },
    el("span", { class: "mark" }),
    el("span", {},
      el("span", { class: "title" }, e.title),
      el("span", { class: "when" }, `${botName(e)}${times(e.count)}${ago(e.last_at)}${e.resolved ? ". Done" : ""}`))));
}
const botName = e => ({ chess: "Chess, ", bcf: "BuriedCasefiles, ", escape: "Escape Cup, ", system: "Bot HQ, " }[e.bot] || "");

export async function inboxTab({ arg, setTabCount }) {
  const filter = CHIPS.some(([k]) => k === arg) ? arg : "all";
  const root = el("div", {});
  const fill = async () => {
    const data = await api(`/api/inbox?filter=${filter}`);
    setTabCount(data.open_actions);
    setBadge(data.open_actions);
    const n = data.open_actions;
    const list = el("ul", { class: "feed" }, data.events.map(feedRow));
    const more = el("button", { class: "btn btn-block section", onclick: async () => {
      more.disabled = true;
      const next = await api(`/api/inbox?filter=${filter}&before=${list.lastChild.dataset.id}`);
      list.append(...next.events.map(feedRow));
      if (!next.more) more.remove(); else more.disabled = false;
    } }, "Show older");
    return [
      el("header", { class: `status${n ? " is-alarm" : ""}` },
        el("h1", {}, n ? `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you` : "All clear"),
        el("p", {}, n ? "Tap one to see what happened and copy the fix prompt." : "Nothing needs you right now.")),
      n ? el("div", { class: "needs" }, data.needs.map(needCard)) : null,
      el("nav", { class: "section", "aria-label": "Filter" }, el("div", { class: "chips" },
        CHIPS.map(([k, text]) => el("a", { class: "chip", href: k === "all" ? "#/inbox" : `#/inbox/${k}`, "aria-pressed": k === filter ? "true" : "false" }, text)))),
      data.events.length ? list : el("div", { class: "empty" }, el("p", {}, EMPTY[filter])),
      data.more ? more : null,
    ];
  };
  return liveView(root, fill).mount();
}
