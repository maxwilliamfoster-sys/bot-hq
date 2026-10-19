// Small UI helpers. Text from the bots is always set as text, never as HTML.
export class SignedOut extends Error {}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith("/api/login")) throw new SignedOut();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// el("button", {class: "btn", onclick}, "Text", childNode)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function svg(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim(); // only ever called with constant markup from this codebase
  return t.content.firstChild;
}

let toastTimer;
export function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

export const BOT_NAMES = { chess: "Chess", bcf: "BuriedCasefiles", escape: "Escape Cup", system: "Bot HQ" };

export const botTag = bot => el("span", { class: "bot-tag", dataset: { bot } }, BOT_NAMES[bot] || bot);

export function ago(iso, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n * 10) / 10);
}

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export async function setBadge(n) {
  try {
    if (!("setAppBadge" in navigator)) return;
    if (n > 0) await navigator.setAppBadge(n); else await navigator.clearAppBadge();
  } catch { /* badge is a nicety */ }
}

const UK_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const UK_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" });
const UK_YMD = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });

// "14:00", "Tue 09:15" when it isn't today (UK time).
export function ukClock(iso, now = Date.now()) {
  if (!iso) return null;
  const d = new Date(iso);
  const t = UK_TIME.format(d);
  return UK_YMD.format(d) === UK_YMD.format(new Date(now)) ? t : `${UK_DAY.format(d)} ${t}`;
}

// A view that keeps itself fresh: fills `root` now, again every `every` ms while the
// page is visible and the view is on screen, and when pulled down from the top.
export function liveView(root, fill, { every = 60000 } = {}) {
  const ptr = el("div", { class: "ptr", "aria-hidden": "true" }, "Release to refresh");
  let busy = false;
  const refresh = async () => {
    if (busy || !root.isConnected) return;
    busy = true;
    try { root.replaceChildren(ptr, ...(await fill())); } catch (e) { if (e instanceof SignedOut) location.reload(); else toast("Couldn't refresh. Check your connection."); }
    busy = false;
  };
  const timer = setInterval(() => {
    if (!root.isConnected) return clearInterval(timer);
    if (document.visibilityState === "visible") refresh();
  }, every);
  let startY = null;
  root.addEventListener("touchstart", e => { startY = window.scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  root.addEventListener("touchmove", e => {
    if (startY !== null) ptr.classList.toggle("show", e.touches[0].clientY - startY > 70);
  }, { passive: true });
  root.addEventListener("touchend", () => {
    if (ptr.classList.contains("show")) { ptr.classList.remove("show"); refresh(); }
    startY = null;
  });
  return { ptr, refresh };
}
