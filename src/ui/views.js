// Screens by route name (#/<name>/<arg>). Settings is wired in app.js.
import { liveTab } from "./live.js";
import { botsTab } from "./bots.js";
import { graphsTab } from "./graphs.js";
import { inboxTab } from "./inbox.js";
import { eventView } from "./event.js";
import { radarTab } from "./radar.js";

export const views = {
  inbox: inboxTab,
  event: eventView,
  live: liveTab,
  graphs: graphsTab,
  radar: radarTab,
  bots: botsTab,
};
