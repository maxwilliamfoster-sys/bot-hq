// Profiles are read-only copies of each account's established niche. Nothing in Bot HQ may write it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES, ALL_PROFILES, profileHash } from "../src/trends/profiles.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNTS = "C:/Users/maxwi/Projects/Content-Bots/analytics-check/autopilot/accounts.json";

test("niche, audience and name match accounts.json word for word", { skip: !existsSync(ACCOUNTS) && "accounts.json is only on Max's PC" }, () => {
  const accounts = Object.fromEntries(JSON.parse(readFileSync(ACCOUNTS, "utf8")).accounts.map(a => [a.key, a]));
  for (const p of ALL_PROFILES) {
    const a = accounts[p.key];
    assert.ok(a, `${p.key} is not in accounts.json`);
    assert.equal(p.niche, a.niche, `${p.key} niche drifted: re-check the profile by hand, never auto-copy`);
    assert.equal(p.audience, a.audience, `${p.key} audience drifted`);
    assert.equal(p.active, !a.stopped, `${p.key} active flag`);
  }
});

test("every profile has a unique key, anchors, and no anchor that is also an exclusion", () => {
  const keys = ALL_PROFILES.map(p => p.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const p of ALL_PROFILES) {
    assert.ok(p.anchors.length >= 5, `${p.key} anchors`);
    assert.ok(["youtube", "tiktok", "instagram"].includes(p.platform), `${p.key} platform`);
    for (const a of p.anchors) assert.ok(!p.exclude.includes(a), `${p.key}: "${a}" is both anchor and exclusion`);
  }
  assert.deepEqual(PROFILES.map(p => p.key), ALL_PROFILES.filter(p => p.active).map(p => p.key));
});

test("profiles are frozen at runtime", () => {
  assert.throws(() => { PROFILES[0].niche = "gaming"; });
  assert.throws(() => { PROFILES[0].anchors.push("fortnite"); });
});

test("the profile hash changes when the niche or terms change", () => {
  const p = PROFILES[0];
  assert.equal(profileHash(p), profileHash({ ...p }));
  assert.notEqual(profileHash(p), profileHash({ ...p, niche: p.niche + "!" }));
  assert.notEqual(profileHash(p), profileHash({ ...p, exclude: [...p.exclude, "x"] }));
});

test("no Worker code refers to accounts.json, so it can never write an account's niche", () => {
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(join(ROOT, "src"));
  for (const f of files.filter(f => f.endsWith(".js"))) {
    assert.ok(!readFileSync(f, "utf8").includes("accounts.json"), `${f} mentions accounts.json`);
  }
});
