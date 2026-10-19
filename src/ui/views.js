// Tab views by route name. Later tasks replace the placeholders with the real screens.
import { el } from "./lib.js";
import { liveTab } from "./live.js";
import { botsTab } from "./bots.js";
import { graphsTab } from "./graphs.js";

const placeholder = (title, text) => async () =>
  el("div", {}, el("h1", {}, title), el("div", { class: "empty" }, el("p", {}, text)));

export const views = {
  inbox: async () => el("div", {},
    el("header", { class: "status" }, el("h1", {}, "All clear"), el("p", {}, "Nothing needs you right now.")),
    el("div", { class: "empty" }, el("p", {}, "Alerts from your bots will appear here."))),
  live: liveTab,
  graphs: graphsTab,
  bots: botsTab,
};
