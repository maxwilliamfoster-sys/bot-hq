// Account trend profiles: read-only copies of each account's established niche (trends/profiles.json, which
// test/trends_profiles.test.js checks against the autopilot's account list on the PC). Frozen, so no code
// path can change an account's niche at runtime, and there is no API that writes them.
import data from "../../trends/profiles.json" with { type: "json" };

const deepFreeze = o => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

export const ALL_PROFILES = deepFreeze(data.profiles.map(p => ({ ...p })));
export const PROFILES = ALL_PROFILES.filter(p => p.active);

export const getProfile = key => PROFILES.find(p => p.key === key) || null;

// FNV-1a over what decides the gate. Stored on each opportunity, so a changed profile is noticed.
export function profileHash(p) {
  const s = JSON.stringify([p.key, p.niche, p.audience, p.anchors, p.related, p.exclude]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
