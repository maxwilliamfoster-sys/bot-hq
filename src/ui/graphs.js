// Graphs tab: saved graphs as tiles (tap to open, long-press to rename or delete) and a
// builder where every choice redraws a live preview.
import { api, el, fmt, toast, liveView, BOT_NAMES } from "./lib.js";
import { drawChart, destroyCharts } from "./chart.js";

const METRICS = [
  ["views", "Views"], ["views_1h", "Views at 1h"], ["views_6h", "Views at 6h"], ["views_24h", "Views at 24h"],
  ["views_72h", "Views at 72h"], ["likes", "Likes"], ["comments", "Comments"], ["shares", "Shares"],
  ["avg_watch_pct", "% watched"], ["followers", "Followers"], ["posts", "Posts"],
  ["gate_pass_rate", "Gate pass rate"], ["ai_reviews", "AI reviews"],
];
const GROUPS = [["post", "Per post"], ["day", "Day"], ["week", "Week"], ["hour", "Hour"], ["post_hour", "Time of day"],
  ["weekday", "Weekday"], ["variant", "Variant"], ["format", "Format"]];
const RANGES = [["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"], ["custom", "Custom"]];
const CHARTS = [["line", "Line"], ["bar", "Bar"], ["scatter", "Dots"], ["table", "Table"]];
const SPLITS = [["", "Together"], ["bots", "By bot"], ["variant", "By variant"]];
const BOT_IDS = ["chess", "bcf", "escape"];
const AVERAGED = new Set(["views", "likes", "comments", "shares", "avg_watch_pct", "views_1h", "views_6h", "views_24h", "views_72h"]);
const EMPTY = "Not enough data yet. History fills in after the nightly backfill, and views at 1h/6h/24h/72h about four hours after each age passes.";

const label = (list, v) => list.find(([k]) => k === v)?.[1] || v;

export function describe(spec) {
  const range = typeof spec.range === "object" ? `${spec.range.from.slice(0, 10)} to ${spec.range.to.slice(0, 10)}` : label(RANGES, spec.range).toLowerCase();
  const bots = spec.bots.length === 3 ? "all bots" : spec.bots.map(b => BOT_NAMES[b]).join(" and ");
  return `${label(METRICS, spec.metric)}, ${label(GROUPS, spec.groupBy).toLowerCase()}, ${range}, ${bots}`;
}

const graphUrl = spec => `/api/graph?spec=${encodeURIComponent(JSON.stringify(spec))}`;
const isEmpty = d => !d.labels.length || d.series.every(s => s.data.every(v => v === null));
const noteFor = spec => n => (AVERAGED.has(spec.metric) && spec.groupBy !== "post" && n ? `, average of ${n} post${n === 1 ? "" : "s"}` : "");

function table(data, spec) {
  const note = AVERAGED.has(spec.metric) && spec.groupBy !== "post";
  return el("table", { class: "table" },
    el("thead", {}, el("tr", {}, el("th", {}, label(GROUPS, spec.groupBy)), data.series.map(s => el("th", {}, s.name)))),
    el("tbody", {}, data.labels.map((lab, i) => el("tr", {},
      el("td", {}, lab),
      data.series.map(s => el("td", {}, s.data[i] === null ? "–" : fmt(s.data[i]),
        note && s.n[i] ? el("div", { class: "cell-n" }, `${s.n[i]} post${s.n[i] === 1 ? "" : "s"}`) : null))))));
}

// Fills `box` with the graph (chart or table) or the empty message.
function render(box, data, spec) {
  if (isEmpty(data)) {
    box.classList.add("is-empty");
    box.replaceChildren(el("p", { class: "empty" }, EMPTY));
    return;
  }
  box.classList.remove("is-empty");
  if (spec.chart === "table") {
    box.classList.add("is-table");
    box.replaceChildren(table(data, spec));
    return;
  }
  box.classList.remove("is-table");
  const canvas = el("canvas", { role: "img", "aria-label": describe(spec) });
  box.replaceChildren(canvas);
  drawChart(canvas, data, spec.chart, { note: noteFor(spec) });
}

async function loadSaved() { return api("/api/graphs"); }
async function saveAll(list) { return api("/api/graphs", { method: "PUT", body: list }); }

// ---------- bottom sheet (long-press menu) ----------
function sheet(title, build) {
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  const panel = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title });
  const wrap = el("div", { class: "sheet-wrap", onclick: e => { if (e.target === wrap) close(); } }, panel);
  panel.append(el("h2", {}, title), ...build(close));
  document.body.append(wrap);
  document.addEventListener("keydown", onKey);
  panel.querySelector("button, input")?.focus();
}

function tileMenu(list, i, rerender) {
  sheet(list[i].name, close => {
    const actions = el("div", { class: "stack" },
      el("button", { class: "btn btn-block", onclick: () => {
        const input = el("input", { class: "input", value: list[i].name, maxlength: 80, "aria-label": "Graph name" });
        actions.replaceChildren(input, el("button", { class: "btn btn-primary btn-block", onclick: async () => {
          if (!input.value.trim()) return input.focus();
          list[i] = { ...list[i], name: input.value.trim() };
          await saveAll(list); close(); toast("Renamed"); rerender();
        } }, "Save name"), el("button", { class: "btn btn-block", onclick: close }, "Cancel"));
        input.focus(); input.select();
      } }, "Rename"),
      el("button", { class: "btn btn-alarm btn-block", onclick: async () => {
        list.splice(i, 1);
        await saveAll(list); close(); toast("Graph deleted"); rerender();
      } }, "Delete"),
      el("button", { class: "btn btn-block", onclick: close }, "Cancel"));
    return [actions];
  });
}

function longPress(node, onLong) {
  let timer = null, x = 0, y = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener("pointerdown", e => {
    fired = false; x = e.clientX; y = e.clientY;
    timer = setTimeout(() => { fired = true; timer = null; onLong(); }, 550);
  });
  node.addEventListener("pointermove", e => { if (Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) node.addEventListener(ev, cancel);
  node.addEventListener("contextmenu", e => { e.preventDefault(); cancel(); if (!fired) { fired = true; onLong(); } });
  node.addEventListener("click", e => { if (fired) { e.preventDefault(); e.stopImmediatePropagation(); fired = false; } }, true);
}

// ---------- tiles ----------
async function tilesScreen({ rerender }) {
  const list = await loadSaved();
  const tiles = list.map((g, i) => {
    const preview = el("div", { class: "tile-chart" });
    const tile = el("a", { class: "tile", href: `#/graphs/${i}` },
      el("span", { class: "name" }, g.name), preview,
      el("span", { class: "tile-dots" }, g.spec.bots.map(b => el("span", { class: "bot-dot", dataset: { bot: b } }))));
    longPress(tile, () => tileMenu(list, i, rerender));
    tile.dataset.spec = JSON.stringify(g.spec);
    return tile;
  });
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const spec = JSON.parse(e.target.dataset.spec);
      api(graphUrl(spec)).then(data => {
        const box = e.target.querySelector(".tile-chart");
        if (isEmpty(data)) return box.replaceChildren(el("span", { class: "muted" }, "No data yet"));
        const canvas = el("canvas", { "aria-hidden": "true" });
        box.replaceChildren(canvas);
        drawChart(canvas, data, spec.chart === "table" ? "bar" : spec.chart, { mini: true });
      }).catch(() => {});
    }
  });
  queueMicrotask(() => tiles.forEach(t => io.observe(t)));
  return el("div", {},
    el("div", { class: "section-head" }, el("h1", {}, "Graphs"),
      el("a", { class: "btn btn-primary btn-small", href: "#/graphs/new" }, "New graph")),
    list.length
      ? el("div", { class: "tiles" }, tiles)
      : el("div", { class: "empty" }, el("p", {}, "No saved graphs. Build one and it will be pinned here.")),
    list.length ? el("p", { class: "muted section hint" }, "Tap a graph to open it. Press and hold to rename or delete it.") : null);
}

// ---------- one graph, full screen ----------
async function graphScreen(i) {
  const list = await loadSaved();
  const g = list[i];
  if (!g) { location.hash = "#/graphs"; return el("div", {}); }
  const root = el("div", {});
  let showTable = g.spec.chart === "table";
  const fill = async () => {
    const data = await api(graphUrl(g.spec));
    destroyCharts();
    const box = el("div", { class: "chart-box chart-full" });
    render(box, data, { ...g.spec, chart: showTable ? "table" : g.spec.chart === "table" ? "bar" : g.spec.chart });
    return [
      el("a", { class: "back", href: "#/graphs" }, "‹ Graphs"),
      el("h1", {}, g.name),
      el("p", { class: "muted" }, describe(g.spec)),
      el("div", { class: "section" }, box),
      el("div", { class: "btn-row section" },
        el("button", { class: "btn", onclick: () => { showTable = !showTable; refresh(); } }, showTable ? "Show chart" : "Show table"),
        el("a", { class: "btn", href: `#/graphs/edit-${i}` }, "Edit")),
    ];
  };
  const { refresh, mount } = liveView(root, fill);
  return mount();
}

// ---------- builder ----------
const DEFAULT = { metric: "views", bots: [...BOT_IDS], range: "7d", groupBy: "day", chart: "line", compare: "bots" };

function seg(options, isOn, onPick, { multi = false } = {}) {
  const box = el("div", { class: "seg", role: multi ? "group" : "radiogroup" });
  const draw = () => box.replaceChildren(...options.map(([v, text]) =>
    el("button", { type: "button", "aria-pressed": isOn(v) ? "true" : "false", dataset: { v },
      onclick: () => { onPick(v); draw(); } }, text)));
  draw();
  return box;
}

async function builderScreen(editIndex) {
  const list = await loadSaved();
  const editing = editIndex !== null ? list[editIndex] : null;
  const spec = structuredClone(editing?.spec || DEFAULT);
  let customFrom = typeof spec.range === "object" ? spec.range.from.slice(0, 10) : "";
  let customTo = typeof spec.range === "object" ? spec.range.to.slice(0, 10) : "";
  let rangeMode = typeof spec.range === "object" ? "custom" : spec.range;
  const box = el("div", { class: "chart-box builder-preview", "aria-live": "polite" });
  const meta = el("p", { class: "muted preview-meta" });
  const name = el("input", { class: "input", id: "graph-name", maxlength: 80, value: editing?.name || "", placeholder: "Name this graph" });
  let timer = null, token = 0;

  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++token;
      try {
        const data = await api(graphUrl(spec));
        if (mine !== token) return;
        destroyCharts();
        render(box, data, spec);
        meta.textContent = describe(spec);
      } catch (e) {
        if (mine === token) { box.replaceChildren(el("p", { class: "empty" }, "Couldn't draw this graph. Try another combination.")); }
      }
    }, 300);
  };

  const customBox = el("div", { class: "custom-range", hidden: rangeMode !== "custom" },
    el("label", {}, "From ", el("input", { type: "date", class: "time", value: customFrom, onchange: e => { customFrom = e.target.value; applyCustom(); } })),
    el("label", {}, "To ", el("input", { type: "date", class: "time", value: customTo, onchange: e => { customTo = e.target.value; applyCustom(); } })));
  function applyCustom() {
    if (customFrom && customTo && customFrom < customTo) {
      spec.range = { from: `${customFrom}T00:00:00.000Z`, to: `${customTo}T23:59:59.999Z` };
      preview();
    }
  }

  const picker = (title, control) => el("section", { class: "picker" }, el("h3", {}, title), control);
  const pickers = el("div", { class: "section" },
    picker("Metric", seg(METRICS, v => spec.metric === v, v => { spec.metric = v; preview(); })),
    picker("Bots", seg(BOT_IDS.map(b => [b, BOT_NAMES[b]]), v => spec.bots.includes(v), v => {
      if (spec.bots.includes(v)) { if (spec.bots.length > 1) spec.bots = spec.bots.filter(b => b !== v); }
      else spec.bots = BOT_IDS.filter(b => b === v || spec.bots.includes(b));
      preview();
    }, { multi: true })),
    picker("Range", el("div", {}, seg(RANGES, v => rangeMode === v, v => {
      rangeMode = v;
      customBox.hidden = v !== "custom";
      if (v === "custom") applyCustom();          // redraws once both dates are picked
      else { spec.range = v; preview(); }
    }), customBox)),
    picker("Group by", seg(GROUPS, v => spec.groupBy === v, v => { spec.groupBy = v; preview(); })),
    picker("Chart", seg(CHARTS, v => spec.chart === v, v => { spec.chart = v; preview(); })),
    picker("Split", seg(SPLITS, v => (spec.compare || "") === v, v => { spec.compare = v || undefined; preview(); })));

  const save = async () => {
    const n = name.value.trim() || describe(spec).slice(0, 80);
    if (rangeMode === "custom" && typeof spec.range !== "object") return toast("Pick both dates for a custom range");
    const entry = { name: n, spec: { ...spec, compare: spec.compare || undefined } };
    if (editing) list[editIndex] = entry; else list.push(entry);
    if (list.length > 30) return toast("You can pin up to 30 graphs. Delete one first.");
    await saveAll(list);
    toast(editing ? "Graph saved" : "Graph pinned");
    location.hash = editing ? `#/graphs/${editIndex}` : "#/graphs";
  };

  preview();
  return el("div", { class: "builder" },
    el("a", { class: "back", href: editing ? `#/graphs/${editIndex}` : "#/graphs" }, editing ? "‹ Back" : "‹ Graphs"),
    el("h1", {}, editing ? "Edit graph" : "New graph"),
    el("div", { class: "preview-wrap" }, box, meta),
    pickers,
    el("section", { class: "section field" }, el("label", { for: "graph-name" }, "Name"), name,
      el("button", { class: "btn btn-primary btn-block", onclick: save }, "Save graph")));
}

export async function graphsTab({ arg, rerender }) {
  destroyCharts();
  if (arg === "new") return builderScreen(null);
  if (arg?.startsWith("edit-")) return builderScreen(Number(arg.slice(5)));
  if (arg !== undefined && arg !== "" && !Number.isNaN(Number(arg))) return graphScreen(Number(arg));
  return tilesScreen({ rerender });
}
