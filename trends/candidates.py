"""Signals -> trend candidates for POST /api/trends/batch.

1. Topics come from search terms (Google Trends) and Wikipedia articles. Signals with the same dedupe key merge.
2. Each news story and video joins a topic when its title shares the topic name's distinctive words (all of them
   for up to 3 words, three quarters for longer names, never fewer than 2, so "chess" alone can't grab every chess
   video, and "World Cup" can't join a cricket story to a football one). Stories that join nothing are grouped
   with stories sharing 3+ distinctive words (at least half the shorter headline's); a group becomes a topic.
   Wrongly joined evidence would make a topic look better supported than it is, so the rules favour precision. Videos that join nothing are dropped: a single
   video is evidence for a topic, never a topic by itself.
3. A local copy of the Worker's niche gate (textmatch.py, kept identical by the parity tests) decides which
   accounts a candidate is sent for. A candidate no account passes is not sent at all. The Worker runs the real
   gate again on everything it receives; this is only a filter to save requests.
4. Score components are 0..1 numbers worked out from the signals. A component with no data is left out (the
   Worker then counts it as 0 and lists it as missing); nothing is estimated.
"""
from .textmatch import FILLER, dedupe_key, has_mixed_script, niche_gate, normalise, phrase_index
from .sources import clamp01, log_momentum, parse_time

MAX_BATCH = 5
MAX_SIGNALS = 10
MAX_CANDIDATES = 60
TEXT_MAX = 1000
STORY_OVERLAP = 3
API_FIELDS = ("source", "source_type", "url", "title", "published_at", "fetched_at", "metric", "value")


# Common words that say nothing about what a story is about. Only used for grouping here; the niche gate and the
# dedupe key (shared with the Worker) don't use this list.
STOP = FILLER | set("""about after again against all also and any are around back been before being but can could
did does down during each even first for from get gets got had has have her here him his how into its just last
latest like live made make more most much new news next not now off one only other our out over own said
says see she should since some still such than that the their them then there these they this those three today
told too two under until update updates very via was watch way were what when where which while who why will
with would year years yet you your""".split())


def words(text):
    """Distinctive words: longer than 2 letters, not a common word, not a bare number (years, ages, scores)."""
    return {w for w in normalise(text).split() if len(w) > 2 and w not in STOP and not w.isdigit()}


def _key_words(key):
    return words(key.replace("-", " ")) if key else set()


def _joins(kw, tw):
    """A story or video belongs to a topic when it shares the topic's words: all of them for a name of up to 3
    words, three quarters for a longer one, and never fewer than 2."""
    if len(kw) < 2:
        return False
    need = len(kw) if len(kw) <= 3 else -(-3 * len(kw) // 4)
    return len(kw & tw) >= need


def _same_story(a, b):
    """Two headlines are one story when they share 3+ distinctive words, at least half of the shorter one's."""
    shared = len(a & b)
    return shared >= STORY_OVERLAP and shared * 2 >= min(len(a), len(b))


def _topics(signals):
    topics = {}
    for s in signals:
        if s["source_type"] not in ("search", "wiki"):
            continue
        key = dedupe_key(s["name"])
        if not key:
            continue
        t = topics.setdefault(key, {"name": s["name"], "key": key, "signals": [], "scope": set()})
        t["signals"].append(s)
        t["scope"].update(s.get("_for") or [])
    return topics


def _attach(topics, signals):
    """Join each news story / video to the topics whose every name word appears in its title. Returns the rest."""
    loose_news, dropped = [], 0
    for s in signals:
        if s["source_type"] in ("search", "wiki"):
            continue
        tw = words(s.get("title") or s["name"])
        hit = False
        for t in topics.values():
            if _joins(_key_words(t["key"]), tw):
                t["signals"].append(s)
                t["scope"].update(s.get("_for") or [])
                hit = True
        if hit:
            continue
        if s.get("_attach_only"):
            dropped += 1
        else:
            loose_news.append(s)
    return loose_news, dropped


def _story_groups(news):
    groups = []
    for s in sorted(news, key=lambda s: s.get("published_at") or "", reverse=True):
        w = words(s["name"])
        for g in groups:
            if _same_story(w, g["words"]):
                g["signals"].append(s)
                g["scope"].update(s.get("_for") or [])
                break
        else:
            groups.append({"name": s["name"], "key": dedupe_key(s["name"]), "signals": [s], "words": w,
                           "scope": set(s.get("_for") or [])})
    return groups


def _pick_signals(sigs):
    """At most MAX_SIGNALS, keeping one of each source first, then the newest; exact duplicates dropped."""
    seen, uniq = set(), []
    for s in sigs:
        k = (s["source"], s["url"], s.get("metric"))
        if k not in seen:
            seen.add(k)
            uniq.append(s)
    uniq.sort(key=lambda s: s.get("published_at") or "", reverse=True)
    first, rest, kinds = [], [], set()
    for s in uniq:
        (rest if s["source"] in kinds else first).append(s)
        kinds.add(s["source"])
    return (first + rest)[:MAX_SIGNALS]


def components(sigs, now):
    """Score inputs, each 0..1, only from numbers the signals carry."""
    out = {}
    mom = [s["_momentum"] for s in sigs if s.get("_momentum") is not None]
    days = max((s.get("_days_seen") or 0 for s in sigs), default=0)
    if mom:
        # Trending on several days counts for a little more than a one-day spike.
        out["momentum"] = round(clamp01(max(mom) + 0.05 * max(0, min(days, 5) - 1)), 3)
    vol = [s["_volume"] for s in sigs if s.get("_volume")]
    if vol:
        out["audience"] = round(log_momentum(max(vol), full=1_000_000), 3)
    perf = [s["_performance"] for s in sigs if s.get("_performance") is not None]
    if perf:
        out["performance"] = round(max(perf), 3)
    pubs = [d for d in (parse_time(s.get("published_at")) for s in sigs) if d]
    if pubs:
        age_h = max(0.0, (now - max(pubs)).total_seconds() / 3600)
        out["timeliness"] = round(clamp01(1 - max(0.0, age_h - 24) / (6 * 24)), 3)   # 1 within a day, 0 after a week
    return out


def _text(sigs):
    parts, n = [], 0
    for s in sigs:
        t = cut((s.get("title") or "").strip(), 300)
        size = len(t.encode("utf-16-le")) // 2 + 1
        if t and n + size <= TEXT_MAX:
            parts.append(t)
            n += size
    return "\n".join(parts) or None


def build(signals, profiles, now):
    """-> (candidates, report). Each candidate is ready to post; report explains what was kept and dropped."""
    topics = _topics(signals)
    loose, dropped_videos = _attach(topics, signals)
    groups = list(topics.values()) + _story_groups(loose)
    by_key = {p["key"]: p for p in profiles}
    out, no_account = [], 0
    for g in groups:
        sigs = _pick_signals(g["signals"])
        name = cut(g["name"].strip(), 200).strip()
        if not dedupe_key(name) or not sigs:
            continue
        text = _text(sigs)
        gate_text = " \n ".join([name] + ([text] if text else []) + [s.get("title") or "" for s in sigs])
        idx, mixed = phrase_index(normalise(gate_text)), has_mixed_script(gate_text)
        gates = {p["key"]: niche_gate(gate_text, p, index=idx, mixed=mixed) for p in profiles}
        passed = [k for k, v in gates.items() if v["passed"]]
        if not passed:
            no_account += 1
            continue
        # Accounts whose own search found it are named too, so a failed gate there is recorded with its reason.
        named = sorted(set(passed) | (g["scope"] & set(by_key)))
        best = max(passed, key=lambda k: gates[k]["relevance"])
        comp = components(sigs, now)
        out.append({
            "name": name, "category": by_key[best]["category"], "text": text,
            "signals": [_api_signal(s) for s in sigs],
            "for_accounts": named, "components": comp,
            "snapshot": {"momentum": comp.get("momentum"), "volume": max((s.get("_volume") or 0 for s in sigs), default=0) or None,
                         "competitor_count": None},
            "_gates": {k: gates[k] for k in named}, "_best": gates[best]["relevance"],
            "_flags": flags(name, text) if "buried" in named else [],
        })
    # Strongest first, so the cap drops the weakest.
    out.sort(key=lambda c: (-c["_best"], -(c["components"].get("momentum") or 0)))
    capped = max(0, len(out) - MAX_CANDIDATES)
    out = out[:MAX_CANDIDATES]
    report = {"signals": len(signals), "topics": len(topics), "story_groups": len(groups) - len(topics),
              "videos_unmatched": dropped_videos, "no_account_passed": no_account, "candidates": len(out),
              "over_cap": capped}
    return out, report


def cut(s, n):
    """Trim to n UTF-16 code units, the way the Worker (JavaScript) counts length: an emoji counts as 2."""
    s = s or ""
    if len(s.encode("utf-16-le")) <= 2 * n:
        return s
    out, units = [], 0
    for ch in s:
        u = 2 if ord(ch) > 0xFFFF else 1
        if units + u > n:
            break
        out.append(ch)
        units += u
    return "".join(out)


def _api_signal(s):
    out = {k: s.get(k) for k in API_FIELDS}
    out["title"] = cut(out["title"], 300) or None
    out["source"] = cut(str(out["source"]), 40)
    out["metric"] = cut(out["metric"], 40) or None
    return out


# Live court cases (UK contempt of court risk, and the rule that nobody accused is presented as guilty). Flagged
# for the true-crime account so ideas wait for a verdict and stick to what the court established.
ACTIVE_CASE = ("accused", "alleged", "allegedly", "trial", "charged", "court hears", "court told", "jury",
               "arrested", "suspect", "bailed", "denies", "pleaded not guilty", "remanded")
SETTLED = ("convicted", "found guilty", "guilty of", "sentenced", "jailed", "life sentence", "whole-life")


def flags(name, text):
    t = f"{name} {text or ''}".lower()
    out = []
    if any(w in t for w in ACTIVE_CASE) and not any(w in t for w in SETTLED):
        out.append("active_case")
    return out


def to_api(c):
    return {k: v for k, v in c.items() if not k.startswith("_")}


def batches(cands, size=MAX_BATCH):
    for i in range(0, len(cands), size):
        yield [to_api(c) for c in cands[i:i + size]]
