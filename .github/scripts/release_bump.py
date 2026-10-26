#!/usr/bin/env python3
"""
Finds the release tags that a push to main asks for: the tools whose README
version line went up between two commits. The release workflow
(.github/workflows/release.yml) runs it on every push to main, with the
folders of the tools that release on a version bump, and tags what it prints.
From the root of the repo:

    python .github/scripts/release_bump.py --before <old commit> --sha <new commit> apps/example-tool

For each folder it reads the version line of <folder>/README.md ("Version
X.Y.Z.", the same line release_notes.py reads) at both commits and compares
them as numbers, so 1.10.0 is above 1.9.0. When the new version is higher it
prints the tag <tool>-v<X.Y.Z> on a line of its own, where <tool> is the
folder's name. Nothing is printed when:
- the version is the same or lower (a revert),
- the old commit is all zeros (a new branch) or isn't in this clone (a force
  push), since there's nothing to compare with,
- the README has no version line at one of the two commits, for example
  because the tool is new in this push.
The reason for each folder goes to standard error. A tag that already exists
is not this script's business: the workflow checks for it before tagging.

Exits with status 1 and a FAILED message when two folders share a name, since
their tags would collide.
"""
import argparse
import re
import subprocess
import sys

VERSION_LINE = re.compile(r"^Version v?(\d+\.\d+\.\d+)\b", re.M)


def git(*args):
    r = subprocess.run(["git", "-c", "core.quotePath=false", *args], capture_output=True)
    return r.returncode, r.stdout.decode("utf-8", "replace")


def readme_version(commit, folder):
    """The README's version as a tuple of ints, or None if there's no README or version line."""
    code, text = git("show", f"{commit}:{folder.strip('/')}/README.md")
    if code != 0:
        return None
    m = VERSION_LINE.search(text)
    return tuple(int(n) for n in m.group(1).split(".")) if m else None


def bumped_tags(before, sha, folders, log=lambda msg: None):
    """The tags to release, one per folder whose version went up from `before` to `sha`."""
    if not before or set(before) == {"0"}:
        log("the old commit is all zeros (a new branch): nothing to compare with")
        return []
    if git("cat-file", "-e", f"{before}^{{commit}}")[0] != 0:
        log(f"the old commit {before} isn't in this clone (a force push?): nothing to compare with")
        return []
    tags = []
    for folder in folders:
        name = folder.strip("/").rpartition("/")[2]
        old, new = readme_version(before, folder), readme_version(sha, folder)
        if old is None or new is None:
            log(f"{folder}: no README version line at {'the old' if old is None else 'the new'} commit, no release")
        elif new > old:
            tags.append(f"{name}-v{'.'.join(map(str, new))}")
            log(f"{folder}: {'.'.join(map(str, old))} -> {'.'.join(map(str, new))}")
        else:
            log(f"{folder}: version {'.'.join(map(str, new))} is not above {'.'.join(map(str, old))}, no release")
    return tags


def main():
    p = argparse.ArgumentParser(description="Print the release tags for the tools whose README version went up.")
    p.add_argument("folders", nargs="+", help="tool folders that release when their version goes up, such as apps/example-tool")
    p.add_argument("--before", required=True, help="the commit before the push (github.event.before)")
    p.add_argument("--sha", required=True, help="the pushed commit")
    args = p.parse_args()
    names = [f.strip("/").rpartition("/")[2] for f in args.folders]
    if len(set(names)) != len(names):
        print("FAILED: two of the folders have the same name, so their tags would collide.", file=sys.stderr)
        sys.exit(1)
    for tag in bumped_tags(args.before, args.sha, args.folders, lambda msg: print(msg, file=sys.stderr)):
        print(tag)


if __name__ == "__main__":
    main()
