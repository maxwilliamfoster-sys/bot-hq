// Text matching for the niche gate: lower case, no accents or punctuation, whole words only.
// The look-alike table is shared with the Python collector (trends/text_rules.json).
import RULES from "../../trends/text_rules.json" with { type: "json" };
// Invisible format characters (zero-width space/joiner, soft hyphen, BOM...) are deleted, not turned into spaces,
// so "mur<zero-width space>der" still reads as "murder" and can't slip past an exclusion.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180e\u3164\uffa0\ufe00-\ufe0f]/gu;
const MARKS = /\p{M}/gu;     // every combining mark after NFKD, not only the basic accents

// Look-alike letters from other alphabets mapped to the Latin letter they imitate (a confusables skeleton for
// the scripts that can spell English words), so a whole word in Cyrillic look-alikes still hits an exclusion.
const CONFUSABLE = RULES.confusables;
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "gu");

const clean = s => String(s ?? "").replace(INVISIBLE, "").normalize("NFKD").replace(MARKS, "");

export function normalise(s) {
  const t = clean(s)
    .replace(CONFUSABLE_RE, ch => CONFUSABLE[ch])
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return t ? ` ${t} ` : " ";
}

// Fail closed on look-alike tricks: (1) a word mixing Latin with another script's letters (Cyrillic "a" inside
// "murder"), or (2) any letter left over, after the look-alike map, from an alphabet that has Latin look-alikes
// (an unmapped one could spell an exclusion). Alphabets with no Latin look-alikes (Japanese, Arabic...) are fine.
const LOOKALIKE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Coptic}\p{Script=Lisu}\p{Script=Canadian_Aboriginal}]/u;
export function hasMixedScript(s) {
  const c = clean(s);
  if (LOOKALIKE_SCRIPT.test(c.replace(CONFUSABLE_RE, ch => CONFUSABLE[ch]))) return true;
  return c.split(/[^\p{L}\p{N}]+/u).some(w => /[a-z]/i.test(w) && /[^\p{Script=Latin}\p{N}]/u.test(w));
}

// Profile terms are fixed, so each is normalised once (the Worker has 10 ms of CPU per request).
const TERM_CACHE = new Map();
export function normTerm(term) {
  let n = TERM_CACHE.get(term);
  if (n === undefined) { n = normalise(term).trim(); TERM_CACHE.set(term, n); }
  return n;
}

// Every 1-5 word phrase in the text, built once so each term check is one lookup.
const MAX_WORDS = 5;
export function phraseIndex(normText) {
  const words = normText.trim().split(" ").filter(Boolean);
  const set = new Set();
  for (let i = 0; i < words.length; i++) {
    let p = "";
    for (let n = 0; n < MAX_WORDS && i + n < words.length; n++) {
      p = n ? `${p} ${words[i + n]}` : words[i];
      set.add(p);
    }
  }
  return set;
}

// Terms found in normalised text or its phrase index (simple plurals too: "black hole" matches "black holes").
export function termHits(textOrIndex, terms) {
  const idx = textOrIndex instanceof Set ? textOrIndex : phraseIndex(textOrIndex);
  const out = [];
  for (const term of terms) {
    const n = normTerm(term);
    if (!n) continue;
    if (idx.has(n) || idx.has(`${n}s`) || idx.has(`${n}es`)) out.push(term);
  }
  return out;
}
