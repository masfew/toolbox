#!/usr/bin/env python3
"""Runs instruction-manager's behaviour tests (evals.json beside this file) as real
Claude Code sessions and grades each run against the test's expectations.

    python -I run_behaviour.py                 every test, 3 runs each
    python -I run_behaviour.py --only 2 --runs 1
    python -I run_behaviour.py --model sonnet --out <folder>

Each run is a `claude -p` session in its own scratch project, which holds a copy of
this skill in .claude/skills and the small made-up skills the test needs. The session
reads its own config file through INSTRUCTION_MANAGER_CONFIG, never yours. User-level
settings, hooks and MCP servers are off, Edit, Write and Agent are refused, and the
CLI that run_triggers.py would start is replaced by a program that exits at once, so
a session that runs the trigger tests anyway starts no sessions. Grading reads the
session's tool calls and its reply. Every session counts against your plan's usage
limits: ask before running these (references/test-tiers.md).

Prints PASS or FAIL per expectation per run, and saves each run's raw stream and a
summary.json in --out (default: a new temporary folder). Exits 1 if any test fails.
Python standard library only.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
sys.path.insert(0, str(SKILL / "scripts"))
import run_triggers  # noqa: E402

TOOLS_ALLOWED = ["Bash", "Read", "Glob", "Grep", "Skill"]
TOOLS_REFUSED = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"]


# ---------- scratch projects ----------

def yaml_quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write_skill(folder, name, description, body, prompts=None, last_run=None):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {yaml_quote(description)}\n---\n\n{body}", encoding="utf-8")
    if prompts:
        (folder / "evals").mkdir(exist_ok=True)
        items = [{"query": q, "should_trigger": s} for q, s in prompts]
        (folder / "evals" / "triggers.json").write_text(json.dumps(items, indent=1), encoding="utf-8")
    if last_run:
        (folder / "evals" / "last-run.json").write_text(json.dumps(last_run, indent=1), encoding="utf-8")


RELEASE_NOTES = dict(
    name="release-notes",
    description=("Writes release notes for a web app from the merged pull requests since the last tag, "
                 "grouped into features, fixes and breaking changes, in a friendly tone. Use it whenever "
                 "the user asks for release notes, a changelog, or what changed since the last release, "
                 "even if they don't say 'notes'. Not for commit messages."),
    body="# Release notes\n\n1. List merged PRs since the last tag.\n2. Group them.\n3. Write the notes.\n",
    prompts=[("write release notes for v2.3", True), ("what changed since the last release?", True),
             ("make a changelog for this sprint", True), ("write a commit message for this diff", False),
             ("explain what a semver minor bump means", False), ("fix the failing login test", False)])

RECIPE_SCALER = dict(
    name="recipe-scaler",
    description=("Scales a recipe to a different number of servings and converts its units between metric "
                 "and US cups and spoons. Use it whenever the user wants a recipe for more or fewer people, "
                 "or asks to convert grams, cups or ounces in a recipe, even if they don't say 'scale'. "
                 "Not for meal plans or nutrition."),
    body=("# Recipe scaler\n\nThis skill scales recipes. It is used to scale recipes. When a recipe needs "
          "scaling, scale it.\n\n1. Read the recipe.\n2. Multiply every amount.\n3. Convert the units.\n"
          "4. Multiply every amount by the factor.\n"),
    prompts=[("double this pancake recipe", True), ("make this lasagne serve 10", True),
             ("convert 250 g of flour to cups", True), ("halve the brownie recipe", True),
             ("plan my meals for the week", False), ("how many calories in a banana", False),
             ("write a shopping list app", False), ("what's a good wine with risotto", False)])

DEPLOY_CHECKLIST = dict(
    name="deploy-checklist",
    description=("The checklist to run before deploying the team's web services to production: tests, "
                 "migrations, feature flags, a rollback plan and the announcement. Use it whenever the user "
                 "is about to deploy, ship or release a service, or asks what to check first, even if they "
                 "don't say 'checklist'. Not for writing release notes (release-notes)."),
    body=("# Deploy checklist\n\n1. Tests pass on main.\n2. Migrations run on staging.\n3. Feature flags set.\n"
          "4. Rollback plan written.\n5. Announce in the team channel.\n\nSee [references/rollback.md]"
          "(references/rollback.md).\n"),
    prompts=[("I'm about to deploy the billing service", True), ("ship the api to prod", True),
             ("what do I check before releasing the web app?", True), ("deploy checklist please", True),
             ("push the new search service live", True), ("write release notes for v4", False),
             ("set up CI for a new repo", False), ("roll back the last migration on my laptop db", False),
             ("explain blue-green deploys", False), ("fix the flaky checkout test", False)])


def base_project(prefix):
    root = Path(tempfile.mkdtemp(prefix=prefix))
    shutil.copytree(SKILL, root / ".claude" / "skills" / "instruction-manager",
                    ignore=shutil.ignore_patterns("__pycache__", "last-run.json", "run_behaviour.py",
                                                  "evals.json"))
    subprocess.run(["git", "init", "-q"], cwd=root)
    return root


def write_config(root, cfg):
    path = root / "im-config.json"
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return path


def setup_new_skill():
    root = base_project("im-newskill-")
    write_skill(root / ".claude" / "skills" / "release-notes", **{k: v for k, v in RELEASE_NOTES.items()
                                                                   if k != "prompts"})
    web = root / "web-skills"
    write_skill(web / "web-perf", "web-perf",
                ("Checks a web page's load time and bundle size before a release and suggests fixes. Use it "
                 "whenever the user asks why a page is slow or how big the bundle is, even if they don't say "
                 "'performance'."), "# Web perf\n\n1. Measure.\n2. Report.\n")
    (web / "README.md").write_text(
        "# Web skills\n\nOne folder per skill, named `web-<name>`. Add a row to the table for each new skill.\n\n"
        "| Skill | What it does |\n|---|---|\n| web-perf | Load time and bundle size checks |\n", encoding="utf-8")
    cfg = write_config(root, {
        "skill_folders": [f"{root.as_posix()}/web-skills/*"],
        "new_skill_homes": [
            {"when": "web front-end work: pages, components, styling, accessibility",
             "path": f"{root.as_posix()}/web-skills/web-<name>"},
            {"when": "anything else", "path": f"{root.as_posix()}/.claude/skills/<name>"}]})
    return root, cfg, {}


def setup_changed_description():
    root = base_project("im-changed-")
    folder = root / ".claude" / "skills" / "release-notes"
    write_skill(folder, **RELEASE_NOTES, last_run={
        "date": "2026-10-20", "tier": "standard", "description_sha256": "0" * 64, "model": "default",
        "runs_per_query": 3, "runs_made": 14, "seconds": 120, "passed": 6, "total": 6})
    cfg = write_config(root, {"skill_folders": []})  # project skills only
    return root, cfg, {"dry_run": dry_run([folder], cfg)}


def setup_audit():
    root = base_project("im-audit-")
    mine = root / "my-skills"
    folders = []
    for spec in (RELEASE_NOTES, RECIPE_SCALER, DEPLOY_CHECKLIST):
        write_skill(mine / spec["name"], **spec)
        folders.append(mine / spec["name"])
    ref = mine / "deploy-checklist" / "references"
    ref.mkdir()
    (ref / "rollback.md").write_text("# Rollback\n\nRedeploy the previous tag.\n", encoding="utf-8")
    cfg = write_config(root, {"skill_folders": [f"{mine.as_posix()}/*"], "project_skills": False})
    return root, cfg, {"dry_run": dry_run(folders, cfg)}


def dry_run(folders, cfg):
    """Summed session counts from run_triggers.py --dry-run over the folders."""
    total = {"quick": 0, "standard_low": 0, "standard_high": 0, "full": 0}
    env = dict(os.environ, INSTRUCTION_MANAGER_CONFIG=str(cfg))
    for f in folders:
        out = subprocess.run([sys.executable, "-I", str(SKILL / "scripts" / "run_triggers.py"), str(f),
                              "--dry-run"], capture_output=True, text=True, env=env).stdout
        q = re.search(r"quick: (\d+) sessions", out)
        s = re.search(r"standard: (\d+) to (\d+) sessions", out)
        fu = re.search(r"full: (\d+) sessions", out)
        if not (q and s and fu):
            sys.exit(f"FAILED: couldn't read run_triggers.py --dry-run for {f}:\n{out}")
        total["quick"] += int(q[1])
        total["standard_low"] += int(s[1])
        total["standard_high"] += int(s[2])
        total["full"] += int(fu[1])
    return total


# ---------- running a session ----------

def run_session(root, cfg, prompt, claude, model, timeout):
    cmd = [claude, "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--setting-sources", "project,local", "--settings", json.dumps({"disableAllHooks": True}),
           "--strict-mcp-config", "--max-turns", "40",
           "--allowedTools", *TOOLS_ALLOWED, "--disallowedTools", *TOOLS_REFUSED]
    if model:
        cmd += ["--model", model]
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    env["INSTRUCTION_MANAGER_CONFIG"] = str(cfg)
    # python -p is an unknown option, so a real trigger run inside the session fails at once
    env["INSTRUCTION_MANAGER_CLAUDE"] = sys.executable
    try:
        proc = subprocess.run(cmd, cwd=root, env=env, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)
        return proc.stdout
    except subprocess.TimeoutExpired as e:
        return (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")


def parse(stream):
    """Tool calls in order (name, input, result text), every assistant text, and the final reply."""
    calls, texts, final, results = [], [], "", {}
    for line in stream.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "assistant":
            for item in e.get("message", {}).get("content", []):
                if item.get("type") == "tool_use":
                    calls.append({"id": item.get("id"), "name": item.get("name"), "input": item.get("input", {}),
                                  "text_before": len(texts)})
                elif item.get("type") == "text":
                    texts.append(item.get("text", ""))
        elif e.get("type") == "user":
            content = e.get("message", {}).get("content", [])
            for item in content if isinstance(content, list) else []:
                if item.get("type") == "tool_result":
                    c = item.get("content")
                    if isinstance(c, list):
                        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                    results[item.get("tool_use_id")] = str(c or "")
        elif e.get("type") == "result":
            final = e.get("result") or ""
    for c in calls:
        c["result"] = results.get(c["id"], "")
    if not final and texts:
        final = texts[-1]
    return calls, texts, final


def cmd_of(c):
    return str(c["input"].get("command", "")).replace("\\", "/")


def before_asking(calls):
    """The calls made before the first AskUserQuestion (all of them if none)."""
    for i, c in enumerate(calls):
        if c["name"] == "AskUserQuestion":
            return calls[:i]
    return calls


def ask_text(calls, final):
    """The question as the user would see it: any AskUserQuestion's content, then the reply."""
    asked = [json.dumps(c["input"], ensure_ascii=False) for c in calls if c["name"] == "AskUserQuestion"]
    return "\n".join(asked + [final])


TIERS = ("quick", "standard", "full", "skip")


def tier_segments(calls, final):
    """The tier question's options, one text segment each: from an AskUserQuestion whose
    option labels are the four tiers, else from the last run of four list items in the
    reply that start with Quick, Standard, Full and Skip, in that order."""
    for c in reversed([c for c in calls if c["name"] == "AskUserQuestion"]):
        for q in c["input"].get("questions", []):
            opts = q.get("options", [])
            labels = [str(o.get("label", "")).strip().lower() for o in opts]
            if [next((t for t in TIERS if lab.startswith(t)), None) for lab in labels] == list(TIERS):
                return {t: f"{o.get('label', '')}: {o.get('description', '')}" for t, o in zip(TIERS, opts)}
    starts = [(m.start(), m[1].lower()) for m in re.finditer(
        r"^[ \t]*(?:\d+[.)]|[-*])?[ \t]*\**(Quick|Standard|Full|Skip)\b", final, re.M)]
    for i in range(len(starts) - 4, -1, -1):
        if [t for _, t in starts[i:i + 4]] == list(TIERS):
            ends = [p for p, _ in starts[i + 1:i + 4]]
            end = final.find("\n\n", starts[i + 3][0])
            ends.append(end if end > 0 else len(final))
            return {t: final[p:e] for (p, t), e in zip(starts[i:i + 4], ends)}
    return None


def snapshot(folder, skip=(".git", "__pycache__")):
    """{relative path: sha256} for every file under folder."""
    out = {}
    for p in Path(folder).rglob("*"):
        if p.is_file() and not any(s in p.parts for s in skip):
            out[p.relative_to(folder).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def changed(before, after):
    return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))


def has_num(segment, n):
    return re.search(rf"(?<![\d.]){n}(?![\d.])", segment or "") is not None


def real_trigger_runs(calls):
    return [cmd_of(c) for c in calls if c["name"] in ("Bash", "PowerShell")
            and "run_triggers" in cmd_of(c) and "--dry-run" not in cmd_of(c)]


def counts_match(seg, totals):
    return bool(seg and has_num(seg["quick"], totals["quick"])
                and has_num(seg["standard"], totals["standard_low"])
                and has_num(seg["standard"], totals["standard_high"])
                and has_num(seg["full"], totals["full"]))


# ---------- graders: one check per expectation, in evals.json's order ----------

def grade_new_skill(calls, texts, final, root, cfg, extra):
    cfgname = Path(cfg).name
    all_text = "\n".join(texts + [final]).replace("\\", "/")
    home_claude = (Path.home() / ".claude" / "skills").as_posix().lower()
    writes = [c for c in calls if c["name"] in ("Write", "Edit", "MultiEdit", "NotebookEdit")]
    writes += extra["changed"]  # files a shell command wrote in the scratch project
    read_cfg = any(("--show-config" in cmd_of(c) or "im_config.py" in cmd_of(c) or cfgname in cmd_of(c))
                   for c in calls) or any(c["name"] == "Read" and str(c["input"].get("file_path", "")).endswith(cfgname)
                                          for c in calls)
    read_real = any("instruction-manager.json" in cmd_of(c) or
                    str(c["input"].get("file_path", "")).replace("\\", "/").endswith(".claude/instruction-manager.json")
                    for c in calls)
    checked_name = any(("check_skill.py" in cmd_of(c) and "--all" in cmd_of(c)) or
                       (c["name"] == "Bash" and re.search(r"\b(ls|dir|find)\b", cmd_of(c)) and "skills" in cmd_of(c))
                       or c["name"] == "Glob" for c in calls)
    plain = re.sub(r"[*_`]", "", final)  # "should *not*" reads as "should not"
    interview = ("?" in plain and re.search(r"should(n't| not)|not (load|trigger)|near-miss|neighbou?r|"
                                             r"shouldn.t", plain, re.I))
    # the home: the full path, or the web-skills folder plus a web-<name> name
    home = (re.search(r"web-skills/web-[a-z0-9-]+", all_text) or
            (re.search(r"web-skills/?", all_text) and re.search(r"\bweb-(?!skills|perf)[a-z0-9]+(?:-[a-z0-9]+)*", all_text)))
    touched_home = [c["input"].get("file_path") for c in writes if isinstance(c, dict) and home_claude in str(
        c["input"].get("file_path", "")).replace("\\", "/").lower()] + extra["home_changed"]
    return [
        (read_cfg and not read_real, "read the test config" if read_cfg else "never read the config in effect"),
        (bool(home), f"named {home[0]}" if home else "no web-skills home or web-<name> named"),
        (checked_name, "listed skills" if checked_name else "no name check seen"),
        (bool(interview) and not writes, f"drafted before the interview: {[w if isinstance(w, str) else w['name'] for w in writes][:8]}"
         if writes else ("asked about loading" if interview else "no interview question about what should load it")),
        (not touched_home, "nothing in ~/.claude/skills" if not touched_home else f"touched it: {touched_home}"),
    ]


def grade_changed_description(calls, texts, final, root, cfg, extra):
    pre = before_asking(calls)
    seg = tier_segments(calls, final)
    totals = extra["dry_run"]
    checked = any("check_skill.py" in cmd_of(c) and "release-notes" in cmd_of(c) for c in pre)
    dry = any("run_triggers" in cmd_of(c) and "--dry-run" in cmd_of(c) for c in pre)
    runs = real_trigger_runs(calls)
    recommended = bool(seg and "Recommended" in seg["standard"] and "Recommended" not in seg["quick"])
    return [
        (checked, "ran check_skill.py" if checked else "no check_skill.py on release-notes"),
        (dry, "ran --dry-run" if dry else "no --dry-run before asking"),
        (seg is not None, "options in order" if seg else "no Quick/Standard/Full/Skip question in order"),
        (counts_match(seg, totals), f"expected {totals}"),
        (recommended, "Standard recommended, Quick first" if recommended else "Standard not marked (Recommended)"),
        (not runs, "no real run" if not runs else f"ran: {runs}"),
    ]


def grade_audit(calls, texts, final, root, cfg, extra):
    scripts = [c for c in calls if re.search(r"check_skill\.py|check_instructions\.py|run_triggers\.py", cmd_of(c))]
    first_all = bool(scripts) and "check_skill.py" in cmd_of(scripts[0]) and "--all" in cmd_of(scripts[0])
    all_text = "\n".join(texts + [final])
    # the count, or the choice to review these few small skills without subagents
    says_agents = re.search(r"[^.\n]{0,80}\bsub-?agents?\b[^.\n]{0,80}", all_text, re.I)
    dried = "\n".join(c["result"] for c in calls if "run_triggers" in cmd_of(c) and "--dry-run" in cmd_of(c))
    dried_all = all(f"{n}:" in dried for n in ("release-notes", "recipe-scaler", "deploy-checklist"))
    text = ask_text(calls, final)
    seg = tier_segments(calls, final)
    questions = len(re.findall(r"How should I (test|run)", text, re.I))
    runs = real_trigger_runs(calls)
    edits = [c["name"] for c in calls if c["name"] in ("Write", "Edit", "MultiEdit", "NotebookEdit")]
    edits += [k for k in extra["changed"] if k.startswith("my-skills/")]
    return [
        (first_all, "check_skill.py --all first" if first_all else
         f"first check was: {cmd_of(scripts[0])[:120] if scripts else 'none'}"),
        (bool(says_agents), says_agents[0].strip() if says_agents else "never said anything about subagents"),
        (dried_all, "dry-run for all 3" if dried_all else "missing a skill's --dry-run"),
        (seg is not None and questions <= 1, f"{questions} tier question(s)" if seg else "no tier question in order"),
        (counts_match(seg, extra["dry_run"]), f"expected {extra['dry_run']}"),
        (not runs, "no real run" if not runs else f"ran: {runs}"),
        (not edits, "no edits" if not edits else f"edited: {edits}"),
    ]


TESTS = {1: (setup_new_skill, grade_new_skill), 2: (setup_changed_description, grade_changed_description),
         3: (setup_audit, grade_audit)}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", help="comma-separated test ids (default: all)")
    ap.add_argument("--runs", type=int, default=3, help="runs per test (default 3)")
    ap.add_argument("--model", help="model for the sessions (default: the CLI's default)")
    ap.add_argument("--claude", help="path to the Claude Code CLI")
    ap.add_argument("--out", help="folder for the raw streams and summary.json")
    ap.add_argument("--parallel", type=int, default=3, help="sessions at once (default 3)")
    ap.add_argument("--timeout", type=int, default=900, help="seconds per session (default 900)")
    ap.add_argument("--keep", action="store_true", help="keep the scratch projects")
    ap.add_argument("--regrade", action="store_true",
                    help="grade the streams already saved in --out again, starting no sessions")
    a = ap.parse_args()
    if a.regrade and not a.out:
        sys.exit("FAILED: --regrade needs --out, the folder holding the saved streams.")

    evals = {e["id"]: e for e in json.loads((HERE / "evals.json").read_text(encoding="utf-8"))["evals"]}
    ids = [int(x) for x in a.only.split(",")] if a.only else sorted(evals)
    claude = None if a.regrade else run_triggers.find_claude(a.claude)
    out = Path(a.out) if a.out else Path(tempfile.mkdtemp(prefix="im-behaviour-"))
    out.mkdir(parents=True, exist_ok=True)
    if not a.regrade:
        print(f"{len(ids) * a.runs} sessions, {a.parallel} at a time, model {a.model or 'the CLI default'}. "
              f"Streams go to {out}")

    def one(job):
        tid, run = job
        setup, grade = TESTS[tid]
        root, cfg, extra = setup()
        before = snapshot(root)
        home_skills = Path.home() / ".claude" / "skills"
        home_before = set(os.listdir(home_skills)) if home_skills.is_dir() else set()
        start = time.time()
        stream = run_session(root, cfg, evals[tid]["prompt"], claude, a.model, a.timeout)
        extra["changed"] = changed(before, snapshot(root))
        home_after = set(os.listdir(home_skills)) if home_skills.is_dir() else set()
        extra["home_changed"] = sorted(home_after ^ home_before)
        (out / f"test{tid}-run{run}.jsonl").write_text(stream, encoding="utf-8")
        (out / f"test{tid}-run{run}.extra.json").write_text(json.dumps(
            {"cfg": str(cfg), **extra}, indent=1), encoding="utf-8")
        calls, texts, final = parse(stream)
        checks = grade(calls, texts, final, root, cfg, extra)
        if len(checks) != len(evals[tid]["expectations"]):
            raise SystemExit(f"test {tid}: {len(checks)} checks for {len(evals[tid]['expectations'])} expectations")
        if not a.keep:
            shutil.rmtree(root, ignore_errors=True)
        return tid, run, round(time.time() - start), checks, calls, final

    def regrade(job):
        tid, run = job
        base = out / f"test{tid}-run{run}"
        extra = json.loads(base.with_suffix(".extra.json").read_text(encoding="utf-8"))
        calls, texts, final = parse(base.with_suffix(".jsonl").read_text(encoding="utf-8"))
        return tid, run, 0, TESTS[tid][1](calls, texts, final, None, extra["cfg"], extra), calls, final

    if a.regrade:
        jobs = sorted((int(m[1]), int(m[2])) for m in (re.match(r"test(\d+)-run(\d+)\.jsonl$", p.name)
                                                        for p in out.iterdir()) if m and int(m[1]) in ids)
        results = [regrade(j) for j in jobs]
    else:
        jobs = [(t, r) for t in ids for r in range(1, a.runs + 1)]
        with ThreadPoolExecutor(a.parallel) as pool:
            results = list(pool.map(one, jobs))

    summary, failed = {}, False
    for tid in ids:
        exp = evals[tid]["expectations"]
        runs = [r for r in results if r[0] == tid]
        passed = all(ok for r in runs for ok, _ in r[3])
        failed |= not passed
        print(f"\n=== Test {tid}: {evals[tid]['eval_name']}: {'PASS' if passed else 'FAIL'}")
        summary[tid] = {"name": evals[tid]["eval_name"], "passed": passed, "runs": []}
        for _, run, secs, checks, calls, final in runs:
            print(f"  run {run} ({secs}s, {len(calls)} tool calls)")
            for (ok, why), e in zip(checks, exp):
                print(f"    {'PASS' if ok else 'FAIL'}  {e}  [{why}]")
            summary[tid]["runs"].append({"run": run, "seconds": secs, "checks": [
                {"expectation": e, "passed": ok, "evidence": why} for (ok, why), e in zip(checks, exp)],
                "reply_end": final[-1500:]})
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(f"\n{'All tests passed' if not failed else 'Some tests failed'}. Summary: {out / 'summary.json'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
