// trends/tests/parity.json is what the Python collector is checked against. If the Worker's matching changes,
// this fails until the file is regenerated (node trends/tests/make_parity.mjs) and the Python side still passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import parity from "../trends/tests/parity.json" with { type: "json" };
import { normalise } from "../src/trends/text.js";
import { dedupeKey } from "../src/trends/dedupe.js";
import { nicheGate } from "../src/trends/gate.js";
import { getProfile } from "../src/trends/profiles.js";

test("parity.json matches the Worker's current matching rules", () => {
  for (const [t, want] of parity.normalise) assert.equal(normalise(t), want);
  for (const [n, want] of parity.dedupe) assert.equal(dedupeKey(n), want);
  for (const [t, byAcc] of parity.gate) {
    for (const [key, want] of Object.entries(byAcc)) {
      const g = nicheGate({ name: t }, getProfile(key));
      assert.deepEqual({ passed: g.passed, relevance: g.relevance, anchors: g.anchors, excluded: g.excluded, mixed: !!g.mixed }, want, `${key}: ${t}`);
    }
  }
});
