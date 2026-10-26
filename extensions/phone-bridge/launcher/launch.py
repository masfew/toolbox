#!/usr/bin/env python3
"""
Phone launcher: starts a new Claude desktop app session from a Telegram message.

phone-bridge's Telegram listener (core/listener.py) is the one program that
reads the bot's messages. It runs this script for each message whose first
line is "Start a new session", or that starts with /new_session (its
"telegram_commands" entry in ~/.claude/phone-bridge.json, which install.py adds;
for a /new_session with nothing after it, the listener asks for the prompt
first), with this JSON on stdin:
  {"chat_id", "message_id", "date", "received_at", "text"}

The prompt is everything under the first line. The script checks the message,
waits until nobody is using the PC, wakes the screens, and has launch_steps.ps1
open claude://code/new?q=<prompt>, choose This computer, No folder and the
permission mode, and press Enter in the message box. It replies to the command's
message when it can't start; on success the notification hook sends a "started" push
when the new session's prompt matches the marker this script writes.

"Start a new session in Work" chooses the app's saved environment (a preset in
the Environment picker) called Work instead of This computer and No folder. A
name that isn't one gets "Did you mean ...?" with Yes and No buttons when one is
close; the listener hands the tap back here as {"chat_id", "received_at",
"callback": {"id", "data", "message_id", "text"}}.

Exits 0 whenever it dealt with the command, including replying about a failure.
Logs one line per decision to ~/.claude/phone-bridge/launcher.log, never the
prompt or the bot token.

With "local_app" set in the config (core/local_app.py) and answering, the session
is started through that app's request folder instead: no waiting for a quiet PC,
no screens woken, no window touched. The folder comes from the saved
environment's folder, or "default_folder" for a message that names none; with
neither, or when the app doesn't answer, the Claude desktop app is driven as above.

  --test PROMPT [--env NAME]  runs a launch from the command line: no Telegram
                  replies (they go to the log and the console), and a test
                  marker, so the started session sends no pushes.
  --environments  prints {"choices": [...]}, the saved environments' names, for
                  the listener's buttons after a bare /new_session.
"""
import ctypes
import ctypes.wintypes as wt
import difflib
import glob
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
# The config holds telegram_token and telegram_chat_id (never logged), and this
# launcher's settings under "launcher".
from core import local_app  # noqa: E402
from core.bridge import MARKER_DIR, PRESENCE_FILE, STATE_DIR, read_config, read_json, telegram_call  # noqa: E402
from notify import notify_hook  # noqa: E402
from notify.sessions import host_info  # noqa: E402

SETTINGS_KEY = "launcher"
LOG_FILE = STATE_DIR / "launcher.log"
LOG_KEEP = 300  # lines
# The notification hook reads MARKER_DIR: a new session whose first prompt matches
# a marker gets pushes switched on and a "started" push (or, for a test, pushes
# switched off).
# Commands waiting on a "Did you mean ...?" tap: {token: {"text", "name", "message_id", "expires"}}
PENDING_FILE = STATE_DIR / "launcher-pending.json"
PENDING_SECONDS = 600
STEPS_SCRIPT = Path(__file__).with_name("launch_steps.ps1")
# The desktop app's saved environments. It's a Store app, so its real files are
# under LocalCache; other programs may not see them at the APPDATA path.
PRESET_FILES = (("LOCALAPPDATA", "Packages/Claude_*/LocalCache/Roaming/Claude/ccd-session-presets.json"),
                ("APPDATA", "Claude/ccd-session-presets.json"))
DEFAULTS = {
    "quiet_seconds": 10,  # no mouse or keyboard input (real or simulated) for this long before a launch
    "busy_reply_after": 300,  # seconds of waiting before the "PC busy, still waiting" reply
    "give_up_after": 1500,  # seconds of waiting before giving up (the listener's timeout is 1800)
    "permission_mode": "Auto",  # as the app's Permissions picker names it: Auto, Manual, Accept edits, Plan
    "max_age_seconds": 120,  # older commands get "Not started, too old"
    # The claude:// link carried 8,000 plain characters (11,328 encoded) and 4,000
    # non-ASCII ones (27,017) intact; Windows refused one of 42,308. A Telegram
    # message holds 4,096 characters, so only an emoji-heavy one can reach this.
    "max_link_chars": 30000,
    "step_timeout": 20,  # seconds for the message box to get the prompt, and for the session to start
    "attempts": 5,  # launches interrupted by input on the PC are retried this many times in all
    "nicknames": {},  # short names for saved environments, such as {"hl": "Home Lab"}
}
COMMAND_LINES = ("start a new session", "new session")
FIRST_LINE = re.compile(r"^\s*(?:start a )?new session(?:\s+in\s+(?P<env>.+?))?\s*\.?\s*$", re.IGNORECASE)
# For the listener ("first_line_match"), so "Start a new session in Work" reaches the launcher.
FIRST_LINE_MATCH = r"^(start a )?new session( in .+)?\.?$"
CHOICE_LINE = "Start a new session in {}"  # how the listener writes a tapped environment into the command
SLASH_COMMAND = "new_session"  # in the bot's command menu; Telegram allows no hyphens there
SLASH_LINE = re.compile(r"^/new_session(?:\x40\w+)?(?=\s|$)", re.IGNORECASE)
OWN_INPUT = 0x50484C4E  # dwExtraInfo on the launcher's own simulated input ("PHLN")
NO_WINDOW = 0x08000000
MODES = ("Auto", "Manual", "Accept edits", "Plan")  # never Bypass permissions

test_mode = False


def log(text):
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()[-(LOG_KEEP - 1):] if LOG_FILE.exists() else []
        lines.append(f"{datetime.now():%Y-%m-%d %H:%M:%S}  {'test  ' if test_mode else ''}{text}")
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        LOG_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def settings():
    saved = read_config().get(SETTINGS_KEY)
    saved = saved if isinstance(saved, dict) else {}
    merged = {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}
    if merged["permission_mode"] not in MODES:
        merged["permission_mode"] = DEFAULTS["permission_mode"]
    if not isinstance(merged["nicknames"], dict):
        merged["nicknames"] = {}
    return merged


# ---- Telegram (replies only; the listener does all the reading) ----

def bot(method, body, what):
    """One Bot API call, tried twice. Never raises, and never logs the token or a
    Bot API URL (it holds the token). Logs what, the call's outcome."""
    if test_mode:
        print(f"{method}: {what}")
        log(f"{method} (not sent, test): {what}")
        return
    config = read_config()
    if not (config.get("telegram_token") and config.get("telegram_chat_id")):
        log(f"{method} not sent: the bot isn't set up")
        return
    if "chat_id" in body:
        body = {**body, "chat_id": config["telegram_chat_id"]}
    for attempt in range(2):
        try:
            status, answer = telegram_call(config["telegram_token"], method, body)
            result = "ok" if answer.get("ok") else f"failed: HTTP {status} {answer.get('description')}"
        except Exception as e:
            result = f"failed: {type(e).__name__}"
        if result == "ok" or attempt:
            break
        time.sleep(2)
    log(f"{what} -> {result}")


def reply(message, text, buttons=None):
    """Replies to the command's message, with a row of inline buttons
    [(label, callback_data), ...] if given."""
    body = {"chat_id": None, "text": text,
            "reply_parameters": {"message_id": message.get("message_id"), "allow_sending_without_reply": True}}
    if buttons:
        body["reply_markup"] = {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in buttons]]}
    bot("sendMessage", body, f"reply \"{text}\"")


# ---- The command ----

def parse(text):
    """(prompt, None) for a start command, or (None, reply) for one without a prompt.
    The first line is "Start a new session" or "New session" (any case, a full
    stop allowed); everything after it is the prompt, line breaks kept. Or the
    message starts with /new_session, and everything after that is the prompt."""
    text = (text or "").replace("\r\n", "\n").strip()
    slash = SLASH_LINE.match(text)
    if slash:
        prompt = text[slash.end():].strip()
        return (prompt, None) if prompt else (None, "Add your prompt after /new_session.")
    lines = text.split("\n")
    if not FIRST_LINE.match(lines[0]):
        return None, "Not a start command."
    prompt = "\n".join(lines[1:]).strip()
    if not prompt:
        return None, "Add your prompt on the line under Start a new session."
    return prompt, None


def environment_name(text):
    """The environment a start command names ("Start a new session in Work"), or None."""
    first = (text or "").replace("\r\n", "\n").strip().split("\n")[0]
    match = None if SLASH_LINE.match(first) else FIRST_LINE.match(first)
    return match.group("env").strip() if match and match.group("env") else None


def presets():
    """The desktop app's saved environments as dicts (name, folder, model, effort,
    worktree), most recently used first, one per name; None if the app's file
    can't be read. A preset that doesn't run on this computer has no folder."""
    for var, pattern in PRESET_FILES:
        for path in sorted(glob.glob(os.path.join(os.environ.get(var, ""), pattern))):
            data = read_json(Path(path))
            if not data:
                continue
            found = [p for account in (data.get("byAccount") or {}).values() if isinstance(account, dict)
                     for p in account.get("presets") or [] if isinstance(p, dict) and p.get("name")]
            listed, seen = [], set()
            for p in sorted(found, key=lambda p: -(p.get("lastUsedAt") or 0)):
                if p["name"] in seen:
                    continue
                seen.add(p["name"])
                target = p.get("target") if isinstance(p.get("target"), dict) else {}
                options = p.get("settings") if isinstance(p.get("settings"), dict) else {}
                folder = target.get("cwd") if target.get("kind") == "local" and isinstance(target.get("cwd"), str) else None
                listed.append({"name": p["name"], "folder": folder or None, "model": options.get("modelId"),
                               "effort": options.get("effort"), "worktree": options.get("worktree")})
            return listed
    return None


def environments():
    """The desktop app's saved environments' names, most recently used first, or
    None if the app's file can't be read."""
    found = presets()
    return None if found is None else [p["name"] for p in found]


def resolve(name, names, nicknames):
    """("exact", environment), ("close", environment) or ("none", None) for a
    name typed after "in", matched against the saved environments and the
    nicknames setting, ignoring case."""
    by_key = {n.lower(): n for n in names}
    for nick, target in nicknames.items():
        if isinstance(nick, str) and str(target).lower() in by_key:
            by_key.setdefault(nick.lower(), by_key[str(target).lower()])
    key = name.lower().strip()
    if key in by_key:
        return "exact", by_key[key]
    close = difflib.get_close_matches(key, list(by_key), n=1, cutoff=0.6)
    if close:
        return "close", by_key[close[0]]
    contains = [k for k in by_key if len(key) >= 2 and (key in k or k in key)]
    if len(contains) == 1:
        return "close", by_key[contains[0]]
    return "none", None


def with_environment(text, environment):
    """The command text with its first line naming environment instead."""
    lines = (text or "").replace("\r\n", "\n").strip().split("\n")
    return "\n".join([CHOICE_LINE.format(environment)] + lines[1:])


def load_pending():
    now = time.time()
    return {k: v for k, v in read_json(PENDING_FILE).items() if isinstance(v, dict) and v.get("expires", 0) > now}


def save_pending(pending):
    tmp = PENDING_FILE.with_suffix(".tmp")
    PENDING_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(pending), encoding="utf-8")
    os.replace(tmp, PENDING_FILE)


def ask_did_you_mean(message, typed, suggestion):
    """Keeps the command for PENDING_SECONDS and asks with Yes and No buttons."""
    pending = load_pending()
    token = secrets.token_hex(4)
    pending[token] = {"text": message.get("text"), "name": suggestion, "message_id": message.get("message_id"),
                      "expires": time.time() + PENDING_SECONDS}
    save_pending(pending)
    log(f"not started yet: no environment called {typed}, asked about {suggestion}")
    reply(message, f"No environment called {typed}. Did you mean {suggestion}?",
          [("Yes", f"env:{token}:y"), ("No", f"env:{token}:n")])


def handle_tap(message):
    """A tap on a "Did you mean ...?" button. Answers the tap, takes the buttons
    off the question so it can't be answered twice, and on Yes starts the kept
    command with the suggested environment."""
    tap = message["callback"]
    match = re.match(r"^env:([0-9a-f]+):([yn])$", tap.get("data") or "")
    pending = load_pending()
    kept = pending.pop(match.group(1), None) if match else None
    if kept is not None:
        save_pending(pending)
    yes = bool(match) and match.group(2) == "y"
    if kept is None:
        toast, line = "That question has expired.", "Expired: not started."
    elif yes:
        toast, line = f"Starting in {kept['name']}", f"Yes: starting in {kept['name']}."
    else:
        toast, line = "Not started", "No: not started."
    log(f"tap: {'expired' if kept is None else 'yes' if yes else 'no'}")
    bot("answerCallbackQuery", {"callback_query_id": tap.get("id"), "text": toast}, "tap answered")
    if tap.get("message_id"):
        bot("editMessageText", {"chat_id": None, "message_id": tap["message_id"],
                                "text": f"{tap.get('text') or ''}\n{line}".strip()}, "question edited")
    if kept is not None and yes:
        now = message.get("received_at") or time.time()
        # The tap is the go-ahead, so the age check counts from it.
        handle({"chat_id": message.get("chat_id"), "message_id": kept.get("message_id"), "date": now,
                "received_at": now, "text": with_environment(kept["text"], kept["name"])})


def too_old(message, limit):
    """The sent time as HH:MM when the command waited longer than limit seconds."""
    sent = message.get("date") or 0
    received = message.get("received_at") or time.time()
    if received - sent > limit:
        return datetime.fromtimestamp(sent).strftime("%H:%M") if sent else "an unknown time"
    return None


def write_marker(key, prompt, expires_in):
    MARKER_DIR.mkdir(parents=True, exist_ok=True)
    path = MARKER_DIR / f"{key}.json"
    data = {"prompt": prompt, "expires": time.time() + expires_in, "test": test_mode}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)
    return path


# ---- Quiet-PC guard and screen wake (Windows) ----

WH_KEYBOARD_LL, WH_MOUSE_LL = 13, 14
WM_QUIT, WM_POWERBROADCAST, PBT_POWERSETTINGCHANGE = 0x0012, 0x0218, 0x8013
DISPLAY_STATES = {0: "off", 1: "on", 2: "dimmed"}


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wt.DWORD), ("Data2", wt.WORD), ("Data3", wt.WORD), ("Data4", ctypes.c_ubyte * 8)]


# GUID_CONSOLE_DISPLAY_STATE: 6FE69556-704A-47A0-8F24-C28D936FDA47
DISPLAY_GUID = GUID(0x6FE69556, 0x704A, 0x47A0, (ctypes.c_ubyte * 8)(0x8F, 0x24, 0xC2, 0x8D, 0x93, 0x6F, 0xDA, 0x47))


class POWERBROADCAST_SETTING(ctypes.Structure):
    _fields_ = [("PowerSetting", GUID), ("DataLength", wt.DWORD), ("Data", wt.DWORD)]


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wt.DWORD), ("scanCode", wt.DWORD), ("flags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long), ("mouseData", wt.DWORD),
                ("flags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("pad", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _U)]


class InputWatch:
    """Counts keyboard and mouse events, real and simulated alike (another
    session's automation is the likelier clash), without recording which keys.
    The launcher's own simulated input carries OWN_INPUT and isn't counted.
    Windows' idle timer (GetLastInputInfo) isn't used: on this PC it resets every
    half second with no input. Also tracks the display's power state."""

    def __init__(self):
        self.events = 0
        self.last_event = None  # time.monotonic() of the latest counted event
        self.display = "unknown"
        self.started = threading.Event()
        self.ok = False
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        self.started.wait(5)

    def counted(self, extra):
        if extra != OWN_INPUT:
            self.events += 1
            self.last_event = time.monotonic()

    def run(self):
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wt.WPARAM, wt.LPARAM)
        WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)
        user32.SetWindowsHookExW.restype = ctypes.c_void_p
        user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, wt.DWORD]
        user32.CallNextHookEx.restype = ctypes.c_ssize_t
        user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
        user32.DefWindowProcW.restype = ctypes.c_ssize_t
        user32.DefWindowProcW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
        user32.CreateWindowExW.restype = wt.HWND
        user32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int,
                                           ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
        user32.RegisterPowerSettingNotification.restype = ctypes.c_void_p
        user32.RegisterPowerSettingNotification.argtypes = [wt.HANDLE, ctypes.POINTER(GUID), wt.DWORD]
        self.thread_id = kernel32.GetCurrentThreadId()

        # Keep the callbacks tiny: Windows drops low-level hooks that answer slowly.
        def on_key(code, wparam, lparam):
            if code == 0:
                self.counted(ctypes.cast(lparam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents.dwExtraInfo)
            return user32.CallNextHookEx(None, code, wparam, lparam)

        def on_mouse(code, wparam, lparam):
            if code == 0:
                self.counted(ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents.dwExtraInfo)
            return user32.CallNextHookEx(None, code, wparam, lparam)

        def on_message(hwnd, msg, wparam, lparam):
            if msg == WM_POWERBROADCAST and wparam == PBT_POWERSETTINGCHANGE and lparam:
                setting = ctypes.cast(lparam, ctypes.POINTER(POWERBROADCAST_SETTING)).contents
                self.display = DISPLAY_STATES.get(setting.Data, str(setting.Data))
                return 1
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        self.procs = (HOOKPROC(on_key), HOOKPROC(on_mouse), WNDPROC(on_message))  # kept alive
        self.ok = bool(user32.SetWindowsHookExW(WH_KEYBOARD_LL, self.procs[0], None, 0)
                       and user32.SetWindowsHookExW(WH_MOUSE_LL, self.procs[1], None, 0))
        # A hidden window for the display's power state: Windows sends the current
        # state at once on registering, then each change.
        hwnd = user32.CreateWindowExW(0, "STATIC", "phone-bridge launcher", 0, 0, 0, 0, 0, None, None, None, None)
        if hwnd:
            user32.SetWindowLongPtrW.restype = ctypes.c_void_p
            user32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_void_p]
            user32.SetWindowLongPtrW(hwnd, -4, ctypes.cast(self.procs[2], ctypes.c_void_p))  # GWLP_WNDPROC
            user32.RegisterPowerSettingNotification(hwnd, ctypes.byref(DISPLAY_GUID), 0)
        self.started.set()
        msg = wt.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))


def wake_screens(watch):
    """Turns the displays on: tells Windows the display is needed, and moves the
    mouse 1 pixel and back (marked as the launcher's own, so the guard ignores it;
    Windows drops a 0-pixel move before any hook sees it). Returns the display
    state before and after."""
    before = watch.display
    ctypes.WinDLL("kernel32").SetThreadExecutionState(0x00000002)  # ES_DISPLAY_REQUIRED, once
    moves = (INPUT * 2)(INPUT(type=0), INPUT(type=0))  # INPUT_MOUSE
    moves[0].mi = MOUSEINPUT(1, 0, 0, 0x0001, 0, OWN_INPUT)  # MOUSEEVENTF_MOVE, relative
    moves[1].mi = MOUSEINPUT(-1, 0, 0, 0x0001, 0, OWN_INPUT)
    ctypes.WinDLL("user32").SendInput(2, moves, ctypes.sizeof(INPUT))
    time.sleep(1)
    return before, watch.display


def wait_until_quiet(watch, conf, message, waited_from):
    """Waits for conf["quiet_seconds"] without input. Returns False on giving up.
    Input before this script started is judged from the presence watcher's file
    (real input only) plus at least 2 seconds of this script's own watching."""
    need = conf["quiet_seconds"]
    started = time.monotonic()
    state = read_json(PRESENCE_FILE)
    before = None  # seconds without real input before this call, if the presence watcher knows
    if state.get("heartbeat") and time.time() - state["heartbeat"] < 30:
        last_real = state.get("last_real_input")
        before = time.time() - last_real if last_real else float("inf")  # none since it started
    while True:
        now = time.monotonic()
        if watch.last_event is not None:
            quiet = now - watch.last_event
        elif before is not None and now - started >= 2:
            quiet = now - started + before
        else:
            quiet = now - started
        if quiet >= need:
            return True
        waited = now - waited_from["start"]
        if waited >= conf["busy_reply_after"] and not waited_from.get("told"):
            waited_from["told"] = True
            log("PC busy: told the phone")
            reply(message, "PC busy, still waiting")
        if waited >= conf["give_up_after"]:
            return False
        time.sleep(0.25)


# ---- The launch ----

def run_steps(prompt, conf, watch, environment=None):
    """One launch attempt through launch_steps.ps1, in the saved environment
    named, or This computer and No folder. Returns ("done", info),
    ("retry", why) or ("fail", message)."""
    attempt_start = watch.events
    args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden", "-File", str(STEPS_SCRIPT)]
    errors = tempfile.TemporaryFile()  # a file, not a pipe, so a full pipe can never stall the script
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                            creationflags=NO_WINDOW, text=True, encoding="utf-8")
    stepped = False  # nothing in the app has been touched until the first step
    timer = threading.Timer(conf["step_timeout"] * 3 + 30, proc.kill)
    timer.start()
    try:
        request = {"prompt": prompt, "mode": conf["permission_mode"], "timeout": conf["step_timeout"],
                   "environment": environment}
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        for line in proc.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            kind = event.get("event")
            if kind == "step":
                stepped = True
                log("step " + ", ".join(f"{k}={v}" for k, v in event.items() if k != "event"))
            elif kind == "ready":
                interrupted = watch.events - attempt_start
                proc.stdin.write("stop\n" if interrupted else "go\n")
                proc.stdin.flush()
                log(f"ready: {'stop, ' + str(interrupted) + ' input events during the launch' if interrupted else 'go'}")
            elif kind == "done":
                return "done", event
            elif kind == "retry":
                return "retry", event.get("why")
            elif kind == "fail":
                if watch.events - attempt_start:
                    # Input during the launch can open the wrong menu or type into a
                    # search box; that's a busy PC, not a broken step.
                    return "retry", f"{event.get('message')}, with input on the PC"
                return "fail", event.get("message") or "the launch failed"
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
        errors.seek(0)
        first_error = next((line.strip() for line in errors.read().decode("utf-8", "replace").splitlines()
                            if line.strip()), "no error output")
        log(f"steps script ended with exit {proc.returncode}: {first_error[:200]}")
        if not stepped:
            # It died while setting up, before touching the app: safe to try again.
            return "retry", "the launch script stopped before its first step"
        return "fail", "the launch script stopped early"
    finally:
        timer.cancel()
        errors.close()
        try:
            proc.kill()
            proc.wait(5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        for pipe in (proc.stdin, proc.stdout):
            try:
                pipe.close()
            except OSError:
                pass


def launch(message, prompt, conf, marker, environment=None):
    watch = InputWatch()
    if not watch.ok:
        log("input hooks failed to start")
        return "couldn't watch the keyboard and mouse"
    waiting = {"start": time.monotonic()}
    for attempt in range(1, conf["attempts"] + 1):
        if not wait_until_quiet(watch, conf, message, waiting):
            return f"the PC stayed busy for {conf['give_up_after'] // 60} minutes"
        log(f"attempt {attempt}: quiet after {time.monotonic() - waiting['start']:.1f}s")
        before, after = wake_screens(watch)
        log(f"screens: {before} -> {after}")
        write_marker(marker, prompt, 120)  # the session's first prompt arrives within seconds of Enter
        outcome, info = run_steps(prompt, conf, watch, environment)
        if outcome == "done":
            log(f"started (attempt {attempt}, {time.monotonic() - waiting['start']:.1f}s, "
                f"window {info.get('restore')})")
            return None
        log(f"attempt {attempt}: {outcome}: {info}")
        if outcome == "fail":
            return info
    return "the launch kept being interrupted"


def refuse_long_prompt(message, link):
    log(f"not started: the link would be {link} characters")
    reply(message, "Couldn't start: the prompt is too long for the app's link")


def start_in_app(message, prompt, conf, app, environment):
    """Starts the session through the local app's request folder. True when the
    command was dealt with (started, or the app refused and the reply says why);
    False to go on with the Claude desktop app: a saved environment with no folder
    to give it, or nothing answered. With no environment and no default_folder,
    no folder is sent and the app starts the session where its own new sessions
    start."""
    options = {"prompt": prompt, "mode": conf["permission_mode"]}
    if environment:
        preset = next((p for p in presets() or [] if p["name"] == environment), None) or {}
        options["cwd"] = preset.get("folder")
        for key in ("model", "effort"):
            if isinstance(preset.get(key), str) and preset[key]:
                options[key] = preset[key]
        if isinstance(preset.get("worktree"), bool):
            options["environment"] = "worktree" if preset["worktree"] else "local"
        if not options["cwd"]:
            log(f"{app['name']} not used: the saved environment {environment} has no folder")
            return False
    elif app["default_folder"]:
        options["cwd"] = app["default_folder"]
    try:
        session = local_app.start(app, options, notify=not test_mode)
    except local_app.AppError as e:
        log(f"couldn't start in {app['name']}: {e}")
        reply(message, f"Couldn't start: {e}")
        return True
    if session is local_app.NO_APP:
        log(f"{app['name']} didn't answer: using the Claude desktop app")
        return False
    session = session if isinstance(session, dict) else {}
    log(f"started in {app['name']}: message {message.get('message_id')}, prompt of {len(prompt)} characters"
        + (f", in {environment}" if environment else "") + (", session " + str(session["id"])[:8] if session.get("id") else ""))
    if test_mode:
        print(f"started push (not sent, test): {session.get('title') or 'New session'}")
    elif session.get("id"):
        key = local_app.session_key(session)
        title = str(session.get("title") or "").strip() or "New session"
        notify_hook.push_for(key, f"{title} · started", prompt, "rocket", host_info(key).get("link", ""))
    return True


def handle(message):
    conf = settings()
    config = read_config()
    if not test_mode and str(message.get("chat_id")) != str(config.get("telegram_chat_id")):
        log("ignored: not from your chat")
        return
    if message.get("callback"):
        handle_tap(message)
        return
    sent = too_old(message, conf["max_age_seconds"])
    if sent:
        log(f"not started: too old (sent {sent})")
        reply(message, f"Not started, too old: sent at {sent}")
        return
    prompt, problem = parse(message.get("text"))
    if problem:
        log(f"not started: {problem}")
        reply(message, problem)
        return
    app = local_app.settings(config)
    link = len("claude://code/new?q=" + urllib.parse.quote(prompt, safe=""))
    if link > conf["max_link_chars"] and not app:
        refuse_long_prompt(message, link)
        return
    environment, typed = None, environment_name(message.get("text"))
    if typed:
        names = environments()
        if names is None:
            log("not started: couldn't read the app's saved environments")
            reply(message, "Couldn't start: couldn't read the app's environments")
            return
        found, environment = resolve(typed, names, conf["nicknames"])
        if found == "close":
            ask_did_you_mean(message, typed, environment)
            return
        if found == "none":
            log("not started: unknown environment")
            listed = ", ".join(names) if names else "none saved in the app"
            reply(message, f"No environment called {typed} exists. These do: {listed}.")
            return
    if app and start_in_app(message, prompt, conf, app, environment):
        return
    if link > conf["max_link_chars"]:
        refuse_long_prompt(message, link)
        return
    log(f"start: message {message.get('message_id')}, prompt of {len(prompt)} characters, "
        f"{prompt.count(chr(10)) + 1} lines" + (f", in {environment}" if environment else ""))
    marker = f"{message.get('message_id') or 'test'}-{int(time.time())}"
    try:
        failure = launch(message, prompt, conf, marker, environment)
    except Exception as e:
        failure = f"the launcher failed ({type(e).__name__})"
    if failure:
        (MARKER_DIR / f"{marker}.json").unlink(missing_ok=True)
        log(f"couldn't start: {failure}")
        reply(message, f"Couldn't start: {failure}")


def main():
    global test_mode
    if sys.platform != "win32":
        sys.exit("The phone launcher runs on Windows only.")
    if sys.argv[1:] == ["--environments"]:
        print(json.dumps({"choices": environments() or []}))
        return
    if len(sys.argv) > 2 and sys.argv[1] == "--test":
        test_mode = True
        if "--quiet" in sys.argv:  # a longer wait, for tests run while someone may be at the PC
            DEFAULTS["quiet_seconds"] = int(sys.argv[sys.argv.index("--quiet") + 1])
            DEFAULTS["give_up_after"] = 3600
        first = CHOICE_LINE.format(sys.argv[sys.argv.index("--env") + 1]) if "--env" in sys.argv else COMMAND_LINES[0]
        now = time.time()
        handle({"message_id": None, "date": now, "received_at": now, "text": first + "\n" + sys.argv[2]})
        return
    try:
        message = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:
        log("ignored: unreadable input")
        return
    handle(message)


if __name__ == "__main__":
    main()
