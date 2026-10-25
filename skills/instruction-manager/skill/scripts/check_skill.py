#!/usr/bin/env python3
"""Fast checks for your skills against the house style. Needs no test runs.

    python check_skill.py <skill folder> [<skill folder> ...]
    python check_skill.py --all            # every skill the config's skill_folders cover
    python check_skill.py --show-config    # the config in effect, and the skills it covers

Reports, per skill, as a plain list:
  - frontmatter problems (and skill-creator's quick_validate.py result when found)
  - description length against the house style
  - word counts against the budgets, with estimated tokens, and the change
    against the last git commit when the file has uncommitted edits
  - links that point nowhere, and reference files nothing links to
  - sentences that closely match one in another skill or the global instructions
  - a missing evals/triggers.json, or a last trigger run that tested another description

Which skills count as yours, which files are the global instructions, and the
budgets come from ~/.claude/instruction-manager.json (im_config.py has the keys).

Lines start with ERROR (breaks the skill or the house style's hard limits),
WARN (over an aim, or likely wrong) or INFO. Exits 1 when any ERROR is printed.
Python standard library only.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import im_config  # noqa: E402

HOME = im_config.CLAUDE_DIR
USER_HOME = Path.home()
CONFIG = im_config.load_or_exit()
_B = CONFIG["budgets"]
DESC_AIM = tuple(_B["description_chars"][:2])
DESC_LIMIT = _B["description_chars"][2]
BODY_AIM, BODY_LIMIT = _B["skill_body_words"]
REF_TOC, REF_LIMIT = _B["reference_words"]
TOKENS_PER_WORD = 1.35
SKIP_DIRS = {".git", "node_modules", "__pycache__", "evals", "history"}
SHINGLE = 5          # words per shingle for the duplicate search
DUP_MIN_WORDS = 10   # sentences shorter than this are never reported as copies
DUP_JACCARD = 0.6


def read(path):
    return Path(path).read_text(encoding="utf-8", errors="replace")


def words(text):
    return len(re.findall(r"\S+", text))


skill_name_of = im_config.skill_name_of


def find_all_skills():
    return im_config.skill_folders()


IMPORT = im_config.IMPORT
strip_code = im_config.strip_code
resolve = im_config.resolve
imports_of = im_config.imports_of


def global_instruction_files():
    """The global instruction files that exist (~/.claude/CLAUDE.md and the configured
    ones), and the files they import."""
    out = []
    for p in im_config.global_files():
        if not p.is_file():
            continue
        for q in [p] + [t for _, t in imports_of(p) if t]:
            if q.resolve() not in [o.resolve() for o in out]:
                out.append(q)
    return out


def split_frontmatter(text):
    text = text.replace("\r\n", "\n")
    m = re.match(r"---\n(.*?)\n---\n?", text, re.S)
    if not m:
        return None, text
    return m.group(1), text[m.end():]


def parse_frontmatter(fm):
    """Returns ({key: raw value}, [problems]). Handles the frontmatter shapes skills use."""
    fields, problems = {}, []
    key = None
    for line in fm.split("\n"):
        m = re.match(r"^([A-Za-z][\w-]*):\s?(.*)$", line)
        if m:
            key = m.group(1)
            fields[key] = m.group(2)
        elif key and (line.startswith(" ") or line.startswith("\t")):
            fields[key] += " " + line.strip()
    desc = fields.get("description", "")
    raw = desc.strip()
    if raw[:1] in ('"', "'"):
        q = raw[0]
        if not raw.endswith(q) or len(raw) < 2:
            problems.append("description opens a quote it never closes")
        value = raw[1:-1]
        if q == '"':
            value = value.replace('\\"', '"')
    elif raw in (">", "|", ">-", "|-"):
        value = raw  # block scalar; folded text was appended above
        value = desc.split(" ", 1)[1] if " " in desc else ""
    else:
        value = raw
        bad = re.search(r": | #", raw)
        if bad:
            problems.append(
                f"description is unquoted and contains '{bad.group(0).strip()}' at character "
                f"{bad.start()}: YAML stops reading there, so sessions see only the start. "
                "Wrap the whole value in double quotes")
    fields["_description"] = value
    return fields, problems


def find_quick_validate():
    pats = [HOME / "plugins" / "**" / "skill-creator" / "scripts" / "quick_validate.py",
            HOME / "skills" / "synced" / "**" / "skill-creator" / "scripts" / "quick_validate.py"]
    for pat in pats:
        hits = glob.glob(str(pat), recursive=True)
        if hits:
            return hits[0]
    return None


def run_quick_validate(qv, folder):
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    try:
        r = subprocess.run([sys.executable, qv, str(folder)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", env=env, timeout=60)
    except Exception as e:  # noqa: BLE001
        return None, f"could not run quick_validate.py: {e}"
    out = (r.stdout + r.stderr).strip().splitlines()
    last = out[-1] if out else ""
    if r.returncode == 0:
        return True, last
    # Keep the YAML error line, not the caret drawing under it.
    msg = next((l for l in out if "Invalid" in l or "too long" in l or "Error" in l), last)
    return False, msg.strip()


def git_head_words(path):
    """Word count of the file at HEAD, or None when it isn't tracked or is unchanged."""
    path = Path(path).resolve()
    try:
        top = subprocess.run(["git", "-C", str(path.parent), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=20)
        if top.returncode:
            return None
        root = Path(top.stdout.strip())
        rel = path.relative_to(root.resolve()).as_posix()
        st = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--", rel],
                            capture_output=True, text=True, timeout=20)
        if not st.stdout.strip():
            return None
        old = subprocess.run(["git", "-C", str(root), "show", f"HEAD:{rel}"],
                             capture_output=True, timeout=20)
        if old.returncode:
            return 0  # new file
        text = old.stdout.decode("utf-8", errors="replace")
        if path.name == "SKILL.md":
            text = split_frontmatter(text)[1]
        return words(text)
    except Exception:  # noqa: BLE001
        return None


def size_line(label, n, aim, limit, head):
    toks = round(n * TOKENS_PER_WORD)
    delta = ""
    if head is not None:
        d = n - head
        delta = f", {d:+,} against the last commit ({head:,})" if head else ", new since the last commit"
    if n > limit:
        level, note = "ERROR", f"over the {limit:,}-word limit: move or cut material"
    elif aim and n > aim:
        level, note = "WARN", f"over the {aim:,}-word aim"
    else:
        level, note = "INFO", "within budget"
    return level, f"{label}: {n:,} words (~{toks:,} tokens), {note}{delta}"


LINK_MD = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
LINK_CODE = re.compile(r"`([\w./<>*-]+\.(?:md|py|ps1|luau|json|js|txt|html|css))`")


KNOWN_SKILLS = set()  # filled in main(): every skill name a path might belong to


def link_targets(text, own_name):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    out = []
    # Links shown as examples inside code spans aren't links.
    for m in LINK_MD.finditer(re.sub(r"``.*?``|`[^`\n]*`", " ", text)):
        t = m.group(1)
        if re.match(r"^(https?:|mailto:|#)", t):
            continue
        out.append(("md", t.split("#")[0]))
    for m in LINK_CODE.finditer(text):
        # A path in the same sentence as another skill's name is that skill's file.
        start = max(text.rfind(". ", 0, m.start()), text.rfind("\n", 0, m.start()))
        ends = [e for e in (text.find(". ", m.end()), text.find("\n", m.end())) if e != -1]
        sentence = text[start + 1:min(ends) if ends else len(text)].replace(m.group(0), " ")
        named = set(re.findall(r"[\w:-]+", sentence)) & KNOWN_SKILLS
        if named - {own_name}:
            continue
        # "write `evals/evals.json`" or "if the skill has `x`" names a file that may not exist yet.
        if re.search(r"\b(write|create|add|make|has)\s+$", text[max(0, m.start() - 12):m.start()], re.I):
            continue
        out.append(("code", m.group(1)))
    return out


def pattern_regex(target):
    """styles/<style>.md -> a regex matching any file it names."""
    esc = re.escape(target)
    esc = re.sub(r"<[^>]*>|\\\*", "[^/]+", esc.replace(r"\<", "<").replace(r"\>", ">"))
    return re.compile("^(?:.*/)?" + esc + "$")


def check_links(folder, docs, files, own_name):
    """docs: {relpath: text} of SKILL.md and reference .md files. Returns (broken, unlinked)."""
    rels = {f.as_posix() for f in files}
    broken, linked = [], set()
    patterns = []
    for doc, text in docs.items():
        base = Path(doc).parent
        for kind, t in link_targets(text, own_name):
            if "<" in t or "*" in t:
                patterns.append(pattern_regex(t))
                continue
            cand = [(base / t).as_posix(), Path(t).as_posix()]
            cand = [os.path.normpath(c).replace("\\", "/") for c in cand]
            hit = next((c for c in cand if c in rels or (folder / c).exists()), None)
            if hit:
                linked.add(hit)
            elif kind == "md":
                broken.append(f"{doc} links to {t}, which doesn't exist")
            elif "/" in t and not t.startswith(("~", "$", "%")):
                # A backticked path inside the skill that isn't there. Paths to other
                # projects (no matching top folder here) are left alone.
                top = t.split("/")[0]
                if (folder / top).is_dir():
                    broken.append(f"{doc} names `{t}`, which doesn't exist")
    # Bare file names in backticks count as links when exactly one file has that name.
    all_text = "\n".join(docs.values())
    for r in rels:
        name = Path(r).name
        if r in linked:
            continue
        if any(p.match(r) for p in patterns):
            linked.add(r)
        elif re.search(r"(?<![\w/.-])" + re.escape(name) + r"(?![\w-])", all_text):
            linked.add(r)
    unlinked = sorted(r for r in rels if r.endswith(".md") and r != "SKILL.md" and r not in linked)
    return broken, unlinked


def without_improving(text):
    """The Improving This Skill section follows a shared house-style wording, so copies there are expected."""
    return re.sub(r"^## Improving this skill\b.*?(?=^## |\Z)", "", text, flags=re.S | re.M | re.I)


def sentences(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"[`*_>|#]", " ", text)
    for s in re.split(r"(?<=[.!?])\s+|\n\s*[-\d]+[.)]?\s+|\n{2,}", text):
        s = " ".join(s.split())
        if words(s) >= DUP_MIN_WORDS:
            yield s


def shingles(s):
    w = re.findall(r"[a-z0-9']+", s.lower())
    return {" ".join(w[i:i + SHINGLE]) for i in range(max(1, len(w) - SHINGLE + 1))}


class DupIndex:
    def __init__(self):
        self.items = []   # (source, sentence, shingles)
        self.by_sh = {}

    def add(self, source, text):
        for s in sentences(text):
            sh = shingles(s)
            idx = len(self.items)
            self.items.append((source, s, sh))
            for x in sh:
                self.by_sh.setdefault(x, []).append(idx)

    def matches(self, source, text):
        seen = set()
        for s in sentences(text):
            sh = shingles(s)
            counts = {}
            for x in sh:
                for idx in self.by_sh.get(x, ()):
                    counts[idx] = counts.get(idx, 0) + 1
            for idx, c in counts.items():
                osrc, os_, osh = self.items[idx]
                if osrc == source:
                    continue
                j = c / len(sh | osh)
                if j >= DUP_JACCARD and (s, osrc) not in seen:
                    seen.add((s, osrc))
                    yield osrc, s, j


def check_skill(folder, qv, dups, show_info):
    folder = Path(folder)
    name = skill_name_of(folder)
    out = []

    def add(level, msg):
        out.append((level, msg))

    skill_md = folder / "SKILL.md"
    if not skill_md.exists():
        add("ERROR", "no SKILL.md")
        return name, out
    text = read(skill_md)
    fm, body = split_frontmatter(text)
    if fm is None:
        add("ERROR", "SKILL.md has no frontmatter (--- block) at the top")
        fields = {"_description": ""}
    else:
        fields, problems = parse_frontmatter(fm)
        for p in problems:
            add("ERROR", p)
        if fields.get("name", "").strip().strip("\"'") != name:
            add("ERROR", f"name '{fields.get('name', '').strip()}' doesn't match the folder name '{name}'")
    if qv:
        ok, msg = run_quick_validate(qv, folder)
        if ok is False:
            add("ERROR", f"quick_validate.py: {msg}")
        elif ok is None:
            add("WARN", msg)

    desc = fields.get("_description", "")
    n = len(desc)
    if n > DESC_LIMIT:
        add("ERROR", f"description: {n:,} characters, over the {DESC_LIMIT:,} limit")
    elif n > DESC_AIM[1]:
        add("WARN", f"description: {n:,} characters, over the {DESC_AIM[1]}-character aim")
    elif n < DESC_AIM[0]:
        add("WARN", f"description: {n:,} characters, under the {DESC_AIM[0]}-character aim")
    else:
        add("INFO", f"description: {n:,} characters (~{round(n / 4):,} tokens in every session)")
    if desc and "not for" not in desc.lower():
        add("INFO", "description has no \"Not for…\" naming a neighbouring skill (fine if none overlaps)")

    level, msg = size_line("SKILL.md body", words(body), BODY_AIM, BODY_LIMIT, git_head_words(skill_md))
    add(level, msg)

    files, docs = [], {"SKILL.md": body}
    kept = {d.rstrip("/") for d in re.findall(r"`?([\w-]+)/`?", body) if d in SKIP_DIRS}
    for root, dirs, fnames in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in fnames:
            p = Path(root, f).relative_to(folder)
            if p.as_posix() == "SKILL.md":
                continue
            files.append(p)
            if f.endswith(".md"):
                t = read(folder / p)
                docs[p.as_posix()] = t
                nw = words(t)
                if nw > REF_LIMIT:
                    # A warning, not an error: a reference only loads when its "Read when" fits.
                    _, m2 = size_line(p.as_posix(), nw, None, REF_LIMIT, git_head_words(folder / p))
                    add("WARN", m2 + "; split it if its parts are read at different times")
                elif nw > REF_TOC and not re.search(r"^(#{2,3} |(Sections|Contents|Items):)", t[:1500], re.M):
                    add("WARN", f"{p.as_posix()}: {nw:,} words with no section list near the top")
    broken, unlinked = check_links(folder, docs, files, name)
    for b in broken:
        add("ERROR", b)
    for u in unlinked:
        add("WARN", f"{u} is never linked or named, so no session will read it")
    if (folder / "history").is_dir() and "history" not in kept and "history/" not in body:
        add("WARN", "history/ exists but SKILL.md doesn't say it's kept on purpose")

    if dups is not None:
        for src, s, j in dups.matches(name, without_improving(body)):
            short = s if len(s) <= 140 else s[:137] + "..."
            add("WARN", f"close copy ({j:.0%}) of a sentence in {src}: \"{short}\"")

    trig = folder / "evals" / "triggers.json"
    last = folder / "evals" / "last-run.json"
    if not trig.exists():
        add("WARN", "no evals/triggers.json (trigger tests)")
    else:
        try:
            items = json.loads(read(trig))
            pos = sum(1 for i in items if i.get("should_trigger"))
            add("INFO", f"evals/triggers.json: {pos} should-load and {len(items) - pos} near-miss prompts")
        except Exception as e:  # noqa: BLE001
            add("ERROR", f"evals/triggers.json isn't valid: {e}")
        if not last.exists():
            add("WARN", "no evals/last-run.json: run the trigger tests and save a starting score")
        else:
            try:
                lr = json.loads(read(last))
                sha = hashlib.sha256(desc.encode("utf-8")).hexdigest()
                score = (f"{lr.get('passed')}/{lr.get('total')} on {lr.get('date')}, "
                         f"{lr.get('tier', 'standard')} tier")
                if lr.get("description_sha256") != sha:
                    add("WARN", f"description changed since the last trigger run ({score}): rerun and compare")
                else:
                    add("INFO", f"last trigger run: {score}")
            except Exception as e:  # noqa: BLE001
                add("ERROR", f"evals/last-run.json isn't valid: {e}")

    if not show_info:
        out = [o for o in out if o[0] != "INFO"]
    return name, out


def load_known_skills():
    """Fills KNOWN_SKILLS with every skill name a session might see: yours, plugins', synced."""
    KNOWN_SKILLS.update(skill_name_of(f) for f in find_all_skills())
    if (HOME / "skills").is_dir():
        KNOWN_SKILLS.update(p.name for p in (HOME / "skills").iterdir())
    for pat in ("plugins/**/skills/*/SKILL.md", "skills/synced/*/*/SKILL.md"):
        KNOWN_SKILLS.update(Path(f).parent.name for f in glob.glob(str(HOME / pat), recursive=True))
    KNOWN_SKILLS.discard("skill")
    return KNOWN_SKILLS


def build_dup_index(skip_global=False):
    """Every skill's SKILL.md body and (unless skip_global) the global instructions."""
    dups = DupIndex()
    for f in find_all_skills():
        dups.add(skill_name_of(f), without_improving(split_frontmatter(read(f / "SKILL.md"))[1]))
    if not skip_global:
        for g in global_instruction_files():
            dups.add("the global instructions", read(g))
    return dups


def main():
    ap = argparse.ArgumentParser(description="Check skills against the house style.")
    ap.add_argument("folders", nargs="*", help="skill folders (the folder holding SKILL.md)")
    ap.add_argument("--all", action="store_true", help="every skill the config's skill_folders cover")
    ap.add_argument("--show-config", action="store_true",
                    help="print the config in effect and the skills it covers, then stop")
    ap.add_argument("--quiet", action="store_true", help="leave out INFO lines")
    ap.add_argument("--no-dups", action="store_true", help="skip the duplicate-sentence search")
    ap.add_argument("--no-validate", action="store_true", help="skip skill-creator's quick_validate.py")
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if a.show_config:
        im_config.main()
        return
    folders = [Path(f).resolve() for f in a.folders]
    if a.all:
        folders += [f for f in find_all_skills() if f not in folders]
    if not folders:
        ap.error("name at least one skill folder, or pass --all")

    load_known_skills()

    qv = None if a.no_validate else find_quick_validate()
    if not a.no_validate and not qv:
        print("WARN: skill-creator's quick_validate.py wasn't found; frontmatter checked by this script only\n")

    dups = None if a.no_dups else build_dup_index()

    errors = 0
    for f in folders:
        name, lines = check_skill(f, qv, dups, not a.quiet)
        print(f"== {name}  ({f})")
        for level, msg in lines:
            print(f"  {level}: {msg}")
            errors += level == "ERROR"
        if not lines:
            print("  nothing to report")
        print()
    print(f"{len(folders)} skill(s) checked, {errors} error(s).")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
