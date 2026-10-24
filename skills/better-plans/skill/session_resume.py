#!/usr/bin/env python3
"""
SessionStart hook for light plans (see light.md). Python 3.9+, stdlib only.

- After /clear or a compaction, pastes this session's light plan into the new
  context (as additionalContext), so Claude carries on without a Read.
- On every session start, deletes light plans not changed for 14 days.

The session is the desktop app's `local_...` id from CLAUDE_CODE_HOST_SESSION_ID,
which stays the same across /clear (the CLI session id in the hook input
doesn't). Without it and without the app's notes folder (Claude Code outside
the desktop app) the hook does nothing, not even log.

The desktop app runs /clear by starting a fresh CLI process, which reports
source=startup, not clear (seen 20 Oct 2026). So startup restores too: a new
session has a new local_ id with no plan yet, and reopening a session reports
resume, which keeps its context and is skipped.

The Claude app is a packaged Windows app, so its %APPDATA%\\Claude folder
really lives under %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude,
which is where Python has to look.

Each run appends one line to ~/.claude/better-plans-session-resume.log (kept
to the last 500 lines), for checking the hook and counting clears and compacts.
"""
import json
import os
import sys
import time
from pathlib import Path

PLAN_NAME = "session-plan.md"
MAX_AGE_DAYS = 14
MAX_CHARS = 60_000
LOG = Path.home() / ".claude" / "better-plans-session-resume.log"
LOG_LINES = 500


def notes_dirs():
    found = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        found.append(Path(appdata) / "Claude" / "side-session-notes")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        found += sorted((Path(local) / "Packages").glob(
            "Claude_*/LocalCache/Roaming/Claude/side-session-notes"))
    return [d for d in found if d.is_dir()]


def clean_up(dirs):
    cutoff = time.time() - MAX_AGE_DAYS * 86400
    removed = 0
    for d in dirs:
        for plan in d.glob(f"*/{PLAN_NAME}"):
            try:
                if plan.is_file() and plan.stat().st_mtime < cutoff:
                    plan.unlink()
                    removed += 1
            except OSError:
                pass
    return removed


def log(line):
    try:
        lines = LOG.read_text(encoding="utf-8").splitlines() if LOG.exists() else []
        lines = (lines + [line])[-LOG_LINES:]
        LOG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
    except ValueError:
        data = {}
    source = data.get("source", "?")
    sid = os.environ.get("CLAUDE_CODE_HOST_SESSION_ID", "")
    dirs = notes_dirs()
    if not sid and not dirs:
        return  # not the desktop app: nothing to restore or clean up
    removed = clean_up(dirs)

    plan = None
    if source in ("clear", "compact", "startup") and sid.startswith("local_"):
        for d in dirs:
            if (d / sid / PLAN_NAME).is_file():
                plan = d / sid / PLAN_NAME
                break

    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log(f"{stamp} source={source} host_id={sid or '-'} cli_id={data.get('session_id', '-')} "
        f"plan={'yes' if plan else 'no'} removed={removed}")
    if not plan:
        return

    text = plan.read_text(encoding="utf-8", errors="replace")
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + "\n\n[Cut off here: Read the file for the rest.]"
    shown = f"%APPDATA%\\Claude\\side-session-notes\\{sid}\\{PLAN_NAME}"
    context = (
        f"This session's light plan (better-plans light.md), restored after {source}. "
        f"It lives at {shown}. Continue from its Current State without being told, "
        "and keep it updated at milestones.\n\n" + text)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart", "additionalContext": context}}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # a broken hook must never block a session
        log(f"{time.strftime('%Y-%m-%d %H:%M:%S')} error: {e!r}")
