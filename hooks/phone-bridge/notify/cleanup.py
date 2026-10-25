#!/usr/bin/env python3
"""
Deletes a session's pushes from the Telegram chat once the session is archived
in the desktop app, so the chat keeps only sessions still in the sidebar.

The hook (notify_hook.py) remembers every push it sends: one line per push,
{"id": <message_id>, "sent": <epoch seconds>}, in
~/.claude/phone-bridge/messages/<key>.jsonl, the key being the session's desktop
record ID (local_...), or its Claude Code session ID when it runs outside the
app. The listener (core/listener.py) deletes a session's pushes right after
/archive archives it, and sweeps every SWEEP_EVERY seconds for sessions
archived at the PC.

Telegram lets a bot delete a message only within 48 hours of sending it
(checked 2026-10-24: a 6-day-old push got "message can't be deleted for
everyone"), so older pushes are forgotten and stay in the chat.

  python cleanup.py --list   what is remembered, per session, and whether it's archived
"""
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from core.bridge import MESSAGES_DIR  # noqa: E402
from notify.sessions import desktop_record, record_paths  # noqa: E402

DELETABLE = 48 * 3600 - 600  # seconds after sending that a delete is still tried (Telegram: 48 h)
SWEEP_EVERY = 180  # seconds between the listener's sweeps for archived sessions
BATCH = 100  # message IDs per deleteMessages call, Telegram's maximum
deleting = threading.Lock()  # the sweep and an /archive tap may clear the same session


def remember(key, message_id):
    """Notes a push sent for the session `key`. Never raises: a push must never
    fail over its bookkeeping."""
    try:
        MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
        with open(MESSAGES_DIR / f"{key}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": int(message_id), "sent": time.time()}) + "\n")
    except (OSError, ValueError, TypeError):
        pass


def entries(path):
    """The pushes remembered in one file; a line cut off mid-write is skipped."""
    found = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return found
    for line in lines:
        try:
            entry = json.loads(line)
            found.append({"id": int(entry["id"]), "sent": float(entry["sent"])})
        except (ValueError, KeyError, TypeError):
            continue
    return found


def session_record(key):
    """The desktop record for a key: by its ID, or for a Claude Code session ID,
    the record running it ({} when there's none)."""
    if key.startswith("local_"):
        return desktop_record(key)
    for path in record_paths():
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if record.get("cliSessionId") == key:
            return record
    return {}


def delete_session(key, call):
    """Deletes the session's remembered pushes that are still young enough and
    forgets them all. `call(method, body)` makes a Bot API call and returns its
    reply. Returns (pushes deleted, Telegram's error or None)."""
    path = MESSAGES_DIR / f"{key}.jsonl"
    with deleting:
        now = time.time()
        ids = sorted({e["id"] for e in entries(path) if now - e["sent"] < DELETABLE})
        deleted, error = 0, None
        for start in range(0, len(ids), BATCH):
            batch = ids[start:start + BATCH]
            reply = call("deleteMessages", {"message_ids": batch})
            if reply.get("ok"):
                deleted += len(batch)
            else:
                error = reply.get("description") or "no answer"
        if error is None:
            path.unlink(missing_ok=True)  # after a failure the next sweep tries again
        return deleted, error


def sweep(call):
    """Clears every archived session's pushes, and forgets pushes too old to
    delete. Returns (key, pushes deleted, error) per archived session found."""
    cleared = []
    now = time.time()
    for path in sorted(MESSAGES_DIR.glob("*.jsonl")):
        key = path.stem
        if session_record(key).get("isArchived"):
            cleared.append((key, *delete_session(key, call)))
        elif all(now - e["sent"] >= DELETABLE for e in entries(path)):
            with deleting:
                path.unlink(missing_ok=True)
    return cleared


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:] != ["--list"]:
        sys.exit(__doc__.strip())
    now = time.time()
    for path in sorted(MESSAGES_DIR.glob("*.jsonl")):
        found = entries(path)
        record = session_record(path.stem)
        young = sum(now - e["sent"] < DELETABLE for e in found)
        state = "archived" if record.get("isArchived") else "not archived" if record else "no record"
        print(f"{path.stem}  {record.get('title') or ''}  ({state}): {len(found)} pushes, {young} deletable")


if __name__ == "__main__":
    main()
