// Event detail: what happened, what to do, links, and the one-tap "Copy fix prompt".
import { api, el, ago, botTag, toast, setBadge } from "./lib.js";

const SEV = { action: ["Needs you", "sev-action"], warn: ["Failed or blocked", "sev-warn"], good: ["Doing well", "sev-good"], info: ["For your info", "sev-info"] };

function whatToDo(e) {
  if (e.kind === "run_failed") return "Copy the fix prompt and paste it into Claude. It has the failed step, the end of the log and the rules to follow.";
  if (e.fix_prompt && (e.severity === "action" || e.severity === "warn")) {
    return "Copy the fix prompt and paste it into Claude. When it's fixed, tap Mark done.";
  }
  return null;
}

function links(d) {
  const out = [];
  if (d.run_url) out.push(["Open the run", d.run_url]);
  if (d.video_url) out.push(["Watch the video", d.video_url]);
  if (d.buffer_id) out.push(["Open Buffer", "https://publish.buffer.com/"]);
  return out.map(([text, href]) => el("a", { class: "btn", href, target: "_blank", rel: "noopener" }, text));
}

async function copy(text, pre) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied ✓  Paste it into Claude");
  } catch {
    // No clipboard permission: select the text so one tap on Copy finishes it.
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("Selected. Tap Copy to finish.");
  }
}

export async function eventView({ arg, setTabCount }) {
  const e = await api(`/api/events/${encodeURIComponent(arg || "")}`).catch(err => { if (err.status === 404) return null; throw err; });
  if (!e) {
    return el("div", { class: "empty" }, el("h2", {}, "This alert is gone"), el("p", {}, "It may have been cleared."),
      el("p", { class: "section" }, el("a", { class: "btn btn-primary", href: "#/inbox" }, "Back to the inbox")));
  }
  if (!e.read) api(`/api/events/${e.id}/read`, { method: "POST" }).catch(() => {});
  const [sevText, sevClass] = SEV[e.severity] || SEV.info;
  const todo = whatToDo(e);
  const pre = e.fix_prompt ? el("pre", { class: "prompt", tabindex: "0", "aria-label": "Fix prompt" }, e.fix_prompt) : null;
  const done = el("button", { class: "btn btn-block", onclick: async () => {
    done.disabled = true;
    const r = await api(`/api/events/${e.id}/resolve`, { method: "POST" });
    setTabCount(r.open_actions);
    setBadge(r.open_actions);
    toast("Marked done");
    location.hash = "#/inbox";
  } }, "Mark done");

  return el("div", { class: "stack" },
    el("a", { class: "back", href: "#/inbox" }, "‹ Inbox"),
    el("div", {},
      el("p", { class: `detail-sev ${sevClass}` }, sevText),
      el("h1", { class: "detail-title" }, e.title),
      el("p", { class: "muted" }, el("span", { dataset: { bot: e.bot } }, botTag(e.bot)), " ",
        e.count > 1 ? `${e.count} times in 24h, last ${ago(e.last_at)}` : ago(e.at))),
    e.fix_prompt ? el("button", { class: "btn btn-primary btn-block btn-copy", onclick: () => copy(e.fix_prompt, pre) }, "Copy fix prompt") : null,
    el("section", { class: "block" }, el("h3", {}, "What happened"),
      el("p", { class: "body-text" }, e.body || e.title),
      e.data.step ? el("p", { class: "muted" }, `Failed step: ${e.data.step}`) : null),
    todo ? el("section", { class: "block" }, el("h3", {}, "What to do"), el("p", {}, todo)) : null,
    links(e.data).length ? el("div", { class: "btn-row" }, links(e.data)) : null,
    pre ? el("section", { class: "block" }, el("h3", {}, "Fix prompt"), pre) : null,
    e.resolved ? el("p", { class: "muted" }, "Done.") : (e.severity === "action" || e.severity === "warn" ? done : null));
}
