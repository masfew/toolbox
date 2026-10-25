#!/usr/bin/env python3
"""Trigger tests for one of your skills: does its description load it for the
prompts it should, and not for the near-misses?

    python run_triggers.py <skill folder> --dry-run              # what each tier would cost; runs nothing
    python run_triggers.py <skill folder> --tier standard        # test the current description
    python run_triggers.py <skill folder> --tier quick --description "..."  # test a candidate instead
    python run_triggers.py <skill folder> --tier standard --save           # record the score in evals/last-run.json
    python run_triggers.py <skill folder> --tier standard --compare        # compare with the last run of that tier
    python run_triggers.py <skill folder> --tier standard --compare --save # both, saving only when not lower

Every run is a real Claude Code session that counts against your plan's usage limits,
so the script never starts one unless you choose how many: with neither --tier nor
--runs/--model it prints the --dry-run estimates and exits with status 2.

Tiers (sessions are per prompt in triggers.json):
  quick     Haiku, 1 run per prompt: about 1 session each. Catches a broken description.
  standard  the CLI's default model, up to 3 runs per prompt, stopping a prompt once its
            result is settled: 2 to 3 sessions each.
  full      Opus, 3 runs per prompt, no early stop: 3 sessions each. (The skill's behaviour
            tests, evals/evals.json, run separately in subagents.)
--runs and --model without --tier make a "custom" run; with --tier they override it.

Reads <skill folder>/evals/triggers.json: [{"query": "...", "should_trigger": true}, ...],
the format skill-creator's run_eval.py reads.

How the runs work, and why this replaces skill-creator's run_eval.py:
  - The CLI is found on PATH, or where the Claude desktop app bundles it on Windows
    (%LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\claude-code\\<version>\\<hash>\\claude.exe
    or %APPDATA%\\Claude\\claude-code\\...). Override with --claude or the
    INSTRUCTION_MANAGER_CLAUDE environment variable. The CLI needs its own sign-in: run it
    once in a terminal and use /login.
  - select() on a pipe fails on Windows, so a thread reads the output.
  - An installed skill hides a test copy with the same name, and a copy with another name
    competes with it. So each run uses a scratch project with user-level settings off
    (--setting-sources project,local), holding description-only stubs of every skill in
    ~/.claude/skills plus the skill under test with the description being tested. The
    session then sees the same list it would normally, with the tested skill in it once.
  - Hooks are off (a notification hook would fire once per prompt), MCP servers are off and
    editing tools are refused, because a run that gets past choosing a skill starts working
    for real.
  - Instructions can tell sessions to load some skills first, so a run counts as triggered
    when the tested skill is loaded at any point before the first tool call that isn't a
    skill load.

A prompt stops as soon as its remaining runs can't change its pass or fail (except in the
full tier): with 3 runs, two that agree settle it and a third runs only when they split.
The verdicts and score match running all 3 every time; the load rates are over the runs
actually made.

evals/last-run.json holds the latest run at the top level and the latest run of each tier
under "tiers". --compare compares only with the same tier (a custom run only with a custom
run on the same model and runs), since scores from different models and run counts aren't
comparable. A file from before tiers existed is read as a standard run.

Prints a summary and, with --out, writes the full results as JSON. Exit status: 0, 2 when
no tier was chosen, 3 when --compare finds a lower score than last time, or 1 on an error.
"""
import argparse
import datetime as dt
import glob
import hashlib
import json
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

HOME = Path.home() / ".claude"
SKILLS_DIR = HOME / "skills"
NEUTRAL_TOOLS = {"Skill", "ToolSearch"}  # tool calls that don't end the "choosing a skill" phase

# Tier -> model (None: the CLI's default), most runs per prompt, early stop, and the
# rough wall-clock seconds one round of parallel sessions takes, for estimates before a
# tier has a run on record (a session stops as soon as it picks a skill or starts work:
# 58 Standard sessions took 51 seconds on 6 workers).
TIERS = {
    "quick": {"model": "haiku", "runs": 1, "early_stop": True, "seconds": 8},
    "standard": {"model": None, "runs": 3, "early_stop": True, "seconds": 10},
    "full": {"model": "opus", "runs": 3, "early_stop": False, "seconds": 15},
}


def skill_name_of(folder):
    folder = Path(folder)
    return folder.parent.name if folder.name == "skill" else folder.name


def read_frontmatter(skill_md):
    """(name, description) from a SKILL.md, tolerant of the shapes skills use."""
    text = Path(skill_md).read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    m = re.match(r"---\n(.*?)\n---", text, re.S)
    if not m:
        return None, ""
    fields, key = {}, None
    for line in m.group(1).split("\n"):
        mm = re.match(r"^([A-Za-z][\w-]*):\s?(.*)$", line)
        if mm:
            key = mm.group(1)
            fields[key] = mm.group(2)
        elif key and line[:1] in (" ", "\t"):
            fields[key] += " " + line.strip()
    desc = fields.get("description", "").strip()
    if desc[:1] in ('"', "'") and desc.endswith(desc[0]) and len(desc) > 1:
        desc = desc[1:-1].replace('\\"', '"')
    elif desc.split(" ", 1)[0] in (">", "|", ">-", "|-"):
        desc = desc.split(" ", 1)[1] if " " in desc else ""
    return fields.get("name", "").strip().strip("\"'"), desc


def broken_yaml(skill_md):
    """True when the description is unquoted and holds ': ' or ' #', which YAML can't parse."""
    text = Path(skill_md).read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^description:[ \t]*(.*)$", text, re.M)
    if not m:
        return False
    v = m.group(1).strip()
    return v[:1] not in ('"', "'", ">", "|") and bool(re.search(r": | #", v))


def find_claude(explicit):
    if explicit:
        return explicit
    if os.environ.get("INSTRUCTION_MANAGER_CLAUDE"):
        return os.environ["INSTRUCTION_MANAGER_CLAUDE"]
    on_path = shutil.which("claude")
    if on_path:
        return on_path
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    roaming = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    hits = glob.glob(str(local / "Packages" / "Claude_*" / "LocalCache" / "Roaming" / "Claude"
                         / "claude-code" / "*" / "*" / "claude.exe"))
    hits += glob.glob(str(roaming / "Claude" / "claude-code" / "*" / "*" / "claude.exe"))

    def version(p):
        v = Path(p).parent.parent.name
        return tuple(int(x) for x in re.findall(r"\d+", v))
    hits = [h for h in hits if os.access(h, os.X_OK) or h.endswith(".exe")]
    if not hits:
        sys.exit("FAILED: couldn't find the Claude Code CLI. Pass --claude <path to claude.exe>.")
    return max(hits, key=version)


def yaml_quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_project(skill_name, description):
    """A scratch project whose .claude/skills mirrors the real list, with the tested description."""
    root = Path(tempfile.mkdtemp(prefix="skilltrig-"))
    dest = root / ".claude" / "skills"
    dest.mkdir(parents=True)
    stubs = {}
    if SKILLS_DIR.is_dir():
        for entry in SKILLS_DIR.iterdir():
            md = entry / "SKILL.md"
            if entry.name == "synced" or not md.exists():
                continue
            name, desc = read_frontmatter(md)
            if broken_yaml(md):
                # Mirror what sessions really see: Claude Code falls back to the name
                # ("my-skill: My skill") when the frontmatter doesn't parse.
                desc = (name or entry.name).replace("-", " ").capitalize()
            stubs[name or entry.name] = desc
    stubs[skill_name] = description
    for name, desc in stubs.items():
        d = dest / name
        d.mkdir()
        (d / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {yaml_quote(desc)}\n---\n\n# {name}\n\n"
            "This is a stub used for a trigger test. Reply with one word: loaded.\n",
            encoding="utf-8")
    return root


def run_one(claude, project, query, skill_name, timeout, model):
    """True when the session loads skill_name before doing other work."""
    cmd = [claude, "-p", query, "--output-format", "stream-json", "--verbose",
           "--setting-sources", "project,local",
           "--settings", json.dumps({"disableAllHooks": True}),
           "--strict-mcp-config",
           "--disallowedTools", "Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch",
           "WebSearch", "Agent", "Task"]
    if model:
        cmd += ["--model", model]
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    proc = subprocess.Popen(cmd, cwd=project, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    lines = queue.Queue()

    def pump():
        for raw in proc.stdout:
            lines.put(raw)
        lines.put(None)
    threading.Thread(target=pump, daemon=True).start()

    deadline = time.time() + timeout
    loaded = []
    try:
        while time.time() < deadline:
            try:
                raw = lines.get(timeout=1.0)
            except queue.Empty:
                continue
            if raw is None:
                break
            try:
                event = json.loads(raw.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            if event.get("type") == "assistant":
                for item in event.get("message", {}).get("content", []):
                    if item.get("type") != "tool_use":
                        continue
                    tool, inp = item.get("name", ""), item.get("input", {})
                    if tool == "Skill":
                        s = str(inp.get("skill", ""))
                        loaded.append(s)
                        if s.split(":")[-1] == skill_name:
                            return True, loaded
                    elif tool == "Read" and f"/{skill_name}/SKILL.md" in str(inp.get("file_path", "")).replace("\\", "/"):
                        return True, loaded
                    elif tool not in NEUTRAL_TOOLS:
                        return False, loaded + [f"({tool})"]
            elif event.get("type") == "result":
                return False, loaded
        return False, loaded + ["(timed out)"]
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def settled(hits, runs, threshold, early_stop=True):
    """True when no result of the runs still to come can move the rate across threshold."""
    h, n = sum(hits), len(hits)
    if n >= runs:
        return True
    return early_stop and (h / runs >= threshold) == ((h + runs - n) / runs >= threshold)


def plan_of(a):
    """(tier name, model or None, runs, early stop) for the arguments, or None when none was chosen."""
    if a.tier:
        t = TIERS[a.tier]
        return (a.tier, a.model or t["model"], a.runs or t["runs"], t["early_stop"])
    if a.runs or a.model:
        return ("custom", a.model, a.runs or 3, True)
    return None


def read_last(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def tier_of(record):
    """A record's tier; one saved before tiers existed counts as standard when it ran like one."""
    if record.get("tier"):
        return record["tier"]
    if record.get("model", "default") == "default" and record.get("runs_per_query", 3) == 3:
        return "standard"
    return "custom"


def last_of_tier(last, tier, model, runs):
    """The last saved run comparable with this one, or None."""
    candidates = list((last.get("tiers") or {}).values())
    if last.get("passed") is not None and not last.get("tiers"):
        candidates.append(last)  # a file from before tiers existed
    for r in candidates:
        if tier_of(r) != tier:
            continue
        if tier == "custom" and (r.get("model") != (model or "default")
                                 or r.get("runs_per_query") != runs):
            continue
        return r
    return None


def estimate(n_prompts, tier, workers, last):
    """(fewest sessions, most sessions, minutes) for one tier."""
    t = TIERS[tier]
    most = n_prompts * t["runs"]
    fewest = most if not t["early_stop"] or t["runs"] == 1 else n_prompts * min(2, t["runs"])
    rec = (last.get("tiers") or {}).get(tier) or {}
    per = t["seconds"]
    if rec.get("seconds") and rec.get("runs_made"):
        # Measured: wall-clock seconds per round of parallel sessions on the last run.
        per = rec["seconds"] / math.ceil(rec["runs_made"] / workers)
    minutes = math.ceil(most / workers) * per / 60
    return fewest, most, max(1, round(minutes))


def print_estimates(name, n_prompts, tiers, workers, last, has_behaviour):
    print(f"{name}: {n_prompts} trigger prompts. Each session is a real Claude Code session on your plan.")
    for tier in tiers:
        t = TIERS[tier]
        fewest, most, minutes = estimate(n_prompts, tier, workers, last)
        count = f"{most}" if fewest == most else f"{fewest} to {most}"
        model = t["model"] or "the CLI's default model"
        extra = ""
        if tier == "full" and has_behaviour:
            extra = f", plus {has_behaviour} behaviour test(s) from evals/evals.json run in subagents"
        print(f"  {tier}: {count} sessions on {model}, about {minutes} minute(s){extra}")


def main():
    ap = argparse.ArgumentParser(description="Run a skill's trigger tests.")
    ap.add_argument("skill", help="the skill folder (the one holding SKILL.md)")
    ap.add_argument("--tier", choices=sorted(TIERS), help="quick, standard or full (see the top of this file)")
    ap.add_argument("--dry-run", action="store_true", help="print what each tier would cost, and run nothing")
    ap.add_argument("--eval-set", help="default: <skill>/evals/triggers.json")
    ap.add_argument("--description", help="test this description instead of the current one")
    ap.add_argument("--runs", type=int, help="most runs per prompt (overrides the tier's)")
    ap.add_argument("--workers", type=int, default=6, help="parallel sessions (default 6)")
    ap.add_argument("--timeout", type=int, default=90, help="seconds per run (default 90)")
    ap.add_argument("--threshold", type=float, default=0.5, help="trigger rate that counts as loading")
    ap.add_argument("--model", help="model for the test sessions (overrides the tier's)")
    ap.add_argument("--claude", help="path to the Claude Code CLI")
    ap.add_argument("--out", help="write the full results here as JSON")
    ap.add_argument("--save", action="store_true", help="record this score in evals/last-run.json")
    ap.add_argument("--compare", action="store_true", help="compare with the last run of the same tier")
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    folder = Path(a.skill).resolve()
    name = skill_name_of(folder)
    if not (folder / "SKILL.md").is_file():
        sys.exit(f"FAILED: {folder} has no SKILL.md. Pass the skill's folder.")
    fm_name, current = read_frontmatter(folder / "SKILL.md")
    if fm_name and fm_name != name:
        sys.exit(f"FAILED: SKILL.md says name '{fm_name}' but the folder is '{name}'. Fix that first.")
    eval_path = Path(a.eval_set) if a.eval_set else folder / "evals" / "triggers.json"
    if not eval_path.exists():
        sys.exit(f"FAILED: {eval_path} doesn't exist. Write the trigger prompts first.")
    try:
        items = json.loads(eval_path.read_text(encoding="utf-8"))
    except ValueError as e:
        sys.exit(f"FAILED: {eval_path} isn't valid JSON ({e}).")
    last_path = folder / "evals" / "last-run.json"
    last = read_last(last_path)
    behaviour = 0
    if (folder / "evals" / "evals.json").is_file():
        try:
            data = json.loads((folder / "evals" / "evals.json").read_text(encoding="utf-8"))
            behaviour = len(data.get("evals", data) if isinstance(data, dict) else data)
        except (ValueError, AttributeError):
            behaviour = 1

    plan = plan_of(a)
    if a.dry_run or plan is None:
        print_estimates(name, len(items), [a.tier] if a.tier else list(TIERS), a.workers, last, behaviour)
        if plan is None and not a.dry_run:
            print("\nNothing run: choose a tier with --tier quick|standard|full (or --runs/--model).")
            sys.exit(2)
        return
    tier, model, runs, early_stop = plan

    if not a.description and broken_yaml(folder / "SKILL.md"):
        # Test what sessions really see today, as for the other skills' stubs.
        current = name.replace("-", " ").capitalize()
        print(f"Note: the description doesn't parse, so sessions see only \"{current}\"; testing that.")
    description = a.description or current
    claude = find_claude(a.claude)

    project = build_project(name, description)
    print(f"Testing {name} ({len(description)}-character description), {len(items)} prompts x up to {runs} "
          f"runs, {tier} tier on {model or 'the default model'}")
    print(f"CLI: {claude}")
    started = time.time()
    try:
        hits = {i: [] for i in range(len(items))}
        seen = {i: [] for i in range(len(items))}
        n = 0
        with ThreadPoolExecutor(max_workers=a.workers) as pool:
            def submit(i):
                return pool.submit(run_one, claude, str(project), items[i]["query"], name,
                                   a.timeout, model)
            # One run per prompt at a time: the next is only submitted while the prompt is unsettled.
            futures = {submit(i): i for i in range(len(items))} if runs > 0 else {}
            while futures:
                done, _ = wait(futures, return_when=FIRST_COMPLETED)
                for fut in done:
                    i = futures.pop(fut)
                    try:
                        ok, loaded = fut.result()
                    except Exception as e:  # noqa: BLE001
                        ok, loaded = False, [f"(error: {e})"]
                    hits[i].append(ok)
                    seen[i].append(loaded)
                    n += 1
                    if not settled(hits[i], runs, a.threshold, early_stop):
                        futures[submit(i)] = i
                    if n % 10 == 0 or not futures:
                        print(f"  {n} runs done", flush=True)
    finally:
        shutil.rmtree(project, ignore_errors=True)
    seconds = round(time.time() - started)

    results, passed = [], 0
    for i, item in enumerate(items):
        rate = sum(hits[i]) / len(hits[i])
        should = bool(item["should_trigger"])
        ok = rate >= a.threshold if should else rate < a.threshold
        passed += ok
        others = sorted({s for run in seen[i] for s in run if s.split(":")[-1] != name})
        results.append({"query": item["query"], "should_trigger": should, "triggers": sum(hits[i]),
                        "runs": len(hits[i]), "pass": ok, "loaded_instead": others})
    total = len(results)
    pos = [r for r in results if r["should_trigger"]]
    neg = [r for r in results if not r["should_trigger"]]
    recall = sum(r["triggers"] for r in pos) / max(1, sum(r["runs"] for r in pos))
    false_rate = sum(r["triggers"] for r in neg) / max(1, sum(r["runs"] for r in neg))

    print(f"\nScore: {passed}/{total} prompts passed. Loaded on {recall:.0%} of should-load runs, "
          f"and on {false_rate:.0%} of near-miss runs. {n} sessions, {seconds // 60} min {seconds % 60} s.")
    for r in results:
        if not r["pass"]:
            want = "should load" if r["should_trigger"] else "near-miss"
            extra = f"; loaded instead: {', '.join(r['loaded_instead'])}" if r["loaded_instead"] else ""
            print(f"  FAIL ({want}, loaded {r['triggers']}/{r['runs']}{extra}): {r['query'][:110]}")

    record = {
        "date": dt.date.today().isoformat(),
        "tier": tier,
        "description_sha256": hashlib.sha256(description.encode("utf-8")).hexdigest(),
        "description_chars": len(description),
        "model": model or "default",
        "runs_per_query": runs,
        "runs_made": n,
        "seconds": seconds,
        "passed": passed,
        "total": total,
        "should_load_rate": round(recall, 3),
        "near_miss_rate": round(false_rate, 3),
        "failed": [{"query": r["query"], "should_trigger": r["should_trigger"],
                    "triggers": r["triggers"], "runs": r["runs"]} for r in results if not r["pass"]],
    }
    status = 0
    if a.compare:
        prev = last_of_tier(last, tier, model, runs)
        if prev is None:
            print(f"\nNo earlier {tier} run in evals/last-run.json to compare with "
                  "(runs from other tiers aren't comparable).")
        else:
            print(f"\nLast {tier} run ({prev.get('date')}): {prev.get('passed')}/{prev.get('total')}, "
                  f"should-load {prev.get('should_load_rate', 0):.0%}, near-miss {prev.get('near_miss_rate', 0):.0%}.")
            if passed < prev.get("passed", 0):
                print("LOWER than last time: explain or fix this before the edit goes in.")
                status = 3
            else:
                print("Not lower than last time.")
    if a.save:
        if a.description and a.description != current:
            print("\nNot saved: --save records the description in SKILL.md, and this run tested another one.")
        elif status == 3:
            print("\nNot saved: the score is lower than last time.")
        else:
            tiers = dict(last.get("tiers") or {})
            if last.get("passed") is not None and not tiers:
                tiers[tier_of(last)] = {k: v for k, v in last.items() if k != "tiers"}
            tiers[tier] = record
            last_path.parent.mkdir(exist_ok=True)
            last_path.write_text(json.dumps(dict(record, tiers=tiers), indent=2) + "\n", encoding="utf-8")
            print(f"\nSaved to {last_path}")
    if a.out:
        Path(a.out).write_text(json.dumps({"summary": record, "results": results}, indent=2), encoding="utf-8")
    sys.exit(status)


if __name__ == "__main__":
    main()
