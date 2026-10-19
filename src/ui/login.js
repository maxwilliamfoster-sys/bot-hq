import { api, el, isIOS, isStandalone } from "./lib.js";

export function loginView(onDone) {
  const input = el("input", {
    class: "input", id: "code", type: "password", autocomplete: "current-password",
    autocapitalize: "none", spellcheck: "false", required: true,
  });
  const error = el("p", { class: "error", role: "alert" });
  const button = el("button", { class: "btn btn-primary btn-block", type: "submit" }, "Sign in");
  const form = el("form", { class: "stack", onsubmit: async e => {
    e.preventDefault();
    error.textContent = "";
    button.disabled = true;
    try {
      await api("/api/login", { method: "POST", body: { code: input.value } });
      onDone();
    } catch (err) {
      error.textContent = err.status === 429
        ? "Too many tries. Wait 15 minutes, then try again."
        : "That code isn't right. Check it and try again.";
      button.disabled = false;
      input.select();
    }
  } },
    el("div", { class: "field" }, el("label", { for: "code" }, "Access code"), input),
    error,
    button,
  );
  return el("section", { class: "signin" },
    el("div", {},
      el("h1", {}, "Bot HQ"),
      el("p", { class: "muted" }, "Alerts, live numbers and fix prompts for your bots."),
    ),
    form,
    isIOS() && !isStandalone()
      ? el("p", { class: "hint" }, "To get notifications: tap Share, then Add to Home Screen, then open Bot HQ from there.")
      : null,
  );
}
