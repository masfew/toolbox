#!/usr/bin/env python3
"""
Claude Code "notify me" hook, phone-bridge's notifications.

Sends push notifications (through your own Telegram bot) ONLY for prompts
ending with "notify me" (or similar),
or sent while you're away from the PC (e.g. from your phone through Remote Control):
  - when Claude asks a question (AskUserQuestion)
  - when Claude is waiting on a permission prompt
  - when Claude pauses to wait on background work (hourglass; paused for now,
    off unless the config sets "waiting_pushes": true)
  - when Claude finishes the prompt (check mark)
"Notify me when you're done" (or similar) skips the hourglass pushes.
A session another session starts takes on that session's pushes, and the
starting session stays quiet about it. Every other prompt stays silent. No dependencies beyond Python 3.
"""
import html
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from core.bridge import (  # noqa: E402
    LISTENER_SCRIPT, MARKER_DIR, PRESENCE_SCRIPT, listener_running, log, presence_state, read_config,
    snoozed_until, start_in_background, telegram_call,
)
from notify.cleanup import remember  # noqa: E402
from notify.sessions import (  # noqa: E402
    FLAG_DIR, HOST_SESSION_VAR, background_work_pending, clear_active, desktop_record, is_prompt,
    mark_active, prompts_queued, result_text, session_title,
)

# ---- Settings ----
# The bot token and chat are in ~/.claude/phone-bridge.json (core/bridge.py).
MESSAGE_LIMIT = 500  # characters a push's message is cut to, whatever made it
# A closing message used as a push body (when the turn has no wrap_up recap) is
# shortened to whole paragraphs or sentences within this many characters.
BODY_LIMIT = 300
OPTION_LIMIT = 120  # characters of a question's option labels on one line
DETAIL_LIMIT = 100  # characters of what a permission prompt's tool call does
# The ⏳ "waiting" push when Claude pauses on background work is off unless the
# config sets "waiting_pushes": true. With many sessions running at once they
# can flood the chat; ❓, ⚠️ and ✅ pushes are unaffected.
WAITING_PUSHES_SETTING = "waiting_pushes"
TELEGRAM_MAX_RETRY_WAIT = 3  # seconds; longer flood-control waits give up
# Each push's tag -> (the emoji leading its message, its kind in the log)
PUSH_KINDS = {
    "question": ("❓", "question"),
    "warning": ("⚠️", "permission"),
    "hourglass_flowing_sand": ("⏳", "waiting"),
    "white_check_mark": ("✅", "done"),
    "rocket": ("🚀", "started"),
}
# Matches only when the prompt ends with "notify me" (or "send me a notification"),
# so the words used in passing ("these notify me changes") don't count. Trailing
# punctuation and attached-image markers are allowed after it. The one longer
# ending, "notify me when you're done" (once it's finished, at the end...), is
# the "final" group and skips progress pushes.
TRIGGER = re.compile(
    r"\b(?:notify me|send me a notification)"
    r"(?P<final>\s+(?:when|once|after)\b[^.!?\n]{0,30}?\b(?:done|finish\w*|complete\w*)|\s+at the end)?"
    r"(?:[\s.!?,;:)'\"]|\[Image #\d+\])*$",
    re.IGNORECASE,
)
# Prompts the app generates itself (not typed by the user): background-task
# results, and subagent hand-backs / messages from other sessions.
AUTO_PROMPT_PREFIXES = (
    "<task-notification>",
    "<agent-message",
    "Another Claude session sent a message:",
)
# The desktop app's own event prompts: a note that a session you started finished
# a turn, or CI news on a watched PR. They open with a <system-reminder>, which
# the user's own first prompt can too, so they're matched by their event tag.
AUTO_PROMPT_EVENT = re.compile(r"^<(side-sessions-event|ci-monitor-event)>", re.MULTILINE)
# Of those, the ones that report on another session's work (a session you started
# finished a turn, or another session messaged you). That session sends its own
# pushes, so a turn these start sends no "done" or "waiting" push.
SESSION_REPORT = re.compile(r"^<side-sessions-event>|^<agent-message|^Another Claude session", re.MULTILINE)
# A subagent's result comes back in the same "Another Claude session sent a
# message" wrapper, marked as a hand-back near the top. It's this session's own
# work, so the turn it starts pushes like any other.
SUBAGENT_HANDBACK = "[Subagent hand-back]"
# A start_session / hand_off_to_session call that actually started a session
# (proposals and refusals don't). The new session takes over the pushes.
SESSION_TOOLS = ("mcp__ccd_session__start_session", "mcp__ccd_session__hand_off_to_session")
SESSION_STARTED = re.compile(r"^\s*(Started|Handed|Moved)\b.*\bsession_id: local_", re.DOTALL)
# The desktop app also raises a permission prompt for Claude's question dialog
# ("Claude needs your permission to use AskUserQuestion").
QUESTION_PERMISSION = re.compile(r"\bpermission to use AskUserQuestion\b")
# A permission prompt's message names the tool ("Claude needs your permission to use Bash").
PERMISSION_TOOL = re.compile(r"\bpermission to use (\S+)")
# Each push links to the session, or the Code tab (the Claude app on the phone, if
# installed), written out at the end of the message. Not a tap action, so tapping
# the banner still opens Telegram to read the message.
CODE_URL = "https://claude.ai/code"
# A Remote Control session's id, recorded in its transcript; its page is
# claude.ai/code/session_<same suffix>.
BRIDGE_SESSION = re.compile(r'"bridgeSessionId":"cse_(\w+)"')
# A session another session starts opens with the starting session's brief. That
# first prompt can arrive before the app has written who started the session into
# its record (from late 2026-10-19, 5 of 6 new sessions whose starting session
# had pushes on missed them, 2-3 s after their record was created), so the hook
# waits for the record to catch up.
SPAWN_BRIEF = re.compile(r"^Background \(from the session that started this one\):", re.MULTILINE)
SPAWN_RECORD_WAIT = 10  # seconds
# A closing message shorter than this says too little on its own, so the push
# adds the turn's summary (the desktop app's next-step box) or task-list progress.
SHORT_MESSAGE = 200  # characters
# The desktop app's task list and next-step box, and the CLI's todo list.
PLAN_TOOL = "mcp__ccd_turn__update_plan"
WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up"
TODO_TOOL = "TodoWrite"
push_session = "unknown"  # the session ID that push() logs, set in main()
# The desktop record ID the push belongs to, so cleanup.py can delete the
# session's pushes once it's archived; None outside the app.
push_record = None
# Away detection (Windows): core/presence.py records your last real keyboard or
# mouse input, ignoring input that programs simulate. A prompt that arrives after
# this long without real input wasn't typed at the PC, so it turns pushes on.
AWAY_AFTER = 15  # seconds; typing or clicking Send at the PC is always more recent
# A claude that a program drives through the Agent SDK or `claude -p` ("sdk-ts",
# "sdk-py", "sdk-cli") gets its prompts from that program, not from you, so being
# away from the PC never turns its pushes on; only "notify me" does. A test run
# by a session that had stripped CLAUDE_* variables through Git Bash (whose
# process chain run_by_another_claude can't follow) once sent about 30 pushes
# this way.
ENTRYPOINT_VAR = "CLAUDE_CODE_ENTRYPOINT"
# The phone launcher (launcher/launch.py) writes a marker in MARKER_DIR holding
# the prompt just before it presses Enter in a new session it starts from a
# Telegram command. The first prompt that matches one turns pushes on and sends a
# "started" push; a test launch's marker ("test": true) turns pushes off instead.
# The "started" push waits in the background for the app to title the new session.
STARTED_TITLE_WAIT = 20  # seconds


def session_url(transcript_path):
    """The session's own page when it's connected to Remote Control, else the Code tab."""
    try:
        ids = BRIDGE_SESSION.findall(Path(transcript_path).read_text(encoding="utf-8"))
        if ids:
            return f"{CODE_URL}/session_{ids[-1]}"
    except (OSError, TypeError, ValueError):
        pass
    return CODE_URL


def push(title, message, tags, url=CODE_URL):
    """Sends a push through Telegram and logs the result; returns True only if
    the push was accepted. Never raises: a missing config or failed push must
    never disrupt Claude Code."""
    started = time.monotonic()
    silent = snoozed_until() is not None
    try:
        result = send_telegram(read_config(), title, message, tags, url, silent)
    except Exception as e:
        # Only the error's type: a message could hold the URL, which holds the bot token.
        result = f"failed: {type(e).__name__}"
    kind = PUSH_KINDS.get(tags, ("", tags))[1]
    snoozed = ", silent: snoozed" if silent else ""
    log(push_session, None, f"{result} ({kind} push{snoozed}, {time.monotonic() - started:.2f}s)", kind="push")
    if result.startswith("ok message_id="):
        remember(push_record or push_session, result.removeprefix("ok message_id="))
    return result.startswith("ok")


def send_telegram(config, title, message, tags, url, silent=False):
    """A message to your chat with the bot: the kind's emoji and the title in bold,
    the message below, and the session's link written out on the last line. The
    link is shown in full because Telegram opens a visible link in one tap, but asks
    "Open this link?" first for a button or a link behind a label. The banner shows
    the text plain under the bot's name, about four lines, so the link stays out of
    it. Every push makes a sound, unless it's silent (during a /snooze)."""
    emoji = PUSH_KINDS.get(tags, ("",))[0]
    message = message.strip()[:MESSAGE_LIMIT]
    escaped = (f"<b>{html.escape(title, quote=False)}</b>\n{html.escape(message, quote=False)}"
               f"\n\n{html.escape(url, quote=False)}")
    body = {
        "chat_id": config["telegram_chat_id"], "text": f"{emoji} {escaped}".strip(), "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
    }
    if silent:
        body["disable_notification"] = True
    waited = False
    while True:
        status, reply = telegram_call(config["telegram_token"], "sendMessage", body)
        if reply.get("ok"):
            return f"ok message_id={reply['result']['message_id']}"
        description = reply.get("description") or f"HTTP {status}"
        wait = (reply.get("parameters") or {}).get("retry_after")
        if status == 400 and "can't parse entities" in description and "parse_mode" in body:
            # Escaping should prevent this; if Telegram still can't read the formatting, send it plain.
            body = {k: v for k, v in body.items() if k != "parse_mode"}
            body["text"] = f"{emoji} {title}\n{message}\n\n{url}".strip()
        elif status == 429 and not waited and wait is not None and wait <= TELEGRAM_MAX_RETRY_WAIT:
            waited = True  # several sessions finished at once: wait out flood control once
            time.sleep(wait)
        else:
            return f"failed: HTTP {status} {description}"


def run_by_another_claude():
    """True if this hook's claude was started (at any depth) by another Claude
    Code process, i.e. some session ran it. Windows only. The desktop app is
    also claude.exe, so it's told apart by its install path."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        class Entry(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                        ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k32.OpenProcess.restype = wintypes.HANDLE
        snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # all processes
        procs, entry = {}, Entry()
        entry.dwSize = ctypes.sizeof(Entry)
        ok = k32.Process32FirstW(wintypes.HANDLE(snap), ctypes.byref(entry))
        while ok:
            procs[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
            ok = k32.Process32NextW(wintypes.HANDLE(snap), ctypes.byref(entry))
        k32.CloseHandle(wintypes.HANDLE(snap))

        def info(pid):
            """(image path, creation time) of a process, or (None, None)."""
            handle = k32.OpenProcess(0x1000, False, pid)  # query limited information
            if not handle:
                return None, None
            try:
                buf, size = ctypes.create_unicode_buffer(1024), wintypes.DWORD(1024)
                path = buf.value if k32.QueryFullProcessImageNameW(
                    wintypes.HANDLE(handle), 0, buf, ctypes.byref(size)) else None
                times = [wintypes.FILETIME() for _ in range(4)]
                created = (times[0].dwHighDateTime << 32 | times[0].dwLowDateTime) if k32.GetProcessTimes(
                    wintypes.HANDLE(handle), *[ctypes.byref(t) for t in times]) else None
                return path, created
            finally:
                k32.CloseHandle(wintypes.HANDLE(handle))

        clis, pid, seen = 0, os.getpid(), set()
        _, child_created = info(pid)
        while pid in procs and pid not in seen and len(seen) < 40:
            seen.add(pid)
            pid, _ = procs[pid]
            if pid not in procs:
                break
            path, created = info(pid)
            # A parent can't start after its child; if it did, the parent exited
            # and its process ID was reused, so the chain ends here.
            if created and child_created and created > child_created:
                break
            child_created = created or child_created
            desktop_app = path and re.search(r"\\WindowsApps\\|\\AnthropicClaude\\", path, re.IGNORECASE)
            if procs[pid][1] == "claude.exe" and path and not desktop_app:
                clis += 1  # the first is this session's own claude
                if clis > 1:
                    return True
    except Exception:
        pass  # can't tell: treat it as the user's
    return False


def spawn_record(local_id, record):
    """For a prompt that is a new session's brief: the session's record once it
    names the session that started it, waiting up to SPAWN_RECORD_WAIT. Returns
    (record, seconds waited)."""
    started = time.monotonic()
    while (local_id and not (record.get("spawnedFrom") and record.get("cliSessionId"))
           and time.monotonic() - started < SPAWN_RECORD_WAIT):
        time.sleep(0.25)
        record = desktop_record(local_id)
    return record, time.monotonic() - started


def inherited_mode(record):
    """For a session another session started, its first prompt (the brief)
    takes on the starting session's pushes: "all", "final", or None if off."""
    parent = (record.get("spawnedFrom") or {}).get("sessionId")
    if not parent or (record.get("completedTurns") or 0) > 0:
        return None
    parent_cli = desktop_record(parent).get("cliSessionId")
    if not parent_cli:
        return None
    try:
        return (FLAG_DIR / parent_cli).read_text().strip() or "all"
    except OSError:
        return None  # no flag: the starting session's pushes are off


def same_prompt(text):
    """The prompt as typed: line endings evened out, and without the notes the app
    puts in front of it (a No folder session's first prompt opens with a
    <system-reminder> about its scratch workspace)."""
    text = re.sub(r"\r\n?", "\n", text or "")
    return re.sub(r"^(?:\s*<system-reminder>.*?</system-reminder>)+", "", text, flags=re.DOTALL).strip()


def launch_marker(prompt):
    """The phone launcher's marker for this prompt, removed once matched; None if
    there's none. Expired markers are removed on the way."""
    wanted = same_prompt(prompt)
    try:
        paths = list(MARKER_DIR.glob("*.json"))
    except OSError:
        return None
    for path in paths:
        try:
            marker = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(marker, dict) or (marker.get("expires") or 0) < time.time():
            path.unlink(missing_ok=True)
        elif same_prompt(marker.get("prompt")) == wanted:
            path.unlink(missing_ok=True)
            return marker
    return None


def started_push(session_id):
    """Run in the background for a session the phone launcher started: waits for
    the app to title it, then pushes "<title> · started" with the prompt."""
    global push_session, push_record
    push_session = session_id
    path = FLAG_DIR / f"{session_id}.started"
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
        path.unlink()
    except (OSError, ValueError):
        return
    push_record = info.get("record")
    deadline = time.monotonic() + STARTED_TITLE_WAIT
    record = desktop_record(info.get("record"))
    while not record.get("title") and time.monotonic() < deadline:
        time.sleep(1)
        record = desktop_record(info.get("record"))
    bridge = record.get("bridgeSessionIds") or []
    url = f"{CODE_URL}/{bridge[-1]}" if bridge else CODE_URL
    push(f"{record.get('title') or 'New session'} · started", info.get("prompt") or "", "rocket", url)


def seconds_since_real_input():
    """Seconds since the last real keyboard or mouse input, or None if unknown
    (the watcher isn't running or hasn't seen any input since it started)."""
    state = presence_state()
    last = state and state.get("last_real_input")
    return time.time() - last if last else None


def user_is_away(idle):
    """True unless real input happened in the last AWAY_AFTER seconds. Unknown
    counts as away: an extra push beats a missed one."""
    return idle is None or idle > AWAY_AFTER


def driven_by_program():
    """The entry point ("sdk-ts", "sdk-cli", ...) if a program drives this claude
    through the Agent SDK or `claude -p`, else None."""
    entrypoint = os.environ.get(ENTRYPOINT_VAR, "")
    return entrypoint if entrypoint.startswith("sdk") else None


def apply_plan_call(steps, name, args):
    """Updates the task list ([content, status] pairs) for one update_plan,
    wrap_up or TodoWrite call."""
    if name == TODO_TOOL:
        return [[t.get("content", ""), t.get("status", "pending")] for t in args.get("todos") or []]
    if name == WRAP_UP_TOOL:
        return [[content, "completed"] for content, _ in steps]
    if args.get("items"):
        return [[i.get("content", ""), i.get("status", "pending")] for i in args["items"]]
    if args.get("advance"):
        current = next((s for s in steps if s[1] == "in_progress"), None)
        if current:
            current[1] = "completed"
        following = next((s for s in steps if s[1] == "pending"), None)
        if following:
            following[1] = "in_progress"
    for n in args.get("done") or []:
        if isinstance(n, int) and 0 < n <= len(steps):
            steps[n - 1][1] = "completed"
    n = args.get("start")
    if isinstance(n, int) and 0 < n <= len(steps):
        for s in steps:
            if s[1] == "in_progress":
                s[1] = "pending"
        steps[n - 1][1] = "in_progress"
    return steps


def turn_details(transcript_path):
    """What the current turn left for a push body: the last text it wrote, its
    latest wrap_up (recap and question), and the task list as it stands."""
    details = {"text": "", "recap": "", "ask": "", "steps": []}
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if is_prompt(entry):
                    details.update(text="", recap="", ask="")  # the task list carries over
                    continue
                if entry.get("type") != "assistant" or entry.get("isSidechain"):
                    continue
                for block in (entry.get("message") or {}).get("content") or []:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and block.get("text", "").strip():
                        details["text"] = block["text"].strip()
                    elif block.get("type") == "tool_use" and block.get("name") in (PLAN_TOOL, WRAP_UP_TOOL, TODO_TOOL):
                        args = block.get("input") or {}
                        details["steps"] = apply_plan_call(details["steps"], block["name"], args)
                        if block["name"] == WRAP_UP_TOOL:
                            details.update(recap=(args.get("recap") or "").strip(), ask=(args.get("ask") or "").strip())
    except (OSError, TypeError):
        pass
    return details


def plain(text):
    """Markdown turned into the plain text a push shows: no code blocks, link
    targets, bold, inline code marks or headings; bullets as •."""
    text = re.sub(r"\r\n?", "\n", text or "")
    text = re.sub(r"^\s*(```|~~~).*?(^\s*\1[^\n]*$|\Z)", "", text, flags=re.MULTILINE | re.DOTALL)
    text = re.sub(r"!?\[([^\]\n]*)\]\([^)\s]*\)", r"\1", text)
    text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)
    text = re.sub(r"`([^`\n]*)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^(\s*)[-*+]\s+", r"\1• ", text, flags=re.MULTILINE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def last_sentence_cut(text):
    """The text without its last sentence, or "" if it's only one."""
    ends = [m.end() for m in re.finditer(r"[.!?](?=\s)", text)]
    return text[:ends[-1]] if ends else ""


def shorten(text, limit=BODY_LIMIT):
    """Whole paragraphs from the start while they fit in `limit`. A first paragraph
    that's too long is cut after its last whole sentence that fits (or a word, with
    "…"), and a lead-in that ends on ":" loses that sentence, since what it
    introduces didn't fit."""
    kept = ""
    for para in re.split(r"\n\s*\n", text.strip()):
        joined = f"{kept}\n\n{para}" if kept else para
        if len(joined) <= limit:
            kept = joined
            continue
        if not kept:
            part = para[:limit + 1]
            kept = last_sentence_cut(part)
            if len(kept) < limit // 3:
                kept = part[:limit].rsplit(None, 1)[0].rstrip(",;:—-") + "…"
        break
    if kept.endswith(":"):
        kept = last_sentence_cut(kept) or kept
    return kept.strip()


def done_message(message, details):
    """The turn's wrap_up recap (written to stand alone, outcome first) and its
    question; without a recap, the start of the closing message in plain text."""
    if details["recap"]:
        body = shorten(plain(details["recap"]), BODY_LIMIT + 100)
        if details["ask"]:
            body += f"\n\nYour call: {plain(details['ask'])}"
        return body
    return shorten(plain(message or details["text"])) or "Claude finished."


def question_message(questions):
    """The first question, its option labels on one line, and how many more there are."""
    first = questions[0] if questions and isinstance(questions[0], dict) else {}
    lines = [plain(first.get("question") or "Claude has a question for you.")]
    labels = [str(o.get("label", "")).strip() for o in first.get("options") or [] if isinstance(o, dict)]
    labels = [label for label in labels if label]
    if labels:
        options = " · ".join(labels)
        lines.append(options if len(options) <= OPTION_LIMIT else options[:OPTION_LIMIT].rsplit(" · ", 1)[0] + " · …")
    if len(questions or []) > 1:
        more = len(questions) - 1
        lines.append(f"+{more} more question{'s' if more > 1 else ''}")
    return "\n".join(lines)


def pending_tool(transcript_path, name):
    """(name, input) of the latest call of that tool in the transcript that has no
    result yet, the one a permission prompt waits on; None if there's none."""
    pending = {}
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                if '"tool_' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("isSidechain"):
                    continue
                content = (entry.get("message") or {}).get("content")
                for block in content if isinstance(content, list) else []:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use":
                        pending[block.get("id")] = (block.get("name") or "", block.get("input") or {})
                    elif block.get("type") == "tool_result":
                        pending.pop(block.get("tool_use_id"), None)
    except (OSError, TypeError):
        return None
    calls = [c for c in pending.values() if c[0] == name]
    return calls[-1] if calls else None


def tool_detail(args):
    """A few words on what a tool call does: its description, the file it touches,
    the host it fetches, or the start of its command."""
    detail = ""
    if isinstance(args.get("description"), str):
        detail = args["description"]
    elif isinstance(args.get("file_path") or args.get("notebook_path"), str):
        detail = Path(args.get("file_path") or args.get("notebook_path")).name
    elif isinstance(args.get("url"), str):
        detail = re.sub(r"^\w+://([^/]+).*", r"\1", args["url"])
    elif isinstance(args.get("command"), str):
        detail = args["command"].strip().splitlines()[0] if args["command"].strip() else ""
    detail = " ".join(detail.split())
    return detail if len(detail) <= DETAIL_LIMIT else detail[:DETAIL_LIMIT].rsplit(None, 1)[0] + "…"


def permission_message(text, transcript_path):
    """"Needs permission for <tool>: <what the call does>", or the prompt's own
    message when it doesn't name a tool (such as an MCP server's form)."""
    match = PERMISSION_TOOL.search(text)
    if not match:
        return text
    name = match.group(1).rstrip(".,")
    call = pending_tool(transcript_path, name)
    detail = tool_detail(call[1]) if call else ""
    shown = name.rsplit("__", 1)[-1] if name.startswith("mcp__") else name
    return f"Needs permission for {shown}" + (f": {detail}" if detail else "")


def waiting_message(message, details, running):
    """The pause message, plus the task list's current step and what's running
    when the message alone is too short to show where things stand."""
    message = shorten(plain(message or details["text"])) or "Waiting on background work."
    if len(message) >= SHORT_MESSAGE:
        return message
    extra, steps = [], details["steps"]
    current = next((i for i, s in enumerate(steps) if s[1] == "in_progress"), None)
    if current is not None:
        extra.append(f"Step {current + 1} of {len(steps)}: {steps[current][0]}")
        done = [content for content, status in steps if status == "completed"]
        if done:
            extra.append("Done: " + "; ".join(done))
    labels = [label for label in running if label]
    if labels:
        extra.append("Running: " + "; ".join(labels))
    return "\n\n".join([message, "\n".join(extra)]) if extra else message


def session_started_this_turn(transcript_path):
    """True if the current turn started a new session that took the work over."""
    started, calls = False, set()
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                if '"user"' not in line and "ccd_session__" not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if is_prompt(entry):
                    started, calls = False, set()
                    continue
                content = (entry.get("message") or {}).get("content")
                for block in content if isinstance(content, list) else []:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use" and block.get("name") in SESSION_TOOLS:
                        calls.add(block.get("id"))
                    elif (block.get("type") == "tool_result" and block.get("tool_use_id") in calls
                          and not block.get("is_error") and SESSION_STARTED.match(result_text(block))):
                        started = True
    except (OSError, TypeError):
        return False
    return started


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--started":
        started_push(sys.argv[2])
        return
    try:
        # Read raw bytes as UTF-8: on Windows, sys.stdin defaults to the ANSI
        # codepage and can choke on non-ASCII prompts.
        data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:
        return

    event = data.get("hook_event_name")
    global push_session, push_record
    session_id = push_session = data.get("session_id", "unknown")
    push_record = os.environ.get(HOST_SESSION_VAR)
    flag = FLAG_DIR / session_id
    # Present only while the latest question's push went out, so its duplicate
    # permission push can be skipped.
    question_pushed = flag.with_name(flag.name + ".question-pushed")
    # Present while the current turn was started by another session's report.
    report_turn = flag.with_name(flag.name + ".report-turn")
    if sys.platform == "win32" and presence_state() is None:
        start_in_background(PRESENCE_SCRIPT)  # every event checks, so it's up long before you leave
    if sys.platform == "win32" and not listener_running():
        start_in_background(LISTENER_SCRIPT)

    # A claude that a session ran itself (a test run, a script) isn't the user's,
    # so it never pushes. It usually inherits that session's record ID while
    # having its own session ID; a script can strip that variable, but it can't
    # hide that a Claude Code process is among its ancestors.
    record = desktop_record(os.environ.get(HOST_SESSION_VAR))
    if (record.get("cliSessionId") and record["cliSessionId"] != session_id) or run_by_another_claude():
        if event == "UserPromptSubmit":
            log(session_id, None, "ignored: claude run by another session")
        return
    # Pushes are titled with the session's title in the app, or else its folder.
    title = session_title(record, data.get("cwd"))

    # Every session's turns are tracked, pushes on or off, so /notify_me can list the
    # ones that are working. App-generated prompts start turns too.
    if event == "UserPromptSubmit":
        mark_active(session_id, data.get("transcript_path"), os.environ.get(HOST_SESSION_VAR),
                    data.get("cwd"), title)
    elif event == "Stop" and not data.get("stop_hook_active"):
        clear_active(session_id, data.get("transcript_path"))

    # Each new prompt turns notifications on (ends with "notify me", or sent
    # while you're away from the PC) or off.
    if event == "UserPromptSubmit":
        prompt = data.get("prompt", "").strip()
        # Background-task results arrive as prompts too; they aren't the
        # user's, so they must not switch notifications on or off.
        if prompt.startswith(AUTO_PROMPT_PREFIXES) or AUTO_PROMPT_EVENT.search(prompt):
            if SESSION_REPORT.search(prompt) and SUBAGENT_HANDBACK not in prompt[:500]:
                if flag.exists():
                    report_turn.touch()
            else:
                # The session's own work reporting back (a background task or a
                # subagent) starts a turn that pushes, even right after a report turn.
                report_turn.unlink(missing_ok=True)
            return
        question_pushed.unlink(missing_ok=True)
        report_turn.unlink(missing_ok=True)
        phrase = TRIGGER.search(prompt)
        idle = seconds_since_real_input() if sys.platform == "win32" else 0
        launched = launch_marker(prompt)
        if launched and launched.get("test"):
            flag.unlink(missing_ok=True)
            log(session_id, idle, "pushes off: phone launcher test")
            return
        if launched:
            FLAG_DIR.mkdir(parents=True, exist_ok=True)
            flag.write_text("all")
            started = flag.with_name(flag.name + ".started")
            started.write_text(json.dumps({"prompt": prompt, "record": os.environ.get(HOST_SESSION_VAR)}),
                               encoding="utf-8")
            start_in_background(Path(__file__).absolute(), "--started", session_id)
            log(session_id, idle, "pushes on (all): phone launcher")
            return
        note = ""  # how long a new session's record took, for checking the wait
        brief = not phrase and SPAWN_BRIEF.search(prompt)
        if brief:
            record, waited = spawn_record(os.environ.get(HOST_SESSION_VAR), record)
            if not record.get("spawnedFrom"):
                note = f" (session record not ready after {waited:.1f}s)"
            elif waited > 0.1:
                note = f" (session record ready after {waited:.1f}s)"
        inherited = inherited_mode(record)
        if phrase:
            FLAG_DIR.mkdir(parents=True, exist_ok=True)
            mode = "final" if phrase.group("final") else "all"
            flag.write_text(mode)
            decision = f"pushes on ({mode}): phrase"
        elif inherited:
            FLAG_DIR.mkdir(parents=True, exist_ok=True)
            flag.write_text(inherited)
            decision = f"pushes on ({inherited}): started by a session with pushes on"
        elif brief:
            # The starting session wrote the brief, often a minute or more after
            # your last input, so time since input says nothing about where you are.
            flag.unlink(missing_ok=True)
            decision = "pushes off: started by a session with pushes off"
        elif driven_by_program():
            flag.unlink(missing_ok=True)
            decision = f"pushes off: driven by a program ({driven_by_program()})"
        elif sys.platform == "win32" and user_is_away(idle):
            FLAG_DIR.mkdir(parents=True, exist_ok=True)
            flag.write_text("all")
            decision = "pushes on (all): away"
        else:
            flag.unlink(missing_ok=True)
            decision = "pushes off: at PC"
        log(session_id, idle, decision + note)
        return

    if not flag.exists():
        return
    bridge = record.get("bridgeSessionIds") or []
    url = f"{CODE_URL}/{bridge[-1]}" if bridge else session_url(data.get("transcript_path"))

    if event == "PreToolUse" and data.get("tool_name") == "AskUserQuestion":
        # The emoji leading each push says its kind, so ❓, ⚠️ and ✅ titles are the session's alone.
        text = question_message(data.get("tool_input", {}).get("questions") or [])
        if push(title, text, "question", url):
            question_pushed.touch()
        else:
            question_pushed.unlink(missing_ok=True)

    elif event == "Notification" and data.get("notification_type") in (
        "permission_prompt",
        "elicitation_dialog",
    ):
        text = data.get("message") or "Claude needs your approval."
        # Skip the question dialog's permission prompt, but only if the
        # question's own push went out; otherwise this is the only alert.
        if QUESTION_PERMISSION.search(text) and question_pushed.exists():
            question_pushed.unlink()
            return
        push(title, permission_message(text, data.get("transcript_path")), "warning", url)

    elif event == "Stop" and not data.get("stop_hook_active"):
        question_pushed.unlink(missing_ok=True)
        # A turn that reported on another session's work, or handed the work to
        # a new session, isn't a finish: that session sends its own pushes.
        if report_turn.exists() or session_started_this_turn(data.get("transcript_path")):
            return
        # A result or message already waiting starts the next turn right away;
        # that turn's stop sends the push.
        if prompts_queued(data.get("transcript_path")):
            return
        # The flag stays on until the user's next prompt, so a pause to wait
        # on background work and the real finish each get a push.
        transcript = data.get("transcript_path")
        message = (data.get("last_assistant_message") or "").strip()
        running = background_work_pending(transcript)
        if running:
            if not read_config().get(WAITING_PUSHES_SETTING) or flag.read_text().strip() == "final":
                return  # paused, or "notify me when you're done": no progress pushes
            text = waiting_message(message, turn_details(transcript), running)
            push(title, text, "hourglass_flowing_sand", url)
        else:
            text = done_message(message, turn_details(transcript))
            push(title, text, "white_check_mark", url)


if __name__ == "__main__":
    main()
