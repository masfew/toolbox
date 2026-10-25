#!/usr/bin/env python3
"""Fast checks for your instruction files: the global instructions, a project's
CLAUDE.md, and READMEs sessions are told to follow. Needs no test runs.

    python check_instructions.py <file> [<file> ...]
    python check_instructions.py --all     # the global instructions and every project CLAUDE.md
                                           # found from the folders Claude Code sessions ran in

Which files are the global instructions, the budgets and the skill name prefixes come
from ~/.claude/instruction-manager.json (im_config.py has the keys).

Reports, per file, as a plain list:
  - word count with estimated tokens (imports included) against the budget for its kind,
    and the change against the last git commit when the file has uncommitted edits (a file
    the global instructions import counts toward their budget, not one of its own)
  - imported files and links that point nowhere, and backticked paths that don't exist
  - skills named that aren't installed (a renamed or removed skill)
  - sentences that closely match one in a skill or in the global instructions
  - for a file with an evals/ folder beside it: which sections
    have tests, and which of those changed since the last commit and need a rerun

Lines start with ERROR, WARN or INFO, as in check_skill.py. Exits 1 when any ERROR is
printed. Python standard library only.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import im_config  # noqa: E402
from check_skill import (CONFIG, HOME, KNOWN_SKILLS, TOKENS_PER_WORD, USER_HOME,  # noqa: E402
                         build_dup_index, imports_of, load_known_skills, read, resolve,
                         size_line, strip_code, words)

# Kind -> (aim, limit) in words, imports included. READMEs are read on demand: no budget.
BUDGETS = {"global": tuple(CONFIG["budgets"]["global_words"]),
           "project": tuple(CONFIG["budgets"]["project_words"])}
PROJECT_NAMES = ("CLAUDE.md", "CLAUDE.local.md")

LINK_MD = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
CODE_SPAN = re.compile(r"`([^`\n]+)`")
SKILL_REF = re.compile(r"`([a-z][a-z0-9:-]*)`\s+skill\b|\bskill\s+`([a-z][a-z0-9:-]*)`")
PREFIXED_SKILL = (re.compile("^(?:" + "|".join(re.escape(x) for x in CONFIG["skill_prefixes"])
                             + r")[a-z0-9-]+$") if CONFIG["skill_prefixes"] else None)


def kind_of(path):
    if im_config.real(path) in im_config.global_files():
        return "global"
    if im_config.real(path) in im_config.imported_files():
        return "global import"
    if path.name in PROJECT_NAMES:
        return "project"
    return "readme"


def git_head_text(path):
    """(the file at HEAD or "" if new, True) when tracked with uncommitted edits; (None, tracked?) otherwise."""
    path = path.resolve()
    try:
        top = subprocess.run(["git", "-C", str(path.parent), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=20)
        if top.returncode:
            return None, False
        root = Path(top.stdout.strip()).resolve()
        rel = path.relative_to(root).as_posix()
        st = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--", rel],
                            capture_output=True, text=True, timeout=20)
        if not st.stdout.strip():
            return None, True
        old = subprocess.run(["git", "-C", str(root), "show", f"HEAD:{rel}"], capture_output=True, timeout=20)
        return (old.stdout.decode("utf-8", errors="replace") if old.returncode == 0 else ""), True
    except Exception:  # noqa: BLE001
        return None, False


def sections(text):
    """{heading: body} for each ## section; the text before the first one is under ''."""
    out, current = {"": []}, ""
    for line in text.replace("\r\n", "\n").split("\n"):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            current = m.group(1)
            out[current] = []
        else:
            out[current].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def slug(heading):
    return re.sub(r"[^a-z0-9]+", "-", heading.lower().replace("'", "")).strip("-")


def check_paths(text, base, add):
    plain = strip_code(text)
    for m in LINK_MD.finditer(plain):
        t = m.group(1).split("#")[0]
        if not t or re.match(r"^(https?:|mailto:)", t):
            continue
        if not resolve(t, base).exists():
            add("ERROR", f"links to {t}, which doesn't exist")
    stripped = re.sub(r"```.*?```", " ", text, flags=re.S)
    for m in CODE_SPAN.finditer(stripped):
        t = m.group(1).strip()
        # Only things that are clearly a path on this machine; patterns and placeholders are left alone.
        if re.search(r"[<>*{}$%|\s]", t) or "/" not in t.replace("\\", "/"):
            continue
        if not (t.startswith(("~/", "./", "../")) or re.match(r"^[A-Za-z]:[\\/]", t)):
            continue
        if not resolve(t, base).exists():
            add("WARN", f"names `{t}`, which doesn't exist")


def project_skills(path):
    """Skills a project keeps in its own .claude/skills, in its folder or any folder above it."""
    found = set()
    for f in [path.parent, *path.parent.parents]:
        d = f / ".claude" / "skills"
        if d.is_dir() and f != USER_HOME:
            found |= {p.name for p in d.iterdir() if (p / "SKILL.md").is_file()}
    return found


def check_skill_names(text, add, extra=()):
    named = set()
    for m in SKILL_REF.finditer(text):
        named.add((m.group(1) or m.group(2)).split(":")[-1])
    if PREFIXED_SKILL:
        named |= {t.strip() for t in CODE_SPAN.findall(text) if PREFIXED_SKILL.match(t.strip())}
    for n in sorted(named - KNOWN_SKILLS - set(extra)):
        add("WARN", f"names the skill `{n}`, which isn't installed (renamed or removed?)")


def check_tests(path, text, add):
    evals = path.parent / "evals"
    if not evals.is_dir():
        return
    tested = {d.name: d for d in evals.iterdir() if d.is_dir()}
    secs = sections(text)
    by_slug = {slug(h): h for h in secs if h}
    for name in sorted(tested):
        if name not in by_slug:
            add("WARN", f"evals/{name}/ matches no ## section (a section was renamed?)")
    head, tracked = git_head_text(path)
    changed = []
    if head is not None:
        old = sections(head)
        changed = [h for h in secs if h and secs[h] != old.get(h)]
        changed += [f"{h} (removed)" for h in old if h and h not in secs]
    for h in changed:
        s = slug(h.replace(" (removed)", ""))
        if s in tested:
            add("WARN", f"section \"{h}\" changed since the last commit and has tests in evals/{s}/: "
                        "rerun them as that folder's README says before the change counts as done")
        else:
            add("INFO", f"section \"{h}\" changed since the last commit (no tests)")
    for s in sorted(set(tested) & set(by_slug)):
        add("INFO", f"section \"{by_slug[s]}\" has tests in evals/{s}/")


def check_file(path, dups, show_info):
    out = []

    def add(level, msg):
        out.append((level, msg))

    if not path.is_file():
        add("ERROR", "no such file")
        return out
    kind = kind_of(path)
    text = read(path)
    imports = imports_of(path)
    for ref, target in imports:
        if target is None:
            add("ERROR", f"imports @{ref}, which doesn't exist")
    loaded = [path] + [t for _, t in imports if t]
    total = sum(words(read(p)) for p in loaded)
    note = f" ({len(loaded) - 1} import(s) included)" if len(loaded) > 1 else ""

    if kind == "readme":
        add("INFO", f"{total:,} words (~{round(total * TOKENS_PER_WORD):,} tokens), read only when a "
                    "session is told to: no budget")
    elif kind == "global import":
        add("INFO", f"{total:,} words (~{round(total * TOKENS_PER_WORD):,} tokens), imported by the "
                    "global instructions, so every session loads it: its budget is counted with "
                    "the file that imports it")
    else:
        aim, limit = BUDGETS[kind]
        head, _ = git_head_text(path)
        level, msg = size_line(f"{kind} instructions{note}, loaded by every session"
                               + (" in this project" if kind == "project" else ""),
                               total, aim, limit, words(head) if head is not None else None)
        add(level, msg)

    for p in loaded:
        sub = []
        check_paths(read(p), p.parent, lambda lv, m: sub.append((lv, m)))
        for lv, m in dict.fromkeys(sub):
            add(lv, m if p == path else f"{p.name}: {m}")
    check_skill_names("\n".join(read(p) for p in loaded), add, project_skills(path))

    if dups is not None:
        own = {"the global instructions"} if kind in ("global", "global import") else set()
        seen = set()
        for src, s, j in dups.matches("", "\n".join(read(p) for p in loaded)):
            if src in own or (s, src) in seen:
                continue
            seen.add((s, src))
            short = s if len(s) <= 140 else s[:137] + "..."
            add("WARN", f"close copy ({j:.0%}) of a sentence in {src}: \"{short}\"")

    for p in loaded:
        check_tests(p, read(p), add)

    if not show_info:
        out = [o for o in out if o[0] != "INFO"]
    return out


def session_folders():
    """Every working folder a Claude Code session has run in, from the newest transcript per project."""
    found = set()
    projects = HOME / "projects"
    if not projects.is_dir():
        return found
    for d in projects.iterdir():
        if not d.is_dir():
            continue
        newest = max(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, default=None)
        if not newest:
            continue
        with open(newest, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 40:
                    break
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and entry.get("cwd"):
                    found.add(Path(entry["cwd"]))
                    break
    return found


def all_files():
    files = {p.resolve() for p in [im_config.USER_CLAUDE_MD]
             + [Path(im_config.expand(f)) for f in CONFIG["global_instructions"]] if p.is_file()}
    for folder in session_folders():
        # Claude Code loads CLAUDE.md from the working folder and every folder above it.
        for f in [folder, *folder.parents]:
            if f == USER_HOME or f == HOME:
                break
            for c in (f / "CLAUDE.md", f / ".claude" / "CLAUDE.md", f / "CLAUDE.local.md"):
                if c.is_file() and "Temp" not in c.parts:
                    files.add(c.resolve())
    return sorted(files, key=lambda p: (kind_of(p) != "global", str(p).lower()))


def main():
    ap = argparse.ArgumentParser(description="Check instruction files against the house style.")
    ap.add_argument("files", nargs="*", help="a CLAUDE.md, the global instructions, or a README")
    ap.add_argument("--all", action="store_true",
                    help="the global instructions and every project CLAUDE.md sessions have loaded")
    ap.add_argument("--quiet", action="store_true", help="leave out INFO lines")
    ap.add_argument("--no-dups", action="store_true", help="skip the duplicate-sentence search")
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    files = [Path(f).resolve() for f in a.files]
    if a.all:
        files += [f for f in all_files() if f not in files]
    if not files:
        ap.error("name at least one file, or pass --all")

    load_known_skills()
    dups = None if a.no_dups else build_dup_index()
    errors = 0
    for f in files:
        lines = check_file(f, dups, not a.quiet)
        print(f"== {f}  ({kind_of(f)})")
        for level, msg in lines:
            print(f"  {level}: {msg}")
            errors += level == "ERROR"
        if not lines:
            print("  nothing to report")
        print()
    print(f"{len(files)} file(s) checked, {errors} error(s).")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
