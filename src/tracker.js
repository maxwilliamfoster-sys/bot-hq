// Progress tracker: each account's progress, its tests, jobs and changes. The analytics check on Max's PC
// (Content-Bots/analytics-check/build_tracker.py) works it all out and POSTs it here; the app only stores and shows it.
import { getState, setState } from "./settings.js";

const LISTS = ["accounts", "trend", "tests", "updates", "todos"];

export function validTracker(b) {
  return !!b && !Number.isNaN(Date.parse(b.generated)) && LISTS.every(k => Array.isArray(b[k])) && b.accounts.length > 0;
}

export async function saveTracker(db, body) {
  await setState(db, "tracker", JSON.stringify(Object.fromEntries(["generated", ...LISTS].map(k => [k, body[k]]))));
}

function summary({ accounts, tests, todos }) {
  const verdicts = v => accounts.filter(a => a.verdict === v).length;
  return {
    better: verdicts("Better"), worse: verdicts("Worse"), early: verdicts("Too early"),
    collecting: tests.filter(t => t.status === "Collecting").length,
    yours: todos.filter(t => t.owner === "You" && t.status === "Open").length,
    next_check: accounts.map(a => a.next_check).filter(Boolean).sort()[0] || null,
  };
}

export async function trackerData(db) {
  const saved = await getState(db, "tracker");
  if (!saved) return { available: false };
  const data = JSON.parse(saved);
  return { available: true, ...data, summary: summary(data) };
}
