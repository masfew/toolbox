#!/usr/bin/env python3
"""
Presence watcher for phone-bridge (Windows only).

Runs in the background from Windows sign-in (a Startup shortcut that install.py
creates; notify_hook.py also starts it if it isn't running) and records when you
last touched the PC's real keyboard or mouse. Input that programs
simulate (automated tests, auto-save helpers, mouse movers)
is flagged by Windows as injected and ignored, so it never counts as you being
at the PC. Windows' own idle timer (GetLastInputInfo) can't be used: it counts
injected input, and on some PCs something resets it constantly.

Writes ~/.claude/phone-bridge/presence.json every few seconds:
  {"last_real_input": <epoch secs or null>, "heartbeat": <epoch secs>, "pid": <pid>}
Records timestamps only, never which keys. One instance at a time.
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from core.bridge import PRESENCE_FILE as STATE_FILE  # noqa: E402

MUTEX_NAME = "Local\\phone-bridge-presence"
WRITE_EVERY_MS = 5000

WH_KEYBOARD_LL, WH_MOUSE_LL = 13, 14
LLKHF_INJECTED, LLMHF_INJECTED = 0x10, 0x01
ERROR_ALREADY_EXISTS = 183

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wt.WPARAM, wt.LPARAM)
user32.SetWindowsHookExW.restype = ctypes.c_void_p
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, wt.DWORD]
user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
user32.SetTimer.restype = ctypes.c_size_t
user32.SetTimer.argtypes = [wt.HWND, ctypes.c_size_t, wt.UINT, ctypes.c_void_p]
kernel32.CreateMutexW.restype = wt.HANDLE
kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.LPCWSTR]


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wt.DWORD), ("scanCode", wt.DWORD), ("flags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long), ("mouseData", wt.DWORD),
                ("flags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


last_real_input = None  # epoch seconds of the latest physical key or mouse event
written_input = None  # the last_real_input value most recently written to STATE_FILE
write_requested = False
WM_APP_WRITE = 0x8001  # posted to ourselves so the file is written outside the hook callback
thread_id = 0


def record_real_input():
    """Keeps the file at most ~1 second behind: the hook judges a message the
    instant it's sent, so input after an idle spell (moving to the Send button)
    must reach the file right away, not at the next 5-second write."""
    global last_real_input, write_requested
    last_real_input = time.time()
    if not write_requested and (written_input is None or last_real_input - written_input > 1):
        write_requested = True
        user32.PostThreadMessageW(thread_id, WM_APP_WRITE, 0, 0)


# Keep the callbacks tiny: Windows drops low-level hooks that answer slowly.
def on_key(code, wparam, lparam):
    if code == 0 and not ctypes.cast(lparam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents.flags & LLKHF_INJECTED:
        record_real_input()
    return user32.CallNextHookEx(None, code, wparam, lparam)


def on_mouse(code, wparam, lparam):
    if code == 0 and not ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents.flags & LLMHF_INJECTED:
        record_real_input()
    return user32.CallNextHookEx(None, code, wparam, lparam)


def write_state():
    global written_input, write_requested
    written_input, write_requested = last_real_input, False
    state = {"last_real_input": last_real_input, "heartbeat": time.time(), "pid": os.getpid()}
    tmp = STATE_FILE.with_suffix(".tmp")
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except OSError:
        pass


def main():
    global thread_id
    if sys.platform != "win32":
        return
    thread_id = kernel32.GetCurrentThreadId()
    kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        return  # another watcher is already running

    # Keep references to the callbacks so they aren't garbage-collected.
    key_proc, mouse_proc = HOOKPROC(on_key), HOOKPROC(on_mouse)
    if not (user32.SetWindowsHookExW(WH_KEYBOARD_LL, key_proc, None, 0)
            and user32.SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, None, 0)):
        return
    user32.SetTimer(None, 0, WRITE_EVERY_MS, None)
    write_state()

    msg = wt.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        if msg.message == WM_APP_WRITE:
            write_state()
        elif msg.message == 0x0113:  # WM_TIMER
            write_state()
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


if __name__ == "__main__":
    main()
