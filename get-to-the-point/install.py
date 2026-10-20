#!/usr/bin/env python3
"""
Installs the Get to the Point output style for Claude Code and makes it the
default for new sessions. Safe to rerun.

    python install.py            install, or update an earlier install
    python install.py --copy     install a copy instead of a link
    python install.py --link     install a link even outside a git clone
    python install.py --remove   undo everything the install added

What it does:
1. Checks that Python is new enough.
2. Puts the tool at one fixed place, ~/.claude/tools/get-to-the-point, so
   nothing else depends on where this folder is.
   - In a git clone it links there (a directory junction on Windows, a
     symlink elsewhere), so a `git pull` updates the tool straight away.
   - Anywhere else (an unzipped release) it copies this folder there, so this
     folder can be deleted afterwards.
   --copy or --link overrides the choice.
3. Installs the style as ~/.claude/output-styles/get-to-the-point.md, a link
   to get-to-the-point.md in ~/.claude/tools/get-to-the-point where the system
   allows it, or a copy if not. It replaces an earlier link or copy, and backs
   up a file there that holds something else.
4. Sets "outputStyle": "Get to the Point" in ~/.claude/settings.json, which
   makes it the default for new sessions. It backs the file up first and
   leaves every other setting alone.
5. Saves what it installed, and the outputStyle it replaced, to
   ~/.claude/tools/get-to-the-point.install.json.

On a rerun it reads that record first, so a rerun from a moved or renamed
folder leaves nothing stale behind.

--remove undoes all of it, using the record (or, for an install made before
there was one, the style file this folder would add). If outputStyle still says
"Get to the Point", it goes back to what it was before the install, or is
removed so new sessions use Claude Code's default style. If it says anything
else, it's left alone.

Ends with "Setup complete" (or "Removed"), or exits with status 1 and a
FAILED message saying what to do.
"""
import argparse
import filecmp
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

TOOL_NAME = "get-to-the-point"
STYLE_NAME = "Get to the Point"  # must match `name:` in get-to-the-point.md
MIN_PYTHON = (3, 9)

# Files to install: path in this folder -> path under ~/.claude.
FILES = {"get-to-the-point.md": "output-styles/get-to-the-point.md"}

TOOL_DIR = Path(__file__).resolve().parent
CLAUDE_DIR = Path.home() / ".claude"
TOOLS_DIR = CLAUDE_DIR / "tools"
STABLE_DIR = TOOLS_DIR / TOOL_NAME
RECORD_FILE = TOOLS_DIR / f"{TOOL_NAME}.install.json"
RECORD_FORMAT = 1
SETTINGS_FILE = CLAUDE_DIR / "settings.json"
COPY_IGNORE = shutil.ignore_patterns(".git", "__pycache__", "*.pyc")


def fail(msg):
    print(f"\nFAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def backup(path):
    stamp = time.strftime('%Y%m%d-%H%M%S')
    copy, n = path.with_name(f"{path.name}.bak-{stamp}"), 1
    while copy.exists():  # never overwrite an earlier backup made in the same second
        n += 1
        copy = path.with_name(f"{path.name}.bak-{stamp}-{n}")
    if path.is_dir():
        shutil.copytree(path, copy)
    else:
        shutil.copy2(path, copy)
    print(f"backed up {path} -> {copy}")


# --- 1. Dependencies -------------------------------------------------------

def check_dependencies():
    if sys.version_info < MIN_PYTHON:
        need = ".".join(map(str, MIN_PYTHON))
        fail(f"Python {need} or newer is needed (this is {sys.version.split()[0]}). "
             "Get it from https://www.python.org/downloads/")


# --- Links -----------------------------------------------------------------

def exists(path):
    # True for a broken link too, such as one left pointing at a folder that moved.
    return os.path.lexists(path)


def is_link(path):
    if path.is_symlink():
        return True
    # A Windows directory junction. Python before 3.12 can't detect one directly.
    try:
        return getattr(os.lstat(path), "st_reparse_tag", 0) == stat.IO_REPARSE_TAG_MOUNT_POINT
    except OSError:
        return False


def same_path(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def links_to(path, src):
    """True if path is a link pointing straight at src (not through other links)."""
    if not is_link(path):
        return False
    try:
        target = os.readlink(path)
    except OSError:
        return False
    for prefix in ("\\\\?\\", "\\??\\"):  # how Windows marks a junction's target
        if target.startswith(prefix):
            target = target[len(prefix):]
    return same_path(os.path.join(os.path.dirname(path), target), src)


def remove_link(path):
    # Removes the link only: what it points to is untouched. Never shutil.rmtree a link.
    attrs = getattr(os.lstat(path), "st_file_attributes", 0)
    if os.name == "nt" and attrs & stat.FILE_ATTRIBUTE_DIRECTORY:
        os.rmdir(path)
    else:
        os.unlink(path)


def remove_path(path):
    if is_link(path):
        remove_link(path)
    elif path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def make_link(dst, src):
    try:
        if src.is_dir() and os.name == "nt":
            # A junction needs no admin rights or Developer Mode.
            r = subprocess.run(["cmd", "/c", "mklink", "/J", str(dst), str(src)], capture_output=True, text=True)
            return r.returncode == 0
        dst.symlink_to(src, target_is_directory=src.is_dir())
        return True
    except OSError:
        return False


def same_content(path, src):
    if src.is_dir():
        if not path.is_dir():
            return False
        cmp = filecmp.dircmp(src, path)
        return not (cmp.left_only or cmp.right_only or cmp.diff_files or cmp.funny_files) and all(
            same_content(path / d, src / d) for d in cmp.common_dirs)
    return path.is_file() and filecmp.cmp(path, src, shallow=False)


# --- 2. The tool's fixed place ---------------------------------------------

def in_git_clone():
    return any((d / ".git").exists() for d in TOOL_DIR.parents)


def is_installed_copy(path):
    """True if path is a real folder holding a copy of this tool, made by an install."""
    script = path / "install.py"
    return (not is_link(path) and script.is_file()
            and f'TOOL_NAME = "{TOOL_NAME}"' in script.read_text(encoding="utf-8"))


def clear_stable_dir():
    if not exists(STABLE_DIR):
        return
    if is_link(STABLE_DIR):
        remove_link(STABLE_DIR)
    elif is_installed_copy(STABLE_DIR):
        shutil.rmtree(STABLE_DIR)
    else:
        fail(f"{STABLE_DIR} exists but isn't this tool. Move it elsewhere, then rerun.")


def install_stable_dir(mode):
    """Puts the tool at STABLE_DIR, as a link or a copy. Returns the mode it used."""
    if mode == "link" and links_to(STABLE_DIR, TOOL_DIR):
        print(f"ok: {STABLE_DIR} already links to {TOOL_DIR}")
        return "link"
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    if mode == "link":
        clear_stable_dir()
        if make_link(STABLE_DIR, TOOL_DIR):
            print(f"linked {STABLE_DIR} -> {TOOL_DIR}")
            return "link"
        print("The system didn't allow a link, so the tool is copied instead. "
              "Rerun this script after each update.")
    # Copy next to it first, so a failed copy leaves the earlier install working.
    new = STABLE_DIR.with_name(f"{STABLE_DIR.name}.new")
    if exists(new):
        remove_path(new)  # left by an interrupted install
    shutil.copytree(TOOL_DIR, new, ignore=COPY_IGNORE)
    clear_stable_dir()
    new.rename(STABLE_DIR)
    print(f"copied {TOOL_DIR} -> {STABLE_DIR}")
    return "copy"


def remove_stable_dir():
    if not exists(STABLE_DIR):
        return
    if is_link(STABLE_DIR):
        remove_link(STABLE_DIR)
        print(f"removed the link {STABLE_DIR} (the folder it pointed to is untouched)")
    elif is_installed_copy(STABLE_DIR):
        try:
            shutil.rmtree(STABLE_DIR)
            print(f"removed {STABLE_DIR}")
        except OSError as e:
            print(f"couldn't delete {STABLE_DIR} ({e}). Close anything using it, such as a "
                  "terminal open in it, then delete it yourself.")
    else:
        print(f"left {STABLE_DIR} alone: it isn't this tool")


# --- 3. Files --------------------------------------------------------------

def make_parents(path):
    """Creates path's missing parent folders. Returns the ones it created, relative to ~/.claude."""
    made = [p for p in path.parents if p != CLAUDE_DIR and CLAUDE_DIR in p.parents and not exists(p)]
    path.parent.mkdir(parents=True, exist_ok=True)
    return [p.relative_to(CLAUDE_DIR).as_posix() for p in made]


def remove_empty_dirs(dirs):
    for rel in sorted(dirs, key=lambda d: d.count("/"), reverse=True):  # deepest first
        try:
            (CLAUDE_DIR / rel).rmdir()  # only if empty
        except OSError:
            pass


def is_style_copy(path):
    """True for a copy of this style from an earlier version, which needs no backup."""
    try:
        head = path.read_text(encoding="utf-8")[:300]
    except (OSError, UnicodeDecodeError):
        return False
    return f"name: {STYLE_NAME}\n" in head.replace("\r\n", "\n")


def install_file(rel_src, rel_dst):
    """Links (or copies) STABLE_DIR/rel_src to ~/.claude/rel_dst.
    Returns "link" or "copy", and the parent folders it had to create."""
    src, dst = STABLE_DIR / rel_src, CLAUDE_DIR / rel_dst
    if not (TOOL_DIR / rel_src).exists():
        fail(f"{TOOL_DIR / rel_src} is missing. Is this the complete {TOOL_NAME} folder?")
    if links_to(dst, src):
        print(f"ok: {dst} already links to {src}")
        return "link", []
    made = make_parents(dst)
    if exists(dst):
        if not is_link(dst) and not same_content(dst, src) and not is_style_copy(dst):
            backup(dst)
        remove_path(dst)
    if make_link(dst, src):
        print(f"linked {dst} -> {src}")
        return "link", made
    if src.is_dir():
        shutil.copytree(src, dst, ignore=COPY_IGNORE)
    else:
        shutil.copy2(src, dst)
    print(f"copied {src} -> {dst}")
    print("  The system didn't allow a link, so rerun this script after each update.")
    if os.name == "nt":
        print("  Turning on Windows Developer Mode and rerunning makes it a link.")
    return "copy", made


def remove_file(rel_dst, rel_src, old_source=None, made_dirs=()):
    """Removes ~/.claude/rel_dst if it's this tool's link or copy of rel_src,
    then the parent folders the install created for it, if they're empty."""
    dst = CLAUDE_DIR / rel_dst
    if not exists(dst):
        remove_empty_dirs(made_dirs)
        return
    sources = [STABLE_DIR / rel_src, TOOL_DIR / rel_src]
    if old_source:
        sources.append(Path(old_source) / rel_src)
    # A copy that differs from the source can still be this style: one made before a
    # `git pull` changed the source, when the system didn't allow a link.
    if any(links_to(dst, s) for s in sources) or (not is_link(dst) and (
            is_style_copy(dst) or any(s.exists() and same_content(dst, s) for s in sources))):
        remove_path(dst)
        print(f"removed {dst}")
        remove_empty_dirs(made_dirs)
    else:
        print(f"left {dst} alone: it isn't this tool's link or copy")


# --- 4. Settings -----------------------------------------------------------

def load_settings():
    if not SETTINGS_FILE.exists():
        return {}
    try:
        settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{SETTINGS_FILE} isn't valid JSON ({e}). Fix it, then rerun.")
    if not isinstance(settings, dict):
        fail(f"{SETTINGS_FILE} doesn't hold a JSON object. Fix it, then rerun.")
    return settings


def save_settings(settings):
    if SETTINGS_FILE.exists():
        backup(SETTINGS_FILE)
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def set_output_style(old_record):
    """Makes this style the default. Returns the outputStyle it replaced (None if there
    wasn't one) and whether this tool's installs created settings.json."""
    old = old_record or {}
    previous, created = old.get("previous_output_style"), bool(old.get("settings_created"))
    settings = load_settings()
    current = settings.get("outputStyle")
    if current == STYLE_NAME:
        print(f'ok: outputStyle is already "{STYLE_NAME}"')
        return previous, created
    created = created or not SETTINGS_FILE.exists()
    settings["outputStyle"] = STYLE_NAME
    save_settings(settings)
    if current:
        print(f'changed outputStyle in settings.json from "{current}" to "{STYLE_NAME}"')
    else:
        print(f'set outputStyle in settings.json to "{STYLE_NAME}"')
    return current, created


def clear_output_style(previous, settings_created):
    if not SETTINGS_FILE.exists():
        return
    settings = load_settings()
    current = settings.get("outputStyle")
    if current != STYLE_NAME:
        if current:
            print(f'left outputStyle as "{current}": it no longer says "{STYLE_NAME}"')
        return
    if previous:
        settings["outputStyle"] = previous
        print(f'set outputStyle back to "{previous}", as it was before the install')
    else:
        del settings["outputStyle"]
        print("removed outputStyle from settings.json, so new sessions use Claude Code's default style")
    if settings_created and not settings:
        # The install made settings.json and nothing else is in it now.
        SETTINGS_FILE.unlink()
        print(f"removed {SETTINGS_FILE}: the install created it, and it's empty now")
    else:
        save_settings(settings)


# --- 5. Install record -----------------------------------------------------

def read_record():
    if not RECORD_FILE.exists():
        return None
    try:
        record = json.loads(RECORD_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{RECORD_FILE} isn't valid JSON ({e}). Delete it, then rerun.")
    if record.get("format", 0) > RECORD_FORMAT:
        fail(f"{RECORD_FILE} was written by a newer version of this installer. "
             "Run install.py from that version instead.")
    return record


def write_record(mode, files, previous, settings_created):
    record = {
        "format": RECORD_FORMAT,
        "tool": TOOL_NAME,
        "source": str(TOOL_DIR),
        "mode": mode,
        "files": files,
        "previous_output_style": previous,
        "settings_created": settings_created,
    }
    RECORD_FILE.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


# --- Install and remove ----------------------------------------------------

def install(mode):
    if not is_link(STABLE_DIR) and same_path(os.path.realpath(STABLE_DIR), TOOL_DIR):
        fail(f"this is the installed copy at {STABLE_DIR}. Run install.py from the tool's own "
             "folder (a clone or an unzipped release) instead. To uninstall, run it here with --remove.")
    check_dependencies()
    old = read_record()
    load_settings()  # stop before changing anything if settings.json is broken
    if old and not same_path(old.get("source", ""), TOOL_DIR):
        print(f"moving the install from {old.get('source')} to {TOOL_DIR}")

    mode = install_stable_dir(mode)
    old_files = {f["path"]: f for f in (old or {}).get("files", [])}
    files = []
    for rel_src, rel_dst in FILES.items():
        path = Path(rel_dst).as_posix()
        kind, made = install_file(rel_src, rel_dst)
        # Keep the folders an earlier install created, so --remove still takes them out.
        made = sorted(set(made) | set(old_files.get(path, {}).get("dirs", [])))
        files.append({"path": path, "from": Path(rel_src).as_posix(), "kind": kind, "dirs": made})
    previous, settings_created = set_output_style(old)
    write_record(mode, files, previous, settings_created)
    print(f'\nSetup complete. New Claude Code sessions use the "{STYLE_NAME}" output style.')
    if mode == "copy":
        print(f"The tool was copied to {STABLE_DIR}, so this folder can be deleted.")


def remove():
    os.chdir(Path.home())  # so this script's own folder can be deleted if it's the installed copy
    record = read_record()
    if record:
        for f in record.get("files", []):
            remove_file(f["path"], f["from"], record.get("source"), f.get("dirs", []))
        clear_output_style(record.get("previous_output_style"), record.get("settings_created"))
    else:
        # An install from before the install record.
        for rel_src, rel_dst in FILES.items():
            remove_file(rel_dst, rel_src)
        clear_output_style(None, False)
    remove_stable_dir()
    if RECORD_FILE.exists():
        RECORD_FILE.unlink()
    try:
        TOOLS_DIR.rmdir()  # only if no other tool is installed there
    except OSError:
        pass
    print(f"\nRemoved {TOOL_NAME}.")


def main():
    p = argparse.ArgumentParser(description=f"Install or remove {TOOL_NAME}.")
    action = p.add_mutually_exclusive_group()
    action.add_argument("--copy", action="store_const", const="copy", dest="action",
                        help="copy the tool into ~/.claude/tools instead of linking it")
    action.add_argument("--link", action="store_const", const="link", dest="action",
                        help="link ~/.claude/tools to this folder, even outside a git clone")
    action.add_argument("--remove", action="store_const", const="remove", dest="action",
                        help="undo everything the install added")
    args = p.parse_args()

    if args.action == "remove":
        remove()
    else:
        install(args.action or ("link" if in_git_clone() else "copy"))


if __name__ == "__main__":
    main()
