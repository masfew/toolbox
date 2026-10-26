#!/usr/bin/env python3
"""
Checks a release tag against its tool's README, then writes the release notes
and the zip that the release workflow (.github/workflows/release.yml) attaches
to the GitHub release. Run it before pushing a tag to see what the release
will hold. From the root of the repo:

    python .github/scripts/release_notes.py <tool>-v<X.Y.Z>
    python .github/scripts/release_notes.py <tool>-v<X.Y.Z> --notes notes.md --zip <tool>-v<X.Y.Z>.zip

What it checks:
1. The tag is named <tool>-v<MAJOR.MINOR.PATCH>, for example example-tool-v1.2.0.
2. Exactly one tool folder is named <tool>. A tool folder is any folder
   holding both a README.md and an install.py, outside .github (which holds
   the template), at any depth: skills/example-tool/ and example-tool/ both count.
3. The README's version line ("Version X.Y.Z.") matches the tag.
4. The README's Changes section has an entry for that version
   ("- X.Y.Z: what changed"). A tool that keeps a CHANGELOG.md instead can
   have a heading naming the version there.
5. A tool packaged as a Claude Code plugin (its folder holds
   .claude-plugin/plugin.json) has the same version in its plugin.json.

Everything is read from the repo as committed at --ref (HEAD by default), so
commit before testing locally. The notes are the version's entry, plus a line
on how to install this version (for a plugin, how to install it from the
repo's plugin marketplace). They go to standard output unless --notes
names a file. --zip packs the tool's folder into a zip whose top folder is the
tool's name, wherever the folder sits in the repo.

    python .github/scripts/release_notes.py --check-names

checks every tool folder at --ref instead: that no two share a name, and that
each name is lowercase words joined by hyphens, since release tags, zips and
install paths use only the name. The secret-scan workflow runs it on every
push, and .github/scripts/pre_push_check.py runs the same check before every commit
and push.

In GitHub Actions it also writes tool=<tool>, version=<X.Y.Z>, folder=<the
tool's folder> and build=true or false (whether the folder holds a build.ps1,
which the release workflow runs to attach built files) to the step's outputs.
Exits with status 1 and a FAILED message saying what to fix.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import textwrap
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NAME = r"[a-z0-9]+(?:-[a-z0-9]+)*"
TOOL_NAME = re.compile(rf"^{NAME}$")
TAG = re.compile(rf"^(?P<tool>{NAME})-v(?P<version>\d+\.\d+\.\d+)$")
VERSION_LINE = re.compile(r"^Version v?(\d+\.\d+\.\d+)\b", re.M)
HEADING = re.compile(r"^(#+)\s")
# Folders at the root of the repo that never hold tools: git's own, and the
# repo's workflows, hooks, scripts and the template new tools start from.
NOT_TOOLS = {".git", ".github"}


def fail(msg):
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::error::{msg}")
    print(f"FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def parse_tag(tag):
    m = TAG.match(tag)
    if not m:
        fail(f"'{tag}' isn't a release tag. Tags are named <tool>-v<MAJOR.MINOR.PATCH>, "
             "for example example-tool-v1.2.0, with the tool's folder name in lowercase.")
    return m.group("tool"), m.group("version")


def git(*args):
    r = subprocess.run(["git", "-C", str(REPO), "-c", "core.quotePath=false", *args], capture_output=True)
    return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace").strip()


# --- Tool folders ----------------------------------------------------------

def tool_folders(paths):
    """The tool folders among repo-relative file paths (with / between parts):
    every folder holding both a README.md and an install.py, outside the
    folders in NOT_TOOLS. Sorted, with / between parts."""
    found = {}
    for path in paths:
        folder, _, name = path.rpartition("/")
        if folder and name in ("README.md", "install.py"):
            found.setdefault(folder, set()).add(name)
    return sorted(f for f, names in found.items() if len(names) == 2 and f.split("/")[0] not in NOT_TOOLS)


def folder_name(folder):
    return folder.rpartition("/")[2]


def name_problems(folders):
    """What's wrong with the names of these tool folders, one line per problem."""
    by_name = {}
    for folder in folders:
        by_name.setdefault(folder_name(folder), []).append(folder)
    problems = []
    for name, where in sorted(by_name.items()):
        if not TOOL_NAME.match(name):
            problems.append(f"{', '.join(where)}: the tool folder name '{name}' isn't lowercase words "
                            "joined by hyphens, such as example-tool. Rename the folder.")
        if len(where) > 1:
            problems.append(f"{len(where)} tool folders are named {name}: {', '.join(where)}. "
                            "Release tags, zips and install paths use only the folder name, "
                            "so each tool needs a name of its own. Rename all but one.")
    return problems


def committed_files(ref):
    code, out, err = git("ls-tree", "-r", "-z", "--name-only", ref)
    if code != 0:
        fail(f"couldn't list the files at {ref}. git said: {err}")
    return [p for p in out.decode("utf-8", "replace").split("\0") if p]


def committed_text(ref, path):
    code, out, err = git("show", f"{ref}:{path}")
    if code != 0:
        fail(f"couldn't read {path} at {ref}. git said: {err}")
    return out.decode("utf-8")


def find_tool(tool, version, ref, files):
    matches = [f for f in tool_folders(files) if folder_name(f) == tool]
    if not matches:
        fail(f"there's no tool folder named {tool} at {ref}. The part of the tag before -v{version} has "
             "to be the name of a folder that holds a README.md and an install.py. Is it committed?")
    if len(matches) > 1:
        fail(f"{len(matches)} tool folders are named {tool} at {ref}: {', '.join(matches)}. "
             "Each tool needs a name of its own. Rename all but one.")
    return matches[0]


# --- Notes -----------------------------------------------------------------

def readme_entry(text, version):
    """The text of the version's entry in the README's Changes section, or None."""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if re.match(r"^##\s+Changes\s*$", line)), None)
    if start is None:
        return None
    entry = None
    for line in lines[start + 1:]:
        if HEADING.match(line):
            break
        m = re.match(r"^[-*]\s+v?(\d+\.\d+\.\d+):\s*(.*)$", line)
        if m:  # the start of an entry
            if entry is not None:
                break
            if m.group(1) == version:
                entry = [m.group(2)]
        elif entry is not None:
            entry.append(line)
    if entry is None:
        return None
    rest = textwrap.dedent("\n".join(entry[1:])).strip("\n")
    return "\n".join(part for part in (entry[0].strip(), rest) if part).strip()


def changelog_entry(text, version):
    """The text under a CHANGELOG.md heading that names the version, or None."""
    lines = text.splitlines()
    names = re.compile(r"^(#+)\s.*(?<![\d.])v?" + re.escape(version) + r"(?![\d.])")
    for i, line in enumerate(lines):
        m = names.match(line)
        if not m:
            continue
        level, body = len(m.group(1)), []
        for rest in lines[i + 1:]:
            h = HEADING.match(rest)
            if h and len(h.group(1)) <= level:
                break
            body.append(rest)
        return "\n".join(body).strip()
    return None


def repo_slug():
    """The GitHub repo as <owner>/<name>: from the workflow, or from the origin remote's URL."""
    slug = os.environ.get("GITHUB_REPOSITORY")
    if slug:
        return slug
    code, url, _ = git("remote", "get-url", "origin")
    m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", url.decode("utf-8", "replace").strip())
    if code != 0 or not m:
        fail("couldn't tell the repo's <owner>/<name> from the origin remote. Set GITHUB_REPOSITORY.")
    return m.group(1)


def build_notes(tool, version, tag, ref, folder, files):
    readme = f"{folder}/README.md"
    text = committed_text(ref, readme)

    found = VERSION_LINE.search(text)
    if not found:
        fail(f"{readme} has no version line. Add 'Version {version}.' under its title.")
    if found.group(1) != version:
        fail(f"{readme} says Version {found.group(1)}, but the tag is for {version}. "
             "Update the version line, or tag the version the README names.")

    entry, source = readme_entry(text, version), readme
    changelog = f"{folder}/CHANGELOG.md"
    if entry is None and changelog in files:
        entry, source = changelog_entry(committed_text(ref, changelog), version), changelog
    if entry is None:
        fail(f"{readme} has no entry for {version} in its Changes section. "
             f"Add one, such as '- {version}: what changed', at the end of the README.")
    if not entry:
        fail(f"the {version} entry in {source} is empty. Say what changed in this version.")

    manifest = f"{folder}/.claude-plugin/plugin.json"
    if manifest in files:
        try:
            plugin_version = json.loads(committed_text(ref, manifest)).get("version")
        except json.JSONDecodeError as e:
            fail(f"{manifest} isn't valid JSON ({e}).")
        if plugin_version != version:
            fail(f"{manifest} says version {plugin_version}, but the tag is for {version}. "
                 "Give plugin.json the same version as the README.")
        return (f"{entry}\n\n"
                f"This is a Claude Code mod. To install the latest version, run "
                f"`claude plugin install {tool} --marketplace {repo_slug()}` in a terminal. To install "
                f"this version, clone the repo, run `git fetch --tags` and `git checkout {tag}`, then run "
                f"`python install.py` from the tool's folder. The tool's README has the details.\n")

    return (f"{entry}\n\n"
            f"To install this version, download {tag}.zip below, unzip it and run `python install.py` "
            f"from the {tool} folder inside it. The install copies the tool to `~/.claude/tools/{tool}`, "
            f"so the unzipped folder can be deleted afterwards. In a clone of the repo, run "
            f"`git fetch --tags` and `git checkout {tag}` instead, then rerun `python install.py` from "
            f"the tool's folder. The tool's README has the details.\n")


def build_zip(tool, ref, folder, path):
    path = Path(path).resolve()
    code, _, err = git("archive", "--format=zip", f"--prefix={tool}/", "-o", str(path), f"{ref}:{folder}")
    if code != 0:
        fail(f"couldn't zip {folder}/ at {ref}. git said: {err}")
    with zipfile.ZipFile(path) as z:
        zipped = [n for n in z.namelist() if not n.endswith("/")]
    if not zipped:
        fail(f"the zip of {folder}/ at {ref} is empty.")
    print(f"zipped {len(zipped)} files from {folder}/ at {ref} into {path}", file=sys.stderr)


def check_names(ref):
    folders = tool_folders(committed_files(ref))
    problems = name_problems(folders)
    if problems:
        for problem in problems:
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::error::{problem}")
            print(f"FAILED: {problem}", file=sys.stderr)
        sys.exit(1)
    print(f"tool folder names are fine at {ref}: {', '.join(folders) or 'no tool folders'}")


def main():
    p = argparse.ArgumentParser(description="Check a release tag and write its notes and zip, "
                                            "or check every tool folder's name.")
    p.add_argument("tag", nargs="?", help="the release tag, for example example-tool-v1.2.0")
    p.add_argument("--notes", help="write the release notes to this file instead of standard output")
    p.add_argument("--zip", help="also zip the tool's folder into this file")
    p.add_argument("--ref", default="HEAD", help="the commit to read the tool from (default: HEAD)")
    p.add_argument("--check-names", action="store_true",
                   help="instead of a tag, check that no two tool folders share a name and every name "
                        "is lowercase words joined by hyphens")
    args = p.parse_args()

    if args.check_names:
        if args.tag or args.notes or args.zip:
            p.error("--check-names takes no tag, --notes or --zip")
        check_names(args.ref)
        return
    if not args.tag:
        p.error("give a release tag, or --check-names")

    tool, version = parse_tag(args.tag)
    files = committed_files(args.ref)
    folder = find_tool(tool, version, args.ref, files)
    notes = build_notes(tool, version, args.tag, args.ref, folder, files)
    if args.zip:
        build_zip(tool, args.ref, folder, args.zip)
    if args.notes:
        Path(args.notes).write_text(notes, encoding="utf-8")
        print(f"wrote the release notes to {args.notes}", file=sys.stderr)
    else:
        sys.stdout.write(notes)

    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as f:
            f.write(f"tool={tool}\nversion={version}\nfolder={folder}\n"
                    f"build={'true' if f'{folder}/build.ps1' in files else 'false'}\n")


if __name__ == "__main__":
    main()
