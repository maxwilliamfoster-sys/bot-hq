"""The collector must match words exactly as the Worker does (parity.json is generated from the Worker's code)."""
import json
import unittest
from pathlib import Path

from trends import textmatch as tm

PARITY = json.loads((Path(__file__).parent / "parity.json").read_text(encoding="utf-8"))
PROFILES = {p["key"]: p for p in tm.load_profiles()}


class Parity(unittest.TestCase):
    def test_normalise(self):
        for text, want in PARITY["normalise"]:
            self.assertEqual(tm.normalise(text), want, ascii(text))

    def test_dedupe(self):
        for name, want in PARITY["dedupe"]:
            self.assertEqual(tm.dedupe_key(name), want, ascii(name))

    def test_gate(self):
        for text, by_acc in PARITY["gate"]:
            self.assertEqual(set(by_acc), set(PROFILES), "same active accounts as the Worker")
            for key, want in by_acc.items():
                got = tm.niche_gate(text, PROFILES[key])
                for field in ("passed", "relevance", "anchors", "excluded", "mixed"):
                    self.assertEqual(got[field], want[field], f"{key} {field} {ascii(text)}")


class Profiles(unittest.TestCase):
    def test_only_active_accounts(self):
        self.assertNotIn("eagle", PROFILES)
        self.assertEqual(len(PROFILES), 8)


if __name__ == "__main__":
    unittest.main()
