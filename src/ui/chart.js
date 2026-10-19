// Chart.js, tree-shaken to what Bot HQ draws. Labels arrive pre-formatted (UK time) from
// the API, so a category axis is enough - no date adapter needed.
import {
  Chart, LineController, BarController, LineElement, BarElement, PointElement,
  CategoryScale, LinearScale, Tooltip, Legend,
} from "chart.js";
import { fmt } from "./lib.js";

Chart.register(LineController, BarController, LineElement, BarElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend);

const live = new Set();
// Charts keep resize observers alive; drop them whenever a screen is rebuilt.
export function destroyCharts() {
  for (const c of live) c.destroy();
  live.clear();
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const BOT_VAR = { Chess: "--chess", BuriedCasefiles: "--bcf", "Escape Cup": "--escape", "Bot HQ": "--system" };
const OTHER = ["--escape", "--system", "--bcf", "--chess", "--warn", "--good"];

function colour(name, i) {
  if (BOT_VAR[name]) return css(BOT_VAR[name]);
  if (name === "All bots") return css("--ink");
  return css(OTHER[i % OTHER.length]);
}

const short = s => (String(s).length > 16 ? `${String(s).slice(0, 15)}…` : String(s));
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// data: {labels, series:[{name, data, n}], unit}; kind: line|bar|scatter; note(n) -> tooltip suffix
export function drawChart(canvas, data, kind, { mini = false, note = () => "" } = {}) {
  const ink = css("--muted"), line = css("--line");
  const datasets = data.series.map((s, i) => {
    const c = colour(s.name, i);
    return {
      label: s.name, data: s.data, n: s.n,
      type: kind === "bar" ? "bar" : "line",
      backgroundColor: c, borderColor: c,
      borderWidth: kind === "bar" ? 0 : 2, borderRadius: kind === "bar" ? 4 : 0,
      showLine: kind !== "scatter", spanGaps: true, tension: 0.25,
      pointRadius: mini ? 0 : kind === "scatter" ? 4 : data.labels.length > 40 ? 0 : 2.5,
      pointHoverRadius: 5,
    };
  });
  const chart = new Chart(canvas, {
    type: kind === "bar" ? "bar" : "line",
    data: { labels: data.labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: mini || reduced() ? false : { duration: 250 },
      interaction: { mode: "nearest", intersect: false },
      layout: { padding: mini ? 0 : { top: 4 } },
      plugins: {
        legend: { display: !mini && datasets.length > 1, position: "bottom",
          labels: { color: ink, boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { weight: 600 } } },
        tooltip: { enabled: !mini, callbacks: {
          title: items => items[0]?.label,
          label: c => `${c.dataset.label}: ${fmt(c.parsed.y)} ${data.unit}${note(c.dataset.n?.[c.dataIndex])}`,
        } },
      },
      scales: {
        x: { display: !mini, grid: { display: false }, border: { color: line },
          ticks: { color: ink, maxRotation: 0, autoSkip: true, autoSkipPadding: 12, callback(v) { return short(this.getLabelForValue(v)); } } },
        y: { display: !mini, beginAtZero: true, grid: { color: line }, border: { display: false },
          ticks: { color: ink, maxTicksLimit: 5, callback: v => fmt(v) } },
      },
    },
  });
  live.add(chart);
  return chart;
}
