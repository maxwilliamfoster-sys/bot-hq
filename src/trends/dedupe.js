// One key per trend however it is worded: "The Case of Joanna Yeates" = "Joanna Yeates case".
import { normalise } from "./text.js";
import RULES from "../../trends/text_rules.json" with { type: "json" };

const FILLER = new Set(RULES.filler);

export function dedupeKey(name) {
  const words = normalise(name).trim().split(" ").filter(w => w && !FILLER.has(w));
  return [...new Set(words)].sort().join("-");
}
