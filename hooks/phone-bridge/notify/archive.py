#!/usr/bin/env python3
"""
/archive for the Telegram listener (core/listener.py): the desktop app's
sessions that are completely finished but not archived, and archiving one of
them from the app's sidebar.

A session is offered only when every check passes. Each failed check is a
reason it isn't, which --list prints:
  - it's in the signed-in account's records, not archived and not pinned, and
    has a transcript;
  - its transcript hasn't changed for QUIET seconds;
  - its latest turn has ended (a Stop summary, an interruption or an API error
    after its last prompt). A turn waiting on a question or a permission prompt
    hasn't ended, however long it waits. A turn whose transcript stopped before
    the app last started was cut off by quitting the app, so it counts as ended;
  - no prompt is queued (a message or a task result Claude hasn't taken in);
  - no background command, subagent or workflow is still to report back,
    servers and watchers included (archiving stops the session's process, and
    them with it). Work started before the app last started was killed when it
    quit, so it counts as finished;
  - the app holds no waiting input for it;
  - the sidebar doesn't show it under "Needs input" (the app's end-of-turn
    summary or wrap-up asks something of the user, or it errored);
  - no session it started (and isn't archived) fails any of these checks.
A tap checks it all again before archiving.

The app has no outside way to archive (no link, and it doesn't watch its record
files), so archive_steps.ps1 opens the session's "More options" menu in the
sidebar and invokes Archive, then this script waits for the app to mark the
record archived.

  python archive.py --list               what /archive offers, and why the rest aren't
  python archive.py --archive local_...  checks one session again and archives it
"""
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from notify.sessions import (  # noqa: E402
    background_work_pending, desktop_record, find_transcript, prompts_queued, record_paths, turn_running,
)

STEPS_SCRIPT = Path(__file__).with_name("archive_steps.ps1")
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
# Seconds a transcript must have been still, for writes still on their way.
# Only a short wait: the turn checks already catch new work (a new prompt is
# in the transcript at once), and 2 minutes hid a session the user had just
# watched finish (2026-10-21).
QUIET = 10
STEPS_TIMEOUT = 30  # seconds archive_steps.ps1 may take
ARCHIVED_WAIT = 10  # seconds to wait for the record to say it's archived
ERROR_SHOWN_MS = 7 * 24 * 3600 * 1000  # how long the app shows a session's error as needing input
# The app's main process: no --type (its helpers have one) and not a session's
# Claude Code (claude-code\<version>\claude.exe in the app's data folder).
APP_START_SCRIPT = (
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | "
    "Where-Object { $_.ExecutablePath -match '\\\\WindowsApps\\\\|\\\\AnthropicClaude\\\\' -and $_.CommandLine -notmatch '--type=' } | "
    "ForEach-Object { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeSeconds() }"
)
archiving = threading.Lock()  # one archive at a time: each drives the app's window


def app_started():
    """When the desktop app's main process started (epoch seconds), or None if
    it isn't running."""
    try:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", APP_START_SCRIPT],
                                capture_output=True, text=True, timeout=30, creationflags=NO_WINDOW)
        starts = [int(line) for line in result.stdout.split() if line.strip().isdigit()]
        return min(starts) if starts else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def account_records():
    """local_... ID -> record, for every session in the signed-in account's
    folder: the one holding the most recently changed record. Other accounts'
    sessions aren't in the sidebar."""
    paths = list(record_paths())
    if not paths:
        return {}
    folder = max(paths, key=lambda p: p.stat().st_mtime).parent
    records = {}
    for path in folder.glob("local_*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            record = {"sessionId": path.stem, "unreadable": True}
        records[path.stem] = {**record, "folder": str(folder)}
    return records


def waiting_input(record):
    """True if the app holds input waiting for the session (its waiting-input folder)."""
    folder = Path(record.get("folder") or ".") / "waiting-input"
    uuid = (record.get("sessionId") or "").removeprefix("local_")
    try:
        return bool(uuid) and any(uuid in p.name for p in folder.iterdir())
    except OSError:
        return False


def needs_input(record):
    """True if the sidebar shows the session under "Needs input". The app's
    status for an idle session comes from its record, not the transcript: a
    turn can end in plain text ("holding until you say go") with nothing
    pending, and the app's end-of-turn summary still marks it blocked. Mirrors
    the app's rules (Claude desktop 3.6556): the summary's status_category
    blocked, need_input or failed, a wrap-up box asking the user something
    (needsUser), or an error in the last 7 days."""
    category = (record.get("postTurnSummary") or {}).get("status_category")
    if category in ("blocked", "need_input", "failed"):
        return True
    if (record.get("turnWrapUp") or {}).get("needsUser") is not None:
        return True
    error_at = record.get("errorAt")
    return bool(record.get("error")) and isinstance(error_at, (int, float)) and time.time() * 1000 - error_at < ERROR_SHOWN_MS


def own_reason(record, app_start):
    """Why the session itself isn't finished, or None."""
    if record.get("unreadable"):
        return "its record can't be read"
    if record.get("isStarred"):
        return "pinned"
    session_id = record.get("cliSessionId")
    transcript = find_transcript(session_id) if session_id else None
    if not transcript:
        return "no transcript"
    path = str(transcript)
    try:
        changed = os.path.getmtime(path)
    except OSError:
        return "no transcript"
    if time.time() - changed < QUIET:
        return f"active in the last {QUIET} seconds"
    if waiting_input(record):
        return "the app holds input waiting for it"
    if needs_input(record):
        return "the app shows it as needing input"
    if not (app_start and changed < app_start):  # quitting the app ended whatever ran before
        if turn_running(path, stale=None):
            return "its turn hasn't ended (working, or waiting on a question or permission)"
        if prompts_queued(path):
            return "a prompt is queued"
    since = datetime.fromtimestamp(app_start, timezone.utc) if app_start else None
    tasks = background_work_pending(path, since=since, servers=True)
    if tasks:
        labels = ", ".join(t for t in tasks if t)
        return f"{len(tasks)} background task{'s' if len(tasks) > 1 else ''} running" + (f" ({labels})" if labels else "")
    return None


def busy_reason(local_id, records, app_start, seen=None):
    """Why the session isn't finished (itself or a session it started), or None."""
    seen = (seen or set()) | {local_id}
    reason = own_reason(records[local_id], app_start)
    if reason:
        return reason
    for child_id, child in records.items():
        if (child_id not in seen and not child.get("isArchived")
                and (child.get("spawnedFrom") or {}).get("sessionId") == local_id
                and busy_reason(child_id, records, app_start, seen)):
            return f"a session it started isn't finished ({child.get('title') or child_id})"
    return None


def finished_at(record):
    """When the session finished: its transcript's last change (epoch seconds), or None."""
    transcript = find_transcript(record.get("cliSessionId") or "")
    try:
        return os.path.getmtime(transcript)
    except (OSError, TypeError):
        return None


def review():
    """(finished, others, app_start): the finished sessions as entries {id,
    title, finished}, most recently finished first, and (title, reason) for
    every other session that isn't archived."""
    app_start = app_started()
    records = account_records()
    live = {i: r for i, r in records.items() if not r.get("isArchived")}
    titles = [r.get("title") for r in live.values()]
    finished, others = [], []
    for local_id, record in live.items():
        title = record.get("title") or ""
        if not title:
            reason = "no title yet"
        elif titles.count(title) > 1:
            reason = "another session has the same title, so its sidebar row can't be told apart"
        else:
            reason = busy_reason(local_id, records, app_start)
        if reason:
            others.append((title or local_id, reason))
        else:
            finished.append({"id": local_id, "title": title, "finished": finished_at(record)})
    finished.sort(key=lambda e: e["finished"] or 0, reverse=True)
    return finished, others, app_start


def run_steps(title):
    """("done" | "confirm" | "fail", message) from archive_steps.ps1."""
    args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden", "-File", str(STEPS_SCRIPT)]
    try:
        result = subprocess.run(args, input=json.dumps({"title": title}) + "\n", capture_output=True, text=True,
                                encoding="utf-8", timeout=STEPS_TIMEOUT, creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired:
        return "fail", f"the app didn't respond within {STEPS_TIMEOUT} s"
    except OSError as e:
        return "fail", f"couldn't run the steps: {type(e).__name__}"
    for line in reversed(result.stdout.splitlines()):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        return event.get("event") or "fail", event.get("message") or ""
    return "fail", "the steps script stopped with an error"


def archive(local_id):
    """Checks the session again and archives it. Returns (outcome, detail):
    "archived"; "already" (archived already); "busy" (detail: why); "gone";
    or "failed" (detail: what went wrong)."""
    with archiving:
        app_start = app_started()
        if not app_start:
            return "failed", "Claude isn't running on the PC"
        records = account_records()
        record = records.get(local_id)
        if not record:
            return "gone", ""
        if record.get("isArchived"):
            return "already", ""
        reason = busy_reason(local_id, records, app_start)
        if reason:
            return "busy", reason
        title = record.get("title") or ""
        if [r.get("title") for r in records.values() if not r.get("isArchived")].count(title) > 1:
            return "busy", "another session has the same title"
        outcome, message = run_steps(title)
        if outcome == "confirm":
            return "failed", f"the app asked to confirm ({message}), so I cancelled; archive it at the PC"
        if outcome != "done":
            return "failed", message
        deadline = time.time() + ARCHIVED_WAIT
        while time.time() < deadline:
            if desktop_record(local_id).get("isArchived"):
                return "archived", ""
            time.sleep(0.5)
        return "failed", "the app didn't mark it archived"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:2] == ["--list"]:
        finished, others, app_start = review()
        if not app_start:
            print("Claude isn't running on the PC (taps would fail).")
        print("Finished:" if finished else "Finished: none")
        for e in finished:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(e["finished"])) if e["finished"] else "?"
            print(f"  {e['id']}  {e['title']}  (finished {when})")
        print("Not offered:" if others else "Not offered: none")
        for title, reason in others:
            print(f"  {title}: {reason}")
    elif sys.argv[1:2] == ["--archive"] and len(sys.argv) == 3:
        print(archive(sys.argv[2]))
    else:
        sys.exit(__doc__.strip())


if __name__ == "__main__":
    main()
