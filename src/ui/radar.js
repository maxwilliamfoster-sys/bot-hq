// Radar tab: what the Shorts Radar found in the chess niche, and the one-tap
// "Copy Claude prompt" that turns it into a request to improve the channel.
import { api, el, ago, fmt, toast, liveView } from "./lib.js";

async function copy(text, pre) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied ✓  Paste it into Claude");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("Selected. Tap Copy to finish.");
  }
}

const pct = x => `${Math.round(x * 100)}%`;

function example(v) {
  const meta = [v.ratio ? `${v.ratio}x its channel's normal` : null, `${fmt(v.views)} views`, v.duration ? `${v.duration}s` : null, v.channel]
    .filter(Boolean).join(" · ");
  return el("li", {}, el("a", { class: "row", href: v.url, target: "_blank", rel: "noopener" },
    el("span", { class: "mark" }),
    el("span", {}, el("span", { class: "title" }, v.title), el("span", { class: "when" }, meta))));
}

function section(title, hint, body) {
  return el("section", { class: "block" }, el("h3", {}, title), hint ? el("p", { class: "muted" }, hint) : null, body);
}

function you(d) {
  const y = d.you;
  if (!y || y.median_v24 == null) return null;
  const facts = [
    ["Your median at 24h", fmt(y.median_v24)],
    ["Small rivals", y.niche_small_channels_median_v24 ? fmt(y.niche_small_channels_median_v24) : "–"],
  ];
  const own = (y.durations || []).filter(Boolean).sort((a, b) => a - b);
  if (own.length && d.winner_median_duration) {
    facts.push(["Your length", `${own[Math.floor(own.length / 2)]}s`], ["Winners' length", `${Math.round(d.winner_median_duration)}s`]);
  }
  return section("You vs the niche", `Your last ${y.videos} Shorts against channels under 50k subs.`,
    el("dl", { class: "facts" }, facts.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))));
}

export async function radarTab() {
  const root = el("div", {});
  const fill = async () => {
    const d = await api("/api/radar");
    if (!d.available) {
      return [el("h1", {}, "Radar"), el("div", { class: "empty" }, el("p", {}, "The radar hasn't published a chess report yet. It runs once a day at 07:00 UTC."))];
    }
    const pre = d.prompt ? el("pre", { class: "prompt", tabindex: "0", "aria-label": "Claude prompt" }, d.prompt) : null;
    return [
      el("div", { class: "section-head" }, el("h1", {}, "Radar"), el("span", { class: "updated" }, `Report ${ago(d.generated)}`)),
      el("p", { class: "muted" }, `Chess Shorts: ${d.n_channels} channels watched, ${fmt(d.n_videos)} Shorts tracked, ${fmt(d.n_scored)} scored.`),
      pre ? el("button", { class: "btn btn-primary btn-block btn-copy", onclick: () => copy(d.prompt, pre) }, "Copy prompt for Claude") : null,
      you(d),
      d.breaking.length ? section("Breaking now", "Under 36 hours old and already beating their channel.", el("ul", { class: "feed" }, d.breaking.map(example))) : null,
      d.levers.length ? section("What winners have in common", "How much more often the top quarter does this. Small samples, so it is a hint, not proof.",
        el("ul", { class: "feed" }, d.levers.map(l => el("li", {}, el("div", { class: "row" }, el("span", { class: "mark" }),
          el("span", {}, el("span", { class: "title" }, l.feature), el("span", { class: "when" }, `${l.lift}x · ${pct(l.share_top)} of winners vs ${pct(l.share_all)} overall · n=${l.n}`))))))) : null,
      d.top_outliers.length ? section("Biggest outliers", null, el("ul", { class: "feed" }, d.top_outliers.map(example))) : null,
      d.hypotheses.length ? section("Ideas to test", "Proposed by the radar, not applied.",
        el("ul", { class: "feed" }, d.hypotheses.map(h => el("li", {}, el("div", { class: "row" }, el("span", { class: "mark" }),
          el("span", {}, el("span", { class: "title" }, h.change), el("span", { class: "when" }, h.how_to_test || h.why))))))) : null,
      pre ? section("Claude prompt", "This is what Copy puts on your clipboard.", pre) : null,
    ];
  };
  return liveView(root, fill, { every: 600000 }).mount();
}
