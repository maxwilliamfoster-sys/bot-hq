import { api, el, toast, isIOS, isStandalone } from "./lib.js";

const TYPES = [
  ["notify_action", "Needs you", "Always sent, even in quiet hours"],
  ["notify_warn", "Failed or blocked posts", "A video couldn't post or was held back"],
  ["notify_good", "Doing well", "A post is in its bot's top 10%"],
  ["notify_posted", "Posted", "Every time a bot publishes"],
  ["notify_summary", "Daily summary", "07:30 every morning"],
];

function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function turnOn() {
  if (!("Notification" in window) || !("PushManager" in window)) {
    throw new Error(isIOS() && !isStandalone()
      ? "Add Bot HQ to your Home Screen first, then open it from there."
      : "This browser can't receive notifications.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in Settings > Bot HQ > Notifications.");
  const { key } = await api("/api/push/key");
  if (!key) throw new Error("The server has no push key yet.");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
  await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
}

async function turnOff() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

export async function settingsView({ rerender, signOut }) {
  const [settings, sub] = await Promise.all([api("/api/settings"), currentSubscription().catch(() => null)]);
  const save = async patch => {
    try { Object.assign(settings, await api("/api/settings", { method: "PUT", body: patch })); toast("Saved"); }
    catch { toast("Couldn't save. Check your connection."); }
  };
  const run = fn => async e => {
    const b = e.currentTarget; b.disabled = true;
    try { await fn(); } catch (err) { toast(err.message || "Something went wrong"); }
    b.disabled = false;
  };

  const device = el("section", { class: "section" },
    el("div", { class: "section-head" }, el("h2", {}, "This device")),
    el("div", { class: "block stack" },
      el("p", {}, sub ? "Connected. This phone gets notifications." : "Not connected. This phone won't get notifications yet."),
      isIOS() && !isStandalone()
        ? el("p", { class: "hint" }, "Tap Share, then Add to Home Screen, then open Bot HQ from your Home Screen to turn notifications on.")
        : null,
      el("div", { class: "btn-row" },
        sub
          ? el("button", { class: "btn", onclick: run(async () => { await turnOff(); toast("Disconnected"); rerender(); }) }, "Disconnect this device")
          : el("button", { class: "btn btn-primary", onclick: run(async () => { await turnOn(); toast("Notifications on"); rerender(); }) }, "Turn on notifications"),
        el("button", { class: "btn", onclick: run(async () => {
          const r = await api("/api/push/test", { method: "POST" });
          toast(r.sent ? `Test sent to ${r.sent} device${r.sent > 1 ? "s" : ""}` : "No connected devices");
        }) }, "Send test notification"),
      ),
    ),
  );

  const toggles = el("section", { class: "section" },
    el("div", { class: "section-head" }, el("h2", {}, "Notify me about")),
    el("div", { class: "list" }, TYPES.map(([key, label, help]) =>
      el("label", { class: "setting" },
        el("span", { class: "what" }, el("span", {}, label), el("span", { class: "small muted" }, help)),
        el("input", { type: "checkbox", role: "switch", class: "switch", checked: !!settings[key],
          onchange: e => save({ [key]: e.target.checked }) }),
      ))),
  );

  const time = key => el("input", { type: "time", class: "time", value: settings[key],
    onchange: e => save({ [key]: e.target.value }) });
  const quiet = el("section", { class: "section" },
    el("div", { class: "section-head" }, el("h2", {}, "Quiet hours")),
    el("div", { class: "list" },
      el("div", { class: "setting" }, el("span", { class: "what" }, el("span", {}, "From"),
        el("span", { class: "small muted" }, "Only “Needs you” gets through")), time("quiet_start")),
      el("div", { class: "setting" }, el("span", {}, "Until"), time("quiet_end")),
    ),
  );

  return el("div", {},
    el("h1", {}, "Settings"),
    device, toggles, quiet,
    el("section", { class: "section" },
      el("button", { class: "btn btn-block", onclick: run(signOut) }, "Sign out")),
  );
}
