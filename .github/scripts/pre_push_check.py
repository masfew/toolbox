#!/usr/bin/env python3
"""
Checks what's about to be pushed for secrets and personal information, and
stops the push if it finds any. The repo's pre-push hook (.github/hooks/pre-push)
runs it before every `git push`, and its pre-commit hook (.github/hooks/pre-commit)
runs it on the working tree before every `git commit`. Turn both hooks on once
per clone, from the root of the repo:

    git config core.hooksPath .github/hooks

Run it by hand from the root of the repo to check the working tree:

    python .github/scripts/pre_push_check.py

The five checks:
1. gitleaks looks for secrets: tokens, API keys, passwords, private keys.
2. The identifier search looks for your own identifiers, listed one fixed
   string per line in ~/.claude/public-repo-identifiers.txt (copy
   .github/scripts/public-repo-identifiers.example.txt to start it), matched without
   regard to case. A few kinds of hit are allowed (ALLOWED below lists them),
   such as links to this repo on GitHub, the copyright line in LICENSE,
   GitHub Actions pinned to a commit SHA, noreply addresses, and the at sign
   in common code (CSS at-rules, PowerShell here-strings, Python decorators,
   npm package scopes) where it can't be part of an email address.
3. Every commit's author and committer email is a GitHub noreply address
   (ending in @users.noreply.github.com).
4. No two tool folders share a name, and each name is lowercase words joined
   by hyphens. This is the check `.github/scripts/release_notes.py
   --check-names` runs, using that script's rule for what a tool folder is.
5. Each tool's install.py keeps the functions it shares with
   .github/template/install.py as they are there, so a fix made in one copy reaches
   the others. Every top-level function both files define is compared as
   text, docstring and comments included. One that differs is a finding
   unless the tool's copy says why, with a comment line
   `# differs from the template: <reason>` between its def line and its first
   statement (so above any docstring). A marked function that matches the
   template again is a finding too, so the marker gets deleted. Functions
   only one of the two files has are ignored.

What it scans:
- As the hook: only what the push sends. For each branch or tag, that's the
  commits the remote doesn't have yet: <remote sha>..<local sha>, or for a
  new branch or tag, the commits not on any of that remote's tracking
  branches. gitleaks scans those commits. The identifier search reads the
  lines they add, the names of the files they touch, their messages, the
  names of the pushed branches and tags, and annotated tags' messages. The
  name and installer checks read the tool folders in each pushed branch or
  tag, as that branch or tag has them.
  Deleting a remote branch or tag sends nothing, so it isn't checked.
- By hand, or as the pre-commit hook: every file in the working tree,
  tracked or untracked (ignored files are left out), the commits not on any
  remote yet, the current branch's name, the email this clone commits
  with, and the tool folders and installers in the working tree.

Ends with one "passed" line, or lists every finding with where it is and which
check found it, then exits with status 1. Exits with status 2 if gitleaks or
the identifier list is missing, so the push stops rather than going through
unchecked.
"""
import argparse
import ast
import fnmatch
import glob
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
IDENTIFIERS = Path.home() / ".claude" / "public-repo-identifiers.txt"
EXAMPLE = ".github/scripts/public-repo-identifiers.example.txt"
ZERO_SHA = re.compile(r"^0+$")
AS_HOOK = False  # set when git runs the script as the pre-push hook
# The at sign is written as \x40 in this file, so it passes its own search.
NOREPLY = re.compile(r"\x40users\.noreply\.github\.com$", re.I)
TEMPLATE_INSTALLER = ".github/template/install.py"
# The comment that says why a tool's installer function differs from the template's.
DIFFERS = re.compile(r"^\s*#\s*differs from the template:(.*)$")

# Text an identifier may appear inside: (only in files whose path matches this
# glob, or None for any file, commit message or ref name; pattern). A hit is
# allowed when it lies wholly inside a match of one of these.
#
# The rules for code symbols, from CSS at-rules on, match only the at sign or
# the one word they allow, with the text around it as lookarounds, so a match
# never covers another identifier next to it. Each at sign they allow follows
# a space or punctuation, never a letter, digit or dot (START), so no rule
# lets an email address through.
START = r"(?<![\w.+-])\x40"
ALLOWED = [
    # Links to this repo on GitHub, which hold its owner's username.
    (None, re.compile(r"github\.com/[\w.-]+/toolbox\b[\w./#?=&%-]*", re.I)),
    # This repo as <owner>/toolbox in a mod's one-line install from its plugin marketplace.
    (None, re.compile(r"--marketplace\s+[\w.-]+/toolbox\b", re.I)),
    # Plugin IDs from this repo's marketplace, <plugin>@toolbox (not an address at an toolbox domain).
    (None, re.compile(r"[\w-]*\x40toolbox(?![\w.-])", re.I)),
    # The copyright holder in the license.
    ("LICENSE", re.compile(r"^Copyright \(c\) \d{4}.*$")),
    # GitHub Actions pinned to a full commit SHA, as in the workflows.
    (None, re.compile(r"uses:\s*[\w.-]+/[\w./-]+\x40[0-9a-f]{40}\b")),
    # GitHub noreply addresses, and noreply addresses in commit trailers.
    (None, re.compile(r"[\w.+-]*\x40users\.noreply\.github\.com", re.I)),
    (None, re.compile(r"\bnoreply\x40[\w-]+(?:\.[\w-]+)+", re.I)),
    # Made-up addresses at the domains reserved for examples.
    (None, re.compile(r"[\w.+-]*\x40example\.(?:com|org|net)\b", re.I)),
    # A shell script passing on its arguments.
    (None, re.compile(r'"\$\x40"')),
    # CSS at-rules, in stylesheets and in code that writes or checks CSS.
    (None, re.compile(START + r"(?=(?:media|font-face|import|keyframes|supports)(?![\w.-]))", re.I)),
    # Font weights in a Google Fonts stylesheet link (family=Name:wght\x40400;600).
    (None, re.compile(r"(?<=:wght)\x40(?=\d)|(?<=:ital,wght)\x40(?=\d)", re.I)),
    # Telegram's bot for making bots, which setup steps send people to.
    (None, re.compile(START + r"(?=BotFather(?![\w.-]))")),
    # CLAUDE.md import lines for an installed tool's files, which name no user.
    (None, re.compile(START + r"(?=~/\.claude/tools/)")),
    # npm package scopes (\x40scope/package), in package files and imports.
    (None, re.compile(START + r"(?=[a-z0-9~-][a-z0-9._~-]*/[a-z0-9._~-])")),
    # The header line Cargo writes at the top of every Cargo.lock.
    ("*Cargo.lock", re.compile(r"^# This file is automatically \x40generated by Cargo\.$")),
    # High-resolution image names (icon\x402x.png).
    (None, re.compile(r"(?<=\w)\x40(?=[1-4]x\.(?:png|jpe?g|webp|svg|ico)(?![\w.-]))", re.I)),
    # PowerShell here-strings, arrays and hash tables, in PowerShell files only.
    ("*.ps1", re.compile(START + r"(?=['\"({])|^['\"]\x40")),
    ("*.psm1", re.compile(START + r"(?=['\"({])|^['\"]\x40")),
    # Python decorators, at the start of a line in Python files only.
    ("*.py", re.compile(r"^\s*\x40(?=[A-Za-z_][\w.]*\s*(?:\(|$))")),
    # C# verbatim strings and identifiers (\x40"C:\x", $\x40"{x}", \x40base), in C# files only.
    ("*.cs", re.compile(r"(?<![\w.+-])\$?\x40(?=[A-Za-z_\"])")),
    # The character literal '\x40', in C# files only.
    ("*.cs", re.compile(r"'\x40'")),
    # Two or more at signs in a row (diff hunk markers, placeholders such as F\x40\x40), which no address has.
    (None, re.compile(r"\x40{2,}")),
    # An at sign right before { or ], as inside a regex character class ([A-Za-z0-9_\x40{:]), which no address has.
    (None, re.compile(r"\x40(?=[{\]])")),
    # A quoted lone at sign ("\x40" or '\x40'), in Python and JavaScript files only.
    ("*.py", re.compile(r"(?<=[\"'])\x40(?=[\"'])")),
    ("*.js", re.compile(r"(?<=[\"'])\x40(?=[\"'])")),
    # A command-line argument that reads its text from a file (\x40file, \x40<file>), as better-plans' plan.py takes.
    (None, re.compile(START + r"(?=file\b|<\w[\w-]*>)")),
    # The word "documents" on its own, not a folder in a path. ([o] keeps the
    # pattern itself from matching the identifier it allows.)
    (None, re.compile(r"(?<![\\/])\bd[o]cuments\b(?![\\/])", re.I)),
]


def setup_error(msg):
    stopped = "\nThe push was stopped, since it couldn't be checked." if AS_HOOK else ""
    print(f"\nPre-push check couldn't run: {msg}{stopped}", file=sys.stderr)
    sys.exit(2)


def git(*args, ok=(0,)):
    r = subprocess.run(["git", "-c", "core.quotePath=false", *args], cwd=REPO, capture_output=True)
    if r.returncode not in ok:
        setup_error(f"`git {' '.join(args)}` failed: {r.stderr.decode('utf-8', 'replace').strip()}")
    return r.returncode, r.stdout.decode("utf-8", "replace")


def git_out(*args):
    return git(*args)[1]


# --- Setup -----------------------------------------------------------------

def find_gitleaks():
    found = shutil.which("gitleaks")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        # winget installs it here. A terminal opened before the install, or a
        # hook started from one, doesn't have it on PATH yet.
        for pattern in (r"Microsoft\WinGet\Links\gitleaks.exe",
                        r"Microsoft\WinGet\Packages\Gitleaks.Gitleaks_*\gitleaks.exe"):
            matches = glob.glob(os.path.join(local, pattern))
            if matches:
                return matches[0]
    setup_error("gitleaks isn't installed, or isn't on PATH. Install it (Windows: "
                "`winget install Gitleaks.Gitleaks`, macOS: `brew install gitleaks`, or a release "
                "from https://github.com/gitleaks/gitleaks/releases), then open a new terminal.")


def load_identifiers():
    if not IDENTIFIERS.is_file():
        setup_error(f"the identifier list {IDENTIFIERS} is missing. Create it from {EXAMPLE}, "
                    "with one of your own identifiers per line: your username, email addresses, "
                    "private project names and anything else that mustn't be published.")
    terms = []
    for line in IDENTIFIERS.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            terms.append((line, re.compile(re.escape(line), re.I)))
    if not terms:
        setup_error(f"the identifier list {IDENTIFIERS} has no identifiers in it. Add one per line.")
    return terms


# --- Checks ----------------------------------------------------------------

class Report:
    def __init__(self, terms):
        self.terms = terms
        self.findings = []

    def add(self, check, where, detail):
        self.findings.append(f"[{check}] {where}: {detail}")

    def search(self, where, text, path=None):
        """Reports each identifier in one line of text that no allow rule covers."""
        allowed = [m.span() for only, rule in ALLOWED
                   if only is None or (path and fnmatch.fnmatch(path, only)) for m in rule.finditer(text)]
        for term, pattern in self.terms:
            for m in pattern.finditer(text):
                if not any(a <= m.start() and m.end() <= b for a, b in allowed):
                    excerpt = text.strip()
                    if len(excerpt) > 160:
                        excerpt = excerpt[:157] + "..."
                    self.add("identifiers", where, f'"{term}" in: {excerpt}')
                    break

    def search_lines(self, where, text, path=None):
        for n, line in enumerate(text.splitlines(), 1):
            self.search(f"{where}:{n}", line, path)


_release_notes = None


def release_notes():
    """.github/scripts/release_notes.py, which holds the rule for what a tool folder is."""
    global _release_notes
    if _release_notes is None:
        path = REPO / ".github" / "scripts" / "release_notes.py"
        try:
            spec = importlib.util.spec_from_file_location("release_notes", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        except Exception as e:
            setup_error(f"couldn't load the tool folder rule from {path.relative_to(REPO).as_posix()}: {e}")
        _release_notes = module
    return _release_notes


def check_tool_names(report, where, paths):
    """Tool folders that share a name, or whose name isn't lowercase words
    joined by hyphens, among repo-relative file paths."""
    rn = release_notes()
    for problem in rn.name_problems(rn.tool_folders(paths)):
        report.add("tool names", where, problem)


def installer_functions(text, path):
    """An installer's top-level functions: name -> (line, source without the
    marker line, the marker's reason or None if it has no marker)."""
    text = text.replace("\r\n", "\n")
    lines = text.split("\n")
    functions = {}
    for node in ast.parse(text, filename=path).body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        # The marker is a comment between the def line and the first statement.
        reason = None
        for line in lines[node.lineno:node.body[0].lineno - 1]:
            m = DIFFERS.match(line)
            if m:
                reason = m.group(1).strip()
        source = "\n".join(line for line in ast.get_source_segment(text, node).split("\n")
                           if not DIFFERS.match(line))
        functions[node.name] = (node.lineno, source, reason)
    return functions


def check_installers(report, paths, read, ref=None):
    """Functions in each tool's install.py that differ from .github/template/install.py's
    and don't say why. paths are repo-relative file paths; read(path) gives a file's text."""
    if TEMPLATE_INSTALLER not in paths:
        return
    where = f"{ref} " if ref else ""

    def parse(path):
        try:
            return installer_functions(read(path), path)
        except SyntaxError as e:
            report.add("installers", f"{where}{path}:{e.lineno}",
                       f"isn't valid Python ({e.msg}), so it couldn't be compared with {TEMPLATE_INSTALLER}")
            return None

    template = parse(TEMPLATE_INSTALLER)
    if template is None:
        return
    for folder in release_notes().tool_folders(paths):
        path = f"{folder}/install.py"
        functions = parse(path)
        for name, (line, source, reason) in (functions or {}).items():
            if name not in template:
                continue
            same = source == template[name][1]
            if reason is None and not same:
                report.add("installers", f"{where}{path}:{line}",
                           f"{name}() differs from the one in {TEMPLATE_INSTALLER}. Make it match, move the "
                           f"change into the template and every tool that has {name}(), or, if it differs on "
                           "purpose, add the line `# differs from the template: <reason>` right under its def.")
            elif reason == "":
                report.add("installers", f"{where}{path}:{line}",
                           f"{name}() has a `# differs from the template:` line with no reason. Say why it differs.")
            elif reason is not None and same:
                report.add("installers", f"{where}{path}:{line}",
                           f"{name}() is marked as differing from the one in {TEMPLATE_INSTALLER}, but matches "
                           "it. Delete the `# differs from the template:` line.")


def run_gitleaks(report, exe, *args, shown_as=None):
    """shown_as: (scanned folder, folder to name in findings), when gitleaks scans a copy."""
    r = subprocess.run([exe, *args, "--redact", "--no-banner", "--no-color", "--verbose",
                        "--exit-code", "1", "--log-level", "warn"],
                       cwd=REPO, capture_output=True)
    out = (r.stdout + r.stderr).decode("utf-8", "replace").strip()
    if shown_as:
        for scanned in {str(shown_as[0]), Path(shown_as[0]).as_posix()}:
            out = out.replace(scanned, str(shown_as[1]))
    if r.returncode == 0:
        return
    if "leaks found" not in out:
        setup_error(f"gitleaks {args[0]} failed:\n{out}")
    out = "\n".join(f"      {line}" for line in out.splitlines() if line.strip())
    report.add("gitleaks", f"gitleaks {args[0]}", "found secrets (shown redacted):\n" + out)


def check_commits(report, revs):
    """Messages, added lines, file names and emails of the commits `git rev-list <revs>` lists."""
    commits = 0
    for entry in git_out("log", "--format=%x1e%h%x1f%ae%x1f%ce%x1f%B", *revs).split("\x1e")[1:]:
        sha, author, committer, message = entry.split("\x1f", 3)
        commits += 1
        for role, email in (("author", author), ("committer", committer)):
            if not NOREPLY.search(email):
                report.add("noreply", f"commit {sha}", f"the {role} email isn't a GitHub noreply address")
        report.search_lines(f"commit {sha} message", message)

    sha = path = None
    in_header = False
    line_no = 0
    diff = git_out("log", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-renames",
                   "--diff-merges=first-parent", "--src-prefix=a/", "--dst-prefix=b/",
                   "--format=%x01%h", *revs)
    for line in diff.splitlines():
        if line.startswith("\x01"):
            sha, path, in_header = line[1:], None, False
        elif line.startswith("diff --git "):
            in_header, path = True, None
        elif in_header and line.startswith("+++ "):
            path = None if line[4:] == "/dev/null" else line[6:]
            if path:
                report.search(f"commit {sha} file name {path}", path)
        elif line.startswith("\x40\x40"):  # a hunk header, which gives the new line number
            in_header = False
            m = re.match(r"\x40\x40 -\S+ \+(\d+)", line)
            line_no = int(m.group(1)) if m else 0
        elif not in_header and path and line.startswith("+"):
            report.search(f"commit {sha} {path}:{line_no}", line[1:], path)
            line_no += 1
    return commits


def check_tag_object(report, sha, ref):
    """An annotated tag's message and tagger email."""
    if git_out("cat-file", "-t", sha).strip() != "tag":
        return
    header, _, message = git_out("cat-file", "-p", sha).partition("\n\n")
    tagger = re.search(r"^tagger .*<([^>]*)>", header, re.M)
    if tagger and not NOREPLY.search(tagger.group(1)):
        report.add("noreply", ref, "the tagger email isn't a GitHub noreply address")
    report.search_lines(f"{ref} message", message)


def check_push(report, exe, remote, stdin):
    commits = refs = 0
    for line in stdin.splitlines():
        parts = line.split()
        if len(parts) != 4:
            continue
        local_ref, local_sha, remote_ref, remote_sha = parts
        if ZERO_SHA.match(local_sha):
            continue  # deleting a remote branch or tag sends nothing
        refs += 1
        report.search(f"pushed ref {local_ref}", local_ref)
        if remote_ref != local_ref:
            report.search(f"pushed ref {remote_ref}", remote_ref)
        check_tag_object(report, local_sha, remote_ref)
        tree = [p for p in git_out("ls-tree", "-r", "-z", "--name-only", f"{local_sha}^{{tree}}").split("\0") if p]
        check_tool_names(report, f"pushed ref {remote_ref}", tree)
        check_installers(report, tree, lambda path, sha=local_sha: git_out("show", f"{sha}:{path}"),
                         f"pushed ref {remote_ref}")

        known = not ZERO_SHA.match(remote_sha) and git("cat-file", "-e", f"{remote_sha}^{{commit}}", ok=(0, 1, 128))[0] == 0
        revs = [f"{remote_sha}..{local_sha}"] if known else [local_sha, "--not", f"--remotes={remote}"]
        if git_out("rev-list", "--max-count=1", *revs).strip():
            run_gitleaks(report, exe, "git", "--log-opts", " ".join(revs), str(REPO))
            commits += check_commits(report, revs)
    return f"{commits} new commit{'s' * (commits != 1)} on {refs} branch{'es' * (refs != 1)} or tag{'s' * (refs != 1)}"


def check_working_tree(report, exe):
    files = [f for f in git_out("ls-files", "-z", "-co", "--exclude-standard").split("\0") if f]
    # gitleaks scans a copy of the files git could commit, since `gitleaks dir` doesn't skip ignored
    # files: a tool's build output (an app's node_modules or Rust target folder) can't be pushed.
    with tempfile.TemporaryDirectory(prefix="pre-push-check-") as copy:
        for f in files:
            if (REPO / f).is_file():
                (Path(copy) / f).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(REPO / f, Path(copy) / f)
        run_gitleaks(report, exe, "dir", copy, shown_as=(copy, REPO))
    run_gitleaks(report, exe, "git", str(REPO))

    for rel in files:
        report.search(f"file name {rel}", rel)
        try:
            data = (REPO / rel).read_bytes()
        except OSError:
            continue  # deleted but not yet staged
        if b"\0" in data:
            continue  # binary
        report.search_lines(rel, data.decode("utf-8", "replace"), rel)

    branch = git_out("rev-parse", "--abbrev-ref", "HEAD").strip()
    report.search("current branch", branch)
    present = [f for f in files if (REPO / f).exists()]
    check_tool_names(report, "working tree", present)
    check_installers(report, present, lambda path: (REPO / path).read_text(encoding="utf-8", errors="replace"))
    email = git_out("config", "user.email").strip() if git("config", "user.email", ok=(0, 1))[0] == 0 else ""
    if not NOREPLY.search(email):
        report.add("noreply", "git config user.email", "this clone doesn't commit with a GitHub noreply address")
    commits = check_commits(report, ["HEAD", "--not", "--remotes"])
    return f"{len(files)} files and {commits} unpushed commit{'s' * (commits != 1)}"


def main():
    p = argparse.ArgumentParser(description="Check a push, or the working tree, for secrets and personal information.")
    p.add_argument("remote", nargs="?", help="the remote's name (git passes it to the pre-push hook)")
    p.add_argument("url", nargs="?", help="the remote's URL (git passes it to the pre-push hook)")
    args = p.parse_args()
    global AS_HOOK
    AS_HOOK = bool(args.remote)
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="replace")

    exe = find_gitleaks()
    report = Report(load_identifiers())
    if args.remote:
        scanned = check_push(report, exe, args.remote, sys.stdin.read())
    else:
        scanned = check_working_tree(report, exe)

    if not report.findings:
        print(f"Pre-push check passed: no secrets, identifiers, non-noreply emails, tool name "
              f"problems or installer drift in {scanned}.")
        return
    print(f"Pre-push check FAILED: {len(report.findings)} finding{'s' * (len(report.findings) != 1)} "
          f"in {scanned}.\n", file=sys.stderr)
    for finding in report.findings:
        print(f"  {finding}", file=sys.stderr)
    print("\nFix each one and try again. A secret, identifier or email has to come out of the commits "
          "that hold it (rewrite them); tool name and installer findings can be fixed in a new commit. "
          "Nothing was pushed."
          if args.remote else "\nFix each one before pushing.", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
