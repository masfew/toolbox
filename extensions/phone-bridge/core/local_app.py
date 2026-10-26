"""
A local desktop app that takes requests through a request folder, as an
alternative to driving the Claude desktop app's windows. Optional: it's used
only when "local_app" is set in ~/.claude/phone-bridge.json and the app answers;
otherwise the launcher, /archive and /notify_me work on the Claude desktop app
as before.

The protocol (README: Local App Request Folder):
  - a program sends a request by writing its JSON body to <name>.tmp in the
    folder and renaming it to <name>.json (<name>: letters, digits and . _ -);
  - the app reads and removes it, and answers with <name>.reply.json, written
    the same way: {"ok": true, "value": ...} or {"ok": false, "error": "..."};
  - the caller reads and deletes the reply. No reply means the app isn't
    running or isn't listening, and the caller falls back.

This module imports only core.bridge, like the other parts.
"""
import json
import os
import time
import uuid
from pathlib import Path

from core.bridge import read_config

SETTINGS_KEY = "local_app"
DEFAULTS = {
    "requests": "",  # the request folder; nothing happens until it's set
    "name": "Local app",  # how messages name the app
    "timeout_seconds": 5,  # for list, notify and archive replies
    "start_timeout_seconds": 30,  # a start replies once the session has started, which takes longer
    "default_folder": "",  # the folder for a new session that names no environment ("" = the app's own default)
}
MAX_BODY = 1024 * 1024  # bytes; the app refuses larger requests
POLL = 0.05  # seconds between looks for the reply
# Statuses the app gives a session in its list.
FINISHED = ("finished", "idle", "failed")
WORKING = "working"
NEEDS_YOU = "needs-you"


class NoApp:
    """The result of a request nobody answered: the folder is missing, or the
    app isn't listening. A distinct value, so `is NO_APP` can't be confused with
    an answer of None or an empty list."""

    def __repr__(self):
        return "NO_APP"


NO_APP = NoApp()


class AppError(Exception):
    """The app answered with ok:false, or took the request and then went quiet.
    str(error) is the app's own text."""


def settings(config=None):
    """The local_app settings with defaults filled in, or None when the request
    folder isn't set. `requests` and `default_folder` may use ~ and %VARIABLES%."""
    saved = (config if config is not None else read_config()).get(SETTINGS_KEY)
    folder = saved.get("requests") if isinstance(saved, dict) else None
    if not isinstance(folder, str) or not folder.strip() or folder.startswith("REPLACE_WITH_"):
        return None  # not set, or the placeholder from config.example.json
    merged = {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}
    for key in ("requests", "default_folder"):
        merged[key] = os.path.expanduser(os.path.expandvars(str(merged[key]).strip())) if merged[key] else ""
    merged["name"] = str(merged["name"]).strip() or DEFAULTS["name"]
    for key in ("timeout_seconds", "start_timeout_seconds"):
        try:
            merged[key] = float(merged[key])
            if merged[key] <= 0:
                raise ValueError
        except (TypeError, ValueError):
            merged[key] = DEFAULTS[key]
    return merged


def request(conf, body, timeout=None):
    """Sends one request and returns the reply's value; NO_APP when nothing
    answers; raises AppError for ok:false.

    The folder is checked first: a missing one means no app, with no waiting. If
    the folder exists but no reply comes in `timeout` seconds and the app never
    took the request, the request file is deleted (so the app can't run it late)
    and the result is NO_APP. If the app did take the request and then never
    answered, it may be running it, so that raises AppError instead of letting a
    caller fall back and do the same work twice."""
    folder = Path(conf["requests"])
    if not folder.is_dir():
        return NO_APP
    data = json.dumps(body).encode("utf-8")
    if len(data) > MAX_BODY:
        raise AppError("the request is too large")
    name = uuid.uuid4().hex  # letters and digits only, 32 characters
    tmp, sent, reply = folder / f"{name}.tmp", folder / f"{name}.json", folder / f"{name}.reply.json"
    try:
        tmp.write_bytes(data)
        os.replace(tmp, sent)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return NO_APP
    wait = conf["timeout_seconds"] if timeout is None else timeout
    deadline = time.monotonic() + wait
    while True:
        answer = read_reply(reply)
        if answer is not None:
            break
        if time.monotonic() >= deadline:
            try:
                sent.unlink()
            except FileNotFoundError:
                answer = read_reply(reply)  # taken, and maybe answered just now
                if answer is None:
                    raise AppError(f"{conf['name']} took the request but didn't answer in {wait:g} s")
                break
            except OSError:
                return NO_APP
            return NO_APP
        time.sleep(POLL)
    if answer.get("ok") is True:
        return answer.get("value")
    raise AppError(str(answer.get("error") or "the app refused the request"))


def read_reply(path):
    """The reply file's JSON object, deleted once read; None while there isn't one."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return None
    try:
        path.unlink()
    except OSError:
        pass
    try:
        value = json.loads(text)
    except ValueError:
        return {"ok": False, "error": "the reply wasn't readable"}
    return value if isinstance(value, dict) else {"ok": False, "error": "the reply wasn't readable"}


# ---- The actions ----

def start(conf, options, notify=True):
    """Starts a session. Returns the new session ({"id", "title", ...}), NO_APP,
    or raises AppError. `options` is the request's "options" object (cwd, prompt,
    and optionally environment, model, effort, mode, title)."""
    return request(conf, {"action": "start", "options": options, "notify": bool(notify)},
                   timeout=conf["start_timeout_seconds"])


def sessions(conf):
    """The app's open sessions (a list of dicts), NO_APP, or raises AppError."""
    value = request(conf, {"action": "list"})
    if value is NO_APP:
        return NO_APP
    return [s for s in value if isinstance(s, dict) and s.get("id")] if isinstance(value, list) else []


def session_key(session):
    """What a request names a session by: its conversation ID once it has one,
    else its own ID."""
    return str(session.get("conversationId") or session["id"])


def title_of(session):
    return str(session.get("title") or "").strip() or "Untitled"


def is_working(session):
    return bool(session.get("working")) or session.get("status") == WORKING


def finished_sessions(listed):
    """The sessions /archive may offer: finished, idle or failed, not working,
    not waiting on you, and with no working or waiting session that was started
    from them. The app itself refuses an archive that isn't safe."""
    busy_parents = {s.get("parent") for s in listed if s.get("parent")
                    and (is_working(s) or s.get("status") in (WORKING, NEEDS_YOU))}
    return [s for s in listed if s.get("status") in FINISHED and not is_working(s) and s["id"] not in busy_parents]


def working_sessions(listed):
    """The sessions /notify_me turns pushes on for: the ones working now."""
    return [s for s in listed if is_working(s)]


def archive(conf, key):
    """Archives a session: (archived, title), NO_APP, or raises AppError (the app
    says why when it won't, such as a running turn)."""
    value = request(conf, {"action": "archive", "session": key})
    if value is NO_APP:
        return NO_APP
    value = value if isinstance(value, dict) else {}
    return bool(value.get("archived")), str(value.get("title") or "")


def notify(conf, key):
    """Turns pushes on for the session's running prompt: its title, NO_APP, or
    raises AppError."""
    value = request(conf, {"action": "notify", "session": key})
    if value is NO_APP:
        return NO_APP
    return str((value if isinstance(value, dict) else {}).get("title") or "")
