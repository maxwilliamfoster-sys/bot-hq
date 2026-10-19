// Time rules (UK local time) and which events get pushed.
const UK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
});

export function ukParts(date) {
  const p = Object.fromEntries(UK.formatToParts(date).map(x => [x.type, x.value]));
  return { hhmm: `${p.hour}:${p.minute}`, ymd: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday };
}

export function inQuietHours(date, settings) {
  const t = ukParts(date).hhmm;
  const { quiet_start: a, quiet_end: b } = settings;
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

function toggleFor(event) {
  if (event.kind === "posted") return "notify_posted";
  if (event.kind === "summary" || event.kind === "digest") return "notify_summary";
  return { action: "notify_action", warn: "notify_warn", good: "notify_good" }[event.severity] || "notify_posted";
}

export function shouldPush(event, settings, date) {
  if (event.severity === "action") return !!settings.notify_action;
  if (!settings[toggleFor(event)]) return false;
  return !inQuietHours(date, settings);
}
