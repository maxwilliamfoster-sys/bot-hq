// The niche gate: a trend reaches an account only if it fits that account's established niche.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nicheGate, MIN_RELEVANCE } from "../src/trends/gate.js";
import { PROFILES, getProfile } from "../src/trends/profiles.js";
import { normalise, termHits } from "../src/trends/text.js";
import { dedupeKey } from "../src/trends/dedupe.js";
import { SAMPLES } from "./fixtures/trend_samples.js";

test("every niche sample reaches exactly its own accounts and no others", () => {
  for (const [text, allowed] of SAMPLES) {
    const passed = PROFILES.filter(p => nicheGate({ name: text }, p).passed).map(p => p.key).sort();
    assert.deepEqual(passed, [...allowed].sort(), `"${text}" reached ${passed.join(", ") || "nobody"}`);
  }
});

test("a single weak anchor with no supporting words is not enough", () => {
  const g = nicheGate({ name: "Protesters burn a flag outside parliament" }, getProfile("escape"));
  assert.equal(g.passed, false);
  assert.ok(g.relevance < MIN_RELEVANCE);
  assert.match(g.reason, /not enough/);
});

test("any exclusion term rejects, even with many anchors", () => {
  const g = nicheGate({ name: "Fortnite chess grandmaster checkmate gambit event" }, getProfile("chess"));
  assert.equal(g.passed, true, "chess has no fortnite exclusion, so the anchors win here");
  const b = nicheGate({ name: "Murder mystery game: jury trial murder cold case" }, getProfile("buried"));
  assert.equal(b.passed, false);
  assert.deepEqual(b.excluded, ["murder mystery game"]);
  assert.match(b.reason, /excluded/);
});

test("tragedies never reach the comedy accounts", () => {
  for (const key of ["perc", "gary", "bodge"]) {
    const g = nicheGate({ name: "Funny meme about the Christmas bin day fox what if giant", text: "two people died in the crash" }, getProfile(key));
    assert.equal(g.passed, false, key);
  }
});

test("evidence text and signal titles count, not just the name", () => {
  const p = getProfile("space");
  assert.equal(nicheGate({ name: "Comet Lemmon" }, p).passed, false);
  assert.equal(nicheGate({ name: "Comet Lemmon", signals: [{ title: "Astronomers photograph comet tail with telescope" }] }, p).passed, true);
});

test("matching is on whole words, with simple plurals", () => {
  assert.deepEqual(termHits(normalise("Chessington World of Adventures"), ["chess"]), []);
  assert.deepEqual(termHits(normalise("Two galaxies collide"), ["galaxy", "galaxies"]), ["galaxies"]);
  assert.deepEqual(termHits(normalise("Black holes merge"), ["black hole"]), ["black hole"]);
  assert.equal(normalise("Mbappé’s  goal!"), " mbappes goal ");
});

test("invisible characters can't hide an exclusion", () => {
  const p = getProfile("perc");
  for (const zw of ["\u200b", "\u200d", "\u00ad", "\u2060", "\ufeff"]) {
    const g = nicheGate({ name: `Relatable meme POV gif: mur${zw}der on the high street` }, p);
    assert.equal(g.passed, false, JSON.stringify(zw));
    assert.deepEqual(g.excluded, ["murder"]);
  }
});

test("rarer combining marks, variation selectors and ignorable characters can't split an exclusion", () => {
  const p = getProfile("perc");
  for (const ch of ["\u20d0", "\u1ab0", "\ufe0f", "\u{e0100}", "\u2064", "\u180b"]) {
    const g = nicheGate({ name: `Relatable meme POV gif: mur${ch}der on the high street` }, p);
    assert.deepEqual(g.excluded, ["murder"], JSON.stringify(ch));
  }
});

test("a whole word spelled in look-alike letters still hits the exclusion", () => {
  const g = nicheGate({ name: "Relatable meme POV gif: ԁеаԁ funny" }, getProfile("perc"));  // Cyrillic ԁ е а ԁ
  assert.equal(g.passed, false);
  assert.deepEqual(g.excluded, ["dead"]);
});

test("letters left over from an alphabet with Latin look-alikes fail closed; other alphabets are fine", () => {
  const cp = (...c) => String.fromCodePoint(...c);
  for (const word of [cp(0x436, 0x438, 0x437, 0x43d, 0x44c), cp(0x540, 0x561, 0x575), cp(0x13a0, 0x13a1), cp(0x3bb, 0x3be)]) {
    const g = nicheGate({ name: `Grandmaster checkmate gambit ${word}` }, getProfile("chess"));
    assert.equal(g.passed, false, word);
    assert.equal(g.mixed, true, word);
  }
  for (const word of [cp(0x30c1, 0x30a7, 0x30b9), cp(0x634, 0x637, 0x631, 0x646, 0x62c), cp(0x4e2d, 0x6587)]) {
    assert.equal(nicheGate({ name: `Grandmaster checkmate gambit ${word}` }, getProfile("chess")).passed, true, word);
  }
});

test("look-alike letters from another alphabet fail closed", () => {
  const g = nicheGate({ name: "Relatable meme POV gif: murdеr on the high street" }, getProfile("perc"));  // Cyrillic е
  assert.equal(g.passed, false);
  assert.equal(g.mixed, true);
  assert.match(g.reason, /alphabets/);
  // Whole words in another script are fine (a French or Japanese title), only mixing inside a word is refused.
  assert.equal(nicheGate({ name: "Grandmaster checkmate gambit — チェス" }, getProfile("chess")).passed, true);
});

test("an exclusion seen once stays: later evidence can't clear it", () => {
  const p = getProfile("buried");
  const g = nicheGate({ name: "Jury convicts man of cold case murder at crown court", prior_excluded: ["murder mystery game"] }, p);
  assert.equal(g.passed, false);
  assert.deepEqual(g.excluded, ["murder mystery game"]);
  assert.equal(nicheGate({ name: "chess gambit checkmate", prior_excluded: ["murder"] }, getProfile("chess")).passed, true,
    "a prior exclusion only counts if it is one of this account's own exclusions");
});

test("an unknown or stopped account has no profile and passes nothing", () => {
  assert.equal(getProfile("eagle"), null);
  assert.equal(getProfile("nope"), null);
  assert.equal(nicheGate({ name: "chess" }, null).passed, false);
});

test("dedupe key ignores order, case, punctuation and filler words", () => {
  assert.equal(dedupeKey("The Case of Joanna Yeates"), dedupeKey("Joanna Yeates case"));
  assert.equal(dedupeKey("JWST: new image!"), dedupeKey("new JWST image"));
  assert.notEqual(dedupeKey("Comet Lemmon"), dedupeKey("Comet Atlas"));
  assert.equal(dedupeKey("  "), "");
});
