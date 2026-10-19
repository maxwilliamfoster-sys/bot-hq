import { test } from "node:test";
import assert from "node:assert/strict";
import { ukParts, inQuietHours, shouldPush } from "../src/rules.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const S = DEFAULT_SETTINGS;
const at = iso => new Date(iso);

test("ukParts gives UK local time on both sides of the clock change", () => {
  assert.equal(ukParts(at("2026-10-24T21:45:00Z")).hhmm, "22:45"); // BST
  assert.equal(ukParts(at("2026-10-26T21:45:00Z")).hhmm, "21:45"); // GMT
  assert.equal(ukParts(at("2026-10-24T23:30:00Z")).ymd, "2026-10-25");
});

test("quiet hours follow UK time across the clock change", () => {
  assert.equal(inQuietHours(at("2026-10-24T21:45:00Z"), S), true);  // 22:45 BST
  assert.equal(inQuietHours(at("2026-10-26T22:45:00Z"), S), true);  // 22:45 GMT
  assert.equal(inQuietHours(at("2026-10-26T06:30:00Z"), S), true);  // 06:30 GMT
  assert.equal(inQuietHours(at("2026-10-24T06:30:00Z"), S), false); // 07:30 BST
  assert.equal(inQuietHours(at("2026-10-26T12:00:00Z"), S), false);
});

test("quiet hours that don't wrap midnight", () => {
  const s = { ...S, quiet_start: "13:00", quiet_end: "14:00" };
  assert.equal(inQuietHours(at("2026-11-02T13:30:00Z"), s), true);
  assert.equal(inQuietHours(at("2026-11-02T14:00:00Z"), s), false);
});

test("shouldPush matrix", () => {
  const night = at("2026-10-26T23:00:00Z");
  const day = at("2026-10-26T12:00:00Z");
  assert.equal(shouldPush({ severity: "action", kind: "run_failed" }, S, night), true);
  assert.equal(shouldPush({ severity: "good", kind: "doing_well" }, S, night), false);
  assert.equal(shouldPush({ severity: "good", kind: "doing_well" }, S, day), true);
  assert.equal(shouldPush({ severity: "info", kind: "posted" }, { ...S, notify_posted: false }, day), false);
  assert.equal(shouldPush({ severity: "info", kind: "posted" }, S, day), true);
  assert.equal(shouldPush({ severity: "info", kind: "summary" }, { ...S, notify_summary: false }, day), false);
  assert.equal(shouldPush({ severity: "warn", kind: "post_failed" }, { ...S, notify_warn: false }, day), false);
  assert.equal(shouldPush({ severity: "action", kind: "x" }, { ...S, notify_action: false }, day), false);
});
