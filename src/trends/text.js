// Text matching for the niche gate: lower case, no accents or punctuation, whole words only.
export function normalise(s) {
  const t = String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return t ? ` ${t} ` : " ";
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
