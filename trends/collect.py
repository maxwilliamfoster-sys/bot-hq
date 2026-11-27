"""Trend collector: fetch every free source, build candidates, write a report, and (only with --post) send them
to Bot HQ.

    py -m trends.collect            # dry run: fetch, build, write trends/out/report.{json,md}; posts nothing
    py -m trends.collect --post     # also POST to $APP_URL/api/trends/batch with $APP_EVENTS_TOKEN

Env: APP_URL, APP_EVENTS_TOKEN (only for --post), YT_TREND_API_KEY (optional; YouTube is skipped without it),
YT_TREND_DAILY_CAP (optional). Exit code 1 only when every source that ran failed, or a post failed.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import candidates, competition, manual_links, state as state_mod
from .http import Http, redact
from .sources import REGISTRY, Skipped
from .textmatch import load_profiles

HERE = Path(__file__).resolve().parent


class Ctx:
    def __init__(self, profiles, http, state, config, env, now):
        self.profiles, self.http, self.state, self.config, self.env, self.now = profiles, http, state, config, env, now
        self.notes = {}
        self.status_override = {}

    def note(self, source, msg):
        self.notes.setdefault(source, []).append(redact(msg))

    def cutoff(self, days):
        return (self.now - timedelta(days=days)).strftime("%Y-%m-%d")


def run_sources(ctx, modules):
    signals, status = [], {}
    for m in modules:
        t0 = time.monotonic()
        try:
            got = m.run(ctx) or []
            signals += got
            status[m.NAME] = {"status": ctx.status_override.get(m.NAME) or ("ok" if got else "empty"), "signals": len(got)}
        except Skipped as e:
            status[m.NAME] = {"status": "skipped", "signals": 0, "reason": str(e)}
        except Exception as e:      # one source failing never stops the others
            status[m.NAME] = {"status": "failed", "signals": 0, "reason": redact(f"{type(e).__name__}: {e}")[:300]}
        status[m.NAME]["seconds"] = round(time.monotonic() - t0, 1)
        if ctx.notes.get(m.NAME):
            status[m.NAME]["notes"] = ctx.notes[m.NAME]
    return signals, status


def post(cands, url, token, opener=urllib.request.urlopen):
    totals = {"trends": 0, "invalid": 0, "opportunities": 0, "rejected": 0, "batches": 0}
    for batch in candidates.batches(cands):
        req = urllib.request.Request(url.rstrip("/") + "/api/trends/batch", method="POST",
                                     data=json.dumps({"candidates": batch}).encode(),
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                                              "User-Agent": "bot-hq-trends/1.0"})
        with opener(req, timeout=30) as r:
            res = json.loads(r.read().decode())
        for k in ("trends", "invalid", "opportunities", "rejected"):
            totals[k] += int(res.get(k) or 0)
        totals["batches"] += 1
    return totals


def markdown(report):
    lines = [f"# Trend collector report ({report['generated']})", "",
             f"Mode: **{'posted' if report['posted'] else 'dry run (nothing sent)'}**", "", "## Sources", ""]
    for name, s in report["sources"].items():
        extra = f" ({s['reason']})" if s.get("reason") else ""
        lines.append(f"- {name}: {s['status']}, {s['signals']} signals, {s['seconds']}s{extra}")
        for n in s.get("notes", []):
            lines.append(f"  - {n}")
    b = report["build"]
    lines += ["", "## Candidates", "",
              f"{b['signals']} signals, {b['topics']} topics, {b['story_groups']} story groups; "
              f"{b['no_account_passed']} matched no account's niche, {b['videos_unmatched']} videos matched no topic; "
              f"{b['candidates']} candidates" + (f" ({b['over_cap']} more over the cap)" if b["over_cap"] else "") + ". "
              f"Competition check: {b['competition'].get('status')}"
              + (f", {b['competition'].get('checked')} topics" if b["competition"].get("checked") is not None else "")
              + (f" ({b['competition']['reason']})" if b["competition"].get("reason") else "") + ".", ""]
    for c in report["candidates"]:
        acc = ", ".join(f"{k}{'' if g['passed'] else ' (rejected: ' + ('excluded ' + ', '.join(g['excluded']) if g['excluded'] else 'too weak') + ')'}"
                        for k, g in c["gates"].items())
        comp = ", ".join(f"{k} {v}" for k, v in c["components"].items()) or "no numbers"
        flag = (" ⚠ allegation or live court case, no verdict yet: never present it as fact; true crime waits "
                "for the verdict." if "active_case" in c["flags"] else "")
        lines.append(f"- **{c['name']}** -> {acc}.{flag} {len(c['signals'])} signals from "
                     f"{', '.join(sorted({s['source'] for s in c['signals']}))}. {comp}.")
    if report.get("post"):
        lines += ["", "## Posted", "", json.dumps(report["post"])]
    lines += ["", "## Research by hand (no free API for these)", ""]
    for acc, links in report["manual_links"].items():
        lines.append(f"- {acc}: " + " · ".join(f"[{l['label']}]({l['url']})" for l in links))
    return "\n".join(lines) + "\n"


def main(argv=None, env=None, http=None, modules=None, now=None, out_dir=None, state_path=None, opener=None):
    ap = argparse.ArgumentParser(description="Bot HQ trend collector (dry run unless --post)")
    ap.add_argument("--post", action="store_true", help="send the candidates to Bot HQ (default: dry run)")
    ap.add_argument("--only", help="comma-separated source names to run")
    args = ap.parse_args(argv)
    env = dict(os.environ) if env is None else env
    now = now or datetime.now(timezone.utc)
    out_dir = Path(out_dir or HERE / "out")
    state_path = Path(state_path or HERE / ".state" / "state.json")
    profiles = load_profiles()
    config = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))
    st = state_mod.load(state_path)
    ctx = Ctx(profiles, http or Http(cache_dir=HERE / ".cache"), st, config, env, now)
    mods = modules if modules is not None else REGISTRY()
    if args.only:
        wanted = set(args.only.split(","))
        mods = [m for m in mods if m.NAME in wanted]

    signals, status = run_sources(ctx, mods)
    cands, build = candidates.build(signals, profiles, now)
    build["competition"] = competition.check(cands, ctx)
    report = {"generated": now.strftime("%Y-%m-%d %H:%M UTC"), "posted": False, "sources": status, "build": build,
              "candidates": [{"name": c["name"], "text": c["text"], "for_accounts": c["for_accounts"], "components": c["components"],
                              "gates": c["_gates"], "flags": c["_flags"], "signals": c["signals"]} for c in cands],
              "manual_links": manual_links.all_links(profiles)}
    code = 0
    ran = [s for s in status.values() if s["status"] != "skipped"]
    if ran and all(s["status"] == "failed" for s in ran):
        code = 1
    if args.post:
        url, token = env.get("APP_URL"), env.get("APP_EVENTS_TOKEN")
        if not url or not token:
            print("--post needs APP_URL and APP_EVENTS_TOKEN", file=sys.stderr)
            code = 1
        elif cands:
            try:
                report["post"] = post(cands, url, token, **({"opener": opener} if opener else {}))
                report["posted"] = True
            except (urllib.error.URLError, OSError, ValueError) as e:
                report["post"] = {"error": redact(f"{type(e).__name__}: {e}")[:300]}
                code = 1
    state_mod.save(state_path, ctx.state)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    (out_dir / "report.md").write_text(markdown(report), encoding="utf-8")
    for name, s in status.items():
        print(f"{name:20} {s['status']:12} {s['signals']:4} signals  {s['seconds']}s  {s.get('reason', '')}")
    print(f"{build['candidates']} candidates ({build['no_account_passed']} matched no niche). "
          f"{'Posted: ' + json.dumps(report.get('post')) if args.post else 'Dry run: nothing sent.'} "
          f"Report: {out_dir / 'report.md'}")
    return code


if __name__ == "__main__":
    sys.exit(main())
