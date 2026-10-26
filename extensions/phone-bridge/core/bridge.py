"""
The core both features share: where phone-bridge keeps its files, the config,
Telegram sending, the log, the snooze, the presence watcher's state, and
starting the background programs. The notifications (notify/) and the phone
launcher (launcher/) import from here, and so does the listener; nothing here
imports from them.

The bot token works like a password, so the config lives outside the tool's
folder, in ~/.claude/phone-bridge.json:
  {"telegram_token": "...", "telegram_chat_id": 123,
   "telegram_commands": [...], "launcher": {...}, "waiting_pushes": false}
Everything else the tool writes is in ~/.claude/phone-bridge/.
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# The tool's own folder. Not resolved, so a script run through
# ~/.claude/tools/phone-bridge keeps naming that path.
TOOL_DIR = Path(__file__).absolute().parents[1]
CLAUDE_DIR = Path.home() / ".claude"
CONFIG_FILE = CLAUDE_DIR / "phone-bridge.json"
STATE_DIR = CLAUDE_DIR / "phone-bridge"
# One line per prompt (whether the user counted as away), one per push (kind,
# time taken and the result) and one per listener event. Never message text or the token.
LOG_FILE = STATE_DIR / "phone-bridge.log"
LOG_KEEP = 300  # lines
# Present while pushes are on for a session; holds "all" or "final".
FLAG_DIR = STATE_DIR / "flags"
# The message IDs of each session's pushes, so they can be deleted once it's archived.
MESSAGES_DIR = STATE_DIR / "messages"
# The phone launcher writes a marker holding the prompt just before it presses
# Enter in a new session; the hook matches the session's first prompt to it.
MARKER_DIR = STATE_DIR / "markers"
# presence.py records your last real keyboard or mouse input here.
PRESENCE_FILE = STATE_DIR / "presence.json"
PRESENCE_SCRIPT = TOOL_DIR / "core" / "presence.py"
WATCHER_STALE = 30  # seconds without a heartbeat before the watcher counts as stopped
# The listener writes a heartbeat at least once per 50-second poll, its process
# ID and the next Telegram update to read.
LISTENER_FILE = STATE_DIR / "listener.json"
LISTENER_SCRIPT = TOOL_DIR / "core" / "listener.py"
LISTENER_STALE = 150  # seconds
# /snooze writes {"until": <epoch seconds>} here. Until then every push still
# goes to the chat, but silently: no sound and no banner.
SNOOZE_FILE = STATE_DIR / "snooze.json"

TELEGRAM_HOST = "api.telegram.org"
# About 1 in 5 connection attempts to Telegram hangs (likely on its IPv6 address)
# until the time limit runs out, and then the next address answers at once. So each
# address gets a short limit to connect, and the reply its own longer one.
TELEGRAM_CONNECT_TIMEOUT = 2  # seconds per address; a normal connect takes ~0.12 s
TELEGRAM_TIMEOUT = 10  # seconds


def read_json(path):
    """A JSON object from path, or {} if it's missing, unreadable or not an object."""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, value, indent=None):
    """Written whole and then swapped in, so a reader never sees a half-written file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=indent) + ("\n" if indent else ""), encoding="utf-8")
    os.replace(tmp, path)


def read_config():
    return read_json(CONFIG_FILE)


def save_config(config):
    write_json(CONFIG_FILE, config, indent=2)


def connect_quickly(address, timeout, source_address=None, *args, **kwargs):
    """Opens the connection giving each of the host's addresses only
    TELEGRAM_CONNECT_TIMEOUT before trying the next, then allows the full
    timeout for the secure handshake and the reply."""
    sock = socket.create_connection(address, TELEGRAM_CONNECT_TIMEOUT, source_address)
    sock.settimeout(timeout)
    return sock


def telegram_call(token, method, body, timeout=TELEGRAM_TIMEOUT):
    """One Bot API call: (HTTP status, reply). Network errors raise; an HTTP error's
    reply holds Telegram's "description" and, for flood control, "retry_after".
    Never put an error's text in a log or a message: it could hold the URL, which
    holds the token."""
    conn = http.client.HTTPSConnection(TELEGRAM_HOST, timeout=timeout)
    conn._create_connection = connect_quickly
    try:
        conn.request("POST", f"/bot{token}/{method}", json.dumps(body).encode("utf-8"),
                     {"Content-Type": "application/json"})
        r = conn.getresponse()
        data = r.read()
        try:
            return r.status, json.loads(data.decode("utf-8"))
        except ValueError:
            return r.status, {}
    finally:
        conn.close()


def log(session_id, idle, decision, kind="prompt"):
    """A prompt's line says how long since real input; a push's line says what was
    sent; a telegram line is the listener's (a command, a tap, a failure)."""
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()[-(LOG_KEEP - 1):] if LOG_FILE.exists() else []
        idle_text = "unknown" if idle is None else f"{idle:.1f}s"
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        what = kind if kind in ("push", "telegram") else f"last real input {idle_text} ago"
        lines.append(f"{stamp}  {session_id[:8]}  {what}  -> {decision}")
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        LOG_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def snoozed_until():
    """When the /snooze running now ends (epoch seconds), or None if there isn't one."""
    try:
        until = float(json.loads(SNOOZE_FILE.read_text(encoding="utf-8"))["until"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return until if until > time.time() else None


def set_snooze(until):
    """Starts a snooze that ends at `until` (epoch seconds), or ends it with None."""
    if until is None:
        SNOOZE_FILE.unlink(missing_ok=True)
        return
    write_json(SNOOZE_FILE, {"until": until})


def presence_state():
    """The presence watcher's latest state, or None if it isn't running."""
    state = read_json(PRESENCE_FILE)
    try:
        if time.time() - state["heartbeat"] < WATCHER_STALE:
            return state
    except (KeyError, TypeError):
        pass
    return None


def listener_running():
    state = read_json(LISTENER_FILE)
    try:
        return time.time() - state["heartbeat"] < LISTENER_STALE
    except (KeyError, TypeError):
        return False


def python_exe(windowless=False):
    """The Python running this, as python.exe, or pythonw.exe for no window."""
    wanted = "pythonw.exe" if windowless else "python.exe"
    sibling = Path(sys.executable).with_name(wanted)
    return str(sibling) if sibling.exists() else sys.executable


def resolve_run(argv):
    """A telegram_commands program as it runs: a first item that's a .py path
    relative to the tool, such as "launcher/launch.py", runs with this Python
    from the tool's folder, so the config never names where the tool is."""
    argv = [str(a) for a in argv]
    if argv and argv[0].endswith(".py") and not Path(argv[0]).is_absolute():
        return [python_exe(), str(TOOL_DIR / argv[0]), *argv[1:]]
    return argv


def in_app_package():
    """True if Windows redirects this process's AppData writes into a packaged
    app's private folder, as it does for everything the Claude desktop app starts
    (its hooks included). Such a process reports no package identity, so this
    writes a probe file and looks for where it landed."""
    local = os.environ.get("LOCALAPPDATA")
    if os.name != "nt" or not local:
        return False
    probe = Path(local) / f"phone-bridge-probe-{os.getpid()}-{time.time_ns()}"
    try:
        probe.write_text("", encoding="utf-8")
    except OSError:
        return False
    try:
        return any(Path(local, "Packages").glob(f"*/LocalCache/Local/{probe.name}"))
    finally:
        try:
            probe.unlink()
        except OSError:
            pass


def start_outside_package(argv):
    """Starts argv through WMI, which Windows runs outside any app's package, with
    the user's default environment and ~/.claude as its folder. True if it started."""
    quote = lambda text: "'" + text.replace("'", "''") + "'"
    script = (f"$p = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "
              f"{quote(subprocess.list2cmdline(argv))}, {quote(str(CLAUDE_DIR))}; exit $p.ReturnValue")
    try:
        done = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=30, creationflags=0x08000000)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0


def start_in_background(script, *args, outside_package=False):
    """Starts a script in the background, detached from the short-lived caller.
    It runs from ~/.claude, not the tool's folder: a running program's working
    folder can't be moved or renamed on Windows, so a git pull would fail.
    outside_package: when the caller runs inside the Claude desktop app's package,
    start it outside, so its AppData writes reach the real folders other programs
    read (the listener's launcher writes a local app's requests there)."""
    exe = python_exe(windowless=True)
    if outside_package and in_app_package() and start_outside_package([exe, str(script), *args]):
        return
    flags = 0x00000008 | 0x00000200 | 0x08000000  # detached, new group, no window
    for extra in (0x01000000, 0):  # break away from the app's job object if allowed
        try:
            subprocess.Popen(
                [exe, str(script), *args], cwd=str(CLAUDE_DIR), creationflags=flags | extra, close_fds=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return
        except OSError:
            continue
