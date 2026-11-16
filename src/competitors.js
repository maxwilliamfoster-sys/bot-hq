// Competitor watchlist (from analytics-check/autopilot): 3-5 channels per account in the same niche that get
// strong views. Each autopilot review studies two of them and borrows techniques (never content); this turns
// that list into rows for the Bots tab. No DOM here so it can be tested in node.

const BORROW = {
  queued: { label: "Queued", tone: "info" },
  testing: { label: "Testing", tone: "info" },
  fix: { label: "Fixed", tone: "good" },
  won: { label: "Worked here", tone: "good" },
  lost: { label: "Didn't work here", tone: "warn" },
};
const known = v => v && !/^(unknown|\?|n\/a)$/i.test(String(v).trim());

export function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

export function competitorView(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(c => c && typeof c === "object" && c.channel).map(c => {
    const studied = c.studies > 0 && c.last_studied
      ? `studied ${c.studies} time${c.studies === 1 ? "" : "s"}, last ${c.last_studied}` : "not studied yet";
    const meta = [c.platform, known(c.followers) && `${c.followers} followers`,
      known(c.typical_views) && `typical ${c.typical_views} views`, studied].filter(Boolean).join(" · ");
    return {
      name: c.channel, url: safeUrl(c.url), why: c.why || "", meta,
      does: Array.isArray(c.what_they_do) ? c.what_they_do : [],
      borrowed: (Array.isArray(c.borrowed) ? c.borrowed : []).map(b => ({
        ...(BORROW[b?.status] || BORROW.queued),
        text: `${b?.idea || ""}${b?.test ? ` (test: ${b.test})` : ""}`,
      })),
    };
  });
}

export function borrowTally(list) {
  const t = { total: 0, won: 0, testing: 0, fix: 0, lost: 0, queued: 0 };
  for (const c of Array.isArray(list) ? list : []) {
    for (const b of Array.isArray(c?.borrowed) ? c.borrowed : []) {
      t.total += 1;
      t[BORROW[b?.status] ? b.status : "queued"] += 1;
    }
  }
  return t;
}
