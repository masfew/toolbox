#!/usr/bin/env python3
"""
Installs the usage-rings mod for Claude Code from a clone of this repo. Safe to rerun.

    python install.py            install, or update an earlier install
    python install.py --remove   undo everything the install added

usage-rings is a Claude Code plugin, so this script hands the work to Claude
Code's own plugin commands rather than linking files under ~/.claude like the
other tools here. Without a clone, the README's one-line install
(/plugin install usage-rings --marketplace <owner>/toolbox) does the same.

What it does:
1. Checks that Python is new enough and finds the claude command.
2. Finds the repo's marketplace file (.claude-plugin/marketplace.json in a
   folder above this one), and adds that folder to Claude Code as the
   toolbox marketplace, unless a marketplace of that name is already there.
   One added from an older location of the clone is replaced.
3. Refreshes the marketplace, then installs usage-rings from it at the user
   scope, or updates it if it's already installed. Claude Code keeps its own
   copy under ~/.claude/plugins/cache, so this folder can move afterwards.

--remove uninstalls usage-rings, then removes the toolbox marketplace if
this script would have added it (it points at this clone) and no other plugin
from it is still installed.

Ends with "Setup complete" (or "Removed"), or exits with status 1 and a
FAILED message saying what to do.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TOOL_NAME = "usage-rings"
MIN_PYTHON = (3, 9)
MARKETPLACE = "toolbox"

# Programs the tool needs: (command, how to install it). claude is found by find_claude().
PROGRAMS = []

TOOL_DIR = Path(__file__).resolve().parent
MARKETPLACE_FILE = Path(".claude-plugin") / "marketplace.json"
# Claude Code names a plugin from a marketplace by the two names joined with an at sign.
FROM_MARKETPLACE = "@toolbox"
PLUGIN_ID = TOOL_NAME + FROM_MARKETPLACE


def fail(msg):
    print(f"\nFAILED: {msg}", file=sys.stderr)
    sys.exit(1)


# --- 1. Dependencies -------------------------------------------------------

def check_dependencies():
    if sys.version_info < MIN_PYTHON:
        need = ".".join(map(str, MIN_PYTHON))
        fail(f"Python {need} or newer is needed (this is {sys.version.split()[0]}). "
             "Get it from https://www.python.org/downloads/")
    missing = [(cmd, how) for cmd, how in PROGRAMS if not shutil.which(cmd)]
    if missing:
        fail("missing programs:\n" + "\n".join(f"  {cmd}: install with `{how}`, then open a new terminal"
                                                for cmd, how in missing))


def same_path(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def find_claude():
    found = shutil.which("claude")
    if found:
        return found
    # The native installer puts it here, which isn't always on PATH.
    local = Path.home() / ".local" / "bin" / ("claude.exe" if os.name == "nt" else "claude")
    if local.exists():
        return str(local)
    fail("can't find the claude command. Install Claude Code (https://claude.com/claude-code), "
         "open a new terminal, then rerun.")


def run(claude, *args):
    """Runs a claude command. Returns its exit code and output."""
    r = subprocess.run([claude, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout + r.stderr).strip()


def run_json(claude, *args):
    code, out = run(claude, *args, "--json")
    if code != 0:
        fail(f"`claude {' '.join(args)}` failed:\n{out}")
    try:
        return json.loads(out[out.find("["):]) if "[" in out else []
    except json.JSONDecodeError:
        fail(f"couldn't read the output of `claude {' '.join(args)} --json`:\n{out}")


# --- 2. The marketplace ----------------------------------------------------

def find_repo():
    """The folder above this one that holds the marketplace file listing this tool."""
    for folder in TOOL_DIR.parents:
        path = folder / MARKETPLACE_FILE
        if not path.is_file():
            continue
        try:
            listing = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            fail(f"{path} isn't valid JSON ({e}).")
        if any(p.get("name") == TOOL_NAME for p in listing.get("plugins", [])):
            return folder
        fail(f"{path} doesn't list {TOOL_NAME}. Add it to the plugins list there, then rerun.")
    fail(f"no {MARKETPLACE_FILE.as_posix()} in any folder above this one, so this isn't a clone of the "
         "repo (a release zip holds only this folder). Install with the one-line command in the README "
         "instead, or clone the repo and run this script from the clone.")


def find_marketplace(claude):
    return next((m for m in run_json(claude, "plugin", "marketplace", "list") if m.get("name") == MARKETPLACE),
                None)


def is_ours(marketplace, repo):
    """True if the marketplace is one this script adds: the clone at repo."""
    return marketplace.get("source") == "directory" and same_path(marketplace.get("path", ""), repo)


def add_marketplace(claude, repo):
    existing = find_marketplace(claude)
    if existing and is_ours(existing, repo):
        print(f"ok: the {MARKETPLACE} marketplace is this clone")
    elif existing and existing.get("source") == "directory" and not Path(existing.get("path", "")).exists():
        print(f"replacing the {MARKETPLACE} marketplace at {existing.get('path')}, which no longer exists")
        code, out = run(claude, "plugin", "marketplace", "remove", MARKETPLACE)
        if code != 0:
            fail(f"couldn't remove the old {MARKETPLACE} marketplace:\n{out}")
        existing = None
    elif existing:
        where = existing.get("repo") or existing.get("url") or existing.get("path")
        print(f"ok: using the {MARKETPLACE} marketplace you already have, from {where}")
    if not existing:
        code, out = run(claude, "plugin", "marketplace", "add", str(repo))
        if code != 0:
            fail(f"couldn't add {repo} as a marketplace:\n{out}")
        print(f"added {repo} as the {MARKETPLACE} marketplace")
    code, out = run(claude, "plugin", "marketplace", "update", MARKETPLACE)
    if code != 0:
        fail(f"couldn't refresh the {MARKETPLACE} marketplace:\n{out}")


# --- 3. The plugin ---------------------------------------------------------

def installed_plugins(claude):
    return [p for p in run_json(claude, "plugin", "list") if p.get("scope") == "user"]


def installed_version(claude):
    return next((p.get("version") for p in installed_plugins(claude) if p.get("id") == PLUGIN_ID), None)


# --- Install and remove ----------------------------------------------------

def install():
    # differs from the template: installs through Claude Code's plugin commands, which keep their own copy
    check_dependencies()
    claude = find_claude()
    repo = find_repo()
    add_marketplace(claude, repo)
    before = installed_version(claude)
    if before is None:
        code, out = run(claude, "plugin", "install", PLUGIN_ID, "--scope", "user")
    else:
        code, out = run(claude, "plugin", "update", PLUGIN_ID)
    if code != 0:
        fail(f"couldn't install {PLUGIN_ID}:\n{out}")
    after = installed_version(claude)
    if after is None:
        fail(f"Claude Code didn't report {PLUGIN_ID} as installed afterwards:\n{out}")
    if before is None:
        print(f"installed {PLUGIN_ID} {after}")
    elif before == after:
        print(f"ok: {PLUGIN_ID} {after} is already the latest")
    else:
        print(f"updated {PLUGIN_ID} from {before} to {after}")
    print(f"\nSetup complete. New Claude Code sessions show the rings. In a session that's already open, "
          "run /reload-plugins.")


def remove():
    # differs from the template: uninstalls through Claude Code's plugin commands
    claude = find_claude()
    if installed_version(claude) is None:
        print(f"ok: {PLUGIN_ID} isn't installed")
    else:
        code, out = run(claude, "plugin", "uninstall", PLUGIN_ID, "--scope", "user")
        if code != 0:
            fail(f"couldn't uninstall {PLUGIN_ID}:\n{out}")
        print(f"uninstalled {PLUGIN_ID}")
    marketplace = find_marketplace(claude)
    if marketplace:
        others = [p["id"] for p in installed_plugins(claude) if p.get("id", "").endswith(FROM_MARKETPLACE)]
        repo = next((f for f in TOOL_DIR.parents if (f / MARKETPLACE_FILE).is_file()), None)
        if others:
            print(f"left the {MARKETPLACE} marketplace: {', '.join(others)} still use it")
        elif repo and is_ours(marketplace, repo):
            code, out = run(claude, "plugin", "marketplace", "remove", MARKETPLACE)
            if code != 0:
                fail(f"couldn't remove the {MARKETPLACE} marketplace:\n{out}")
            print(f"removed the {MARKETPLACE} marketplace")
        else:
            print(f"left the {MARKETPLACE} marketplace: this script didn't add it. Remove it with "
                  f"`claude plugin marketplace remove {MARKETPLACE}` if you don't need it.")
    print(f"\nRemoved {TOOL_NAME}. Sessions that are already open keep the rings until they restart.")


def main():
    # differs from the template: a plugin has no --copy or --link choice, since Claude Code always copies it
    # claude prints ticks and other symbols a Windows console code page can't encode.
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
    p = argparse.ArgumentParser(description=f"Install or remove {TOOL_NAME}.")
    p.add_argument("--remove", action="store_true", help="undo everything the install added")
    args = p.parse_args()

    if args.remove:
        remove()
    else:
        install()


if __name__ == "__main__":
    main()
