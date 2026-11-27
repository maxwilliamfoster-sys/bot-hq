"""The collector's small memory between runs (days a search term has trended, earlier YouTube view counts, the
quota ledger). A JSON file in trends/.state/ (git-ignored); in the GitHub Action it lives in the Actions cache.
Losing it is harmless: day counts and view history simply start again."""
import json
import os
from pathlib import Path

VERSION = 1


def load(path):
    p = Path(path)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) and data.get("version") == VERSION else {"version": VERSION}
    except (OSError, ValueError):
        return {"version": VERSION}


def save(path, state):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, p)
