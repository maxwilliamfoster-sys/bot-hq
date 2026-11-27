"""Word matching for the collector, the same as the Worker's src/trends/text.js, gate.js and dedupe.js.

The Worker is the authority: it re-runs the niche gate on everything the collector sends. This copy only lets
the collector skip candidates that could never pass and name the accounts a candidate is meant for.
trends/tests/test_textmatch.py checks every answer against parity.json, generated from the Worker's code.
"""
import json
import unicodedata
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULES = json.loads((HERE / "text_rules.json").read_text(encoding="utf-8"))
CONFUSABLE = RULES["confusables"]
FILLER = set(RULES["filler"])

MIN_RELEVANCE = 0.6
ONE_ANCHOR, EXTRA_ANCHOR, RELATED, RELATED_CAP = 0.55, 0.15, 0.1, 0.3
MAX_WORDS = 5

# Unicode Default_Ignorable_Code_Point ranges (DerivedCoreProperties), plus anything in category Cf.
_IGNORABLE = [(0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5),
              (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
              (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
              (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF)]


def _invisible(ch):
    o = ord(ch)
    return unicodedata.category(ch) == "Cf" or any(a <= o <= b for a, b in _IGNORABLE)


def _clean(s):
    s = "".join(ch for ch in str(s or "") if not _invisible(ch))
    s = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in s if not unicodedata.category(ch).startswith("M"))


def normalise(s):
    t = "".join(CONFUSABLE.get(ch, ch) for ch in _clean(s)).lower()
    t = t.replace("'", "").replace("’", "").replace("`", "")
    out, space = [], False
    for ch in t:
        if ("a" <= ch <= "z") or ("0" <= ch <= "9"):
            out.append(ch)
            space = False
        elif not space:
            out.append(" ")
            space = True
    t = "".join(out).strip()
    return f" {t} " if t else " "


def _is_latin(ch):
    return ch.isascii() or unicodedata.name(ch, "").startswith("LATIN")


# Alphabets with Latin look-alikes: a letter from one left over after the look-alike map fails closed.
_LOOKALIKE = ("CYRILLIC", "GREEK", "ARMENIAN", "CHEROKEE", "COPTIC", "LISU", "CANADIAN SYLLABICS")


def has_mixed_script(s):
    cleaned = _clean(s)
    for ch in cleaned:
        ch = CONFUSABLE.get(ch, ch)
        if len(ch) == 1 and not ch.isascii() and unicodedata.name(ch, "").startswith(_LOOKALIKE):
            return True
    word = []
    for ch in cleaned + " ":
        if unicodedata.category(ch)[0] in "LN":
            word.append(ch)
            continue
        if word:
            w = "".join(word)
            if any(c.isascii() and c.isalpha() for c in w) and any(
                    not (unicodedata.category(c).startswith("N") or _is_latin(c)) for c in w):
                return True
        word = []
    return False


def phrase_index(norm_text):
    words = [w for w in norm_text.strip().split(" ") if w]
    out = set()
    for i in range(len(words)):
        p = ""
        for n in range(MAX_WORDS):
            if i + n >= len(words):
                break
            p = f"{p} {words[i + n]}" if n else words[i]
            out.add(p)
    return out


@lru_cache(maxsize=None)
def norm_term(term):
    return normalise(term).strip()


def term_hits(text_or_index, terms):
    idx = text_or_index if isinstance(text_or_index, set) else phrase_index(text_or_index)
    hits = []
    for term in terms:
        n = norm_term(term)
        if n and (n in idx or f"{n}s" in idx or f"{n}es" in idx):
            hits.append(term)
    return hits


def dedupe_key(name):
    words = [w for w in normalise(name).strip().split(" ") if w and w not in FILLER]
    return "-".join(sorted(set(words)))


def niche_gate(text, profile, index=None, mixed=None):
    """Same result as the Worker's nicheGate({ name: text }, profile)."""
    idx = index if index is not None else phrase_index(normalise(text))
    mixed = has_mixed_script(text) if mixed is None else mixed
    anchors = term_hits(idx, profile["anchors"])
    excluded = term_hits(idx, profile["exclude"])
    if mixed:
        return {"passed": False, "relevance": 0, "anchors": anchors, "excluded": excluded, "mixed": True}
    related = [r for r in term_hits(idx, profile["related"]) if not any(norm_term(r) in norm_term(a) for a in anchors)]
    rel = 0
    if anchors:
        rel = ONE_ANCHOR + EXTRA_ANCHOR * (len(anchors) - 1) + min(RELATED_CAP, RELATED * len(related))
        rel = min(1, round(rel * 100 + 1e-9) / 100)
    passed = not excluded and bool(anchors) and rel >= MIN_RELEVANCE
    return {"passed": passed, "relevance": 0 if excluded else rel, "anchors": anchors, "excluded": excluded,
            "related": related, "mixed": False}


def load_profiles(path=HERE / "profiles.json"):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [p for p in data["profiles"] if p.get("active")]
