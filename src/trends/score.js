// Opportunity score out of 100. Components arrive as 0..1 from the collector (computed in Python from real
// numbers; no AI produces them). Niche relevance comes from the gate, and failing the gate means no score at all.
export const DEFAULT_WEIGHTS = Object.freeze({
  niche: 25, momentum: 20, audience: 15, performance: 15, competition: 10, timeliness: 10, originality: 5,
});
export const COMPONENTS = ["momentum", "audience", "performance", "competition", "timeliness", "originality"];
const KEYS = Object.keys(DEFAULT_WEIGHTS);
export const MIN_NICHE_WEIGHT = 10;

export function validWeights(w) {
  if (!w || typeof w !== "object" || Array.isArray(w)) return false;
  const keys = Object.keys(w);
  if (keys.length !== KEYS.length || !KEYS.every(k => keys.includes(k))) return false;
  if (!KEYS.every(k => Number.isFinite(w[k]) && w[k] >= 0 && w[k] <= 100)) return false;
  return w.niche >= MIN_NICHE_WEIGHT;
}

export function classify(score) {
  if (score >= 80) return "high";
  if (score >= 65) return "test";
  if (score >= 45) return "monitor";
  return "low";
}

const clamp01 = v => Math.max(0, Math.min(1, v));

export function scoreOpportunity(gate, components = {}, weights = DEFAULT_WEIGHTS) {
  const missing = COMPONENTS.filter(k => !Number.isFinite(components?.[k]));
  if (!gate?.passed) return { score: null, class: "rejected", missing };
  const total = KEYS.reduce((s, k) => s + weights[k], 0) || 1;
  let raw = weights.niche * clamp01(gate.relevance);
  for (const k of COMPONENTS) if (!missing.includes(k)) raw += weights[k] * clamp01(components[k]);
  const score = Math.round((raw / total) * 100);
  return { score, class: classify(score), missing };
}

// Confirmed = seen in 2+ independent kinds of source; manual notes and Claude's ideas are never evidence.
const NOT_EVIDENCE = new Set(["manual", "claude"]);
export function evidenceLabel(signals = []) {
  const types = new Set(signals.map(s => s?.source_type).filter(t => t && !NOT_EVIDENCE.has(t)));
  return types.size >= 2 ? "confirmed" : types.size === 1 ? "emerging" : "hypothesis";
}
