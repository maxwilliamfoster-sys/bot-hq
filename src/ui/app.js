// Bot HQ app shell: sign-in gate, hash router, bottom tab bar.
import { api, el, svg, SignedOut } from "./lib.js";
import { loginView } from "./login.js";
import { settingsView } from "./settings.js";
import { views } from "./views.js";

const ICONS = {
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
  graphs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/></svg>',
  bots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
};
const TABS = [["inbox", "Inbox"], ["live", "Live"], ["graphs", "Graphs"], ["radar", "Radar"], ["bots", "Bots"], ["settings", "Settings"]];

const main = document.getElementById("view");
const nav = document.getElementById("tabs");
let renderToken = 0;
let signedIn = false;

function route() {
  const parts = (location.hash.replace(/^#\/?/, "") || "inbox").split("/");
  return { name: parts[0], arg: parts[1] };
}

export function setTabCount(n) {
  const a = nav.querySelector('a[href="#/inbox"]');
  if (!a) return;
  a.querySelector(".count")?.remove();
  if (n > 0) a.append(el("span", { class: "count", "aria-label": `${n} need you` }, n > 99 ? "99+" : n));
}

function drawTabs(active) {
  if (!nav.childElementCount) {
    for (const [name, label] of TABS) nav.append(el("a", { href: `#/${name}` }, svg(ICONS[name]), label));
  }
  for (const a of nav.querySelectorAll("a")) {
    if (a.getAttribute("href") === `#/${active}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  nav.hidden = false;
}

async function showSignIn() {
  signedIn = false;
  nav.hidden = true;
  main.replaceChildren(loginView(() => { location.hash = "#/inbox"; render(); }));
  main.querySelector("input")?.focus();
}

export async function render() {
  const token = ++renderToken;
  const { name, arg } = route();
  const tab = name === "event" ? "inbox" : name;
  try {
    if (!signedIn) {
      signedIn = (await api("/api/me")).signedIn;
      if (!signedIn) throw new SignedOut();
    }
    const view = name === "settings"
      ? await settingsView({ rerender: render, signOut })
      : await (views[name] || views.inbox)({ arg, rerender: render, setTabCount });
    if (token !== renderToken) return; // a newer navigation won
    drawTabs(TABS.some(([n]) => n === tab) ? tab : "inbox");
    main.replaceChildren(view);
    window.scrollTo(0, 0);
  } catch (e) {
    if (e instanceof SignedOut) return showSignIn();
    console.error(e);
    drawTabs(tab);
    main.replaceChildren(el("div", { class: "empty" },
      el("h2", {}, "Couldn't load this screen"),
      el("p", {}, "Check your connection, then pull down or tap below."),
      el("p", { class: "section" }, el("button", { class: "btn btn-primary", onclick: render }, "Try again"))));
  }
}

async function signOut() {
  await api("/api/logout", { method: "POST" });
  showSignIn();
}

window.addEventListener("hashchange", render);
navigator.serviceWorker?.addEventListener("message", e => {
  if (e.data?.type === "open" && e.data.url) location.href = e.data.url;
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render();
