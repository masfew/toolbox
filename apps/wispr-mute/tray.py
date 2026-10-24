"""Tray icon for the Wispr Mute: shows whether dictation mutes
your audio, and switches it.

The icon is Wispr Flow's own tray icon with a badge: red (muted speaker) when muting,
whether or not whitelisted apps are kept audible, grey when muting is switched off
(Audible), and amber "!" when the helper isn't running. Hovering shows the state. A left click opens the flyout above the
icon (flyout.py): the Muting/Audible switch and the whitelist's app buttons. A right
click opens a plain menu with the same switches plus Quit.

The tray only reads and writes the config; the helper rereads it each time the mic
opens. It runs as its own process (pythonw, no window), so a problem here never
touches the muting itself.

  python tray.py [run]   run the tray icon (what the Startup shortcut launches)
  python tray.py stop    close a running tray icon
"""

import ctypes
import logging
import logging.handlers
import os
import sys
import winreg
from ctypes import wintypes
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import app_icons  # noqa: E402
import core_audio  # noqa: E402
import flyout  # noqa: E402
import install  # noqa: E402
import tray_icons  # noqa: E402
import wispr_mute as w  # noqa: E402
from win32 import *  # noqa: E402,F401,F403  (Win32 declarations shared with flyout.py)

LOG_PATH = w.DATA_DIR / "tray.log"
THEME_KEY = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"

WM_TRAY = WM_APP + 1
TIMER_ID, TIMER_MS = 1, 1000
ICON_ID = 1
ID_MUTING, ID_START, ID_QUIT, ID_APP = 1, 2, 3, 100  # ID_APP + i: the i-th whitelisted app

log = logging.getLogger("wispr-mute-tray")


def setup_logging():
    w.DATA_DIR.mkdir(parents=True, exist_ok=True)
    log.setLevel(logging.INFO)
    handler = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=200_000, backupCount=1, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)


def follow_taskbar_theme():
    """Draw menus dark or light to match the taskbar, as Windows' own tray menus do
    (Windows' "apps" and "system" themes can differ). Uses undocumented uxtheme exports
    (ordinals 135 SetPreferredAppMode, 136 FlushMenuThemes) that many tray apps use;
    if they're ever missing, menus are simply light."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, THEME_KEY) as key:
            light = winreg.QueryValueEx(key, "SystemUsesLightTheme")[0]
    except OSError:
        light = 1
    try:
        uxtheme = ctypes.WinDLL("uxtheme")
        set_preferred_app_mode = uxtheme[135]
        set_preferred_app_mode.argtypes, set_preferred_app_mode.restype = (ctypes.c_int,), ctypes.c_int
        set_preferred_app_mode(3 if light else 2)  # ForceLight / ForceDark
        uxtheme[136]()
    except (OSError, AttributeError):
        pass


def icon_size():
    """Small-icon size for the taskbar's DPI (16 px at 100%, 20 at 125%, 24 at 150%...)."""
    try:
        dpi = user32.GetDpiForSystem()
        return user32.GetSystemMetricsForDpi(SM_CXSMICON, dpi)
    except AttributeError:
        return user32.GetSystemMetrics(SM_CXSMICON)


def make_icon(pixels, size):
    header = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=size, biHeight=-size,
                              biPlanes=1, biBitCount=32, biCompression=0)
    bits = ctypes.c_void_p()
    hdc = user32.GetDC(None)
    colour = gdi32.CreateDIBSection(hdc, ctypes.byref(header), 0, ctypes.byref(bits), None, 0)
    user32.ReleaseDC(None, hdc)
    data = tray_icons.to_bgra(pixels)
    ctypes.memmove(bits, data, len(data))
    mask_bits = ctypes.create_string_buffer(((size + 15) // 16) * 2 * size)  # all zero: alpha decides
    mask = gdi32.CreateBitmap(size, size, 1, 1, mask_bits)
    info = ICONINFO(fIcon=True, hbmMask=mask, hbmColor=colour)
    icon = user32.CreateIconIndirect(ctypes.byref(info))
    gdi32.DeleteObject(colour)
    gdi32.DeleteObject(mask)
    return icon


def work_area_at(x, y):
    """The work area (screen minus taskbar) of the monitor holding point (x, y)."""
    monitor = user32.MonitorFromPoint(wintypes.POINT(x, y), MONITOR_DEFAULTTONEAREST)
    info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
    user32.GetMonitorInfoW(monitor, ctypes.byref(info))
    return info.rcWork


def tray_state(config, running):
    if not running:
        return "stopped"
    return "muting" if config["mute_audio"] else "audible"


def tooltip(config, running):
    kept = [w.display_name(e) for e in config["whitelist"] if e["enabled"]]
    if not running:
        text = "Wispr Mute: helper isn't running\nNothing is muted while you dictate. Click to start it"
    elif not config["mute_audio"]:
        text = "Wispr Mute: audible\nNothing is muted while you dictate"
    elif kept:
        text = f"Wispr Mute: muting\n{', '.join(kept)} {'stays' if len(kept) == 1 else 'stay'} audible while you dictate"
    else:
        text = "Wispr Mute: muting\nAll sound is muted while you dictate"
    return text if len(text) < 128 else text[:124] + "..."


def playing_apps(exclude):
    """[(exe, path, name)] of apps with an audio session on any output device, other
    than System sounds, this process and exe names in `exclude` (app keys)."""
    found, own = {}, os.getpid()
    for device in core_audio.OutputDevice.all_active():
        for session in device.sessions():
            if session.pid in (0, own):
                continue
            path = w.process_path(session.pid)
            if not path:
                continue
            exe = Path(path).name
            if w.app_key(exe) not in exclude and w.app_key(exe) not in found:
                found[w.app_key(exe)] = (exe, path, app_icons.file_description(path) or Path(path).stem)
    # Different exes can share a name (a game and its editor); tell those apart.
    names = [name for _, _, name in found.values()]
    apps = [(exe, path, f"{name} ({exe})" if names.count(name) > 1 else name) for exe, path, name in found.values()]
    return sorted(apps, key=lambda app: app[2].lower())


def browse_for_app(owner):
    """Let the user pick a program (.exe); its path, or None if cancelled."""
    buffer = ctypes.create_unicode_buffer(1024)
    dialog = OPENFILENAMEW(lStructSize=ctypes.sizeof(OPENFILENAMEW), hwndOwner=owner,
                           lpstrFilter="Programs (*.exe)\0*.exe\0", lpstrFile=ctypes.cast(buffer, wintypes.LPWSTR),
                           nMaxFile=len(buffer), lpstrTitle="Add an app to Wispr Mute's whitelist",
                           lpstrInitialDir=os.environ.get("ProgramFiles", "C:\\"),
                           Flags=OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR)
    return buffer.value if comdlg32.GetOpenFileNameW(ctypes.byref(dialog)) else None


class Tray:
    def __init__(self, stop_event):
        self.stop_event = stop_event
        self.icons = {}  # (state, size, base image path) -> HICON
        self.added = False
        self.config_stamp = None
        self.config = w.load_config()
        self.running = w.helper_running()
        self.shown = None  # (icon key, tooltip) last given to the shell
        self.base_path = tray_icons.wispr_tray_png()
        self.ticks = 0

        self.taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")
        self.wndproc = WNDPROC(self.on_message)  # kept referenced for the window's lifetime
        instance = kernel32.GetModuleHandleW(None)
        cls = WNDCLASSW(lpfnWndProc=self.wndproc, hInstance=instance, lpszClassName="WisprMuteTray")
        user32.RegisterClassW(ctypes.byref(cls))
        self.hwnd = user32.CreateWindowExW(WS_EX_TOOLWINDOW, "WisprMuteTray", "Wispr Mute tray",
                                           0, 0, 0, 0, 0, None, None, instance, None)
        user32.SetTimer(self.hwnd, TIMER_ID, TIMER_MS, None)
        self.flyout = flyout.Flyout(self)
        self.find_app_paths()
        self.refresh(force=True)

    # --- the icon in the notification area --------------------------------------

    def notify_data(self, flags):
        return NOTIFYICONDATAW(cbSize=ctypes.sizeof(NOTIFYICONDATAW), hWnd=self.hwnd, uID=ICON_ID,
                               uFlags=flags, uCallbackMessage=WM_TRAY)

    def icon_for(self, state):
        key = (state, icon_size(), self.base_path)
        if key not in self.icons:
            self.icons[key] = make_icon(tray_icons.render(state, key[1]), key[1])
        return key, self.icons[key]

    def refresh(self, force=False):
        """Bring the icon and tooltip up to date with the config and the helper."""
        key, icon = self.icon_for(tray_state(self.config, self.running))
        tip = tooltip(self.config, self.running)
        if not force and self.added and self.shown == (key, tip):
            return
        data = self.notify_data(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP)
        data.hIcon, data.szTip = icon, tip
        if self.added:
            self.added = bool(shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(data)))
        if not self.added:  # first time, after Explorer restarts, or if the taskbar wasn't ready at login
            shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self.notify_data(0)))
            self.added = bool(shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(data)))
            if self.added:
                data.uVersion = NOTIFYICON_VERSION_4
                shell32.Shell_NotifyIconW(NIM_SETVERSION, ctypes.byref(data))
        self.shown = (key, tip) if self.added else None

    def poll(self):
        """Once a second: notice changes made elsewhere, and the helper starting or stopping."""
        if kernel32.WaitForSingleObject(self.stop_event, 0) == WAIT_OBJECT_0:
            log.info("Stop requested")
            user32.DestroyWindow(self.hwnd)
            return
        try:
            stamp = w.CONFIG_PATH.stat().st_mtime_ns
        except OSError:
            stamp = None
        if stamp != self.config_stamp:
            self.config_stamp = stamp
            self.config = w.load_config()
        self.running = w.helper_running()
        self.ticks += 1
        if self.ticks % 60 == 0:  # Wispr Flow updates now and then; follow its icon
            self.base_path = tray_icons.wispr_tray_png()
        if self.ticks % 10 == 0:
            self.find_app_paths()
        self.refresh()
        self.flyout.refresh()

    def find_app_paths(self):
        """Whitelisted apps without a known exe path (Discord, carried over from the old
        config), or whose exe is gone because the app updated into a new version folder
        (Discord's app-1.0.x), get one, and their friendly name, once they're seen running."""
        for entry in self.config["whitelist"]:
            if "path" not in entry or not Path(entry["path"]).is_file():
                path = app_icons.find_exe(entry["exe"])
                if path:
                    self.edit(w.set_app_details, entry["exe"], path, app_icons.file_description(path))

    # --- actions (from the flyout and the menu) ---------------------------------------

    def edit(self, change, *args):
        """Apply a config change; on failure, log it and say so."""
        try:
            change(*args)
        except (OSError, ValueError) as e:
            log.exception("Could not update the config")
            user32.MessageBoxW(self.hwnd, f"Could not update {w.CONFIG_PATH}:\n{e}", "Wispr Mute", 0x10)
        self.config_stamp = None  # reread on the poll below
        self.poll()

    def toggle_muting(self):
        log.info("Muting switched %s", "off (audible)" if self.config["mute_audio"] else "on")
        self.edit(w.set_muting, not self.config["mute_audio"])

    def toggle_app(self, exe):
        for entry in self.config["whitelist"]:
            if w.app_key(entry["exe"]) == w.app_key(exe):
                log.info("%s %s", w.display_name(entry), "muted with the rest" if entry["enabled"] else "kept audible")
                self.edit(w.set_app_enabled, exe, not entry["enabled"])

    def add_app(self, path):
        exe = Path(path).name
        log.info("Added %s to the whitelist (%s)", exe, path)
        self.edit(w.add_app, exe, path, app_icons.file_description(path) or Path(path).stem)

    def remove_app(self, exe):
        log.info("Removed %s from the whitelist", exe)
        self.edit(w.remove_app, exe)

    def start_helper(self):
        log.info("Starting the helper")
        install.start_detached(install.pythonw(), HERE / "wispr_mute.py", ["run"])

    def apps_to_add(self):
        return playing_apps({w.app_key(e["exe"]) for e in self.config["whitelist"]})

    def browse_for_app(self):
        return browse_for_app(self.hwnd)

    def log_exception(self, message):
        log.exception(message)

    # --- the menu (right click) --------------------------------------------------------

    def show_menu(self, x, y):
        self.flyout.close()
        self.poll()
        apps = self.config["whitelist"]
        items = [("Muting while dictating", ID_MUTING, self.config["mute_audio"]), None]
        if apps:
            items += [("Keep audible", 0, None)]
            items += [(w.display_name(entry), ID_APP + i, entry["enabled"]) for i, entry in enumerate(apps)]
            items += [None]
        if not self.running:
            items += [("Start helper (not running)", ID_START, False)]
        items += [("Quit tray icon", ID_QUIT, False)]

        # The anchor Windows gives is on the icon itself; open from the taskbar's edge
        # instead, so the menu sits on top of the taskbar rather than over its icons.
        work = work_area_at(x, y)
        if y >= work.bottom:
            y, vertical = work.bottom, TPM_BOTTOMALIGN
        elif y < work.top:
            y, vertical = work.top, TPM_TOPALIGN
        else:
            vertical = TPM_BOTTOMALIGN
        choice = flyout.track_menu(self.hwnd, items, x, y, TPM_CENTERALIGN | vertical)
        if choice == ID_MUTING:
            self.toggle_muting()
        elif choice == ID_START:
            self.start_helper()
        elif choice == ID_QUIT:
            log.info("Quit from the menu")
            user32.DestroyWindow(self.hwnd)
        elif choice >= ID_APP and choice - ID_APP < len(apps):
            self.toggle_app(apps[choice - ID_APP]["exe"])

    # --- window messages -------------------------------------------------------------

    def on_message(self, hwnd, msg, wparam, lparam):
        try:
            if msg == WM_TRAY:
                event = lparam & 0xFFFF
                # Version 4 passes the icon's anchor point in wParam, so the flyout or
                # menu opens right at the icon, even when opened from the keyboard.
                x = ctypes.c_short(wparam & 0xFFFF).value
                y = ctypes.c_short((wparam >> 16) & 0xFFFF).value
                if event in (NIN_SELECT, NIN_KEYSELECT):
                    self.poll()
                    self.flyout.toggle(x, y)
                elif event == WM_CONTEXTMENU:
                    self.show_menu(x, y)
                return 0
            if msg == WM_TIMER:
                self.poll()
                return 0
            if msg == self.taskbar_created:  # Explorer restarted; the icon must be added again
                self.added = False
                self.refresh(force=True)
                return 0
            if msg in (WM_DPICHANGED, WM_DISPLAYCHANGE, WM_SETTINGCHANGE):
                if msg == WM_SETTINGCHANGE:
                    follow_taskbar_theme()  # light/dark may have been switched
                self.refresh(force=True)  # the icon size may have changed
            if msg == WM_DESTROY:
                self.flyout.close()
                shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self.notify_data(0)))
                for icon in self.icons.values():
                    user32.DestroyIcon(icon)
                user32.PostQuitMessage(0)
                return 0
        except Exception:
            log.exception("Error handling message 0x%04x", msg)
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)


def cmd_run():
    setup_logging()
    mutex = kernel32.CreateMutexW(None, False, w.TRAY_MUTEX_NAME)
    if ctypes.get_last_error() == w.ERROR_ALREADY_EXISTS:
        log.info("Tray icon is already running; exiting")
        return 1
    stop_event = kernel32.CreateEventW(None, True, False, w.TRAY_STOP_EVENT_NAME)
    kernel32.ResetEvent(stop_event)
    try:
        user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
    except AttributeError:
        pass
    core_audio.init_com()  # for listing the apps playing audio (the flyout's + button)
    follow_taskbar_theme()
    tray = Tray(stop_event)
    log.info("Tray icon started (%s; helper %s; icon %d px from %s)", w.describe(tray.config),
             "running" if tray.running else "not running", icon_size(), tray.base_path or "fallback")
    msg = MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
    kernel32.CloseHandle(mutex)
    return 0


def cmd_stop():
    return w.stop_process("Tray icon", w.TRAY_STOP_EVENT_NAME, w.TRAY_MUTEX_NAME)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    commands = {"run": cmd_run, "stop": cmd_stop}
    if command not in commands:
        print(__doc__)
        sys.exit(2)
    sys.exit(commands[command]())
