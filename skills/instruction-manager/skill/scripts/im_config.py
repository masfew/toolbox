#!/usr/bin/env python3
"""Reads instruction-manager's config, ~/.claude/instruction-manager.json, for the
check scripts, run_triggers.py and the edit guard. Every key is optional, and a
missing file means the defaults below. The INSTRUCTION_MANAGER_CONFIG environment
variable, when set, names another config file to read instead (the behaviour tests
use it, so they never read your own config).

    python im_config.py     prints the config in effect and the skill folders it finds

Keys:
  skill_folders        glob patterns for your own skills (~ allowed, * is one folder
                       level, ** any depth); a match counts when it holds a SKILL.md
  project_skills       also count each project's .claude/skills/<name>/ as yours
  global_instructions  files checked as global instructions (~/.claude/CLAUDE.md always is)
  skill_prefixes       name prefixes that mark a backticked word as a skill name
  new_skill_homes      where a new skill goes: [{"when": ..., "path": ".../<name>"}]
  budgets              overrides for the word and character budgets (see DEFAULTS)

Python standard library only.
"""
import copy
import glob
import json
import os
import re
import sys
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"
CONFIG_FILE = Path(os.path.expanduser(os.environ.get("INSTRUCTION_MANAGER_CONFIG")
                                      or CLAUDE_DIR / "instruction-manager.json"))
USER_CLAUDE_MD = CLAUDE_DIR / "CLAUDE.md"

DEFAULTS = {
    "skill_folders": ["~/.claude/skills/*"],
    "project_skills": True,
    "global_instructions": ["~/.claude/CLAUDE.md"],
    "skill_prefixes": [],
    "new_skill_homes": [{"when": "anything", "path": "~/.claude/skills/<name>"}],
    "budgets": {
        "description_chars": [500, 900, 1024],  # aim low, aim high, limit
        "skill_body_words": [2000, 3000],        # aim, limit
        "reference_words": [1500, 3000],         # list sections above this, limit
        "global_words": [4000, 5000],            # aim, limit, imports included
        "project_words": [1000, 3000],           # aim, limit, imports included
    },
}

_cache = None


class ConfigError(Exception):
    pass


def load():
    """The config in effect: DEFAULTS with the file's keys on top. Raises ConfigError."""
    global _cache
    if _cache is not None:
        return _cache
    cfg = copy.deepcopy(DEFAULTS)
    if CONFIG_FILE.is_file():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig") or "{}")
        except (OSError, ValueError) as e:
            raise ConfigError(f"{CONFIG_FILE} isn't valid JSON ({e}). Fix it, or delete it to use the defaults.")
        if not isinstance(data, dict):
            raise ConfigError(f"{CONFIG_FILE} must hold a JSON object, like config.example.json.")
        unknown = set(data) - set(DEFAULTS)
        if unknown:
            raise ConfigError(f"{CONFIG_FILE} has unknown settings: {', '.join(sorted(unknown))}. "
                              f"Known: {', '.join(DEFAULTS)}.")
        for key, value in data.items():
            if key == "budgets":
                if not isinstance(value, dict) or set(value) - set(DEFAULTS["budgets"]):
                    raise ConfigError(f"'budgets' in {CONFIG_FILE} takes only: "
                                      f"{', '.join(DEFAULTS['budgets'])}.")
                for b, v in value.items():
                    if (not isinstance(v, list) or len(v) != len(DEFAULTS["budgets"][b])
                            or not all(isinstance(n, int) for n in v)):
                        raise ConfigError(f"budgets.{b} in {CONFIG_FILE} must be "
                                          f"{len(DEFAULTS['budgets'][b])} whole numbers, "
                                          f"like {DEFAULTS['budgets'][b]}.")
                    cfg["budgets"][b] = v
            elif type(value) is not type(DEFAULTS[key]):
                raise ConfigError(f"'{key}' in {CONFIG_FILE} must be a "
                                  f"{'list' if isinstance(DEFAULTS[key], list) else 'true or false'}.")
            else:
                cfg[key] = value
    _cache = cfg
    return cfg


def load_or_exit():
    try:
        return load()
    except ConfigError as e:
        sys.exit(f"FAILED: {e}")


def expand(pattern):
    return os.path.expanduser(os.path.expandvars(str(pattern)))


def real(path):
    return Path(os.path.normcase(os.path.realpath(path)))


def skill_name_of(folder):
    folder = Path(folder)
    return folder.parent.name if folder.name == "skill" else folder.name


def project_skill_folders(start):
    """Skill folders in .claude/skills of start and every folder above it, except ~/.claude's."""
    found = []
    start = Path(start).resolve()
    for f in [start, *start.parents]:
        d = f / ".claude" / "skills"
        if f == Path.home() or not d.is_dir():
            continue
        found += [p for p in d.iterdir() if (p / "SKILL.md").is_file()]
    return found


def skill_folders(cwd=None):
    """Every skill folder the config covers, once each (by real path), sorted by name."""
    cfg = load()
    seen, out = set(), []
    hits = []
    for pat in cfg["skill_folders"]:
        hits += sorted(glob.glob(expand(pat), recursive=True))
    if cfg["project_skills"]:
        hits += [str(p) for p in project_skill_folders(cwd or os.getcwd())]
    for h in hits:
        p = Path(h)
        if not (p / "SKILL.md").is_file():
            continue
        r = real(p)
        if r in seen:
            continue
        seen.add(r)
        out.append(p.resolve())
    return sorted(out, key=lambda p: (skill_name_of(p), str(p).lower()))


def global_files():
    """The configured global instruction files, plus ~/.claude/CLAUDE.md, as real paths."""
    files = [real(expand(f)) for f in load()["global_instructions"]]
    if real(USER_CLAUDE_MD) not in files:
        files.append(real(USER_CLAUDE_MD))
    return files


# ---------- import lines, read the way Claude Code reads them ----------

AT = "@"  # an import line in a CLAUDE.md starts with it
IMPORT = re.compile(r"(?:^|\s)" + AT + r"((?:~|\.{1,2})?[\w./\\ -]*?[\w-]+\.md)\b", re.M)
IMPORT_DEPTH = 5  # Claude Code follows imports this many hops deep


def strip_code(text):
    """Text with fenced blocks and code spans blanked, so examples aren't read as imports."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    return re.sub(r"`[^`\n]*`", " ", text)


def resolve(ref, base):
    ref = ref.strip().replace("\\", "/")
    if ref.startswith("~/"):
        return Path.home() / ref[2:]
    if re.match(r"^[A-Za-z]:/", ref) or ref.startswith("/"):
        return Path(ref)
    return base / ref


def imports_of(path, seen=None, depth=IMPORT_DEPTH):
    """[(import text, resolved path or None if missing)] for path and what it imports,
    IMPORT_DEPTH hops deep, each file once."""
    path = Path(path)
    seen = seen if seen is not None else {path.resolve()}
    out = []
    if depth <= 0:
        return out
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for m in IMPORT.finditer(strip_code(text)):
        target = resolve(m.group(1), path.parent)
        if not target.is_file():
            out.append((m.group(1), None))
            continue
        if target.resolve() in seen:
            continue
        seen.add(target.resolve())
        out.append((m.group(1), target))
        out += imports_of(target, seen, depth - 1)
    return out


def imported_files():
    """Real paths of the files the global instruction files import, directly or through
    another import: every session loads them along with the global instructions."""
    files = global_files()
    out = []
    for f in files:
        if not f.is_file():
            continue
        for _, target in imports_of(f):
            if target is not None and real(target) not in files and real(target) not in out:
                out.append(real(target))
    return out


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    cfg = load_or_exit()
    print(f"Config file: {CONFIG_FILE} ({'found' if CONFIG_FILE.is_file() else 'not found: using the defaults'})")
    print(json.dumps(cfg, indent=2))
    folders = skill_folders()
    print(f"\n{len(folders)} skill folder(s) covered:")
    for f in folders:
        print(f"  {skill_name_of(f)}  ({f})")


if __name__ == "__main__":
    main()
