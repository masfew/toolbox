#!/usr/bin/env python3
"""
Session lookups shared by the notification hook (notify_hook.py) and the
Telegram listener (core/listener.py): the desktop app's session records, what a
session's transcript says is still running, and which sessions are active now.

  python sessions.py --active   lists the active sessions, with whether pushes are on
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from core.bridge import FLAG_DIR  # noqa: E402

TRANSCRIPT_DIR = Path.home() / ".claude" / "projects"
# The hook writes <session-id>.active in FLAG_DIR when a turn starts and removes
# it when the turn ends with nothing left running, so /notify_me can find working
# sessions, including ones outside the desktop app.
ACTIVE_SUFFIX = ".active"
# A marker this new is never cleared as stale: its turn's first entries may not
# be in the transcript yet.
MARKER_GRACE = 60  # seconds
# Desktop records changed this recently are checked too, for sessions that have
# no marker (their turn started before the hook wrote markers).
RECENT_RECORD = 6 * 3600  # seconds
# A turn ends with the Stop hooks' summary entry, or with an "[Request interrupted
# by user]" prompt when you stop it (Stop hooks don't run then), or with an API
# error message. A turn that wrote nothing for this long was likely cut off by
# quitting the app.
INTERRUPTED = "[Request interrupted by user"
TURN_STALE = 2 * 3600  # seconds
# The CLI writes slash-command output as prompts; they don't start a turn.
LOCAL_COMMAND = re.compile(r"^\s*<(command-name|command-message|local-command-stdout|local-command-caveat)>")
# A finished background task reports back with the ID of the call that started it.
FINISHED_TASK = re.compile(r"<tool-use-id>(toolu_\w+)</tool-use-id>")
# Background work this old that never reported back was likely killed by
# quitting the app, so it no longer counts as running.
MAX_TASK_AGE = timedelta(hours=24)
# Background commands that run until stopped (servers, watchers) and that Claude
# leaves running rather than waits on. "Watch for..."/"Wait for..." jobs that end
# on their own are deliberately not matched.
SERVER_COMMAND = re.compile(
    r"\brojo(\.exe)?\s+serve\b|\bhttp\.server\b|SimpleHTTPServer"
    r"|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b"
    r"|\blive-server\b|\bnext\s+dev\b|\buvicorn\b|\bflask\s+run\b",
    re.IGNORECASE,
)
SERVER_DESCRIPTION = re.compile(
    r"^\s*(?:(?:start|launch|run)\b.*\b(?:server|daemon|watch(?:er)?)\b|serve\b)",
    re.IGNORECASE,
)
# Sessions started without a project folder run in a scratch workspace the app creates.
SCRATCH_WORKSPACE = re.compile(r"[\\/]Claude[\\/]scratch-workspaces[\\/]", re.IGNORECASE)
# The desktop app keeps a record per session (title, the Claude Code session ID it
# runs, the session that started it) and passes that record's ID to Claude Code in
# this variable, which hooks and anything Claude runs inherit. The Store version of
# the app keeps its data under LocalCache, which other programs see at that path.
HOST_SESSION_VAR = "CLAUDE_CODE_HOST_SESSION_ID"
# A prompt that arrives mid-turn (a background task's or subagent's result, or a
# message you send) is written to the transcript as a queue "enqueue", and as a
# "dequeue" or "remove" once Claude takes it in. One still queued when the turn
# stops starts the next turn at once, so that stop is neither a pause nor a finish.
QUEUE_OPS = {"enqueue": 1, "dequeue": -1, "remove": -1}
SESSION_RECORD_DIRS = (
    ("APPDATA", "Claude/claude-code-sessions"),
    ("LOCALAPPDATA", "Packages/Claude_*/LocalCache/Roaming/Claude/claude-code-sessions"),
)


def record_paths(name="local_*"):
    """The desktop app's session record files (all of them, or one by its local_... ID)."""
    for var, pattern in SESSION_RECORD_DIRS:
        base = os.environ.get(var)
        if base:
            yield from Path(base).glob(f"{pattern}/*/*/{name}.json")


def desktop_record(local_id):
    """The desktop app's record of a session (by its local_... ID), or {}. A
    record caught while the app rewrites it reads as broken JSON, so it's read again."""
    if not local_id:
        return {}
    for attempt in range(5):
        broken = False
        for path in record_paths(local_id):
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                broken = True
            except OSError:
                continue
        if not broken:
            break
        time.sleep(0.1)
    return {}


def project_name(cwd):
    """The folder name, except a git worktree is named after its main repository
    (its .git is a file: "gitdir: <repo>/.git/worktrees/<name>"), and a session
    with no project folder is "No folder", as the app calls it."""
    if SCRATCH_WORKSPACE.search(cwd or ""):
        return "No folder"
    path = Path(cwd or ".")
    for folder in (path, *path.parents):
        git = folder / ".git"
        if git.is_file():
            try:
                gitdir = git.read_text(encoding="utf-8").strip().removeprefix("gitdir:").strip()
                parts = (folder / gitdir).resolve().parts  # gitdir may be relative
                if "worktrees" in parts:
                    return Path(*parts[: parts.index("worktrees")]).parent.name
            except (OSError, ValueError):
                pass
            break
        if git.exists():
            break
    return path.name


def session_title(record, cwd):
    """The session's title in the app, or else its folder, as pushes are titled."""
    return record.get("title") or project_name(cwd) or "Claude Code"


def is_server_or_watcher(args):
    """Servers and watchers run until stopped, so Claude doesn't wait on them."""
    return bool(
        SERVER_COMMAND.search(args.get("command") or "")
        or SERVER_DESCRIPTION.search(args.get("description") or "")
    )


def runs_in_background(block, servers=False):
    name, args = block.get("name"), block.get("input") or {}
    if name in ("Bash", "PowerShell"):
        return args.get("run_in_background") is True and (servers or not is_server_or_watcher(args))
    if name in ("Agent", "Task"):
        return args.get("run_in_background") is not False  # background by default
    return name == "Workflow"


def result_text(block):
    content = block.get("content")
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return str(content or "")


def started_at(entry):
    try:
        return datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
    except (KeyError, AttributeError, TypeError, ValueError):
        return None


def work_label(block):
    """A short label for a background launch, if Claude gave it one."""
    args = block.get("input") or {}
    return (args.get("description") or "").strip() or ("a workflow" if block.get("name") == "Workflow" else "")


def background_work_pending(transcript_path, since=None, servers=False):
    """The labels of background work that hasn't reported back yet (a list,
    empty if none, with "" for unlabeled work), i.e. Claude stopped only to
    wait for it. Work started before the user's latest prompt counts too: a
    "notify me" sent while a task runs must not get a premature done. Work
    started before `since` (a datetime; default MAX_TASK_AGE ago) counts as
    finished. With servers, servers and watchers count as running too."""
    started, finished = {}, set()  # started: launch call ID -> start time
    labels = {}  # launch call ID -> its label
    launch_results = {}  # launch call ID -> its result, which names the task ID
    stop_calls = {}  # TaskStop call ID -> the task ID it stops
    stopped = set()  # task IDs Claude stopped itself
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("isSidechain"):
                    continue
                content = (entry.get("message") or {}).get("content")
                for block in content if isinstance(content, list) else []:
                    kind, call = block.get("type"), block.get("tool_use_id")
                    if kind == "tool_use" and runs_in_background(block, servers):
                        started[block.get("id")] = started_at(entry)
                        labels[block.get("id")] = work_label(block)
                    elif kind == "tool_use" and block.get("name") in ("TaskStop", "KillShell"):
                        args = block.get("input") or {}
                        stop_calls[block.get("id")] = args.get("task_id") or args.get("shell_id")
                    elif kind == "tool_result" and block.get("is_error"):
                        started.pop(call, None)  # never launched
                        stop_calls.pop(call, None)  # stop failed
                    elif kind == "tool_result" and call in started:
                        launch_results[call] = result_text(block)
                    elif kind == "tool_result" and stop_calls.get(call):
                        stopped.add(stop_calls.pop(call))
                finished.update(FINISHED_TASK.findall(line))
    except (OSError, TypeError):
        return []
    # A task Claude stops itself (TaskStop) never sends a completion message,
    # and neither does one killed by quitting the app, so old ones are dropped.
    cutoff = since or datetime.now(timezone.utc) - MAX_TASK_AGE
    return [
        labels.get(call, "") for call, when in started.items()
        if call not in finished
        and (when is None or when > cutoff)
        and not any(task in launch_results.get(call, "") for task in stopped)
    ]


def is_prompt(entry):
    """A main-chain entry that starts a turn (any prompt), not a tool result."""
    if entry.get("type") != "user" or entry.get("isSidechain") or entry.get("isMeta"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    blocks = content if isinstance(content, list) else []
    return not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks)


def prompt_text(entry):
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def turn_running(transcript_path, stale=TURN_STALE):
    """True if the session's latest turn hasn't ended: its last prompt has no Stop
    summary, interruption or API error after it, and the transcript changed
    within `stale` seconds (None: however long ago). Only lines that can start
    or end a turn are parsed."""
    running = False
    try:
        if stale is not None and time.time() - os.path.getmtime(transcript_path) > stale:
            return False
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                if '"stop_hook_summary"' in line or '"isApiErrorMessage":true' in line:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if not entry.get("isSidechain") and (entry.get("subtype") == "stop_hook_summary"
                                                         or entry.get("isApiErrorMessage")):
                        running = False
                elif '"type":"user"' in line and '"tool_result"' not in line:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if not is_prompt(entry) or entry.get("isCompactSummary"):
                        continue
                    text = prompt_text(entry).strip()
                    if text.startswith(INTERRUPTED):
                        running = False
                    elif not LOCAL_COMMAND.match(text):
                        running = True
    except (OSError, TypeError):
        return False
    return running


def prompts_queued(transcript_path):
    """True if a prompt is queued that Claude hasn't taken in yet, i.e. the
    session goes straight on to another turn."""
    queued = 0
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                if '"queue-operation"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") == "queue-operation":
                    queued = max(0, queued + QUEUE_OPS.get(entry.get("operation"), 0))
    except (OSError, TypeError):
        return False
    return queued > 0


def marker_path(session_id):
    return FLAG_DIR / (session_id + ACTIVE_SUFFIX)


def mark_active(session_id, transcript_path, record_id, cwd, title):
    """Called by the hook when a turn starts, for every session pushes on or off."""
    try:
        FLAG_DIR.mkdir(parents=True, exist_ok=True)
        marker_path(session_id).write_text(json.dumps({
            "started": time.time(), "transcript": transcript_path, "record": record_id,
            "cwd": cwd, "title": title,
        }), encoding="utf-8")
    except OSError:
        pass


def clear_active(session_id, transcript_path):
    """Called by the hook when a turn ends: the marker goes unless background
    work is still running, so a session waiting on it stays listed."""
    if not background_work_pending(transcript_path):
        marker_path(session_id).unlink(missing_ok=True)


def pushes_mode(session_id):
    """"all", "final", or None while pushes are off for the session."""
    try:
        return (FLAG_DIR / session_id).read_text().strip() or "all"
    except OSError:
        return None


def turn_pushes_on(session_id, mode="all"):
    """Writes the session's flag file, as a prompt ending with "notify me" does."""
    FLAG_DIR.mkdir(parents=True, exist_ok=True)
    (FLAG_DIR / session_id).write_text(mode)


def find_transcript(session_id):
    return next(TRANSCRIPT_DIR.glob(f"*/{session_id}.jsonl"), None)


def candidates():
    """Session ID -> what's known about it, for every session that may be active:
    those with a marker, and those whose desktop record changed recently."""
    found = {}
    for marker in FLAG_DIR.glob("*" + ACTIVE_SUFFIX):
        try:
            info = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        found[marker.name[: -len(ACTIVE_SUFFIX)]] = {**info, "marker": marker}
    cutoff = time.time() - RECENT_RECORD
    for path in record_paths():
        try:
            if path.stat().st_mtime < cutoff:
                continue
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        session_id = record.get("cliSessionId")
        if session_id and session_id not in found and not record.get("isArchived"):
            transcript = find_transcript(session_id)
            if transcript:
                found[session_id] = {"transcript": str(transcript), "record": record.get("sessionId"),
                                     "cwd": record.get("cwd")}
    return found


def new_entry(session_id, record, cwd, title, working=False, tasks=()):
    return {
        "id": session_id, "record": record.get("sessionId"),
        "parent": (record.get("spawnedFrom") or {}).get("sessionId"),
        "title": session_title(record, cwd) if record else (title or project_name(cwd) or "Claude Code"),
        "working": working, "tasks": list(tasks), "pushes": pushes_mode(session_id), "subs": [],
    }


def describe(entry):
    """What's running, such as "working, 2 background tasks"."""
    parts = ["working"] if entry["working"] else []
    if entry["tasks"]:
        n = len(entry["tasks"])
        parts.append(f"{n} background task{'s' if n > 1 else ''}")
    if entry["subs"]:
        n = len(entry["subs"])
        parts.append("sub-session working" if n == 1 else f"{n} sub-sessions working")
    return ", ".join(parts)


def active_sessions():
    """Every session with something running (its turn, background work, or a
    session it started), as entries with: id, record, title, working, tasks,
    pushes ("all", "final" or None), and subs (the active sessions it started,
    folded in rather than listed on their own). Markers whose turn ended
    without a Stop (interrupted, or the app quit) are cleared on the way."""
    entries = {}
    for session_id, info in candidates().items():
        record = desktop_record(info.get("record"))
        if record.get("isArchived"):
            continue
        working = turn_running(info.get("transcript"))
        tasks = background_work_pending(info.get("transcript"))
        if not (working or tasks):
            marker = info.get("marker")
            try:
                if marker and time.time() - marker.stat().st_mtime > MARKER_GRACE:
                    marker.unlink()
            except OSError:
                pass
            continue
        entries[session_id] = new_entry(session_id, record, info.get("cwd"), info.get("title"), working, tasks)

    # Fold each session another session started into the topmost starting
    # session, adding a starting session that's idle while it waits.
    by_record = {e["record"]: e for e in entries.values() if e["record"]}

    def parent_of(entry):
        if not entry["parent"]:
            return None
        if entry["parent"] not in by_record:
            record = desktop_record(entry["parent"])
            if not record.get("cliSessionId") or record.get("isArchived"):
                return None
            parent = entries.get(record["cliSessionId"]) or new_entry(record["cliSessionId"], record, record.get("cwd"), None)
            entries[parent["id"]] = by_record[entry["parent"]] = parent
        return by_record[entry["parent"]]

    roots = {}
    for entry in list(entries.values()):  # not the idle starting sessions added on the way
        root, seen = entry, {entry["id"]}
        while (parent := parent_of(root)) and parent["id"] not in seen:
            seen.add(parent["id"])
            root = parent
        roots.setdefault(root["id"], root)
        if root is not entry:
            root["subs"].append(entry)
    return list(roots.values())


def sessions_without_pushes():
    """The active sessions /notify_me offers: those where the session or one of its
    active sub-sessions has pushes off."""
    return [e for e in active_sessions() if not e["pushes"] or any(not s["pushes"] for s in e["subs"])]


def main():
    if "--active" not in sys.argv:
        sys.exit(__doc__.strip())
    sys.stdout.reconfigure(encoding="utf-8")
    sessions = active_sessions()
    if not sessions:
        print("No active sessions.")
    for e in sessions:
        print(f"{e['id']}  {e['title']} · {describe(e)}  [pushes {e['pushes'] or 'off'}]")
        for s in e["subs"]:
            print(f"    {s['id']}  {s['title']} · {describe(s) or 'idle'}  [pushes {s['pushes'] or 'off'}]")


if __name__ == "__main__":
    main()
