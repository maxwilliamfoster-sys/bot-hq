// Tab views by route name. Later tasks replace the placeholders with the real screens.
import { el } from "./lib.js";

const placeholder = (title, text) => async () =>
  el("div", {}, el("h1", {}, title), el("div", { class: "empty" }, el("p", {}, text)));

export const views = {
  inbox: async () => el("div", {},
    el("header", { class: "status" }, el("h1", {}, "All clear"), el("p", {}, "Nothing needs you right now.")),
    el("div", { class: "empty" }, el("p", {}, "Alerts from your bots will appear here."))),
  live: placeholder("Live", "Live numbers appear here once the bots report in."),
  graphs: placeholder("Graphs", "Build and save your own graphs here."),
  bots: placeholder("Bots", "Each bot's runs and tests appear here."),
};
