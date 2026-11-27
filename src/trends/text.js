// Text matching for the niche gate: lower case, no accents or punctuation, whole words only.
// Invisible format characters (zero-width space/joiner, soft hyphen, BOM...) are deleted, not turned into spaces,
// so "mur​der" still reads as "murder" and can't slip past an exclusion.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}­͏ᅟᅠ឴឵᠎ㅤﾠ︀-️]/gu;
const MARKS = /\p{M}/gu;     // every combining mark after NFKD, not only the basic accents

// Look-alike letters from other alphabets mapped to the Latin letter they imitate (a confusables skeleton for
// the scripts that can spell English words), so a whole word in Cyrillic look-alikes still hits an exclusion.
const CONFUSABLE = {
  "а": "a", "в": "b", "с": "c", "е": "e", "ё": "e", "һ": "h", "і": "i", "ї": "i", "ј": "j", "к": "k", "м": "m",
  "н": "h", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ԝ": "w", "ɡ": "g",
  "А": "a", "В": "b", "С": "c", "Е": "e", "Н": "h", "І": "i", "Ј": "j", "К": "k", "М": "m", "О": "o", "Р": "p",
  "Ѕ": "s", "Т": "t", "Х": "x", "У": "y",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u",
  "χ": "x", "ω": "w", "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n",
  "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  "ı": "i", "ȷ": "j", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ß": "ss", "æ": "ae", "œ": "oe",
};
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

// A word mixing Latin with another script's letters (Cyrillic "а" inside "murder") is a look-alike trick or
// garbage. The gate fails closed on it rather than guess.
export function hasMixedScript(s) {
  const words = clean(s).split(/[^\p{L}\p{N}]+/u);
  return words.some(w => /[a-z]/i.test(w) && /[^\p{Script=Latin}\p{N}]/u.test(w));
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
