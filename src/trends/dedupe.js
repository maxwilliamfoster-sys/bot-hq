// One key per trend however it is worded: "The Case of Joanna Yeates" = "Joanna Yeates case".
import { normalise } from "./text.js";

const FILLER = new Set(["the", "a", "an", "of", "and", "in", "on", "for", "to", "at", "case", "news", "latest",
  "update", "updates", "video", "videos", "new", "story", "explained", "trend", "trending"]);

export function dedupeKey(name) {
  const words = normalise(name).trim().split(" ").filter(w => w && !FILLER.has(w));
  return [...new Set(words)].sort().join("-");
}
