"""Keeps Wispr Flow's tray icon pinned next to the clock across Wispr Flow updates.

Windows 11 remembers each tray icon's pinned state under
HKCU\\Control Panel\\NotifyIconSettings, one key per exe path (IsPromoted = 1 when
pinned). Wispr Flow installs every update into a new app-<version> folder and often
restarts into it without a sign-in, so Windows sees a new exe and puts its icon in
the ^ overflow. The helper calls TrayPin.check every SNAPSHOT_SECONDS: for each
running Wispr Flow exe it hasn't handled yet, it sets IsPromoted = 1 on that exe's
key and sends Wispr Flow's windows the "TaskbarCreated" message, so Wispr Flow
re-adds its icon (Explorer only reads IsPromoted when an icon is added).

At login (run --at-login), login_watchdog also starts Wispr Flow if it isn't running
after LOGIN_TIMEOUT, with toast notifications saying what happened.
"""

import base64
import ctypes
import logging
import os
import subprocess
import threading
import time
import winreg
from ctypes import wintypes
from pathlib import Path
from xml.sax.saxutils import escape

ICON_SETTINGS = r"Control Panel\NotifyIconSettings"
WISPR_DIR = Path(os.environ["LOCALAPPDATA"]) / "WisprFlow"
# Squirrel's stub, the target of Wispr Flow's Startup shortcut: it launches the newest
# app-<version> folder.
WISPR_LAUNCHER = WISPR_DIR / "Wispr Flow.exe"
LOGIN_TIMEOUT = 120  # Wispr Flow's own Startup shortcut runs in the same batch as the helper's
RETRY_TIMEOUT = 60
# Toasts need a registered AppUserModelID; this one shows them as Wispr Mute.
APP_ID = "Toolbox.WisprMute"
APP_NAME = "Wispr Mute"
APP_ICON = WISPR_DIR / "app.ico"
CREATE_NO_WINDOW = 0x08000000
SMTO_ABORTIFHUNG = 0x0002

user32 = ctypes.WinDLL("user32", use_last_error=True)
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = (WNDENUMPROC, wintypes.LPARAM)
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.RegisterWindowMessageW.restype = wintypes.UINT
user32.RegisterWindowMessageW.argtypes = (wintypes.LPCWSTR,)
user32.SendMessageTimeoutW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                       wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t))

log = logging.getLogger("wispr-mute")


class TrayPin:
    """Pins the tray icon of each running Wispr Flow exe once per helper run, so an
    icon you drag into the overflow by hand stays there until the next login."""

    def __init__(self):
        self.handled = set()  # normcased exe paths whose icon key was found

    def check(self, processes):
        """processes: {pid: exe path} of the running Wispr Flow processes."""
        new = {os.path.normcase(p) for p in processes.values()} - self.handled
        if not new:
            return
        entries = icon_entries(new)  # no key yet: the icon isn't showing yet, so try again next time
        self.handled |= {path for _, path, _ in entries}
        for _, path, promoted in entries:
            if promoted == 1:
                log.info("Wispr Flow's tray icon is already pinned: %s", path)
        unpinned = [(name, path) for name, path, promoted in entries if promoted != 1]
        if not unpinned:
            return
        for name, _ in unpinned:
            promote(name)
        pids = set(processes)
        # Off the main loop: a slow Wispr Flow window could hold each message up to its timeout.
        threading.Thread(target=readd_icons, args=(pids, [path for _, path in unpinned]), daemon=True).start()


def icon_entries(exe_paths):
    """[(subkey name, normcased exe path, IsPromoted or None)] for these exes' tray icon keys."""
    entries = []
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, ICON_SETTINGS) as root:
        index = 0
        while True:
            try:
                name = winreg.EnumKey(root, index)
            except OSError:
                break
            index += 1
            with winreg.OpenKey(root, name) as key:
                try:
                    path = os.path.normcase(winreg.QueryValueEx(key, "ExecutablePath")[0])
                except OSError:
                    continue
                if path not in exe_paths:
                    continue
                try:
                    promoted = winreg.QueryValueEx(key, "IsPromoted")[0]
                except OSError:
                    promoted = None
                entries.append((name, path, promoted))
    return entries


def promote(name):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"{ICON_SETTINGS}\{name}", 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, "IsPromoted", 0, winreg.REG_DWORD, 1)


def readd_icons(pids, paths):
    """Send "TaskbarCreated" to these processes' top-level windows, as Explorer does after
    it restarts, so they re-add their tray icons and Explorer rereads IsPromoted."""
    try:
        message = user32.RegisterWindowMessageW("TaskbarCreated")
        windows = []

        @WNDENUMPROC
        def collect(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in pids:
                windows.append(hwnd)
            return True

        user32.EnumWindows(collect, 0)
        result = ctypes.c_size_t()
        for hwnd in windows:
            user32.SendMessageTimeoutW(hwnd, message, 0, 0, SMTO_ABORTIFHUNG, 2000, ctypes.byref(result))
        log.info("Pinned Wispr Flow's tray icon: %s (asked %d windows to re-add it)",
                 ", ".join(sorted(paths)), len(windows))
    except Exception:  # noqa: BLE001 - a thread of a windowless helper, so the log is the only report
        log.exception("Could not re-add Wispr Flow's tray icon")


# --- at login: start Wispr Flow if it didn't start --------------------------------

def login_watchdog(running):
    """running() -> {pid: path} of Wispr Flow processes. If none appear within
    LOGIN_TIMEOUT, notify, start Wispr Flow, and say whether that worked."""
    try:
        if wait_for(running, LOGIN_TIMEOUT):
            return
        log.info("Wispr Flow isn't running %d s after login; starting it", LOGIN_TIMEOUT)
        notify_didnt_start()
        try:
            os.startfile(WISPR_LAUNCHER)
        except OSError as error:
            log.warning("Couldn't start %s: %r", WISPR_LAUNCHER, error)
            notify("Wispr Flow retry failed",
                   f"Couldn't start Wispr Flow: {error.strerror or error}. Start it from the Start menu.",
                   sticky=True)
            return
        if wait_for(running, RETRY_TIMEOUT):
            log.info("Retry worked: Wispr Flow is running")
            notify("Wispr Flow started", "It started on the retry. Its tray icon gets pinned within a minute.")
        else:
            log.info("Retry failed: Wispr Flow still isn't running %d s after starting it", RETRY_TIMEOUT)
            notify("Wispr Flow retry failed",
                   f"Tried to start it again, but it still isn't running after {wait_text(RETRY_TIMEOUT)}. "
                   "Start it from the Start menu.", sticky=True)
    except Exception:  # noqa: BLE001
        log.exception("Login check for Wispr Flow failed")


def wait_for(running, timeout):
    deadline = time.monotonic() + timeout
    while not running():
        if time.monotonic() >= deadline:
            return False
        time.sleep(1)
    return True


def notify_didnt_start():
    notify("Wispr Flow didn't start - retrying",
           f"It wasn't running {wait_text(LOGIN_TIMEOUT)} after sign-in. Trying to start it now.")


def wait_text(seconds):
    if seconds % 60 == 0:
        minutes = seconds // 60
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    return f"{seconds} seconds"


def register_app_id():
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\AppUserModelId\{APP_ID}") as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
        if APP_ICON.exists():
            winreg.SetValueEx(key, "IconUri", 0, winreg.REG_SZ, str(APP_ICON))


def notify(title, body, sticky=False):
    """Show a Windows toast notification, through PowerShell's WinRT access. A normal one
    stays up for Windows' "Dismiss notifications after" time (5 s by default); a sticky
    one (a reminder with a Dismiss button) stays until you close it."""
    try:
        register_app_id()
        content = (f"<visual><binding template=\"ToastGeneric\"><text>{escape(title)}</text>"
                   f"<text>{escape(body)}</text></binding></visual>")
        if sticky:
            toast = ('<toast scenario="reminder">' + content +
                     '<actions><action content="Dismiss" arguments="dismiss" activationType="system"/>'
                     "</actions></toast>")
        else:
            toast = '<toast duration="short">' + content + "</toast>"
        script = (
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
            "ContentType = WindowsRuntime] > $null;"
            "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, "
            "ContentType = WindowsRuntime] > $null;"
            "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;"
            f"$xml.LoadXml('{toast.replace(chr(39), chr(39) * 2)}');"
            f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{APP_ID}')"
            ".Show([Windows.UI.Notifications.ToastNotification]::new($xml))")
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                capture_output=True, text=True, timeout=30, creationflags=CREATE_NO_WINDOW)
        if result.returncode != 0:
            log.warning("Notification failed: %s", result.stderr.strip())
    except (OSError, subprocess.SubprocessError) as error:
        log.warning("Notification failed: %r", error)
