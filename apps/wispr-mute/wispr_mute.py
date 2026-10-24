"""Wispr Mute: mutes your speakers while Wispr Flow is dictating.

Wispr Flow's own "Mute music while dictating" lowers each app's volume one by one
and can leave some apps silent, or take seconds to restore. This helper replaces
it: the moment Wispr Flow opens the microphone it mutes your audio, and the moment
the mic closes it restores it. Config "mute_audio" is the Muting/Audible switch, and
"whitelist" lists apps that can be kept audible, each turned on or off:
  no whitelisted app on   mute the whole default output device
  some turned on          mute every other app, on every output device

Wispr Flow is recording while one of its processes has an active capture session
on a microphone (Core Audio), checked every 50 ms. Windows also logs every desktop
app's microphone use under
HKCU\\...\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged, one key per
exe path with LastUsedTimeStart / LastUsedTimeStop (a stop time of 0 means the mic
is open right now). The helper still wakes on changes there, but since a Windows
update in October 2026 that log no longer records Wispr Flow's dictations.

Commands (python wispr_mute.py <command>):
  run [--at-login]     run the helper (the Startup shortcut runs it with --at-login, via pythonw)
  stop                 stop a running helper
  mute [on|off]        show or switch muting (applies from the next dictation)
  status               show the helper, Wispr Flow's mic use, and per-app volumes
  repair-audio         list apps left muted or at 0%; add --fix to restore them
  watch                print mic open/close and Ctrl+Win timings live
  test-notification    show the "Wispr Flow didn't start - retrying" notification

The helper also keeps Wispr Flow's tray icon pinned next to the clock across Wispr
Flow updates (tray_pin.py).

Standard library only. Config, log and saved app volumes live in ~/.claude/wispr-mute/.
"""

import ctypes
import json
import logging
import logging.handlers
import re
import sys
import threading
import time
import winreg
from ctypes import wintypes
from pathlib import Path

import core_audio
import tray_pin

DATA_DIR = Path.home() / ".claude" / "wispr-mute"
CONFIG_PATH = DATA_DIR / "config.json"
LOG_PATH = DATA_DIR / "helper.log"
MARKER_PATH = DATA_DIR / "muted-device.json"  # present only while the helper has something to restore
VOLUMES_PATH = DATA_DIR / "app-volumes.json"  # last good per-app volume, for repair-audio

DEFAULT_CONFIG = {
    # Mute audio while Wispr Flow has the mic open (the flyout's Muting/Audible switch).
    "mute_audio": True,
    # Apps that can stay audible: {"exe", "enabled", "name", "path"}. Enabled ones are
    # kept audible and every other app is muted; with none enabled, the whole default
    # output device is muted. "name" and "path" are filled in when known (for the
    # flyout's label and icon). Plain exe-name strings are accepted and converted.
    "whitelist": [{"exe": "Discord.exe", "enabled": True}],
    # Unmute after this many seconds of one mic session (0 = never). Guards against
    # Wispr Flow's meeting recorder muting your speakers for a whole call.
    "max_mute_seconds": 0,
    # Longest wait between checks for Wispr Flow recording (capped at CAPTURE_POLL_MS).
    "poll_ms": 500,
}
SNAPSHOT_SECONDS = 30  # also how often to check that Wispr Flow's tray icon is pinned
RESCAN_MS = 250  # muting app by app: how often to look for apps that start playing mid-dictation
CAPTURE_POLL_MS = 50  # how often to check whether Wispr Flow is recording (about 0.5 ms a check)
SILENT_LEVEL = 0.02  # an app volume below this counts as silenced

MIC_KEY = (r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager"
           r"\ConsentStore\microphone\NonPackaged")
WISPR_KEY_RE = re.compile(r"#WisprFlow#app-[^#]+#Wispr Flow\.exe$", re.IGNORECASE)
WISPR_EXE = "wispr flow.exe"
DUCKING_KEY = r"Software\Microsoft\Multimedia\Audio"
DUCKING_NAMES = {0: "mute all other sounds", 1: "reduce other sounds by 80%",
                 2: "reduce other sounds by 50%", 3: "do nothing"}

MUTEX_NAME = "Local\\WisprMuteHelper"
STOP_EVENT_NAME = "Local\\WisprMuteStop"
TRAY_MUTEX_NAME = "Local\\WisprMuteTray"  # held by tray.py
TRAY_STOP_EVENT_NAME = "Local\\WisprMuteTrayStop"

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)

ERROR_ALREADY_EXISTS = 183
WAIT_OBJECT_0 = 0
SYNCHRONIZE = 0x00100000
EVENT_MODIFY_STATE = 0x0002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x2
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
REG_NOTIFY_CHANGE_NAME = 0x1
REG_NOTIFY_CHANGE_LAST_SET = 0x4
VK_CONTROL, VK_LWIN, VK_RWIN = 0x11, 0x5B, 0x5C

kernel32.CreateMutexW.restype = wintypes.HANDLE
kernel32.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
kernel32.OpenMutexW.restype = wintypes.HANDLE
kernel32.OpenMutexW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
kernel32.CreateEventW.restype = wintypes.HANDLE
kernel32.CreateEventW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR)
kernel32.OpenEventW.restype = wintypes.HANDLE
kernel32.OpenEventW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
kernel32.SetEvent.argtypes = (wintypes.HANDLE,)
kernel32.ResetEvent.argtypes = (wintypes.HANDLE,)
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.WaitForMultipleObjects.restype = wintypes.DWORD
kernel32.WaitForMultipleObjects.argtypes = (wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE),
                                            wintypes.BOOL, wintypes.DWORD)
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.QueryFullProcessImageNameW.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                ctypes.POINTER(wintypes.DWORD))
advapi32.RegNotifyChangeKeyValue.restype = wintypes.LONG
advapi32.RegNotifyChangeKeyValue.argtypes = (wintypes.HKEY, wintypes.BOOL, wintypes.DWORD,
                                             wintypes.HANDLE, wintypes.BOOL)
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.GetAsyncKeyState.argtypes = (ctypes.c_int,)


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]


kernel32.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W))
kernel32.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W))

log = logging.getLogger("wispr-mute")


# --- config, logging, small helpers -------------------------------------------------

def load_config():
    config = dict(DEFAULT_CONFIG)
    try:
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        config.update({k: v for k, v in saved.items() if k in DEFAULT_CONFIG})
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        log.warning("Could not read %s (%s); using defaults", CONFIG_PATH, e)
    config["mute_audio"] = bool(config["mute_audio"])
    config["whitelist"] = normalize_whitelist(config["whitelist"])
    return config


def normalize_whitelist(raw):
    """Whitelist entries as {"exe", "enabled", ...}: converts the older plain exe-name
    strings (kept audible, so enabled), drops broken entries and duplicates."""
    if not isinstance(raw, list):
        log.warning("whitelist should be a list; ignoring it")
        return []
    out, seen = [], set()
    for item in raw:
        if isinstance(item, str):
            item = {"exe": item}
        if not isinstance(item, dict) or not isinstance(item.get("exe"), str) or not item["exe"].strip():
            log.warning("Ignoring whitelist entry %r", item)
            continue
        entry = {"exe": item["exe"].strip(), "enabled": bool(item.get("enabled", True))}
        for key in ("name", "path"):
            if isinstance(item.get(key), str) and item[key]:
                entry[key] = item[key]
        if app_key(entry["exe"]) not in seen:
            seen.add(app_key(entry["exe"]))
            out.append(entry)
    return out


def kept_apps(config):
    """Exe names of the whitelisted apps turned on (kept audible while muting)."""
    return [entry["exe"] for entry in config["whitelist"] if entry["enabled"]]


def display_name(entry):
    return entry.get("name") or entry["exe"].rsplit(".", 1)[0]


def describe(config):
    if not config["mute_audio"]:
        return "audible: nothing is muted while you dictate"
    kept = [display_name(e) for e in config["whitelist"] if e["enabled"]]
    if kept:
        return f"muting: everything except {', '.join(kept)} while you dictate"
    return "muting: everything while you dictate"


def edit_config(change):
    """Read the config, let change(config) edit it, and write it back whole.

    Keys the add-on doesn't know are dropped, older formats converted. The file is
    replaced in one step, so the helper never reads it half-written."""
    config = load_config()
    change(config)
    config["whitelist"] = normalize_whitelist(config["whitelist"])
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = CONFIG_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    temp.replace(CONFIG_PATH)
    return config


def set_muting(on):
    return edit_config(lambda c: c.update(mute_audio=bool(on)))


def set_app_enabled(exe, enabled):
    def change(config):
        for entry in config["whitelist"]:
            if app_key(entry["exe"]) == app_key(exe):
                entry["enabled"] = bool(enabled)
    return edit_config(change)


def add_app(exe, path=None, name=None):
    """Add an app to the whitelist, turned on (or turn it on, if it's there already)."""
    def change(config):
        for entry in config["whitelist"]:
            if app_key(entry["exe"]) == app_key(exe):
                entry["enabled"] = True
                break
        else:
            entry = {"exe": exe, "enabled": True}
            config["whitelist"].append(entry)
        if path:
            entry["path"] = str(path)
        if name:
            entry["name"] = name
    return edit_config(change)


def remove_app(exe):
    return edit_config(lambda c: c.update(
        whitelist=[e for e in c["whitelist"] if app_key(e["exe"]) != app_key(exe)]))


def set_app_details(exe, path=None, name=None):
    """Remember where an app's exe is and its friendly name, once found."""
    def change(config):
        for entry in config["whitelist"]:
            if app_key(entry["exe"]) == app_key(exe):
                if path:
                    entry["path"] = str(path)
                if name:
                    entry["name"] = name
    return edit_config(change)


def setup_logging(to_console):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s.%(msecs)03d %(message)s", "%Y-%m-%d %H:%M:%S")
    file_handler = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=1_000_000,
                                                        backupCount=1, encoding="utf-8")
    file_handler.setFormatter(fmt)
    log.addHandler(file_handler)
    if to_console and sys.stdout is not None:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        log.addHandler(console)


def process_path(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        kernel32.CloseHandle(handle)


def process_name(pid):
    if pid == 0:
        return "System sounds"
    path = process_path(pid)
    return path.rsplit("\\", 1)[-1] if path else f"pid {pid}"


def app_key(name):
    """Compare app names without case or a trailing .exe: "discord" matches Discord.exe."""
    name = name.lower()
    return name[:-4] if name.endswith(".exe") else name


def ducking_preference():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, DUCKING_KEY) as key:
            value = winreg.QueryValueEx(key, "UserDuckingPreference")[0]
    except OSError:
        value = 1  # Windows default when unset
    return value, DUCKING_NAMES.get(value, f"unknown ({value})")


# --- detecting Wispr Flow's mic use ----------------------------------------------

class WisprProcesses:
    """Exe paths of running Wispr Flow processes, cached briefly.

    Old version folders keep their registry keys, and a key whose app crashed while
    recording can stay at stop time 0 forever, so only the running exe counts.
    """

    def __init__(self, ttl=10.0):
        self.ttl = ttl
        self.paths = set()
        self.fetched = 0.0

    def get(self, force=False):
        if force or time.monotonic() - self.fetched > self.ttl:
            self.paths = running_wispr_paths()
            self.fetched = time.monotonic()
        return self.paths


def running_wispr_paths():
    return {path.lower() for path in running_exe_paths(WISPR_EXE)}


def running_wispr():
    """{pid: exe path} of the running Wispr Flow processes."""
    return running_processes(WISPR_EXE)


def running_exe_paths(exe):
    """Full paths of running processes whose exe file is named `exe` (any case)."""
    return set(running_processes(exe).values())


def running_processes(exe):
    """{pid: full path} of running processes whose exe file is named `exe` (any case)."""
    found = {}
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return found
    try:
        entry = PROCESSENTRY32W(dwSize=ctypes.sizeof(PROCESSENTRY32W))
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() == exe.lower():
                path = process_path(entry.th32ProcessID)
                if path:
                    found[entry.th32ProcessID] = path
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return found


def wispr_mic_entries(root):
    """Yield (key name, start, stop) for every Wispr Flow key under the mic store."""
    i = 0
    while True:
        try:
            name = winreg.EnumKey(root, i)
        except OSError:
            return
        i += 1
        if not WISPR_KEY_RE.search(name):
            continue
        try:
            with winreg.OpenKey(root, name) as sub:
                start = winreg.QueryValueEx(sub, "LastUsedTimeStart")[0]
                stop = winreg.QueryValueEx(sub, "LastUsedTimeStop")[0]
        except OSError:
            continue
        yield name, start, stop


def wispr_mic_open(root, processes):
    """True when the running Wispr Flow currently has the microphone open."""
    open_keys = [name.lower() for name, start, stop in wispr_mic_entries(root) if start and not stop]
    if not open_keys:
        return False
    running = processes.get()
    if not any(k.replace("#", "\\") in running for k in open_keys):
        running = processes.get(force=True)  # Wispr Flow may have just updated or restarted
    return any(k.replace("#", "\\") in running for k in open_keys)


class MicWatcher:
    """Tells whether the running Wispr Flow is recording, and waits between checks.

    Two signals: an active capture (microphone) session of a Wispr Flow process, from
    Core Audio, and the registry mic store. Since a Windows update in October 2026 the
    registry no longer records Wispr Flow's dictations, so capture sessions are
    checked every CAPTURE_POLL_MS. The registry is reread when it changes (which wakes
    the wait at once) or every poll_ms, and stop wakes the wait too. Needs COM
    initialised on the calling thread.
    """

    def __init__(self, poll_ms, stop_event):
        self.root = winreg.OpenKey(winreg.HKEY_CURRENT_USER, MIC_KEY, 0,
                                   winreg.KEY_READ | winreg.KEY_NOTIFY)
        self.change_event = kernel32.CreateEventW(None, False, False, None)
        handles = [self.change_event] + ([stop_event] if stop_event else [])
        self.handles = (wintypes.HANDLE * len(handles))(*handles)
        self.poll_ms = poll_ms
        self.registry_open = False
        self.registry_due = 0.0  # when to reread the registry without a change notification
        self.processes = WisprProcesses()
        self.capture = core_audio.CaptureSessions()
        self.pid_paths = {}  # pid -> lowercased exe path, for processes seen recording
        self.capture_failed = False  # logged once until capture checks work again

    def capture_open(self):
        """True when a running Wispr Flow process has an active microphone session."""
        try:
            pids = self.capture.active_pids()
        except OSError:
            if not self.capture_failed:
                log.exception("Could not check microphone sessions; using the registry only")
                self.capture_failed = True
            return False
        self.capture_failed = False
        if len(self.pid_paths) > 256:
            self.pid_paths.clear()
        paths = set()
        for pid in pids:
            if pid not in self.pid_paths:
                self.pid_paths[pid] = (process_path(pid) or "").lower()
            paths.add(self.pid_paths[pid])
        wispr = {p for p in paths if p.endswith("\\" + WISPR_EXE)}
        if not wispr:
            return False
        running = self.processes.get()
        if not wispr & running:
            running = self.processes.get(force=True)  # Wispr Flow may have just updated or restarted
        return bool(wispr & running)

    def arm(self):
        """Ask for one notification of the next change (notifications are one-shot)."""
        rc = advapi32.RegNotifyChangeKeyValue(
            wintypes.HKEY(self.root.handle), True,
            REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET, self.change_event, True)
        if rc != 0:
            log.warning("RegNotifyChangeKeyValue failed (%d); polling only", rc)

    def is_open(self):
        now = time.monotonic()
        if now >= self.registry_due:
            self.registry_open = wispr_mic_open(self.root, self.processes)
            self.registry_due = now + self.poll_ms / 1000
        return self.capture_open() or self.registry_open

    def wait(self, timeout_ms=None):
        """Return 'change', 'timeout' or 'stop'."""
        if timeout_ms is None:
            timeout_ms = min(self.poll_ms, CAPTURE_POLL_MS)
        rc = kernel32.WaitForMultipleObjects(len(self.handles), self.handles, False, timeout_ms)
        if rc == WAIT_OBJECT_0:
            self.registry_due = 0.0
            return "change"
        if rc == WAIT_OBJECT_0 + 1:
            return "stop"
        return "timeout"


# --- muting the output device --------------------------------------------------

class AudioMuter:
    """Mutes audio while Wispr Flow dictates and restores exactly what it changed.

    With no app to keep audible it mutes the default output device; otherwise it
    mutes each app's session on every output device except the kept ones, and keeps
    catching apps that start playing mid-dictation. A marker file lists what is muted until it
    is restored, so a crash mid-dictation is repaired the next time the helper starts.
    Windows remembers an app's mute after the app quits, so an app that quits while
    muted stays in the marker as pending and is unmuted when it next plays.
    """

    def __init__(self):
        self.device = None   # {"device_id", "name"}: output device muted as a whole
        self.apps = []       # [{"device_id", "device", "exe", "instance"}]: apps muted one by one
        self.pending = []    # apps that quit while muted, same shape as self.apps
        self.devices = None  # muting app by app, while dictating: output devices watched for new apps
        self.keep = set()
        self.seen = set()    # (device id, session) already handled this dictation
        self.names = {}      # pid -> exe name, this dictation
        self.muted_apps = set()  # app_key of each app muted this dictation

    @property
    def watching(self):
        return self.devices is not None

    def save(self):
        data = dict(self.device or {})  # device_id/name at the top, as older markers had it
        if self.apps:
            data["apps"] = self.apps
        if self.pending:
            data["pending"] = self.pending
        if data:
            MARKER_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        else:
            MARKER_PATH.unlink(missing_ok=True)

    def mute(self, kept):
        """Mute for a dictation: app by app keeping `kept` audible, or, with nothing
        to keep, the whole default output device (faster, and nothing slips through)."""
        if kept:
            self.mute_apps(kept)
        else:
            self.mute_device()

    def mute_device(self):
        started = time.perf_counter()
        device = core_audio.OutputDevice.default()
        if device.muted:
            log.info("  output %s was already muted; leaving it", device.name)
            return
        self.device = {"device_id": device.id, "name": device.name}
        self.save()
        device.muted = True
        log.info("  muted %s (%.0f ms)", device.name, (time.perf_counter() - started) * 1000)

    def mute_apps(self, kept):
        started = time.perf_counter()
        self.keep = {app_key(name) for name in kept}
        self.seen, self.names, self.muted_apps = set(), {}, set()
        default = core_audio.OutputDevice.default()
        self.devices = [default]
        muted, playing_kept = self._scan()  # the default output first, so most sound stops soonest
        default_ms = (time.perf_counter() - started) * 1000
        self.devices += [d for d in core_audio.OutputDevice.all_active() if d.id != default.id]
        more_muted, more_kept = self._scan(self.devices[1:])
        log.info("  muted %d app sessions on %d outputs (%.0f ms, default output in %.0f ms); kept %s",
                 len(muted + more_muted), len(self.devices), (time.perf_counter() - started) * 1000,
                 default_ms, summarize(playing_kept + more_kept) or "nothing (no whitelisted app is open)")

    def catch_new(self):
        """Muting app by app, mid-dictation: mute apps that started playing since the last scan."""
        if self.watching:
            muted, _ = self._scan()
            if muted:
                log.info("  muted %s (started playing mid-dictation)", summarize(muted))

    def _scan(self, devices=None):
        """Mute every session not seen yet this dictation and not whitelisted. Returns (muted, kept) names."""
        muted, kept = [], []
        for device in list(self.devices if devices is None else devices):
            try:
                sessions = device.sessions()
            except OSError:
                log.info("  an output device went away mid-dictation; no longer watching it")
                self.devices.remove(device)
                continue
            targets = []
            for session in sessions:
                key = (device.id, session.instance_id or session.pid)
                if key in self.seen:
                    continue  # handled already; if you unmuted it by hand, it stays unmuted
                self.seen.add(key)
                if session.pid not in self.names:
                    self.names[session.pid] = process_name(session.pid)
                exe = self.names[session.pid]
                if app_key(exe) in self.keep:
                    kept.append(exe)
                elif not session.muted or app_key(exe) in self.muted_apps:
                    # A new session of an app muted this dictation starts muted (Windows
                    # carries the mute over), so it is ours to restore. Any other session
                    # already muted (by you or the app) is left alone.
                    targets.append((session, exe))
            if not targets:
                continue
            name = device.name
            self.apps += [{"device_id": device.id, "device": name, "exe": exe,
                           "instance": session.instance_id} for session, exe in targets]
            self.save()  # before muting, so a crash in between still gets restored
            for session, exe in targets:
                try:
                    session.muted = True
                    muted.append(exe)
                    self.muted_apps.add(app_key(exe))
                except OSError as e:
                    log.warning("  could not mute %s on %s (%s)", exe, name, e)
        return muted, kept

    def restore(self):
        self.devices = None
        if self.device is not None:
            started = time.perf_counter()
            try:
                device = core_audio.OutputDevice.by_id(self.device["device_id"])
            except OSError:
                log.info("  muted output device is gone; nothing to restore")
            else:
                if device.muted:
                    device.muted = False
                    log.info("  unmuted %s (%.0f ms)", device.name, (time.perf_counter() - started) * 1000)
                else:
                    log.info("  %s was already unmuted by hand", device.name)
            self.device = None
        if self.apps:
            started = time.perf_counter()
            waiting, unmuted = self._unmute(self.apps)
            self.apps = []
            self.pending += waiting
            log.info("  unmuted %d app sessions (%.0f ms)", len(unmuted), (time.perf_counter() - started) * 1000)
            if waiting:
                log.info("  %s quit while muted; will unmute when it plays again",
                         summarize(r["exe"] for r in waiting))
        self.save()

    def retry_pending(self):
        """Unmute apps that quit while muted, once they are playing again."""
        if not self.pending:
            return
        waiting, unmuted = self._unmute(self.pending)
        if unmuted:
            log.info("Unmuted %s, which quit while muted and is back", summarize(unmuted))
        if len(waiting) != len(self.pending):
            self.pending = waiting
            self.save()

    @staticmethod
    def _unmute(records):
        """Unmute the recorded sessions. A session that is gone means its app quit or
        restarted: unmute any muted session of the same app on that output instead.
        Returns (records whose app isn't playing there now, names unmuted)."""
        waiting, unmuted = [], []
        by_device = {}
        for record in records:
            by_device.setdefault(record["device_id"], []).append(record)
        for device_id, group in by_device.items():
            try:
                sessions = core_audio.OutputDevice.by_id(device_id).sessions()
            except OSError:
                waiting += group  # output unplugged; its apps stay muted on it until it is back
                continue
            by_instance = {s.instance_id: s for s in sessions if s.instance_id}
            names = {}
            for record in group:
                session = by_instance.get(record["instance"])
                if session is not None:
                    matches = [session]
                else:
                    for s in sessions:
                        if s.pid not in names:
                            names[s.pid] = app_key(process_name(s.pid))
                    matches = [s for s in sessions if names[s.pid] == app_key(record["exe"])]
                if not matches:
                    waiting.append(record)
                for s in matches:
                    if s.muted:
                        s.muted = False
                        unmuted.append(record["exe"])
        return waiting, unmuted

    def recover(self):
        """Restore audio left muted by a previous run that died mid-dictation."""
        try:
            data = json.loads(MARKER_PATH.read_text(encoding="utf-8"))
            if "device_id" in data:
                self.device = {"device_id": data["device_id"], "name": data.get("name", "")}
            self.apps = [dict(r, instance=r.get("instance", "")) for r in data.get("apps", [])
                         if r["device_id"] and r["exe"]]
            self.pending = [dict(r, instance=r.get("instance", "")) for r in data.get("pending", [])
                            if r["device_id"] and r["exe"]]
        except FileNotFoundError:
            return False
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            MARKER_PATH.unlink(missing_ok=True)
            return False
        if self.device or self.apps:
            log.info("Found audio left muted by a previous run; restoring it")
        self.restore()
        self.retry_pending()
        return True


def summarize(names):
    """'Spotify.exe, chrome.exe x3' from a list of exe names."""
    counts = {}
    for name in names:
        counts[name] = counts.get(name, 0) + 1
    return ", ".join(f"{n} x{c}" if c > 1 else n for n, c in sorted(counts.items(), key=lambda x: x[0].lower()))


def load_saved_volumes():
    try:
        return json.loads(VOLUMES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def snapshot_app_volumes(saved):
    """Remember each app's last audible volume, so repair-audio can put it back."""
    changed = False
    for device in core_audio.OutputDevice.all_active():
        for session in device.sessions():
            if session.pid == 0:
                continue
            level = session.level
            if session.muted or level < SILENT_LEVEL:
                continue
            name = process_name(session.pid).lower()
            if saved.get(name) != round(level, 3):
                saved[name] = round(level, 3)
                changed = True
    if changed:
        VOLUMES_PATH.write_text(json.dumps(saved, indent=2, sort_keys=True), encoding="utf-8")


# --- commands -----------------------------------------------------------------------

def cmd_run(at_login=False):
    setup_logging(to_console=True)
    mutex = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        log.info("Helper is already running; exiting")
        return 1
    stop_event = kernel32.CreateEventW(None, True, False, STOP_EVENT_NAME)
    kernel32.ResetEvent(stop_event)
    core_audio.init_com()
    config = load_config()
    max_mute = float(config["max_mute_seconds"] or 0)
    watcher = MicWatcher(int(config["poll_ms"]), stop_event)
    muter = AudioMuter()
    saved_volumes = load_saved_volumes()
    next_snapshot = 0.0
    pinner = tray_pin.TrayPin()

    try:
        muter.recover()
    except OSError:
        log.exception("Could not restore audio from a previous run")
    log.info("Helper started: %s, max mute %s, Wispr Flow running: %s", describe(config),
             f"{max_mute:.0f} s" if max_mute else "off",
             ", ".join(sorted(watcher.processes.get())) or "no")
    if at_login:
        threading.Thread(target=tray_pin.login_watchdog, args=(running_wispr,), daemon=True).start()

    recording_since = None
    next_rescan = 0.0  # muting app by app: when to next look for apps that started playing
    capped = False  # max_mute_seconds hit; wait for the mic to close
    try:
        watcher.arm()  # always armed before reading, so a change in between still wakes us
        while True:
            mic_open = watcher.is_open()
            now = time.monotonic()
            try:
                if mic_open and recording_since is None and not capped:
                    recording_since = now
                    config = load_config()  # reread each dictation, so changes from the flyout need no restart
                    max_mute = float(config["max_mute_seconds"] or 0)
                    kept = kept_apps(config)
                    log.info("Mic opened (%s)", "audible: muting is off" if not config["mute_audio"]
                             else f"muting, keeping {', '.join(kept)}" if kept else "muting everything")
                    if config["mute_audio"]:
                        muter.mute(kept)
                elif mic_open and recording_since is not None and now >= next_rescan:
                    muter.catch_new()
                    next_rescan = now + RESCAN_MS / 1000
                elif not mic_open:
                    if recording_since is not None:
                        log.info("Mic closed after %.2f s", now - recording_since)
                        muter.restore()
                    recording_since, capped = None, False
                if recording_since is not None and max_mute and now - recording_since > max_mute:
                    log.info("Unmuting after max_mute_seconds (%.0f s)", max_mute)
                    muter.restore()
                    recording_since, capped = None, True
                if recording_since is None:
                    muter.retry_pending()
                if recording_since is None and now >= next_snapshot:
                    next_snapshot = now + SNAPSHOT_SECONDS
                    snapshot_app_volumes(saved_volumes)
                    try:
                        pinner.check(running_wispr())
                    except OSError:
                        log.exception("Could not check Wispr Flow's tray icon")
            except OSError:
                log.exception("Audio call failed")
            woke = watcher.wait()
            if woke == "stop":
                log.info("Stop requested")
                break
            if woke == "change":
                watcher.arm()
    except KeyboardInterrupt:
        log.info("Interrupted")
    finally:
        try:
            muter.restore()
        except OSError:
            log.exception("Could not restore audio on exit")
        kernel32.CloseHandle(mutex)
    return 0


def mutex_held(name):
    handle = kernel32.OpenMutexW(SYNCHRONIZE, False, name)
    if handle:
        kernel32.CloseHandle(handle)
        return True
    return False


def helper_running():
    return mutex_held(MUTEX_NAME)


def tray_running():
    return mutex_held(TRAY_MUTEX_NAME)


def stop_process(what, stop_event_name, mutex_name):
    """Signal a running helper or tray to stop, and wait for it to let go of its mutex."""
    handle = kernel32.OpenEventW(EVENT_MODIFY_STATE, False, stop_event_name)
    if not handle:
        print(f"{what} is not running.")
        return 0
    kernel32.SetEvent(handle)
    kernel32.CloseHandle(handle)
    for _ in range(50):
        if not mutex_held(mutex_name):
            print(f"{what} stopped.")
            return 0
        time.sleep(0.1)
    print(f"Asked the {what.lower()} to stop, but it is still running.")
    return 1


def cmd_stop():
    return stop_process("Helper", STOP_EVENT_NAME, MUTEX_NAME)


def filetime_text(value):
    if not value:
        return "-"
    seconds = value / 10_000_000 - 11_644_473_600
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(seconds)) + f".{int(seconds % 1 * 1000):03d}"


def cmd_status():
    config = load_config()
    max_mute = config["max_mute_seconds"]
    print(f"Helper running:   {'yes' if helper_running() else 'no'}")
    print(f"Tray icon:        {'running' if tray_running() else 'not running'}")
    print(f"Wispr Mute:       {describe(config)}  (max mute: {f'{max_mute} s' if max_mute else 'off'})")
    print("Whitelist:        " + (", ".join(f"{display_name(e)} ({'on' if e['enabled'] else 'off'})"
                                            for e in config["whitelist"]) or "empty"))
    running = running_wispr_paths()
    print(f"Wispr Flow:       {', '.join(sorted(running)) or 'not running'}")
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, MIC_KEY) as root:
        entries = sorted(wispr_mic_entries(root), key=lambda e: e[1], reverse=True)
        print("Mic use by Wispr Flow in the registry (newest first; no longer updated since an "
              "October 2026 Windows update):")
        for name, start, stop in entries[:3]:
            live = " (running exe)" if name.replace("#", "\\").lower() in running else ""
            state = "OPEN" if start and not stop else "closed"
            print(f"  {name.rsplit('#', 2)[-2]}{live}: {state}, last start {filetime_text(start)}, "
                  f"stop {filetime_text(stop)}")
    core_audio.init_com()
    print(f"Mic open now:     {'yes' if MicWatcher(CAPTURE_POLL_MS, None).is_open() else 'no'}")

    device = core_audio.OutputDevice.default()
    print(f"\nDefault output:   {device.name} ({'MUTED' if device.muted else 'not muted'})")
    try:
        marker = json.loads(MARKER_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        marker = {}
    if "device_id" in marker:
        print("                  the helper has it muted for a dictation right now")
    if marker.get("apps"):
        print(f"                  the helper has {len(marker['apps'])} app sessions muted for a dictation right now")
    if marker.get("pending"):
        print("Quit while muted:  " + summarize(r["exe"] for r in marker["pending"])
              + " (unmuted when they next play)")
    print(f"Windows ducking:  {ducking_preference()[1]}")
    print("App volumes on the default output:")
    keep = {app_key(name) for name in kept_apps(config)}
    for session in device.sessions():
        name = process_name(session.pid)
        flag = "  <- muted" if session.muted else ("  <- silent" if session.level < SILENT_LEVEL else "")
        if config["mute_audio"] and app_key(name) in keep:
            flag += "  (whitelisted: stays audible while dictating)"
        print(f"  {name:40} {session.level:4.0%}{flag}")
    print(f"\nConfig: {CONFIG_PATH}{'' if CONFIG_PATH.exists() else ' (not created; defaults in use)'}")
    print(f"Log:    {LOG_PATH}")
    return 0


def cmd_repair_audio(fix=False):
    """List (or with --fix, restore) apps left muted or at 0%, and a device left muted."""
    core_audio.init_com()
    saved = load_saved_volumes()
    found = 0
    if MARKER_PATH.exists() and not helper_running():
        found += 1
        print("Audio was left muted by a helper that stopped mid-dictation.")
        if fix:
            muter = AudioMuter()
            muter.recover()
            print("  restored it")
            if muter.pending:
                print("  not running, so unmuted when the helper next sees them play: "
                      + summarize(r["exe"] for r in muter.pending))
    for device in core_audio.OutputDevice.all_active():
        for session in device.sessions():
            muted, level = session.muted, session.level
            if not muted and level >= SILENT_LEVEL:
                continue
            found += 1
            name = process_name(session.pid)
            target = saved.get(name.lower(), 1.0) if level < SILENT_LEVEL else level
            problem = "muted" if muted else f"at {level:.0%}"
            print(f"{name} on {device.name}: {problem}"
                  + (f" -> restored to {target:.0%}" if fix else f" (would restore to {target:.0%})"))
            if fix:
                session.muted = False
                session.level = target
    if not found:
        print("No muted or silent apps found.")
    elif not fix:
        print("\nNothing changed. Run 'repair-audio --fix' to restore these.")
    return 0


def cmd_mute(args):
    """Show whether dictation mutes audio, or switch it with on/off."""
    if args:
        if args[0] not in ("on", "off"):
            print("Use: mute [on|off]")
            return 2
        try:
            set_muting(args[0] == "on")
        except (OSError, ValueError) as e:
            print(f"Could not update {CONFIG_PATH}: {e}")
            return 1
    config = load_config()
    print(f"Wispr Mute: {describe(config)}.")
    if args:
        print("Applies from your next dictation.")
    if not helper_running():
        print("The helper isn't running; run install.py to start it.")
    return 0


def ctrl_win_down():
    return bool(user32.GetAsyncKeyState(VK_CONTROL) & 0x8000) and bool(
        (user32.GetAsyncKeyState(VK_LWIN) | user32.GetAsyncKeyState(VK_RWIN)) & 0x8000)


def cmd_watch():
    """Print Ctrl+Win and mic changes with the delay between them. Ctrl+C to quit."""
    core_audio.init_com()
    watcher = MicWatcher(poll_ms=5, stop_event=None)
    print("Dictate with Wispr Flow a few times. Ctrl+C to quit.\n")
    keys_down = ctrl_win_down()
    mic_open = watcher.is_open()
    keys_at = time.perf_counter()
    watcher.arm()
    try:
        while True:
            now = time.perf_counter()
            down = ctrl_win_down()
            if down != keys_down:
                keys_down, keys_at = down, now
                print(f"{time.strftime('%H:%M:%S')}  Ctrl+Win {'down' if down else 'up'}")
            opened = watcher.is_open()
            if opened != mic_open:
                mic_open = opened
                delay = f"{(now - keys_at) * 1000:.0f} ms after Ctrl+Win {'down' if keys_down else 'up'}"
                print(f"{time.strftime('%H:%M:%S')}  mic {'OPEN' if opened else 'closed'}  ({delay})")
            if watcher.wait(timeout_ms=5) == "change":  # 5 ms keeps the key timing accurate
                watcher.arm()
    except KeyboardInterrupt:
        return 0


def main(argv):
    command = argv[1] if len(argv) > 1 else "status"
    commands = {
        "run": lambda: cmd_run(at_login="--at-login" in argv[2:]),
        "stop": cmd_stop,
        "mute": lambda: cmd_mute(argv[2:]),
        "status": cmd_status,
        "repair-audio": lambda: cmd_repair_audio(fix="--fix" in argv[2:]),
        "watch": cmd_watch,
        "test-notification": lambda: tray_pin.notify_didnt_start() or 0,
    }
    if command not in commands:
        print(__doc__)
        return 2
    return commands[command]()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
