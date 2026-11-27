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

// Distinctive words, for matching a story or one of the account's past videos to a topic (not for the gate):
// longer than 2 letters, not a common word (text_rules.json "stop", shared with Python), not a bare number.
const STOP = new Set([...RULES.stop, ...RULES.filler]);
export function distinctWords(s) {
  return new Set(normalise(s).trim().split(" ").filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
}

// Does a title (its distinctive words) belong to a topic? All of a name's words when it has up to 3, three
// quarters of a longer one, never fewer than 2. A plural or possessive counts ("Carlsen's" reads "carlsens").
// Same rule as trends/candidates.py.
export function wordForms(w) {
  const f = [w, `${w}s`, `${w}es`];
  if (w.length > 3 && w.endsWith("s")) f.push(w.slice(0, -1));
  if (w.length > 4 && w.endsWith("es")) f.push(w.slice(0, -2));
  return f;
}

export function topicJoins(topicWords, titleWords) {
  const k = topicWords.size;
  if (k < 2) return false;
  const need = k <= 3 ? k : Math.ceil((3 * k) / 4);
  let n = 0;
  for (const w of topicWords) if (wordForms(w).some(f => titleWords.has(f))) n++;
  return n >= need;
}
