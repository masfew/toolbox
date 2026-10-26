#!/usr/bin/env python3
"""
Telegram listener for phone-bridge: the one program that reads the bot's incoming
messages. Telegram lets only one program poll a bot at a time, so other tools
that take commands through the same bot plug into this one instead of polling.

  /notify_me   turns pushes on for every session that has something running
        and pushes off (and its running sub-sessions), then replies "Done". With
        NOTIFY_ME_ALL set to False it lists those sessions instead,
        one button each. A tap writes the session's flag file (and its running
        sub-sessions'), so its next push goes out as if its prompt had ended
        with "notify me". A typed /notify-me works too (Telegram's command
        menu allows no hyphens).
  /snooze    offers 1, 4, 12 and 24 hours (and "End snooze" while one runs).
        A tap writes ~/.claude/phone-bridge/snooze.json; until it runs out, every
        push still arrives, but silently (no sound, no banner).
  /archive   lists the desktop app's sessions that are completely finished and
        not archived (archive.py says what that takes), one button each, and
        Archive All under them when there are two or more. A tap checks the
        session again and archives it from the app's sidebar; Archive All does
        that for every session still listed, one after another.

With "local_app" set in the config and the app answering (core/local_app.py),
/notify_me and /archive also cover that app's sessions, named with its "name":
/notify_me turns pushes on for its working sessions and /archive offers its
finished ones. When it doesn't answer, both work on the desktop app alone.

An archived session's pushes are deleted from the chat (cleanup.py): right
after /archive archives it, or within SWEEP_EVERY seconds of archiving it at the PC.

Other tools add commands in ~/.claude/phone-bridge.json under "telegram_commands":
  [{"name": "start", "first_line": ["start a new session"],
    "command": "new_session", "description": "Start a new Claude session",
    "ask": "What should the new session do?", "ask_placeholder": "Your prompt",
    "run": ["<python>", "<handler.py>"], "timeout": 600}]
A message whose first line matches "first_line" (ignoring case and a trailing
full stop), or that starts with /<command> (which goes in the bot's command
menu, with "description"), runs that program with no window and this JSON on its
stdin: chat_id,
message_id, date (Telegram's), received_at (this listener's) and text. It never
gets the token; it reads the config itself and sends its own replies. Runs of
one command go one at a time, in order, and never hold up /notify_me. Exit code 0 means
it handled everything; anything else, or no answer within its timeout (default
10 minutes, then it's killed), gets a "Couldn't run <name> (...)" reply.
With "ask", a command with nothing after it gets that question as a reply
(Telegram opens a reply to it), and your next message, within 10 minutes, runs
the command with the answer under the command's first line, so tapping
/new_session in the menu and then typing the prompt works. Once that message
arrives, or the 10 minutes pass, the question is deleted: otherwise Telegram's
iPhone app reopens a reply to it every time the chat opens.
Optional fields:
  "first_line_match": a regex (any case, whole first line) that also matches,
      such as "Start a new session in Work". Alone, such a line gets the "ask"
      question, and the answer goes under that line.
  "choices", "choose", "choose_default", "choice_line": before asking, a bare
      command (the slash command or an exact "first_line") runs the "choices"
      program, which prints {"choices": ["Work", ...]}, and replies "choose"
      with one button for "choose_default" (the command as it is) and one per
      choice. A tap fills the message box with "@<bot> Work: " and opens the
      keyboard; the message sent from it runs the command with the rest under
      "choice_line" (the choice in place of {}), or under the bare command for
      "choose_default". With nothing after the colon it asks the "ask" question.
  "callback_prefix": button taps whose data starts with "<prefix>:" (buttons
      the command sent itself) run the command with chat_id, received_at and
      "callback": {"id", "data", "message_id", "text"} on its stdin.
External commands get old messages too (Telegram keeps them for 24 hours), so
they can say they're too old; everything else older than 10 minutes is dropped.

Runs in the background from Windows sign-in (a Startup shortcut that install.py
creates; notify_hook.py also starts it if it isn't running). One instance at a
time. Writes ~/.claude/phone-bridge/listener.json: {"heartbeat", "pid", "offset",
"question"}, the offset being the next update to read, so a restart doesn't
replay old taps, and question the open question's message_id, which a restart
deletes.
Logs one line per command and tap to ~/.claude/phone-bridge/phone-bridge.log, never message
text or the token.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from datetime import datetime

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from core import local_app  # noqa: E402
from core.bridge import LISTENER_FILE as STATE_FILE  # noqa: E402
from core.bridge import log, read_config, resolve_run, set_snooze, snoozed_until, telegram_call  # noqa: E402
# The built-in commands come from the notifications, which every install has.
from notify import archive, cleanup  # noqa: E402
from notify.sessions import active_sessions, describe, sessions_without_pushes, turn_pushes_on  # noqa: E402

MUTEX_NAME = "Local\\phone-bridge-listener"
POLL_TIMEOUT = 50  # seconds Telegram holds a getUpdates call open when nothing arrives
NO_CONFIG_WAIT = 10  # seconds between config checks before the bot and chat are set up
MAX_MESSAGE_AGE = 600  # seconds; older messages (sent before the listener ran) get no answer
DEFAULT_COMMAND_TIMEOUT = 600  # seconds an external command may run
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
BUTTON_TITLE = 40  # characters of a session title on its button
ASK_SECONDS = 600  # how long a command's question waits for its answer
CHOICES_TIMEOUT = 15  # seconds a command's "choices" program may take
CHOICE_LABEL = 60  # characters of a choice on its button
# In a group, Telegram adds the bot's username to a command after an at sign,
# written \x40 in these patterns.
NOTIFY_ME_COMMAND = re.compile(r"^/notify[_-]me(\x40\w+)?$", re.IGNORECASE)
# What /notify_me does: turns pushes on for every working session that has them
# off and replies "Done". Set to False to go back to one button per session, each tapped on its own.
NOTIFY_ME_ALL = True
SNOOZE_COMMAND = re.compile(r"^/snooze(\x40\w+)?$", re.IGNORECASE)
SNOOZE_HOURS = (1, 4, 12, 24)
ARCHIVE_COMMAND = re.compile(r"^/archive(\x40\w+)?$", re.IGNORECASE)
ARCHIVE_LIST = 40  # buttons at most in one /archive reply
ARCHIVE_ALL = "archive_all"  # the data of the Archive All button under an /archive list
APP_PREFIX = "app:"  # in a button's data, before the ID of a local app's session
CALLBACK_LIMIT = 64  # bytes Telegram allows in a button's data
SLASH = re.compile(r"^/([A-Za-z0-9_]+)(?:\x40\w+)?(?=\s|$)")  # "/new_session fix it", maybe with the username
FILLED = re.compile(r"^\x40\w*bot\s+([^:\n]+?)\s*:\s*(.*)$", re.IGNORECASE | re.DOTALL)  # "@<bot-username> Work: fix it"
COMMAND_NAME = re.compile(r"^[a-z0-9_]{1,32}$")  # what Telegram allows in the command menu
BOT_COMMANDS = [{"command": "notify_me", "description": "Turn pushes on for all working sessions" if NOTIFY_ME_ALL
                 else "Turn pushes on for a working session"},
                {"command": "snooze", "description": "Make pushes silent for a while"},
                {"command": "archive", "description": "Archive sessions that have finished"}]

log_lock = threading.Lock()  # log() rewrites the whole file, so threads take turns
workers = ThreadPoolExecutor(max_workers=2)  # built-in commands, off the polling thread
runners = {}  # external command name -> its queue of messages
awaiting = None  # the command whose question waits for an answer: {"command", "head", "message_id", "expires"}
offered = None  # the newest choice question, until a choice fills a message: {"message_id", "text"}
state_lock = threading.Lock()  # the polling thread and handle_ask both save the state
last_offset = None  # the offset save_state last wrote
archiving_all = set()  # message_ids of the /archive lists an Archive All is working through


def note(session_id, text):
    with log_lock:
        log(session_id, None, text, kind="telegram")


def save_state(offset=None):
    """Writes the state file; with no offset, keeps the one last written. It
    also holds the open question's message_id, so a restart can delete it."""
    global last_offset
    with state_lock:
        if offset is not None:
            last_offset = offset
        state = {"heartbeat": time.time(), "pid": os.getpid(), "offset": last_offset,
                 "question": (awaiting or {}).get("message_id")}
        tmp = STATE_FILE.with_suffix(".tmp")
        try:
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(state), encoding="utf-8")
            tmp.replace(STATE_FILE)
        except OSError:
            pass


def saved_state(key):
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8")).get(key)
    except (OSError, ValueError, AttributeError):
        return None


def call(config, method, body):
    """A Bot API call that never raises; returns the reply ({} on a network error)."""
    try:
        status, reply = telegram_call(config["telegram_token"], method, body)
        if not reply.get("ok"):
            note("listener", f"{method} failed: HTTP {status} {reply.get('description')}")
        return reply
    except Exception as e:
        note("listener", f"{method} failed: {type(e).__name__}")
        return {}


def send(config, text, keyboard=None, reply_to=None, markup=None):
    body = {"chat_id": config["telegram_chat_id"], "text": text, "link_preview_options": {"is_disabled": True}}
    if keyboard:
        body["reply_markup"] = {"inline_keyboard": keyboard}
    if markup:
        body["reply_markup"] = markup
    if reply_to:
        body["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
    reply = call(config, "sendMessage", body)
    if not reply:
        # No answer from Telegram (a timeout or other network error): send once more. If
        # the first one got through and only its answer was lost, the reply shows twice,
        # which beats a command that seems to hang.
        reply = call(config, "sendMessage", body)
    return reply


def guarded(handler, *args):
    """Runs a handler on a worker thread; a failure is logged, never raised."""
    try:
        handler(*args)
    except Exception as e:
        note("listener", f"{handler.__name__} failed: {type(e).__name__}")


def button_title(title):
    return title[: BUTTON_TITLE - 1].rstrip() + "…" if len(title) > BUTTON_TITLE else title


def button_label(entry):
    return f"{button_title(entry['title'])} · {describe(entry)}"


def app_sessions(config):
    """(app settings, its open sessions) when the local app is set up and
    answers; (None, []) when it isn't set, doesn't answer or refuses, which
    leaves everything to the Claude desktop app."""
    app = local_app.settings(config)
    if not app:
        return None, []
    try:
        listed = local_app.sessions(app)
    except local_app.AppError as e:
        note("listener", f"{app['name']} list refused: {str(e)[:100]}")
        return None, []
    if listed is local_app.NO_APP:
        note("listener", f"{app['name']} didn't answer")
        return None, []
    return app, listed


def app_button_data(prefix, session):
    """A button's data for a local app session, or None when it wouldn't fit."""
    data = prefix + APP_PREFIX + local_app.session_key(session)
    return data if len(data.encode("utf-8")) <= CALLBACK_LIMIT else None


def turn_on_in_app(app, working):
    """Turns pushes on for the local app's working sessions: (how many, a line
    for each, as "title · status" or why it failed)."""
    done, lines = 0, []
    for s in working:
        title = local_app.title_of(s)
        try:
            result = local_app.notify(app, local_app.session_key(s))
        except local_app.AppError as e:
            lines.append(f"• {title} · couldn't turn pushes on ({str(e)[:100]})")
            continue
        if result is local_app.NO_APP:
            lines.append(f"• {title} · couldn't turn pushes on ({app['name']} stopped answering)")
            continue
        done += 1
        lines.append(f"• {title} · {s.get('status') or 'working'}")
        note(local_app.session_key(s), f"pushes on (all): telegram /notify_me ({app['name']})")
    return done, lines


def handle_notify_me(config, message):
    sessions = sessions_without_pushes()
    app, listed = app_sessions(config)
    app_working = local_app.working_sessions(listed) if app else []
    if NOTIFY_ME_ALL:
        turned_on = [s for e in sessions for s in (e, *e["subs"]) if not s["pushes"]]
        for s in turned_on:
            turn_pushes_on(s["id"])
            note(s["id"], "pushes on (all): telegram /notify_me")
        in_app, app_lines = turn_on_in_app(app, app_working) if app_working else (0, [])
        count = len(turned_on) + in_app
        failed = len(app_lines) - in_app
        if count:
            text = f"Done. All notifications are on (turned on for {count} session{'s' if count != 1 else ''})."
        elif failed:
            text = "Couldn't turn pushes on for every session:"
        else:
            text = "Done. All notifications were already on."
        if app_lines:
            text += f"\n\n{app['name']}:\n" + "\n".join(app_lines)
        send(config, text)
        note("listener", f"/notify_me: {count} turned on")
        return
    keyboard = [[{"text": button_label(e), "callback_data": f"on:{e['id']}"}] for e in sessions]
    for s in app_working:
        data = app_button_data("on:", s)
        if data:
            keyboard.append([{"text": f"{button_title(local_app.title_of(s))} · {app['name']}, "
                                      f"{s.get('status') or 'working'}", "callback_data": data}])
    if keyboard:
        send(config, "Working sessions with pushes off. Tap one to turn its pushes on:", keyboard)
    else:
        send(config, "No active sessions with pushes off.")
    note("listener", f"/notify_me: {len(keyboard)} listed")


def find_session(session_id):
    """The active session (or sub-session) with this ID, with its own sub-sessions."""
    for entry in active_sessions():
        for candidate in (entry, *entry["subs"]):
            if candidate["id"] == session_id:
                return candidate
    return None


def app_tap(config, key, tapped):
    """(toast, line) for a tap on a local app session's button in /notify_me."""
    app = local_app.settings(config)
    title = tapped.split(" · ")[0]
    if not app:
        return "The local app isn't set up", f"⏹ {title}: the local app isn't set up, pushes left off"
    try:
        result = local_app.notify(app, key)
    except local_app.AppError as e:
        note(key, f"telegram tap: {app['name']} refused: {str(e)[:100]}")
        return "Couldn't turn pushes on", f"⚠️ {title}: couldn't turn pushes on ({str(e)[:100]})"
    if result is local_app.NO_APP:
        return "Couldn't reach the app", f"⚠️ {title}: {app['name']} didn't answer, pushes left off"
    note(key, f"pushes on (all): telegram ({app['name']})")
    return "Pushes on", f"✅ {result or title}: pushes on"


def handle_tap(config, query):
    data = query.get("data") or ""
    session_id = data.removeprefix("on:")
    message = query.get("message") or {}
    keyboard = (message.get("reply_markup") or {}).get("inline_keyboard") or []
    tapped = next((b["text"] for row in keyboard for b in row if b.get("callback_data") == data), "That session")
    entry = None if session_id.startswith(APP_PREFIX) else find_session(session_id)
    if session_id.startswith(APP_PREFIX):
        toast, line = app_tap(config, session_id.removeprefix(APP_PREFIX), tapped)
    elif entry is None:
        # It finished between the list and the tap: nothing is left to push about.
        toast, line = "That session has finished.", f"⏹ {tapped}: finished, pushes left off"
        note(session_id, "telegram tap: session no longer active")
    else:
        turned_on = [s for s in (entry, *entry["subs"]) if not s["pushes"]]
        for s in turned_on:
            turn_pushes_on(s["id"])
            note(s["id"], "pushes on (all): telegram")
        toast = "Pushes on" if turned_on else "Pushes were already on"
        line = f"✅ {entry['title']}: pushes on"
    call(config, "answerCallbackQuery", {"callback_query_id": query["id"], "text": toast})
    if message.get("message_id"):
        remaining = [row for row in keyboard if not any(b.get("callback_data") == data for b in row)]
        body = {"chat_id": message["chat"]["id"], "message_id": message["message_id"],
                "text": f"{message.get('text', '')}\n{line}"}
        if remaining:
            body["reply_markup"] = {"inline_keyboard": remaining}
        call(config, "editMessageText", body)


def clock(until):
    """"22:15", or "Thu 22:15" when it isn't today."""
    when = datetime.fromtimestamp(until)
    return when.strftime("%H:%M") if when.date() == datetime.now().date() else when.strftime("%a %H:%M")


def handle_snooze(config, message):
    until = snoozed_until()
    keyboard = [[{"text": f"{h} hour{'s' if h > 1 else ''}", "callback_data": f"snooze:{h}"} for h in pair]
                for pair in (SNOOZE_HOURS[:2], SNOOZE_HOURS[2:])]
    if until:
        keyboard.append([{"text": "End snooze", "callback_data": "snooze:end"}])
        text = f"Snoozed until {clock(until)}. Change it, or end it:"
    else:
        text = "Make pushes silent for how long?"
    send(config, text, keyboard)
    note("listener", f"/snooze: offered{' (snoozed)' if until else ''}")


def handle_snooze_tap(config, query):
    choice = (query.get("data") or "").removeprefix("snooze:")
    message = query.get("message") or {}
    if choice == "end":
        if snoozed_until():
            set_snooze(None)
            toast, line = "Snooze ended", "🔔 Snooze ended, pushes make a sound again"
        else:
            toast, line = "The snooze had already ended", "🔔 The snooze had already ended"
    elif choice.isdigit() and int(choice) in SNOOZE_HOURS:
        until = time.time() + int(choice) * 3600
        set_snooze(until)
        toast, line = f"Snoozed until {clock(until)}", f"😴 Snoozed until {clock(until)}"
    else:
        return
    note("listener", f"snooze: {choice}")
    call(config, "answerCallbackQuery", {"callback_query_id": query["id"], "text": toast})
    if message.get("message_id"):
        call(config, "editMessageText", {"chat_id": message["chat"]["id"], "message_id": message["message_id"],
                                         "text": f"{message.get('text', '')}\n{line}"})


def finished_clock(when):
    """"8:25 PM" today, "yesterday" the day before, else ">1 day" (calendar days)."""
    if not when:
        return "time unknown"
    finished = datetime.fromtimestamp(when)
    days = (datetime.now().date() - finished.date()).days
    if days <= 0:
        return finished.strftime("%I:%M %p").lstrip("0")
    return "yesterday" if days == 1 else ">1 day"


def archive_keyboard(sessions):
    """One button per (local_id, label), plus Archive All under them when there are two or more."""
    keyboard = [[{"text": label, "callback_data": f"archive:{local_id}"}] for local_id, label in sessions]
    if len(sessions) > 1:
        keyboard.append([{"text": "Archive All", "callback_data": ARCHIVE_ALL}])
    return keyboard


def listed_sessions(keyboard):
    """(local_id, label) for each session button still on an /archive message."""
    return [(b["callback_data"].removeprefix("archive:"), b["text"]) for row in keyboard for b in row
            if (b.get("callback_data") or "").startswith("archive:")]


def archive_result(title, outcome, detail):
    """(toast, line) for an archive's outcome."""
    return {
        "archived": ("Archived", f"🗄 {title}: archived"),
        "already": ("It was already archived", f"🗄 {title}: already archived"),
        "gone": ("That session is gone", f"⏹ {title}: no longer in the app"),
        "busy": ("Not archived: it isn't finished", f"⏳ {title}: not archived, {detail}"),
    }.get(outcome, ("Couldn't archive it", f"⚠️ {title}: couldn't archive it ({detail})"))


def chat_call(config):
    """call() for cleanup.py, which leaves out the chat."""
    return lambda method, body: call(config, method, {"chat_id": config["telegram_chat_id"], **body})


def note_cleared(key, deleted, error):
    if deleted or error:
        note(key, f"archived session's pushes: {deleted} deleted" + (f", failed: {error}" if error else ""))


def clear_pushes(config, local_id):
    """Deletes a session's pushes from the chat once /archive has archived it."""
    key = local_id.removeprefix(APP_PREFIX)
    note_cleared(key, *cleanup.delete_session(key, chat_call(config)))


def archive_session(config, key):
    """archive.archive's (outcome, detail) for the desktop app's session `key`,
    or, for a key starting with app:, for the local app's."""
    if not key.startswith(APP_PREFIX):
        return archive.archive(key)
    app = local_app.settings(config)
    if not app:
        return "failed", "the local app isn't set up any more"
    try:
        result = local_app.archive(app, key.removeprefix(APP_PREFIX))
    except local_app.AppError as e:
        return "busy", str(e)[:200]  # the app says why it won't, such as a turn still running
    if result is local_app.NO_APP:
        return "failed", f"{app['name']} isn't answering"
    return ("archived", "") if result[0] else ("failed", f"{app['name']} didn't archive it")


def sweep_archived():
    """Runs on its own thread: every cleanup.SWEEP_EVERY seconds, deletes the
    pushes of sessions archived since (at the PC, or anywhere /archive missed)."""
    while True:
        config = read_config()
        if config.get("telegram_token") and config.get("telegram_chat_id"):
            try:
                for cleared in cleanup.sweep(chat_call(config)):
                    note_cleared(*cleared)
            except Exception as e:
                note("listener", f"archive sweep failed: {type(e).__name__}")
        time.sleep(cleanup.SWEEP_EVERY)


def handle_archive(config, message):
    finished, others, app_start = archive.review()
    app, listed = app_sessions(config)
    in_app = [s for s in local_app.finished_sessions(listed) if app_button_data("archive:", s)] if app else []
    if not app_start and not app:
        send(config, "Claude isn't running on the PC, so nothing can be archived.")
    elif (finished and app_start) or in_app:
        # The full titles go in the text, which wraps: Telegram shows a button's
        # text on one line and cuts a long one off.
        desktop = finished[:ARCHIVE_LIST] if app_start else []
        rows = [(e["id"], e["title"], f"{e['title']} ({finished_clock(e['finished'])})") for e in desktop]
        for s in in_app[: max(0, ARCHIVE_LIST - len(rows))]:
            title = local_app.title_of(s)
            rows.append((APP_PREFIX + local_app.session_key(s), f"{title} · {app['name']}", title))
        lines = []
        for n, (_, _, text) in enumerate(rows, 1):
            if app and n == 1:  # with two apps' sessions in one list, headings say which is which
                lines.append("Claude desktop app:" if desktop else f"{app['name']}:")
            elif app and desktop and n == len(desktop) + 1:
                lines.append(f"{app['name']}:")
            lines.append(f"{n}. {text}")
        more = (len(finished) if app_start else 0) + len(in_app) - len(rows)
        send(config, "Finished sessions that aren't archived"
             + (". " if app else ", newest first, with when each finished. ")
             + ("Tap one to archive it, or Archive All at the bottom:\n\n" if len(rows) > 1
                else "Tap it to archive it:\n\n")
             + "\n".join(lines)
             + (f"\n\n({more} more not shown: send /archive again after these.)" if more > 0 else ""),
             archive_keyboard([(key, label) for key, label, _ in rows]))
    else:
        send(config, "No finished sessions to archive.")
    note("listener", f"/archive: {len(finished)} listed, {len(others)} not finished"
         + (f", {len(in_app)} in {app['name']}" if app else ""))


def handle_archive_tap(config, query):
    data = query.get("data") or ""
    message = query.get("message") or {}
    if message.get("message_id") in archiving_all:
        call(config, "answerCallbackQuery", {"callback_query_id": query["id"], "text": "Archive All is still going"})
        return
    keyboard = (message.get("reply_markup") or {}).get("inline_keyboard") or []
    tapped = next((b["text"] for row in keyboard for b in row if b.get("callback_data") == data), "That session")
    title = tapped.rsplit(" · idle ", 1)[0]  # buttons sent before 2026-10-22 end with " · idle 3 h"
    outcome, detail = archive_session(config, data.removeprefix("archive:"))
    toast, line = archive_result(title, outcome, detail)
    note("listener", f"archive tap: {outcome}{': ' + detail if detail else ''}")
    call(config, "answerCallbackQuery", {"callback_query_id": query["id"], "text": toast})
    if message.get("message_id"):
        # Only an archived (or vanished) session's button goes; a busy one can be tapped again later.
        done = outcome in ("archived", "already", "gone")
        remaining = [s for s in listed_sessions(keyboard) if not (done and f"archive:{s[0]}" == data)]
        body = {"chat_id": message["chat"]["id"], "message_id": message["message_id"],
                "text": f"{message.get('text', '')}\n{line}"}
        if remaining:
            body["reply_markup"] = {"inline_keyboard": archive_keyboard(remaining)}
        call(config, "editMessageText", body)
    if outcome in ("archived", "already"):
        clear_pushes(config, data.removeprefix("archive:"))


def handle_archive_all(config, query):
    """Archives every session still listed on an /archive message, one at a
    time (each takes a few seconds in the app's window), keeping a count on the
    message while it goes and taking the buttons off until it's done."""
    message = query.get("message") or {}
    message_id = message.get("message_id")
    sessions = listed_sessions((message.get("reply_markup") or {}).get("inline_keyboard") or [])
    if not message_id or not sessions or message_id in archiving_all:
        call(config, "answerCallbackQuery", {"callback_query_id": query["id"],
                                             "text": "Archive All is still going" if message_id in archiving_all
                                             else "Nothing left to archive"})
        return
    archiving_all.add(message_id)
    try:
        total = len(sessions)
        text = message.get("text", "")
        call(config, "answerCallbackQuery", {"callback_query_id": query["id"],
                                             "text": f"Archiving {total} session{'s' if total > 1 else ''}"})

        def edit(status, keyboard=None):
            body = {"chat_id": message["chat"]["id"], "message_id": message_id, "text": f"{text}\n{status}"}
            if keyboard:
                body["reply_markup"] = {"inline_keyboard": keyboard}
            call(config, "editMessageText", body)

        edit(f"🗄 Archiving all {total}: 0 done")
        archived, lines, kept = 0, [], []
        for done, (local_id, label) in enumerate(sessions, 1):
            title = label.rsplit(" · idle ", 1)[0]
            outcome, detail = archive_session(config, local_id)
            note("listener", f"archive all: {outcome}{': ' + detail if detail else ''}")
            if outcome in ("archived", "already"):
                clear_pushes(config, local_id)
            if outcome == "archived":
                archived += 1
            else:
                lines.append(archive_result(title, outcome, detail)[1])
                if outcome not in ("already", "gone"):
                    kept.append((local_id, label))  # busy or failed: its button stays to try again
            if done < total:
                edit(f"🗄 Archiving all {total}: {done} done")
        edit("\n".join([f"🗄 Archived {archived} of {total}"] + lines), archive_keyboard(kept))
    finally:
        archiving_all.discard(message_id)


def handle_hint(config, message):
    commands = [f"/{c['command']}" if c["command"] else f'"{c["first_line"][0]}"'
                for c in external_commands(config) if c["command"] or c["first_line"]]
    send(config, "I know these commands: " + ", ".join(commands + ["/notify_me", "/snooze", "/archive"]),
         reply_to=message.get("message_id"))


def handle_ask(config, waiting, message):
    """Asks a command's question, as a reply Telegram opens for you."""
    command = waiting["command"]
    markup = {"force_reply": True}
    if command.get("ask_placeholder"):
        markup["input_field_placeholder"] = command["ask_placeholder"][:64]
    answer = send(config, command["ask"], reply_to=message.get("message_id"), markup=markup)
    waiting["message_id"] = (answer.get("result") or {}).get("message_id")
    note("listener", f"{command['name']}: asked for the rest")
    if awaiting is not waiting:
        end_question(config, waiting)  # a message used it up while it was being sent
    else:
        save_state()


def end_question(config, waiting):
    """Deletes a question that takes no more answers. Telegram's iPhone app
    treats the chat's newest ForceReply message as still asking, and keeps
    opening a reply to it whenever the chat opens, until that message goes."""
    message_id = waiting.pop("message_id", None)  # pop: two threads may end it
    if message_id:
        call(config, "deleteMessage", {"chat_id": config["telegram_chat_id"], "message_id": message_id})
        note("listener", f"{waiting['command']['name']}: question deleted")


def expire_question(config):
    """Ends the open question once ASK_SECONDS have passed with no answer."""
    global awaiting
    if awaiting and time.time() > awaiting["expires"]:
        waiting, awaiting = awaiting, None
        workers.submit(guarded, end_question, config, waiting)


def get_choices(command):
    """The command's choices from its "choices" program, or [] if it fails."""
    try:
        result = subprocess.run(resolve_run(command["choices"]), text=True, encoding="utf-8", timeout=CHOICES_TIMEOUT,
                                creationflags=NO_WINDOW, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        choices = json.loads(result.stdout).get("choices") or []
        return [c for c in choices if isinstance(c, str) and c.strip()]
    except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired) as e:
        note("listener", f"{command['name']}: choices failed: {type(e).__name__}")
        return []


def handle_choose(config, command, message):
    """Offers the command's choices as buttons, or asks its question at once if
    there are none."""
    global awaiting, offered
    choices = get_choices(command)
    if not choices:
        awaiting = {"command": command, "head": None, "message_id": None, "expires": time.time() + ASK_SECONDS}
        handle_ask(config, awaiting, message)
        return
    labels =[command.get("choose_default") or "As it is"] + choices
    # A switch_inline_query_current_chat button fills the message box with
    # "@<bot> Work: " and brings the keyboard up; a ForceReply question never
    # opens the keyboard on Telegram's iPhone app.
    buttons = [{"text": label if len(label) <= CHOICE_LABEL else label[: CHOICE_LABEL - 1] + "…",
                "switch_inline_query_current_chat": f"{label}: "} for label in labels]
    keyboard = [buttons[i:i + 2] for i in range(0, len(buttons), 2)]
    answer = send(config, command["choose"], keyboard, reply_to=message.get("message_id"))
    question = (answer.get("result") or {}).get("message_id")
    if question:
        offered = {"message_id": question, "text": command["choose"]}
    note("listener", f"{command['name']}: offered {len(choices)} choices")


def bare_line(command):
    """The command alone: its slash command, or its first first_line."""
    return f"/{command['command']}" if command["command"] else command["first_line"][0]


def filled_choice(config, text):
    """(command, head, rest, label) for a message a choice button started, such as
    "@<bot-username> Work: fix it", or None. head is the choice_line with the choice
    in it, or the bare command for the choose_default button."""
    found = FILLED.match(text.strip())
    if not found:
        return None
    label, rest = found.group(1).strip(), found.group(2).strip()
    for command in external_commands(config):
        if command.get("choices") and command.get("choose"):
            default = command.get("choose_default") or "As it is"
            if normalise(label) == normalise(default) or not command.get("choice_line"):
                return command, bare_line(command), rest, label
            return command, command["choice_line"].replace("{}", label), rest, label
    return None


def mark_choice(config, label):
    """Writes the choice under the newest choice question and takes its buttons off."""
    global offered
    question, offered = offered, None
    if question:
        call(config, "editMessageText", {"chat_id": config["telegram_chat_id"], "message_id": question["message_id"],
                                         "text": f"{question['text']}\n→ {label}"})


def handle_stale_pick(config, query):
    """A tap on a choice button from before choices filled the message box."""
    message = query.get("message") or {}
    call(config, "answerCallbackQuery", {"callback_query_id": query["id"], "text": "That question has expired."})
    if message.get("message_id"):
        call(config, "editMessageText", {"chat_id": message["chat"]["id"], "message_id": message["message_id"],
                                         "text": f"{message.get('text', '')}\nExpired. Send the command again."})


def normalise(line):
    return line.strip().rstrip(".").strip().lower()


def external_commands(config):
    """The valid entries of "telegram_commands" in the config."""
    commands = []
    for c in config.get("telegram_commands") or []:
        if isinstance(c, dict) and c.get("name") and isinstance(c.get("run"), list) and c["run"]:
            first = c.get("first_line") or []
            slash = str(c.get("command") or "").lower().lstrip("/")
            commands.append({**c, "first_line": [first] if isinstance(first, str) else list(first),
                             "command": slash if COMMAND_NAME.match(slash) else None})
    return commands


def menu_commands(config):
    """The bot's command menu: the external slash commands, then /notify_me."""
    menu = [{"command": c["command"], "description": (c.get("description") or c["name"])[:256]}
            for c in external_commands(config) if c["command"]]
    return menu + BOT_COMMANDS


def matches_pattern(command, line):
    try:
        return bool(command.get("first_line_match")) and \
            re.fullmatch(command["first_line_match"], line.strip(), re.IGNORECASE) is not None
    except re.error:
        return False


def matching_command(config, text):
    """(command, rest, head) for the external command a message starts with, or
    (None, None, None). rest is what follows it: the lines under a first-line
    match, or everything after a slash command. head is the first line when
    "first_line_match" matched it (it says more than the bare command), else None."""
    text = text.strip()
    first = text.splitlines()[0] if text else ""
    slash = SLASH.match(first)
    for command in external_commands(config):
        if normalise(first) in (normalise(f) for f in command["first_line"]):
            return command, "\n".join(text.splitlines()[1:]).strip(), None
        if slash and command["command"] == slash.group(1).lower():
            return command, text[slash.end():].strip(), None
        if not slash and matches_pattern(command, first):
            return command, "\n".join(text.splitlines()[1:]).strip(), first.strip()
    return None, None, None


def take_answer(message):
    """The command whose question this message answers, if any: the next message
    after the question, within ASK_SECONDS, unless it replies to another message.
    Any message uses the question up."""
    global awaiting
    waiting, awaiting = awaiting, None
    if not waiting or time.time() > waiting["expires"]:
        return None
    replied = (message.get("reply_to_message") or {}).get("message_id")
    if replied and replied != waiting.get("message_id"):
        return None
    return waiting


def run_external(command, payload):
    """Runs one external command for one message or tap, replying if it fails."""
    timeout = command.get("timeout") or DEFAULT_COMMAND_TIMEOUT
    started, reason = time.monotonic(), None
    try:
        result = subprocess.run(resolve_run(command["run"]), input=json.dumps(payload), text=True, encoding="utf-8",
                                timeout=timeout, creationflags=NO_WINDOW, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        outcome = f"exit {result.returncode}"
        if result.returncode:
            reason = f"exit code {result.returncode}"
    except subprocess.TimeoutExpired:
        outcome = reason = f"no answer after {timeout} s"
    except (OSError, ValueError) as e:
        outcome = reason = f"couldn't start it: {type(e).__name__}"
    note("listener", f"{command['name']}: {outcome} ({time.monotonic() - started:.1f}s)")
    if reason:
        config = read_config()
        if config.get("telegram_token"):
            send(config, f"Couldn't run {command['name']} ({reason})", reply_to=payload.get("message_id"))


def run_queue(jobs):
    while True:
        command, payload = jobs.get()
        try:
            run_external(command, payload)
        except Exception as e:
            note("listener", f"{command.get('name')} failed: {type(e).__name__}")


def queue_external(command, message, tap=None):
    """Queues a run of the command for a message, or for a tap on its buttons."""
    if tap:
        payload = {"chat_id": tap["message"]["chat"]["id"], "received_at": time.time(),
                   "callback": {"id": tap["id"], "data": tap.get("data"),
                                "message_id": tap["message"].get("message_id"), "text": tap["message"].get("text", "")}}
    else:
        payload = {"chat_id": message["chat"]["id"], "message_id": message.get("message_id"),
                   "date": message.get("date"), "received_at": time.time(), "text": message.get("text", "")}
    jobs = runners.get(command["name"])
    if jobs is None:
        jobs = runners[command["name"]] = queue.Queue()
        threading.Thread(target=run_queue, args=(jobs,), daemon=True).start()
    jobs.put((command, payload))


def dispatch_tap(query, config):
    global awaiting
    data = query.get("data") or ""
    message = query.get("message") or {}
    if data.startswith("on:"):
        workers.submit(guarded, handle_tap, config, query)
        return
    if data.startswith("snooze:"):
        workers.submit(guarded, handle_snooze_tap, config, query)
        return
    if data.startswith("archive:"):
        workers.submit(guarded, handle_archive_tap, config, query)
        return
    if data == ARCHIVE_ALL:
        workers.submit(guarded, handle_archive_all, config, query)
        return
    if data.startswith("pick:"):
        workers.submit(guarded, handle_stale_pick, config, query)
        return
    for command in external_commands(config):
        prefix = command.get("callback_prefix")
        if prefix and data.startswith(f"{prefix}:") and message.get("chat"):
            queue_external(command, None, tap=query)
            return


def dispatch(update, config):
    chat = str(config["telegram_chat_id"])
    query = update.get("callback_query")
    if query:
        if str(((query.get("message") or {}).get("chat") or {}).get("id")) == chat:
            dispatch_tap(query, config)
        return
    message = update.get("message") or {}
    if str((message.get("chat") or {}).get("id")) != chat or not message.get("text"):
        return  # other chats are ignored, with no reply
    global awaiting
    used = awaiting
    answers = take_answer(message)
    if used:
        workers.submit(guarded, end_question, config, used)
    fresh = time.time() - (message.get("date") or 0) <= MAX_MESSAGE_AGE
    filled = filled_choice(config, message["text"])
    if filled:
        command, head, rest, label = filled
        note("listener", f"{command['name']}: choice filled in")
        workers.submit(guarded, mark_choice, config, label)
        if rest:
            queue_external(command, {**message, "text": f"{head}\n{rest}"})
        elif fresh:
            awaiting = {"command": command, "head": head, "message_id": None, "expires": time.time() + ASK_SECONDS}
            workers.submit(guarded, handle_ask, config, awaiting, message)
        return
    command, rest, head = matching_command(config, message["text"])
    if command and (rest or not command.get("ask")):
        # Old ones too: the command decides what's too old and says so
        # (the phone launcher replies "Not started, too old").
        queue_external(command, message)
        return
    if command:
        if fresh and head is None and command.get("choices") and command.get("choose"):
            workers.submit(guarded, handle_choose, config, command, message)
        elif fresh:
            awaiting = {"command": command, "head": head, "message_id": None, "expires": time.time() + ASK_SECONDS}
            workers.submit(guarded, handle_ask, config, awaiting, message)
        return
    first = message["text"].strip().splitlines()[0] if message["text"].strip() else ""
    word = first.split()[0] if first.split() else ""
    if fresh and NOTIFY_ME_COMMAND.match(word):
        workers.submit(guarded, handle_notify_me, config, message)
        return
    if fresh and SNOOZE_COMMAND.match(word):
        workers.submit(guarded, handle_snooze, config, message)
        return
    if fresh and ARCHIVE_COMMAND.match(word):
        workers.submit(guarded, handle_archive, config, message)
        return
    if answers:
        head = answers["head"] or bare_line(answers["command"])
        queue_external(answers["command"], {**message, "text": f"{head}\n{message['text']}"})
        return
    if fresh:
        workers.submit(guarded, handle_hint, config, message)


def single_instance():
    """True if this is the only listener running (Windows: a named mutex)."""
    if sys.platform != "win32":
        return True
    import ctypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    globals()["mutex"] = kernel32.CreateMutexW(None, False, MUTEX_NAME)  # held until exit
    return ctypes.get_last_error() != 183  # ERROR_ALREADY_EXISTS


def main():
    if not single_instance():
        return
    offset, registered, failing = saved_state("offset"), None, False
    leftover = saved_state("question")  # asked before a restart, so nothing will take its answer
    threading.Thread(target=sweep_archived, daemon=True).start()
    while True:
        save_state(offset)
        config = read_config()
        token = config.get("telegram_token")
        if not (token and config.get("telegram_chat_id")):
            # Not set up yet. Not polling also leaves install.py free to read
            # the bot's messages while it looks for your chat.
            time.sleep(NO_CONFIG_WAIT)
            continue
        if leftover:
            call(config, "deleteMessage", {"chat_id": config["telegram_chat_id"], "message_id": leftover})
            note("listener", "question from before the restart deleted")
            leftover = None
        expire_question(config)
        menu = menu_commands(config)
        if registered != (token, menu):
            call(config, "setMyCommands", {"commands": menu})  # the command menu in Telegram
            registered = (token, menu)
        body = {"timeout": POLL_TIMEOUT, "allowed_updates": ["message", "callback_query"]}
        if offset:
            body["offset"] = offset
        try:
            status, reply = telegram_call(token, "getUpdates", body, timeout=POLL_TIMEOUT + 15)
        except Exception as e:
            if not failing:
                note("listener", f"getUpdates failed: {type(e).__name__}")
            failing = True
            time.sleep(10)
            continue
        if not reply.get("ok"):
            # 409: another program is reading the bot's messages (install.py
            # looking for your chat, or a second listener on another PC).
            if not failing:
                note("listener", f"getUpdates failed: HTTP {status} {reply.get('description')}")
            failing = True
            time.sleep(30)
            continue
        failing = False
        for update in reply.get("result") or []:
            offset = update["update_id"] + 1
            save_state(offset)  # before handling it, so a crash never replays it
            try:
                dispatch(update, config)
            except Exception as e:
                note("listener", f"dispatch failed: {type(e).__name__}")


if __name__ == "__main__":
    main()
