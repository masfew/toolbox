"""The tray icon's flyout (Wispr Mute): a small Windows 11-style card above the icon.

  [ Muting ]  [ app ][ app ]      the switch (accent fill while muting; grey "Audible"
  [ (76px) ]  [  +  ][     ]      when off), and the whitelist: one tile per app, in its
  Wispr Mute                      brand colour (or as the app's own icon) when kept
                                  audible, grey when muted with the rest. Two rows; a
                                  column is added as it fills.

Click the switch to flip it, an app to keep it audible or not, + to add an app
(apps playing audio now, or "Browse for an app..."), right-click an app (or Delete)
to remove it. Hovering an app shows its name. The whitelist dims while Audible but
stays clickable. "Start helper" appears in the footer when the helper is down.

Shapes are drawn with GDI+ (anti-aliased), text with GDI (so it renders like the
rest of Windows), double-buffered. Windows 11 rounds the corners and draws the
border (DWM attributes). Colours follow the taskbar's light/dark setting and the
Windows accent colour. It closes on a click elsewhere, Esc or switching apps; a
50 ms check backs that up in case Windows didn't let it take focus.

The flyout only draws and reports: the tray (tray.py) owns the state and actions.
"""

import ctypes
import json
import math
import time
import winreg
from ctypes import wintypes

import app_icons
import tray_icons
import wispr_mute as w
from win32 import *  # noqa: F401,F403

CLASS_NAME, TIP_CLASS_NAME = "WisprMuteFlyout", "WisprMuteFlyoutTip"
THEME_KEY = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
ACCENT_KEY = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent"
CHECK_TIMER, CHECK_MS = 1, 50
TIP_TIMER, TIP_MS = 2, 450
REOPEN_GUARD = 0.4  # s: the click on the icon that closed the flyout shouldn't reopen it
ID_BROWSE = 1000

# Layout in pixels at 100% scaling.
PAD, GAP, MARGIN = 12, 8, 12
SWITCH, SWITCH_GLYPH, SWITCH_GLYPH_TOP = 76, 30, 13
BOX_PAD, CELL, CELL_GAP, APP_GLYPH = 6, 30, 4, 20
FOOTER_H, LINK_H, LINK_PAD = 30, 22, 6
RADIUS, CELL_RADIUS, LINK_RADIUS = 6, 5, 4
TIP_PAD_X, TIP_H, TIP_GAP = 8, 24, 6

_gdiplus_token = ctypes.c_size_t()


def start_gdiplus():
    if not _gdiplus_token.value:
        startup = GdiplusStartupInput(GdiplusVersion=1)
        gdiplus.GdiplusStartup(ctypes.byref(_gdiplus_token), ctypes.byref(startup), None)


def track_menu(owner, items, x, y, align):
    """Show a popup menu and return the chosen id (0 if none). items: None for a
    separator, or (label, id, checked); id 0 makes a greyed heading."""
    menu = user32.CreatePopupMenu()
    for item in items:
        if item is None:
            user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
        else:
            label, item_id, checked = item
            flags = MF_STRING | (MF_GRAYED if not item_id else 0) | (MF_CHECKED if checked else 0)
            user32.AppendMenuW(menu, flags, item_id, label)
    # Without the foreground switch, the menu wouldn't close when you click elsewhere.
    user32.SetForegroundWindow(owner)
    choice = user32.TrackPopupMenuEx(menu, align | TPM_RIGHTBUTTON | TPM_NONOTIFY | TPM_RETURNCMD,
                                     x, y, owner, None)
    user32.PostMessageW(owner, WM_NULL, 0, 0)
    user32.DestroyMenu(menu)
    return choice


# --- colours ------------------------------------------------------------------------

def taskbar_is_dark():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, THEME_KEY) as key:
            return winreg.QueryValueEx(key, "SystemUsesLightTheme")[0] == 0
    except OSError:
        return False


def accent_color(dark):
    """Windows' accent in the shade Windows 11 uses for filled controls: Light2 on
    dark, Dark1 on light (AccentPalette holds 8 RGBA shades, lightest first)."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, ACCENT_KEY) as key:
            data = winreg.QueryValueEx(key, "AccentPalette")[0]
        i = 1 if dark else 4
        return tuple(data[i * 4:i * 4 + 3])
    except (OSError, IndexError, TypeError, ValueError):
        return (76, 194, 255) if dark else (0, 95, 184)


def mix(a, b, t):
    """Colour a moved t of the way toward b."""
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def palette(dark):
    accent = accent_color(dark)
    if dark:
        c = dict(bg=(44, 44, 44), footer=(32, 32, 32), line=(29, 29, 29), text=(255, 255, 255),
                 title=(230, 230, 230), muted=(138, 138, 138), caution=(252, 225, 0), tile=(56, 56, 56),
                 tile_border=(68, 68, 68), box=(38, 38, 38), box_border=(54, 54, 54), empty=(44, 44, 44),
                 dash=(96, 96, 96), link_hover=(50, 50, 50), link_down=(44, 44, 44), focus=(255, 255, 255),
                 hover_toward=(255, 255, 255), plate=(236, 236, 236))
    else:
        c = dict(bg=(249, 249, 249), footer=(238, 238, 238), line=(229, 229, 229), text=(26, 26, 26),
                 title=(40, 40, 40), muted=(128, 128, 128), caution=(157, 93, 0), tile=(255, 255, 255),
                 tile_border=(222, 222, 222), box=(243, 243, 243), box_border=(229, 229, 229),
                 empty=(236, 236, 236), dash=(170, 170, 170), link_hover=(228, 228, 228), link_down=(222, 222, 222),
                 focus=(0, 0, 0), hover_toward=(0, 0, 0), plate=(255, 255, 255))
    c.update(accent=accent, on_accent=app_icons.ink_for(accent) if dark else (255, 255, 255))
    return c


def shade(rgb, state, c):
    """Hover and pressed variants of a fill: toward white on dark, toward black on light."""
    return mix(rgb, c["hover_toward"], {"hover": 0.08, "down": 0.14}.get(state, 0.0))


def argb(rgb, alpha=255):
    return (alpha << 24) | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]


def colorref(rgb):
    return rgb[0] | (rgb[1] << 8) | (rgb[2] << 16)


# --- drawing helpers ------------------------------------------------------------------

def fill_rect(g, rgb, x, y, w_, h):
    brush = ctypes.c_void_p()
    gdiplus.GdipCreateSolidFill(argb(rgb), ctypes.byref(brush))
    gdiplus.GdipFillRectangleI(g, brush, x, y, w_, h)
    gdiplus.GdipDeleteBrush(brush)


def rounded_rect(g, rect, radius, fill=None, outline=None, width=1.0, dashed=False):
    """Fill and/or outline a rounded rectangle; rect = (left, top, right, bottom)."""
    left, top, right, bottom = rect
    inset = width / 2 if outline and not fill else 0  # keep a lone outline inside the rect
    x, y = left + inset, top + inset
    w_, h = right - left - 2 * inset, bottom - top - 2 * inset
    d = min(2 * radius, w_, h)
    path = ctypes.c_void_p()
    gdiplus.GdipCreatePath(0, ctypes.byref(path))
    gdiplus.GdipAddPathArc(path, x, y, d, d, 180, 90)
    gdiplus.GdipAddPathArc(path, x + w_ - d, y, d, d, 270, 90)
    gdiplus.GdipAddPathArc(path, x + w_ - d, y + h - d, d, d, 0, 90)
    gdiplus.GdipAddPathArc(path, x, y + h - d, d, d, 90, 90)
    gdiplus.GdipClosePathFigure(path)
    if fill:
        brush = ctypes.c_void_p()
        gdiplus.GdipCreateSolidFill(argb(fill), ctypes.byref(brush))
        gdiplus.GdipFillPath(g, brush, path)
        gdiplus.GdipDeleteBrush(brush)
    if outline:
        pen = ctypes.c_void_p()
        gdiplus.GdipCreatePen1(argb(outline), width, UNIT_PIXEL, ctypes.byref(pen))
        if dashed:
            gdiplus.GdipSetPenDashStyle(pen, DASH_STYLE_DASH)
        gdiplus.GdipDrawPath(g, pen, path)
        gdiplus.GdipDeletePen(pen)
    gdiplus.GdipDeletePath(path)


def draw_text(hdc, text, font, rgb, rect, flags):
    old = gdi32.SelectObject(hdc, font)
    gdi32.SetTextColor(hdc, colorref(rgb))
    r = wintypes.RECT(*rect)
    user32.DrawTextW(hdc, text, -1, ctypes.byref(r), flags | DT_SINGLELINE | DT_NOPREFIX | DT_VCENTER)
    gdi32.SelectObject(hdc, old)


def text_width(hdc, font, text):
    old = gdi32.SelectObject(hdc, font)
    size = wintypes.SIZE()
    gdi32.GetTextExtentPoint32W(hdc, text, len(text), ctypes.byref(size))
    gdi32.SelectObject(hdc, old)
    return size.cx


def draw_coverage(g, coverage, size, rgb, x, y, cache, key):
    """Draw a size x size coverage mask (0..1) in one colour, via a cached ARGB buffer."""
    if key not in cache:
        data = bytearray()
        for a in coverage():
            data += bytes((rgb[2], rgb[1], rgb[0], round(a * 255)))
        cache[key] = ctypes.create_string_buffer(bytes(data), len(data))
    bitmap = ctypes.c_void_p()
    gdiplus.GdipCreateBitmapFromScan0(size, size, size * 4, PIXEL_FORMAT_32BPP_ARGB, cache[key],
                                      ctypes.byref(bitmap))
    gdiplus.GdipDrawImageRectI(g, bitmap, x, y, size, size)
    gdiplus.GdipDisposeImage(bitmap)


def draw_image(g, bgra, side, size, x, y, cache, key):
    """Draw a side x side BGRA image scaled to size x size, via a cached buffer."""
    if key not in cache:
        data = bgra()
        cache[key] = ctypes.create_string_buffer(data, len(data))
    bitmap = ctypes.c_void_p()
    gdiplus.GdipCreateBitmapFromScan0(side, side, side * 4, PIXEL_FORMAT_32BPP_ARGB, cache[key],
                                      ctypes.byref(bitmap))
    gdiplus.GdipSetInterpolationMode(g, INTERPOLATION_HIGH_QUALITY_BICUBIC)
    gdiplus.GdipDrawImageRectI(g, bitmap, x, y, size, size)
    gdiplus.GdipSetInterpolationMode(g, INTERPOLATION_DEFAULT)
    gdiplus.GdipDisposeImage(bitmap)


def monitor_dpi(monitor):
    if shcore is not None:
        x, y = wintypes.UINT(), wintypes.UINT()
        try:
            shcore.GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, ctypes.byref(x), ctypes.byref(y))
            return x.value
        except OSError:
            pass
    try:
        return user32.GetDpiForSystem()
    except AttributeError:
        return 96


def set_dwm(hwnd, dark):
    for attribute, value in ((DWMWA_USE_IMMERSIVE_DARK_MODE, int(dark)),
                             (DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND)):
        v = ctypes.c_int(value)
        try:
            dwmapi.DwmSetWindowAttribute(hwnd, attribute, ctypes.byref(v), ctypes.sizeof(v))
        except OSError:
            pass  # older Windows: square corners


class Tooltip:
    """A small rounded label above a tile (the app's name), shown without taking focus."""

    def __init__(self, flyout):
        self.flyout = flyout
        self.hwnd = None
        self.text = ""
        self.wndproc = WNDPROC(self.on_message)
        cls = WNDCLASSW(lpfnWndProc=self.wndproc, hInstance=flyout.instance, lpszClassName=TIP_CLASS_NAME)
        user32.RegisterClassW(ctypes.byref(cls))

    def show(self, text, rect):
        """Show `text` centred above rect (client coordinates of the flyout)."""
        f = self.flyout
        self.text = text
        hdc = user32.GetDC(None)
        width = text_width(hdc, f.font(12), text) + 2 * f.px(TIP_PAD_X)
        user32.ReleaseDC(None, hdc)
        height = f.px(TIP_H)
        corner = wintypes.POINT(rect[0], rect[1])
        user32.ClientToScreen(f.hwnd, ctypes.byref(corner))
        x = corner.x + (rect[2] - rect[0]) // 2 - width // 2
        y = corner.y - f.px(TIP_GAP) - height
        if self.hwnd is None:
            self.hwnd = user32.CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, TIP_CLASS_NAME,
                                               "", WS_POPUP, x, y, width, height, f.hwnd, None, f.instance, None)
            set_dwm(self.hwnd, f.dark)
        else:
            user32.SetWindowPos(self.hwnd, None, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE)
        self.size = (width, height)
        user32.InvalidateRect(self.hwnd, None, False)
        user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)

    def hide(self):
        if self.hwnd:
            user32.ShowWindow(self.hwnd, SW_HIDE)

    def destroy(self):
        if self.hwnd:
            hwnd, self.hwnd = self.hwnd, None
            user32.DestroyWindow(hwnd)

    def on_message(self, hwnd, msg, wparam, lparam):
        if msg == WM_PAINT and hwnd == self.hwnd:
            ps = PAINTSTRUCT()
            hdc = user32.BeginPaint(hwnd, ctypes.byref(ps))
            f, (width, height) = self.flyout, self.size
            g = ctypes.c_void_p()
            gdiplus.GdipCreateFromHDC(hdc, ctypes.byref(g))
            fill_rect(g, f.colors["bg"], 0, 0, width, height)
            gdiplus.GdipDeleteGraphics(g)
            gdi32.SetBkMode(hdc, TRANSPARENT)
            draw_text(hdc, self.text, f.font(12), f.colors["text"], (0, 0, width, height), DT_CENTER)
            user32.EndPaint(hwnd, ctypes.byref(ps))
            return 0
        if msg == WM_ERASEBKGND:
            return 1
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)


class Flyout:
    def __init__(self, tray):
        self.tray = tray
        self.hwnd = None
        self.closed_at = self.opened_at = 0.0
        self.anchor = (0, 0)
        self.scale = 1.0
        self.fonts, self.bitmaps, self.icons = {}, {}, {}
        self.items = []  # (key, (left, top, right, bottom)), in focus order
        self.empties = []  # rects of empty whitelist cells
        self.hover = self.pressed = self.focus = None
        self.show_focus = self.tracking = self.modal = False
        self.state = None
        start_gdiplus()
        self.wndproc = WNDPROC(self.on_message)  # kept referenced for the window's lifetime
        self.instance = kernel32.GetModuleHandleW(None)
        cls = WNDCLASSW(lpfnWndProc=self.wndproc, hInstance=self.instance, lpszClassName=CLASS_NAME,
                        hCursor=user32.LoadCursorW(None, ctypes.c_void_p(IDC_ARROW)))
        user32.RegisterClassW(ctypes.byref(cls))
        self.tip = Tooltip(self)

    @property
    def is_open(self):
        return bool(self.hwnd)

    # --- opening, closing, placing ---------------------------------------------------

    def toggle(self, x, y):
        now = time.monotonic()
        if self.is_open:
            if now - self.opened_at > 0.3:  # Enter on the icon can arrive twice
                self.close()
        elif now - self.closed_at > REOPEN_GUARD:
            self.open(x, y)

    def open(self, x, y):
        self.anchor = (x, y)
        monitor = user32.MonitorFromPoint(wintypes.POINT(x, y), MONITOR_DEFAULTTONEAREST)
        self.scale = monitor_dpi(monitor) / 96
        self.hover = self.pressed = None
        self.show_focus = self.tracking = self.modal = False
        self.focus = "switch"
        self.state = None
        self.update_state()
        left, top = self.position()
        self.hwnd = user32.CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, CLASS_NAME, "Wispr Mute", WS_POPUP,
                                           left, top, self.size[0], self.size[1], self.tray.hwnd, None,
                                           self.instance, None)
        set_dwm(self.hwnd, self.dark)
        user32.ShowWindow(self.hwnd, SW_SHOW)
        user32.SetForegroundWindow(self.hwnd)
        user32.SetTimer(self.hwnd, CHECK_TIMER, CHECK_MS, None)
        self.opened_at = time.monotonic()

    def close(self, clicked_away=False):
        """Close the flyout. clicked_away: it lost focus or a click landed outside it,
        which may be the click on the tray icon that is about to arrive as a toggle."""
        if self.hwnd:
            self.tip.destroy()
            hwnd, self.hwnd = self.hwnd, None
            user32.DestroyWindow(hwnd)
            if clicked_away:
                self.closed_at = time.monotonic()

    def position(self):
        """Centred over the icon, just above the taskbar (or below it, if it's at the top)."""
        x, y = self.anchor
        monitor = user32.MonitorFromPoint(wintypes.POINT(x, y), MONITOR_DEFAULTTONEAREST)
        info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
        user32.GetMonitorInfoW(monitor, ctypes.byref(info))
        work, margin = info.rcWork, self.px(MARGIN)
        width, height = self.size
        left = max(work.left + margin, min(x - width // 2, work.right - margin - width))
        top = work.top + margin if y < work.top else min(y, work.bottom) - margin - height
        return left, top

    def refresh(self):
        """Called by the tray when its state may have changed; redraws if it did."""
        if self.is_open and self.update_state():
            left, top = self.position()
            user32.SetWindowPos(self.hwnd, None, left, top, self.size[0], self.size[1],
                                SWP_NOZORDER | SWP_NOACTIVATE)
            self.invalidate()

    def update_state(self):
        """Recompute colours and layout if anything they depend on changed."""
        config = self.tray.config
        state = (config["mute_audio"], json.dumps(config["whitelist"]), self.tray.running, taskbar_is_dark(),
                 self.scale)
        if state == self.state:
            return False
        self.state = state
        self.dark = state[3]
        self.colors = palette(self.dark)
        self.apps = {"app:" + w.app_key(e["exe"]): e for e in config["whitelist"]}
        self.size = self.layout()
        if self.focus not in dict(self.items):
            self.focus = "switch"
        if self.hover not in dict(self.items):
            self.hover = None
        return True

    # --- layout and painting -----------------------------------------------------------

    def px(self, value):
        return round(value * self.scale)

    def font(self, size, weight=400):
        key = (size, weight, self.scale)
        if key not in self.fonts:
            self.fonts[key] = gdi32.CreateFontW(-self.px(size), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, 0, 0,
                                                CLEARTYPE_QUALITY, 0, "Segoe UI")
        return self.fonts[key]

    def layout(self):
        px, pad = self.px, self.px(PAD)
        switch = px(SWITCH)
        cell, cell_gap, box_pad = px(CELL), px(CELL_GAP), px(BOX_PAD)
        keys = list(self.apps) + ["add"]
        cols = max(2, math.ceil(len(keys) / 2))
        box_left = pad + switch + px(GAP)
        box_w = 2 * box_pad + cols * cell + (cols - 1) * cell_gap
        width = box_left + box_w + pad
        self.items = [("switch", (pad, pad, pad + switch, pad + switch))]
        self.box_rect = (box_left, pad, box_left + box_w, pad + switch)
        self.empties = []
        for i in range(cols * 2):
            row, col = divmod(i, cols)
            x = box_left + box_pad + col * (cell + cell_gap)
            y = pad + box_pad + row * (cell + cell_gap)
            rect = (x, y, x + cell, y + cell)
            if i < len(keys):
                self.items.append((keys[i], rect))
            else:
                self.empties.append(rect)
        self.footer_top = pad + switch + pad
        height = self.footer_top + px(FOOTER_H)
        self.title_rect = (pad, self.footer_top, width - pad, height)
        if not self.tray.running:
            hdc = user32.GetDC(None)
            link_w = text_width(hdc, self.font(12), "Start helper") + 2 * px(LINK_PAD)
            user32.ReleaseDC(None, hdc)
            top = self.footer_top + (px(FOOTER_H) - px(LINK_H)) // 2
            right = width - pad + px(LINK_PAD)
            self.items.append(("start", (right - link_w, top, right, top + px(LINK_H))))
        return width, height

    def app_icon(self, entry):
        key = (w.app_key(entry["exe"]), entry.get("path"))
        if key not in self.icons:
            self.icons[key] = app_icons.app_icon(entry["exe"], entry.get("path"))
        return self.icons[key]

    def paint(self):
        ps = PAINTSTRUCT()
        hdc = user32.BeginPaint(self.hwnd, ctypes.byref(ps))
        width, height = self.size
        mem = gdi32.CreateCompatibleDC(hdc)
        header = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=width, biHeight=-height,
                                  biPlanes=1, biBitCount=32)
        bits = ctypes.c_void_p()
        bitmap = gdi32.CreateDIBSection(hdc, ctypes.byref(header), 0, ctypes.byref(bits), None, 0)
        old_bitmap = gdi32.SelectObject(mem, bitmap)
        try:
            self.draw(mem, width, height)
            gdi32.BitBlt(hdc, 0, 0, width, height, mem, 0, 0, SRCCOPY)
        finally:
            gdi32.SelectObject(mem, old_bitmap)
            gdi32.DeleteObject(bitmap)
            gdi32.DeleteDC(mem)
            user32.EndPaint(self.hwnd, ctypes.byref(ps))

    def draw(self, hdc, width, height):
        c, px = self.colors, self.px
        muting = self.tray.config["mute_audio"]
        letters = []  # (text, colour, rect): app tiles without a traced glyph, drawn as text below

        def faded(rgb):  # the whitelist dims while Audible: nothing is being muted
            return rgb if muting else mix(rgb, c["box"], 0.6)

        g = ctypes.c_void_p()
        gdiplus.GdipCreateFromHDC(hdc, ctypes.byref(g))
        gdiplus.GdipSetSmoothingMode(g, SMOOTHING_ANTIALIAS)
        gdiplus.GdipSetPixelOffsetMode(g, PIXEL_OFFSET_HALF)
        fill_rect(g, c["bg"], 0, 0, width, height)
        fill_rect(g, c["footer"], 0, self.footer_top, width, height - self.footer_top)
        fill_rect(g, c["line"], 0, self.footer_top, width, max(1, px(1)))
        rounded_rect(g, self.box_rect, px(RADIUS), fill=c["box"], outline=c["box_border"], width=max(1, px(1)))
        for rect in self.empties:
            rounded_rect(g, rect, px(CELL_RADIUS), fill=faded(c["empty"]))

        for key, rect in self.items:
            state = "down" if key == self.pressed and key == self.hover else "hover" if key == self.hover else ""
            if key == "switch":
                if muting:
                    rounded_rect(g, rect, px(RADIUS), fill=shade(c["accent"], state, c))
                    ink, kind = c["on_accent"], "speaker_x"
                else:
                    rounded_rect(g, rect, px(RADIUS), fill=shade(c["tile"], state, c), outline=c["tile_border"],
                                 width=max(1, px(1)))
                    ink, kind = c["text"], "speaker_wave"
                size = px(SWITCH_GLYPH)
                draw_coverage(g, lambda: tray_icons.coverage(size, tray_icons.glyph(kind), 0, 0, size), size, ink,
                              (rect[0] + rect[2] - size) // 2, rect[1] + px(SWITCH_GLYPH_TOP), self.bitmaps,
                              (kind, size, ink))
            elif key in self.apps:
                entry = self.apps[key]
                icon = self.app_icon(entry)
                if entry["enabled"] and "image" in icon:  # the app's own icon, on a light plate
                    rounded_rect(g, rect, px(CELL_RADIUS), fill=faded(shade(c["plate"], state, c)))
                elif entry["enabled"]:
                    rounded_rect(g, rect, px(CELL_RADIUS), fill=faded(shade(icon["color"], state, c)))
                    ink = faded(icon["ink"])
                else:
                    rounded_rect(g, rect, px(CELL_RADIUS), fill=faded(shade(c["tile"], state, c)),
                                 outline=faded(c["tile_border"]), width=max(1, px(1)))
                    ink = faded(c["muted"])
                if "image" in icon:  # in colour when kept audible, grey and faint when muted
                    grey = not entry["enabled"]
                    opacity = (0.5 if grey else 1.0) * (1.0 if muting else 0.4)
                    size = px(APP_GLYPH)
                    draw_image(g, lambda: app_icons.image_bgra(icon["image"], grey, opacity), icon["image"][0],
                               size, (rect[0] + rect[2] - size) // 2, (rect[1] + rect[3] - size) // 2, self.bitmaps,
                               (key, grey, opacity, id(icon["image"])))
                elif "mask" in icon:
                    size = px(APP_GLYPH)
                    draw_coverage(g, lambda: app_icons.scaled_mask(icon["mask"], size), size, ink,
                                  (rect[0] + rect[2] - size) // 2, (rect[1] + rect[3] - size) // 2, self.bitmaps,
                                  (key, size, ink, id(icon["mask"])))
                else:
                    letters.append((icon["letter"], ink, rect))
            elif key == "add":
                if state:
                    rounded_rect(g, rect, px(CELL_RADIUS), fill=faded(shade(c["box"], state, c)))
                rounded_rect(g, rect, px(CELL_RADIUS), outline=faded(c["dash"]), width=max(1, px(1)), dashed=True)
                arm, thick = px(5), max(2, px(2))
                cx, cy = (rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2
                fill_rect(g, faded(c["muted"]), cx - arm, cy - thick // 2, 2 * arm, thick)
                fill_rect(g, faded(c["muted"]), cx - thick // 2, cy - arm, thick, 2 * arm)
            elif key == "start" and state:
                rounded_rect(g, rect, px(LINK_RADIUS), fill=c["link_" + state])
            if key == self.focus and self.show_focus:
                ring = (rect[0] - px(2), rect[1] - px(2), rect[2] + px(2), rect[3] + px(2))
                rounded_rect(g, ring, px(RADIUS), outline=c["focus"], width=max(2, px(2)))
        gdiplus.GdipDeleteGraphics(g)

        gdi32.SetBkMode(hdc, TRANSPARENT)
        for text, ink, rect in letters:
            draw_text(hdc, text, self.font(14, 600), ink, rect, DT_CENTER)
        switch = dict(self.items)["switch"]
        label_rect = (switch[0], switch[1] + px(SWITCH_GLYPH_TOP + SWITCH_GLYPH), switch[2], switch[3] - px(8))
        draw_text(hdc, "Muting" if muting else "Audible", self.font(12, 600 if muting else 400),
                  c["on_accent"] if muting else c["text"], label_rect, DT_CENTER)
        draw_text(hdc, "Wispr Mute", self.font(12, 600), c["title"], self.title_rect, DT_LEFT)
        if "start" in dict(self.items):
            draw_text(hdc, "Start helper", self.font(12), c["caution"], dict(self.items)["start"], DT_CENTER)

    def invalidate(self):
        if self.hwnd:
            user32.InvalidateRect(self.hwnd, None, False)

    # --- input ---------------------------------------------------------------------------

    def hit(self, lparam):
        x = ctypes.c_short(lparam & 0xFFFF).value
        y = ctypes.c_short((lparam >> 16) & 0xFFFF).value
        for key, (left, top, right, bottom) in self.items:
            if left <= x < right and top <= y < bottom:
                return key
        return None

    def screen_point(self, rect, corner="bottom-left"):
        x, y = (rect[0], rect[3]) if corner == "bottom-left" else (rect[0], rect[1])
        point = wintypes.POINT(x, y)
        user32.ClientToScreen(self.hwnd, ctypes.byref(point))
        return point.x, point.y

    def menu(self, items, x, y):
        """A popup menu from the flyout, which stays open (and focused) around it."""
        self.tip.hide()
        self.modal = True
        try:
            return track_menu(self.hwnd, items, x, y, TPM_LEFTALIGN | TPM_TOPALIGN)
        finally:
            self.modal = False
            if self.hwnd:
                user32.SetForegroundWindow(self.hwnd)

    def activate(self, key):
        if key == "switch":
            self.tray.toggle_muting()
        elif key in self.apps:
            self.tray.toggle_app(self.apps[key]["exe"])
        elif key == "add":
            self.add_menu()
        elif key == "start":
            self.tray.start_helper()
        self.refresh()

    def add_menu(self):
        apps = self.tray.apps_to_add()
        items = [(name, i + 1, False) for i, (_, _, name) in enumerate(apps)]
        if not items:
            items = [("No other apps are playing audio", 0, None)]
        items += [None, ("Browse for an app...", ID_BROWSE, False)]
        rect = dict(self.items)["add"]
        choice = self.menu(items, *self.screen_point(rect))
        if choice == ID_BROWSE:
            anchor = self.anchor
            self.close()  # the file dialog would take focus from it anyway
            path = self.tray.browse_for_app()
            if path:
                self.tray.add_app(path)
            self.open(*anchor)
        elif 0 < choice <= len(apps):
            self.tray.add_app(apps[choice - 1][1])

    def remove_menu(self, key, x=None, y=None):
        entry = self.apps[key]
        if x is None:
            x, y = self.screen_point(dict(self.items)[key])
        if self.menu([(f"Remove {w.display_name(entry)}", 1, False)], x, y) == 1:
            self.tray.remove_app(entry["exe"])
            self.refresh()

    def move_focus(self, step):
        keys = [key for key, _ in self.items]
        i = keys.index(self.focus) if self.focus in keys else 0
        self.focus = keys[(i + step) % len(keys)]
        self.show_focus = True
        self.invalidate()

    def clicked_elsewhere(self):
        """Backup for closing: a mouse button is down outside the flyout."""
        if not any(user32.GetAsyncKeyState(vk) & 0x8000 for vk in (VK_LBUTTON, VK_RBUTTON, VK_MBUTTON)):
            return False
        cursor, rect = wintypes.POINT(), wintypes.RECT()
        user32.GetCursorPos(ctypes.byref(cursor))
        user32.GetWindowRect(self.hwnd, ctypes.byref(rect))
        return not (rect.left <= cursor.x < rect.right and rect.top <= cursor.y < rect.bottom)

    def tooltip_text(self, key):
        if key in self.apps:
            return w.display_name(self.apps[key])
        if key == "add":
            return "Add an app"
        return None

    def on_message(self, hwnd, msg, wparam, lparam):
        try:
            if hwnd != self.hwnd:  # messages while the window is being created or destroyed
                return user32.DefWindowProcW(hwnd, msg, wparam, lparam)
            if msg == WM_PAINT:
                self.paint()
                return 0
            if msg == WM_ERASEBKGND:
                return 1
            if msg == WM_CLOSE:
                self.close()
                return 0
            if msg == WM_ACTIVATE and (wparam & 0xFFFF) == WA_INACTIVE:
                if not self.modal:
                    self.close(clicked_away=True)
                return 0
            if msg == WM_TIMER:
                if wparam == TIP_TIMER:
                    user32.KillTimer(hwnd, TIP_TIMER)
                    text = self.tooltip_text(self.hover)
                    if text and not self.modal:
                        self.tip.show(text, dict(self.items)[self.hover])
                elif not self.modal and self.clicked_elsewhere():
                    self.close(clicked_away=True)
                return 0
            if msg == WM_MOUSEMOVE:
                if not self.tracking:
                    track = TRACKMOUSEEVENT(cbSize=ctypes.sizeof(TRACKMOUSEEVENT), dwFlags=TME_LEAVE, hwndTrack=hwnd)
                    self.tracking = bool(user32.TrackMouseEvent(ctypes.byref(track)))
                key = self.hit(lparam)
                if key != self.hover or self.show_focus:
                    self.hover, self.show_focus = key, False
                    self.tip.hide()
                    user32.KillTimer(hwnd, TIP_TIMER)
                    if self.tooltip_text(key):
                        user32.SetTimer(hwnd, TIP_TIMER, TIP_MS, None)
                    self.invalidate()
                return 0
            if msg == WM_MOUSELEAVE:
                self.tracking, self.hover = False, None
                self.tip.hide()
                user32.KillTimer(hwnd, TIP_TIMER)
                self.invalidate()
                return 0
            if msg == WM_LBUTTONDOWN:
                self.pressed = self.hit(lparam)
                self.tip.hide()
                self.invalidate()
                return 0
            if msg == WM_LBUTTONUP:
                key, pressed, self.pressed = self.hit(lparam), self.pressed, None
                self.invalidate()
                if key and key == pressed:
                    self.focus = key
                    self.activate(key)
                return 0
            if msg == WM_RBUTTONUP:
                key = self.hit(lparam)
                if key in self.apps:
                    cursor = wintypes.POINT()
                    user32.GetCursorPos(ctypes.byref(cursor))
                    self.remove_menu(key, cursor.x, cursor.y)
                return 0
            if msg == WM_KEYDOWN:
                if wparam == VK_ESCAPE:
                    self.close()
                elif wparam == VK_TAB:
                    self.move_focus(-1 if user32.GetKeyState(VK_SHIFT) & 0x8000 else 1)
                elif wparam in (VK_RIGHT, VK_DOWN):
                    self.move_focus(1)
                elif wparam in (VK_LEFT, VK_UP):
                    self.move_focus(-1)
                elif wparam in (VK_RETURN, VK_SPACE) and self.focus:
                    self.show_focus = True
                    self.activate(self.focus)
                elif wparam in (VK_DELETE, VK_APPS) and self.focus in self.apps:
                    self.show_focus = True
                    self.remove_menu(self.focus)
                return 0
            if msg == WM_DESTROY:
                user32.KillTimer(hwnd, CHECK_TIMER)
                user32.KillTimer(hwnd, TIP_TIMER)
                return 0
        except Exception:
            self.tray.log_exception("Flyout error handling message 0x%04x" % msg)
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)
