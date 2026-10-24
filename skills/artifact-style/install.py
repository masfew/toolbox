#!/usr/bin/env python3
"""
Installs the artifact-style skill for Claude Code. Safe to rerun.

    python install.py                    install, or update an earlier install
    python install.py --copy             install a copy instead of a link
    python install.py --link             install a link even outside a git clone
    python install.py --remove           undo everything the install added
    python install.py --instructions     add the CLAUDE.md lines without asking
    python install.py --no-instructions  leave the CLAUDE.md lines out (or take them out)

What it does:
1. Checks that Python is new enough.
2. Puts the tool at one fixed place, ~/.claude/tools/artifact-style, so nothing
   else depends on where this folder is.
   - In a git clone it links there (a directory junction on Windows, a
     symlink elsewhere), so a `git pull` updates the tool straight away.
   - Anywhere else (an unzipped release) it copies this folder there, so this
     folder can be deleted afterwards.
   --copy or --link overrides the choice.
3. Installs the skill as ~/.claude/skills/artifact-style, a link to the skill
   folder in ~/.claude/tools/artifact-style where the system allows it, or a
   copy if not.
4. Adds two lines to ~/.claude/CLAUDE.md, between marker lines, telling every
   session to load the skill before writing an Artifact page, after showing
   them and asking. --instructions and --no-instructions answer ahead of
   time. With no terminal to ask in (as when Claude Code runs the install)
   and neither flag, it leaves them out and prints the command that adds them.
5. Saves what it installed to ~/.claude/tools/artifact-style.install.json.

On a rerun it reads that record first and takes out whatever the earlier
install added that this one doesn't, so a rerun from a moved or renamed
folder leaves nothing stale behind.

--remove undoes all of it, using the record (or, for an install made before
there was one, the skill this folder would add).

Ends with "Setup complete" (or "Removed"), or exits with status 1 and a
FAILED message saying what to do.
"""
import argparse
import base64
import filecmp
import glob
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

TOOL_NAME = "artifact-style"
MIN_PYTHON = (3, 9)

# Files and folders to install: path in this folder -> path under ~/.claude.
# Example: {"my-style.md": "output-styles/my-style.md", "skill": "skills/my-skill"}
FILES = {"skill": "skills/artifact-style"}

# Hooks to add to settings.json: (event, matcher or None, command).
# {tool} in the command becomes ~/.claude/tools/<tool-name> as a full path, so
# the hook keeps working wherever this folder is, even after it moves.
# Example: ("Stop", None, 'python "{tool}/hook.py"')
HOOKS = []

# Programs the tool needs: (command, how to install it).
# Example: ("gitleaks", "winget install Gitleaks.Gitleaks")
PROGRAMS = []

# Windows only. Background programs to start at sign-in: (shortcut name, script
# in this folder, arguments). Each runs with pythonw, with no window, through
# ~/.claude/tools/<tool-name>, and the install starts it straight away.
# Example: ("Example Tool helper", "helper.py", ["run", "--at-login"])
STARTUP = []

# True if the tool writes under AppData itself, so the install has to run
# outside the Claude desktop app's package (STARTUP needs it too, always).
NEEDS_REAL_APPDATA = False

# Text to add to ~/.claude/CLAUDE.md, which every Claude Code session loads,
# between marker lines. Keep it to a few lines that say when to use the tool.
# Example: "- Before writing any plan, load the example-tool skill."
INSTRUCTIONS = (
    "- Before writing any HTML Artifact page by hand that isn't a plan made with better-plans,\n"
    "  load the artifact-style skill along with artifact-design, and follow it for every colour and font."
)

# Steps only the person can do, listed after "Setup complete": accounts,
# secrets typed into a hidden prompt, clicks in other apps. Keep each one a
# single instruction that says where to do it.
# Example: "Open Example App's settings and turn on Allow plugins."
HUMAN_STEPS = []

TOOL_DIR = Path(__file__).resolve().parent
CLAUDE_DIR = Path.home() / ".claude"
TOOLS_DIR = CLAUDE_DIR / "tools"
STABLE_DIR = TOOLS_DIR / TOOL_NAME
RECORD_FILE = TOOLS_DIR / f"{TOOL_NAME}.install.json"
RECORD_FORMAT = 1
SETTINGS_FILE = CLAUDE_DIR / "settings.json"
CONFIG_EXAMPLE = TOOL_DIR / "config.example.json"
CONFIG_FILE = CLAUDE_DIR / f"{TOOL_NAME}.json"
CLAUDE_MD = CLAUDE_DIR / "CLAUDE.md"
BLOCK_START = f"<!-- {TOOL_NAME}: start of the lines its install.py added. `python install.py --remove` takes them out. -->"
BLOCK_END = f"<!-- {TOOL_NAME}: end -->"
OUTSIDE_PACKAGE = "TOOLBOX_INSTALL_OUTSIDE_PACKAGE"  # set on the rerun outside the app's package
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


def powershell(script):
    """Runs a Windows PowerShell script and returns the finished process."""
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                           "-Command", script], capture_output=True, text=True)


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


# --- 0. Outside the Claude app's package -----------------------------------

def in_app_package():
    """True if Windows redirects this process's AppData writes into a packaged
    app's private folder, as it does for anything the Claude desktop app starts.
    Such a process doesn't report a package identity, so this writes a probe
    file and looks for where it landed."""
    local = os.environ.get("LOCALAPPDATA")
    if os.name != "nt" or not local or os.environ.get(OUTSIDE_PACKAGE):
        return False
    probe = Path(local) / f"{TOOL_NAME}-probe-{uuid.uuid4().hex}"
    try:
        probe.write_text("", encoding="utf-8")
    except OSError:
        return False
    try:
        return bool(glob.glob(os.path.join(local, "Packages", "*", "LocalCache", "Local", probe.name)))
    finally:
        try:
            probe.unlink()
        except OSError:
            pass


def rerun_outside_app_package(argv):
    """Runs this script again with argv, outside the app's package, then prints
    its output and exits with its status. Windows starts a process created
    through WMI outside the package. That process gets the user's default
    environment, so the overrides that decide where things go are passed on."""
    print("Running the install outside the Claude app's package, so it reaches the real AppData folders...")
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)  # ~/.claude isn't under AppData, so both processes see it
    run_id = uuid.uuid4().hex
    log = TOOLS_DIR / f"{TOOL_NAME}.install-output-{run_id}.txt"
    code = TOOLS_DIR / f"{TOOL_NAME}.install-status-{run_id}.txt"
    env = "".join(f"$env:{name} = {ps_quote(os.environ[name])}; "
                  for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "PATH")
                  if name in os.environ)
    # The rerun writes its own output to the log (see main), since Windows
    # PowerShell would write it as UTF-16 and mangle what goes to stderr.
    inner = (f"{env}$env:{OUTSIDE_PACKAGE} = {ps_quote(log)}; "
             f"& {ps_quote(sys.executable)} {ps_quote(Path(__file__).resolve())} "
             + " ".join(ps_quote(a) for a in argv)
             + f"; Set-Content -LiteralPath {ps_quote(code)} -Value $LASTEXITCODE")
    encoded = base64.b64encode(inner.encode("utf-16-le")).decode("ascii")
    command = (f"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden "
               f"-EncodedCommand {encoded}")
    started = powershell(f"$p = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList {ps_quote(command)}; "
                         "if ($p.ReturnValue -ne 0) { Write-Output \"failed $($p.ReturnValue)\"; exit 1 }; "
                         "Wait-Process -Id $p.ProcessId -ErrorAction SilentlyContinue")
    try:
        if started.returncode != 0:
            fail(f"couldn't start the install outside the Claude app's package ({started.stdout.strip()}"
                 f"{started.stderr.strip()}). Run `python install.py` in a terminal outside the Claude app instead.")
        if log.exists():
            print(log.read_text(encoding="utf-8", errors="replace"), end="")
        status = code.read_text(encoding="utf-8-sig").strip() if code.exists() else ""
    finally:
        for path in (log, code):
            try:
                path.unlink()
            except OSError:
                pass
        try:
            TOOLS_DIR.rmdir()  # a --remove left it in place while the log was open in it
        except OSError:
            pass
    sys.exit(int(status) if status.lstrip("-").isdigit() else 1)


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


def is_empty_dir(path):
    """True if path is a real, empty folder, such as one left when --remove couldn't delete it."""
    return not is_link(path) and path.is_dir() and not any(path.iterdir())


def clear_stable_dir():
    if not exists(STABLE_DIR):
        return
    if is_link(STABLE_DIR):
        remove_link(STABLE_DIR)
    elif is_installed_copy(STABLE_DIR):
        shutil.rmtree(STABLE_DIR)
    elif is_empty_dir(STABLE_DIR):
        try:
            os.rmdir(STABLE_DIR)
        except OSError as e:
            fail(f"couldn't delete the empty folder {STABLE_DIR} ({e}). Close anything using it, "
                 "such as a terminal open in it, then rerun.")
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
    elif is_empty_dir(STABLE_DIR):
        try:
            os.rmdir(STABLE_DIR)
            print(f"removed the empty folder {STABLE_DIR}")
        except OSError as e:
            print(f"couldn't delete the empty folder {STABLE_DIR} ({e}). Close anything using it, "
                  "such as a terminal open in it, then delete it yourself.")
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
        if not is_link(dst) and not same_content(dst, src):
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
    if os.name == "nt" and src.is_file():
        # Folders use junctions, which need no Developer Mode; file links do.
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
    if any(links_to(dst, s) for s in sources) or (
            not is_link(dst) and any(s.exists() and same_content(dst, s) for s in sources)):
        remove_path(dst)
        print(f"removed {dst}")
        remove_empty_dirs(made_dirs)
    else:
        print(f"left {dst} alone: it isn't this tool's link or copy")


# --- 4. Settings -----------------------------------------------------------

def hook_entries():
    """HOOKS as this install adds them, with {tool} pointing at STABLE_DIR."""
    return [{"event": event, "matcher": matcher, "command": command.replace("{tool}", STABLE_DIR.as_posix())}
            for event, matcher, command in HOOKS]


def legacy_hooks():
    """HOOKS as an install from before the install record added them, with {tool} pointing at this folder."""
    return [(event, command.replace("{tool}", TOOL_DIR.as_posix())) for event, _matcher, command in HOOKS]


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


def has_command(groups, command):
    return any(h.get("command") == command for g in groups for h in g.get("hooks", []))


def drop_hook(settings, event, command):
    """Takes every hook running exactly this command out of the event. Returns True if any was there."""
    all_hooks = settings.get("hooks", {})
    groups = all_hooks.get(event, [])
    if not has_command(groups, command):
        return False
    for g in groups:
        g["hooks"] = [h for h in g.get("hooks", []) if h.get("command") != command]
    all_hooks[event] = [g for g in groups if g["hooks"]]
    if not all_hooks[event]:
        del all_hooks[event]
    if not all_hooks:
        settings.pop("hooks", None)
    print(f"removed the {event} hook from settings.json: {command}")
    return True


def update_hooks(old_record):
    """Takes out the earlier install's hooks that this one doesn't add, then adds HOOKS.
    Returns whether this tool's installs created settings.json."""
    created = bool(old_record and old_record.get("settings_created"))
    new = hook_entries()
    keep = {(h["event"], h["command"]) for h in new}
    if old_record:
        stale = [(h["event"], h["command"]) for h in old_record.get("hooks", [])]
    else:
        stale = legacy_hooks()
    stale = [s for s in stale if s not in keep]
    if not new and not stale:
        return created
    settings = load_settings()
    changed = False
    for event, command in stale:
        changed |= drop_hook(settings, event, command)
    for h in new:
        groups = settings.setdefault("hooks", {}).setdefault(h["event"], [])
        if has_command(groups, h["command"]):
            print(f"ok: the {h['event']} hook is already in settings.json")
            continue
        group = {"matcher": h["matcher"]} if h["matcher"] else {}
        group["hooks"] = [{"type": "command", "command": h["command"]}]
        groups.append(group)
        changed = True
        print(f"added the {h['event']} hook to settings.json")
    if changed:
        created = created or not SETTINGS_FILE.exists()
        save_settings(settings)
    return created


def remove_hooks(commands, settings_created):
    if not commands or not SETTINGS_FILE.exists():
        return
    settings = load_settings()
    changed = False
    for event, command in commands:
        changed |= drop_hook(settings, event, command)
    if not changed:
        return
    if settings_created and not settings:
        # The install made settings.json and nothing else is in it now.
        SETTINGS_FILE.unlink()
        print(f"removed {SETTINGS_FILE}: the install created it, and it's empty now")
    else:
        save_settings(settings)


# --- 5. Personal config ----------------------------------------------------

def create_config():
    if not CONFIG_EXAMPLE.exists():
        return
    if CONFIG_FILE.exists():
        print(f"ok: keeping your config at {CONFIG_FILE}")
        return
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CONFIG_EXAMPLE, CONFIG_FILE)
    print(f"created {CONFIG_FILE} from config.example.json")
    print("  Replace its placeholder values with your own before using the tool.")


# --- 6. Startup entries and background processes ---------------------------

def startup_dir():
    return Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def pythonw():
    """pythonw.exe, which runs a script with no window. The Python install
    manager's alias survives Python upgrades; a versioned install folder doesn't."""
    alias = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WindowsApps" / "pythonw.exe"
    if alias.exists():
        return alias
    sibling = Path(sys.executable).with_name("pythonw.exe")
    return sibling if sibling.exists() else Path(sys.executable)


def stop_processes():
    """Stops every Python process running a script from STABLE_DIR or this
    folder, other than this install, so its files can be replaced or removed."""
    if os.name != "nt":
        return
    r = powershell("Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | "
                   "Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress")
    try:
        found = json.loads(r.stdout) if r.stdout.strip() else []
    except json.JSONDecodeError:
        found = []
    if isinstance(found, dict):
        found = [found]
    folders = [os.path.normcase(str(d)).replace("/", "\\") for d in (STABLE_DIR, TOOL_DIR)]
    for proc in found:
        line = os.path.normcase(proc.get("CommandLine") or "").replace("/", "\\")
        pid = proc.get("ProcessId")
        if pid in (os.getpid(), os.getppid()) or "install.py" in line or not any(f in line for f in folders):
            continue
        if powershell(f"Stop-Process -Id {int(pid)} -Force").returncode == 0:
            print(f"stopped the running {TOOL_NAME} process {pid}")


# Background programs run from ~/.claude, not from the tool's folder: a running
# program's working folder can't be moved or renamed on Windows, so a git pull
# or a move of the clone would fail while it runs.

def make_shortcut(link, target, script, arguments, description):
    ps = ("$s = (New-Object -ComObject WScript.Shell).CreateShortcut({link}); "
          "$s.TargetPath = {target}; $s.Arguments = {args}; $s.WorkingDirectory = {cwd}; "
          "$s.Description = {desc}; $s.Save()").format(
        link=ps_quote(link), target=ps_quote(target), cwd=ps_quote(CLAUDE_DIR), desc=ps_quote(description),
        args=ps_quote(subprocess.list2cmdline([str(script), *arguments])))
    r = powershell(ps)
    if r.returncode != 0:
        fail(f"couldn't create the Startup shortcut {link} ({r.stderr.strip()}).")


def start_detached(target, script, arguments):
    subprocess.Popen([str(target), str(script), *arguments], cwd=str(CLAUDE_DIR),
                     creationflags=0x00000008 | 0x00000200,  # DETACHED_PROCESS, CREATE_NEW_PROCESS_GROUP
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def remove_startup(links):
    for link in map(Path, links):
        if exists(link):
            link.unlink()
            print(f"removed the Startup shortcut {link}")


def install_startup(old_record):
    """Adds a Startup shortcut for each entry in STARTUP and starts it, and takes
    out the earlier install's shortcuts that this one doesn't add. Returns the
    shortcuts' paths."""
    old = (old_record or {}).get("startup", [])
    links = []
    if STARTUP and os.name != "nt":
        print("skipped the Startup shortcuts, which are for Windows only. Start these yourself: "
              + ", ".join(f"python {STABLE_DIR / script} {' '.join(arguments)}".strip()
                          for _name, script, arguments in STARTUP))
    elif STARTUP:
        target = pythonw()
        startup_dir().mkdir(parents=True, exist_ok=True)
        for name, script, arguments in STARTUP:
            if not (TOOL_DIR / script).is_file():
                fail(f"{TOOL_DIR / script} is missing. Is this the complete {TOOL_NAME} folder?")
            link = startup_dir() / f"{name}.lnk"
            make_shortcut(link, target, STABLE_DIR / script, arguments, name)
            start_detached(target, STABLE_DIR / script, arguments)
            links.append(str(link))
            print(f"added the Startup shortcut {link}, and started it")
    remove_startup(p for p in old if not any(same_path(p, link) for link in links))
    return links


# --- 7. CLAUDE.md block ----------------------------------------------------

def instructions_block():
    return f"{BLOCK_START}\n{INSTRUCTIONS.strip()}\n{BLOCK_END}"


def find_block(text):
    """The (start, end) of this tool's block in text, or None."""
    start = text.find(BLOCK_START)
    end = text.find(BLOCK_END, start)
    return (start, end + len(BLOCK_END)) if start >= 0 and end >= 0 else None


def read_claude_md():
    return CLAUDE_MD.read_text(encoding="utf-8") if CLAUDE_MD.exists() else ""


def ask_instructions():
    """Shows the block and asks whether to add it. Returns True or False, or None
    when there's no terminal to ask in."""
    if not sys.stdin.isatty():
        return None
    print(f"\n{TOOL_NAME} can add these lines to {CLAUDE_MD}, which every Claude Code session loads:\n")
    print("    " + INSTRUCTIONS.strip().replace("\n", "\n    "))
    return input("\nAdd them? [Y/n] ").strip().lower() not in ("n", "no")


def write_claude_md(text):
    if CLAUDE_MD.exists():
        backup(CLAUDE_MD)
    CLAUDE_MD.parent.mkdir(parents=True, exist_ok=True)
    CLAUDE_MD.write_text(text, encoding="utf-8")


def drop_block(text, span):
    before, after = text[:span[0]].rstrip("\n"), text[span[1]:].lstrip("\n")
    return before + ("\n\n" if before and after else "\n" if before else "") + after


def update_instructions(choice, old_record):
    """Adds, refreshes or takes out the block as choice says (None: keep what's
    there). Returns whether the block is in CLAUDE.md, and whether the tool's
    installs created CLAUDE.md."""
    created = bool(old_record and old_record.get("claude_md_created"))
    if not INSTRUCTIONS:
        return False, created
    text = read_claude_md()
    span = find_block(text)
    if choice is False:
        if span:
            write_claude_md(drop_block(text, span))
            print(f"took this tool's lines out of {CLAUDE_MD} (--no-instructions)")
        return False, created
    if span:
        if text[span[0]:span[1]] == instructions_block():
            print(f"ok: this tool's lines are already in {CLAUDE_MD}")
        else:
            write_claude_md(text[:span[0]] + instructions_block() + text[span[1]:])
            print(f"updated this tool's lines in {CLAUDE_MD}")
        return True, created
    if choice is None:
        print(f"left this tool's lines out of {CLAUDE_MD}, since there was no terminal to ask in. "
              "To add them, rerun with --instructions.")
        return False, created
    created = created or not CLAUDE_MD.exists()
    write_claude_md(text.rstrip("\n") + ("\n\n" if text.strip() else "") + instructions_block() + "\n")
    print(f"added this tool's lines to {CLAUDE_MD}")
    return True, created


def remove_instructions(claude_md_created):
    text = read_claude_md()
    span = find_block(text)
    if not span:
        return
    text = drop_block(text, span)
    if claude_md_created and not text.strip():
        CLAUDE_MD.unlink()
        print(f"removed {CLAUDE_MD}: the install created it, and it's empty now")
    else:
        write_claude_md(text)
        print(f"took this tool's lines out of {CLAUDE_MD}")


# --- 8. Install record -----------------------------------------------------

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


def write_record(mode, files, settings_created, startup, instructions, claude_md_created):
    record = {
        "format": RECORD_FORMAT,
        "tool": TOOL_NAME,
        "source": str(TOOL_DIR),
        "mode": mode,
        "files": files,
        "hooks": hook_entries(),
        "settings_created": settings_created,
        "startup": startup,
        "instructions": instructions,
        "claude_md_created": claude_md_created,
    }
    RECORD_FILE.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


# --- 9. Steps for the person -----------------------------------------------

def print_human_steps():
    if HUMAN_STEPS:
        print("\nStill to do yourself, one at a time:")
        for n, text in enumerate(HUMAN_STEPS, 1):
            print(f"  {n}. {text}")


# --- Install and remove ----------------------------------------------------

def install(mode, instructions=None):
    if not is_link(STABLE_DIR) and same_path(os.path.realpath(STABLE_DIR), TOOL_DIR):
        fail(f"this is the installed copy at {STABLE_DIR}. Run install.py from the tool's own "
             "folder (a clone or an unzipped release) instead. To uninstall, run it here with --remove.")
    check_dependencies()
    old = read_record()
    if HOOKS or (old and old.get("hooks")):
        load_settings()  # stop before changing anything if settings.json is broken
    if old and not same_path(old.get("source", ""), TOOL_DIR):
        print(f"moving the install from {old.get('source')} to {TOOL_DIR}")
    if STARTUP or (old and old.get("startup")):
        stop_processes()  # a running copy would keep its files and folder in use

    mode = install_stable_dir(mode)
    old_files = {f["path"]: f for f in (old or {}).get("files", [])}
    files = []
    for rel_src, rel_dst in FILES.items():
        path = Path(rel_dst).as_posix()
        kind, made = install_file(rel_src, rel_dst)
        # Keep the folders an earlier install created, so --remove still takes them out.
        made = sorted(set(made) | set(old_files.get(path, {}).get("dirs", [])))
        files.append({"path": path, "from": Path(rel_src).as_posix(), "kind": kind, "dirs": made})
    installed = {f["path"] for f in files}
    for path, old_file in old_files.items():
        if path not in installed:
            remove_file(path, old_file["from"], old.get("source"), old_file.get("dirs", []))
    settings_created = update_hooks(old)
    create_config()
    startup = install_startup(old)
    in_claude_md, claude_md_created = update_instructions(instructions, old)
    write_record(mode, files, settings_created, startup, in_claude_md, claude_md_created)
    print("\nSetup complete." + (f" Start a new Claude Code session to use {TOOL_NAME}."
                                 if FILES or HOOKS or INSTRUCTIONS else ""))
    if mode == "copy":
        print(f"The tool was copied to {STABLE_DIR}, so this folder can be deleted.")
    print_human_steps()


def remove():
    os.chdir(Path.home())  # so this script's own folder can be deleted if it's the installed copy
    record = read_record()
    if STARTUP or (record and record.get("startup")):
        stop_processes()
    if record:
        for f in record.get("files", []):
            remove_file(f["path"], f["from"], record.get("source"), f.get("dirs", []))
        remove_hooks([(h["event"], h["command"]) for h in record.get("hooks", [])],
                     record.get("settings_created"))
        remove_startup(record.get("startup", []))
    else:
        # An install from before the install record.
        for rel_src, rel_dst in FILES.items():
            remove_file(rel_dst, rel_src)
        remove_hooks(legacy_hooks() + [(h["event"], h["command"]) for h in hook_entries()], False)
        if os.name == "nt":
            remove_startup(startup_dir() / f"{name}.lnk" for name, _script, _arguments in STARTUP)
    remove_instructions(bool(record and record.get("claude_md_created")))
    remove_stable_dir()
    if RECORD_FILE.exists():
        RECORD_FILE.unlink()
    try:
        TOOLS_DIR.rmdir()  # only if no other tool is installed there
    except OSError:
        pass
    print(f"\nRemoved {TOOL_NAME}.")
    if CONFIG_FILE.exists():
        print(f"Your config is still at {CONFIG_FILE}. Delete it if you don't need it.")


def main():
    p = argparse.ArgumentParser(description=f"Install or remove {TOOL_NAME}.")
    action = p.add_mutually_exclusive_group()
    action.add_argument("--copy", action="store_const", const="copy", dest="action",
                        help="copy the tool into ~/.claude/tools instead of linking it")
    action.add_argument("--link", action="store_const", const="link", dest="action",
                        help="link ~/.claude/tools to this folder, even outside a git clone")
    action.add_argument("--remove", action="store_const", const="remove", dest="action",
                        help="undo everything the install added")
    if INSTRUCTIONS:
        choice = p.add_mutually_exclusive_group()
        choice.add_argument("--instructions", action="store_const", const=True, dest="instructions",
                            help=f"add the tool's lines to {CLAUDE_MD} without asking")
        choice.add_argument("--no-instructions", action="store_const", const=False, dest="instructions",
                            help=f"leave the tool's lines out of {CLAUDE_MD}, or take them out")
    args = p.parse_args()
    if os.environ.get(OUTSIDE_PACKAGE):  # the rerun outside the app's package: its output goes back through a file
        sys.stdout = sys.stderr = open(os.environ[OUTSIDE_PACKAGE], "w", encoding="utf-8", buffering=1)
    instructions = getattr(args, "instructions", None)
    if args.action != "remove" and INSTRUCTIONS and instructions is None and not find_block(read_claude_md()):
        instructions = ask_instructions()  # asked here, since the rerun below has no terminal

    if (STARTUP or NEEDS_REAL_APPDATA) and in_app_package():
        rerun_outside_app_package([f"--{args.action}"] * bool(args.action)
                                  + {True: ["--instructions"], False: ["--no-instructions"]}.get(instructions, []))
    if args.action == "remove":
        remove()
    else:
        install(args.action or ("link" if in_git_clone() else "copy"), instructions)


if __name__ == "__main__":
    main()
