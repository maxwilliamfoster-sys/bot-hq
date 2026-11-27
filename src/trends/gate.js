// The niche gate. A trend reaches an account only if its evidence names the account's niche (an anchor term),
// has supporting words, and hits none of the account's exclusions. It is a gate, not a score: failing it means
// rejected, whatever else the trend has going for it. Every write path in src/trends/store.js calls this.
import { normalise, normTerm, termHits, phraseIndex, hasMixedScript } from "./text.js";

export const MIN_RELEVANCE = 0.6;
const ONE_ANCHOR = 0.55, EXTRA_ANCHOR = 0.15, RELATED = 0.1, RELATED_CAP = 0.3;

export function gateText(candidate) {
  const parts = [candidate?.name, candidate?.text, ...(candidate?.signals || []).map(s => s?.title)];
  return parts.filter(Boolean).join(" \n ");
}

export function nicheGate(candidate, profile) {
  if (!profile) return { passed: false, relevance: 0, anchors: [], related: [], excluded: [], reason: "no active profile for this account" };
  // `index` (+ `mixed`) lets a caller judging many accounts build the phrase index once.
  const raw = candidate?.index ? "" : (candidate?.evidence_text ?? gateText(candidate));
  const text = candidate?.index ?? phraseIndex(normalise(raw));
  const mixed = candidate?.index ? !!candidate.mixed : hasMixedScript(raw);
  const anchors = termHits(text, profile.anchors);
  // Exclusions are sticky: once a trend's evidence hit one for this account, later evidence can't clear it.
  const excluded = [...new Set([...termHits(text, profile.exclude), ...(candidate?.prior_excluded || [])])]
    .filter(t => profile.exclude.includes(t));
  if (mixed) {
    return { passed: false, relevance: 0, anchors, related: [], excluded, mixed: true,
      reason: "text mixes alphabets inside a word or uses look-alike letters; check it by hand" };
  }
  // Related words only count when they are not part of a matched anchor phrase ("carlsen" in "magnus carlsen").
  const related = termHits(text, profile.related).filter(r => !anchors.some(a => normTerm(a).includes(normTerm(r))));
  let relevance = 0;
  if (anchors.length) {
    relevance = ONE_ANCHOR + EXTRA_ANCHOR * (anchors.length - 1) + Math.min(RELATED_CAP, RELATED * related.length);
    relevance = Math.min(1, Math.round(relevance * 100) / 100);
  }
  let reason = "fits the niche";
  if (excluded.length) reason = `excluded for this niche: ${excluded.join(", ")}`;
  else if (!anchors.length) reason = "names nothing in this account's niche";
  else if (relevance < MIN_RELEVANCE) reason = "not enough niche evidence (one niche word and nothing supporting it)";
  const passed = !excluded.length && anchors.length > 0 && relevance >= MIN_RELEVANCE;
  return { passed, relevance: excluded.length ? 0 : relevance, anchors, related, excluded, reason };
}
