//! Screen capture. The screen is frozen first: one picture of every monitor at full resolution,
//! taken before anything is shown, so menus and tooltips stay in the shot. A plain Win32 window over
//! the whole desktop then shows that picture dimmed, with a toolbar at the top: Area (the default,
//! drag to pick), Window and Full screen (click to pick), and Close. F (or Enter) takes the screen
//! under the pointer in any mode; Esc or a right-click cancels. The toolbar hides while a dragged
//! area comes near it. It's never in the shot, which comes from the frozen picture.
//!
//! The overlay isn't a webview: it appears at once, even when the capture shortcut starts Sketch, and
//! it draws the frozen picture one to one with the screen's pixels on every monitor, so nothing is
//! scaled or blurred whatever each monitor's display scale is. It runs on a thread of its own with
//! its own message loop, apart from Tauri's.

use std::sync::atomic::{AtomicBool, Ordering};

/// A captured picture: straight RGBA, top row first.
pub struct Shot {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

static BUSY: AtomicBool = AtomicBool::new(false);

/// Claims the capture. False while one is already on screen, so a second press does nothing.
pub fn begin() -> bool {
    !BUSY.swap(true, Ordering::AcqRel)
}

pub fn end() {
    BUSY.store(false, Ordering::Release);
}

/// Whether a capture is on screen.
pub fn busy() -> bool {
    BUSY.load(Ordering::Acquire)
}

/// Screen positions in physical pixels on every monitor. Tauri asks for this too, but only once its
/// event loop starts, which is after a cold-start capture has frozen the screen.
pub fn dpi_aware() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        // Fails when the manifest already set it, which is fine.
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

/// True when a Sketch window is the one in front, so a capture shortcut pressed in Sketch hides it first.
pub fn sketch_in_front() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        let mut pid = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid as *mut u32));
        return pid == std::process::id();
    }
    #[cfg(not(windows))]
    false
}

/// Turns Windows' fade on hiding and showing a window off or back on. With it on, a window hidden
/// for a capture is still fading out when the screen is frozen.
pub fn set_fade(hwnd: isize, on: bool) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
        let off: windows::core::BOOL = (!on).into();
        let _ = DwmSetWindowAttribute(windows::Win32::Foundation::HWND(hwnd as _), DWMWA_TRANSITIONS_FORCEDISABLED, &off as *const _ as *const _, 4);
    }
    #[cfg(not(windows))]
    let _ = (hwnd, on);
}

/// Waits until windows hidden a moment ago are gone from the screen.
pub fn wait_for_screen() {
    #[cfg(windows)]
    unsafe {
        // Each flush waits for the next frame the desktop composes.
        for _ in 0..3 {
            let _ = windows::Win32::Graphics::Dwm::DwmFlush();
        }
    }
}

/// Freezes the screen, lets the user pick, and returns what they picked. None when cancelled.
/// Blocks until then; call it from a thread that can wait.
pub fn pick() -> Option<Shot> {
    #[cfg(windows)]
    return imp::pick();
    #[cfg(not(windows))]
    None
}

/// Whether another app already holds a key combination as a global hotkey.
pub fn hotkey_taken(mods: u32, vk: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT};
        const PROBE: i32 = 0x5ce7;
        if RegisterHotKey(None, PROBE, HOT_KEY_MODIFIERS(mods) | MOD_NOREPEAT, vk).is_ok() {
            let _ = UnregisterHotKey(None, PROBE);
            return false;
        }
        return true;
    }
    #[cfg(not(windows))]
    {
        let _ = (mods, vk);
        false
    }
}

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DWMWA_TRANSITIONS_FORCEDISABLED};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, SetFocus, VK_ESCAPE, VK_RETURN};
    use windows::Win32::UI::WindowsAndMessaging::*;

    use super::Shot;

    /// Pointer travel, in pixels, that turns a click into a drag.
    const DRAG_START: i32 = 4;
    /// Windows 11's accent blue in dark mode, which shows on any dimmed screen.
    const ACCENT: COLORREF = COLORREF(0x00ffcd60);
    const PILL: COLORREF = COLORREF(0x00202020);
    const PILL_TEXT: COLORREF = COLORREF(0x00ffffff);
    const BAR_EDGE: COLORREF = COLORREF(0x00404040);
    const BUTTON_HOT: COLORREF = COLORREF(0x00353535);
    const BUTTON_ON: COLORREF = COLORREF(0x00454545);
    const ICON: COLORREF = COLORREF(0x00f0f0f0);
    /// Posted by checks to pick a mode (`wparam`: 0 area, 1 window, 2 screen) without the mouse.
    pub const WM_SET_MODE: u32 = WM_APP + 1;

    /// What a press on the frozen screen picks.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        Area,
        Window,
        Screen,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Button {
        Mode(Mode),
        Close,
    }

    const BUTTONS: [Button; 4] = [Button::Mode(Mode::Area), Button::Mode(Mode::Window), Button::Mode(Mode::Screen), Button::Close];

    impl Button {
        fn label(self) -> &'static str {
            match self {
                Button::Mode(Mode::Area) => "Area",
                Button::Mode(Mode::Window) => "Window",
                Button::Mode(Mode::Screen) => "Full screen",
                Button::Close => "Close (Esc)",
            }
        }
    }

    // The toolbar's layout at 100% scale.
    const BAR_PAD: f32 = 4.0;
    const BUTTON_W: f32 = 40.0;
    const BUTTON_H: f32 = 36.0;
    const BUTTON_GAP: f32 = 2.0;
    /// Room for the line between the modes and Close.
    const BAR_SEP: f32 = 9.0;
    const BAR_TOP: f32 = 16.0;

    /// A picture held by GDI: a memory DC with a 32-bit top-down bitmap selected into it.
    struct Surface {
        dc: HDC,
        bmp: HBITMAP,
        old: HGDIOBJ,
        bits: *mut u8,
        w: i32,
        h: i32,
    }

    impl Surface {
        unsafe fn new(w: i32, h: i32) -> Option<Surface> {
            let dc = CreateCompatibleDC(None);
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bmp) = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) else {
                let _ = DeleteDC(dc);
                return None;
            };
            let old = SelectObject(dc, HGDIOBJ(bmp.0));
            Some(Surface { dc, bmp, old, bits: bits as *mut u8, w, h })
        }

        fn bytes(&self) -> &[u8] {
            unsafe { std::slice::from_raw_parts(self.bits, (self.w * self.h * 4) as usize) }
        }
    }

    impl Drop for Surface {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.dc, self.old);
                let _ = DeleteObject(HGDIOBJ(self.bmp.0));
                let _ = DeleteDC(self.dc);
            }
        }
    }

    struct Monitor {
        rect: RECT,
        dpi: u32,
    }

    struct Overlay {
        hwnd: HWND,
        /// The frozen screen, and a darker copy shown everywhere outside the highlight.
        bright: Surface,
        dim: Surface,
        /// Measures text for the labels.
        measure: HDC,
        /// Windows on screen, top first, in the overlay's coordinates (the desktop's top-left is 0, 0).
        windows: Vec<RECT>,
        monitors: Vec<Monitor>,
        /// The desktop's top-left in screen coordinates.
        origin: POINT,
        cursor: POINT,
        mode: Mode,
        /// The toolbar, on the screen the pointer was on, and that screen's scale.
        bar: RECT,
        bar_scale: f32,
        /// The toolbar button under the pointer.
        hot: Option<Button>,
        /// What a click would take in the Window and Full screen modes.
        hover: Option<RECT>,
        press: Option<POINT>,
        drag: Option<RECT>,
        fonts: HashMap<u32, HFONT>,
        done: bool,
        result: Option<RECT>,
    }

    thread_local! {
        static OVERLAY: RefCell<Option<Overlay>> = const { RefCell::new(None) };
    }

    fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
        RECT { left: l, top: t, right: r, bottom: b }
    }

    fn contains(r: &RECT, p: POINT) -> bool {
        p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom
    }

    fn intersect(a: &RECT, b: &RECT) -> Option<RECT> {
        let r = rect(a.left.max(b.left), a.top.max(b.top), a.right.min(b.right), a.bottom.min(b.bottom));
        (r.right > r.left && r.bottom > r.top).then_some(r)
    }

    fn inflate(r: &RECT, by: i32) -> RECT {
        rect(r.left - by, r.top - by, r.right + by, r.bottom + by)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    // ---------- What's on screen ----------

    unsafe fn monitors(origin: POINT) -> Vec<Monitor> {
        unsafe extern "system" fn each(mon: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows::core::BOOL {
            let list = &mut *(data.0 as *mut Vec<(RECT, u32)>);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(mon, &mut info).as_bool() {
                let (mut x, mut y) = (96, 96);
                let _ = GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut x, &mut y);
                list.push((info.rcMonitor, x));
            }
            true.into()
        }
        let mut list: Vec<(RECT, u32)> = Vec::new();
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut list as *mut _ as isize));
        list.into_iter()
            .map(|(r, dpi)| Monitor { rect: rect(r.left - origin.x, r.top - origin.y, r.right - origin.x, r.bottom - origin.y), dpi })
            .collect()
    }

    /// Top-level windows someone could mean by clicking, top first. Invisible ones are left out:
    /// cloaked windows (other desktops, suspended apps), click-through and fully see-through overlays,
    /// and the desktop itself, so clicking the desktop picks the screen instead.
    unsafe fn windows_on_screen(origin: POINT) -> Vec<RECT> {
        unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> windows::core::BOOL {
            let list = &mut *(data.0 as *mut Vec<RECT>);
            if let Some(r) = pickable(hwnd) {
                list.push(r);
            }
            true.into()
        }
        let mut list: Vec<RECT> = Vec::new();
        let _ = EnumWindows(Some(each), LPARAM(&mut list as *mut _ as isize));
        list.into_iter()
            .map(|r| rect(r.left - origin.x, r.top - origin.y, r.right - origin.x, r.bottom - origin.y))
            .collect()
    }

    unsafe fn pickable(hwnd: HWND) -> Option<RECT> {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        if pid == std::process::id() {
            return None;
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4);
        if cloaked != 0 {
            return None;
        }
        let ex = WINDOW_EX_STYLE(GetWindowLongW(hwnd, GWL_EXSTYLE) as u32);
        if ex.contains(WS_EX_TRANSPARENT) {
            return None;
        }
        if ex.contains(WS_EX_LAYERED) {
            let mut alpha = 255u8;
            let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
            if GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha as *mut u8), Some(&mut flags as *mut _)).is_ok() && flags.contains(LWA_ALPHA) && alpha == 0 {
                return None;
            }
        }
        if ex.contains(WS_EX_TOOLWINDOW) && ex.contains(WS_EX_NOACTIVATE) && GetWindowTextLengthW(hwnd) == 0 {
            return None;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut class) as usize;
        let class = String::from_utf16_lossy(&class[..n]);
        if class == "Progman" || class == "WorkerW" {
            return None;
        }
        // The frame without its invisible resize border and shadow.
        let mut r = RECT::default();
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).is_err() && GetWindowRect(hwnd, &mut r).is_err() {
            return None;
        }
        (r.right - r.left > 1 && r.bottom - r.top > 1).then_some(r)
    }

    /// The whole desktop (every monitor), as GDI sees it right now.
    unsafe fn grab(origin: POINT, w: i32, h: i32) -> Option<Surface> {
        let surface = Surface::new(w, h)?;
        let screen = GetDC(None);
        // CAPTUREBLT includes layered windows: tooltips, menus with shadows, many modern apps.
        let ok = BitBlt(surface.dc, 0, 0, w, h, Some(screen), origin.x, origin.y, ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0)).is_ok();
        ReleaseDC(None, screen);
        ok.then_some(surface)
    }

    // ---------- Picking ----------

    impl Overlay {
        fn whole(&self) -> RECT {
            rect(0, 0, self.bright.w, self.bright.h)
        }

        fn monitor_at(&self, p: POINT) -> Option<&Monitor> {
            self.monitors.iter().find(|m| contains(&m.rect, p)).or_else(|| {
                // Between monitors of different sizes there are gaps that belong to none: use the nearest.
                self.monitors.iter().min_by_key(|m| {
                    let dx = (m.rect.left - p.x).max(p.x - m.rect.right + 1).max(0) as i64;
                    let dy = (m.rect.top - p.y).max(p.y - m.rect.bottom + 1).max(0) as i64;
                    dx * dx + dy * dy
                })
            })
        }

        /// What a click at `p` captures: the window under it, or else that screen.
        fn target_at(&self, p: POINT) -> Option<RECT> {
            let whole = self.whole();
            if let Some(r) = self.windows.iter().find(|r| contains(r, p)).and_then(|r| intersect(r, &whole)) {
                return Some(r);
            }
            self.monitor_at(p).map(|m| m.rect)
        }

        fn highlight(&self) -> Option<RECT> {
            self.drag.or(self.hover)
        }

        fn scale_at(&self, p: POINT) -> f32 {
            self.monitor_at(p).map_or(1.0, |m| m.dpi as f32 / 96.0)
        }

        fn font(&mut self, scale: f32) -> HFONT {
            let key = (scale * 100.0) as u32;
            *self.fonts.entry(key).or_insert_with(|| unsafe {
                CreateFontW(
                    -((13.0 * scale).round() as i32),
                    0,
                    0,
                    0,
                    FW_SEMIBOLD.0 as i32,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY,
                    0,
                    w!("Segoe UI"),
                )
            })
        }

        /// A rounded label holding `text`, its box, and the font and scale it's drawn with.
        fn pill(&mut self, text: &str, anchor: POINT) -> (RECT, HFONT, f32) {
            let scale = self.scale_at(anchor);
            let font = self.font(scale);
            let mut size = SIZE::default();
            unsafe {
                let old = SelectObject(self.measure, HGDIOBJ(font.0));
                let _ = GetTextExtentPoint32W(self.measure, &wide(text), &mut size);
                SelectObject(self.measure, old);
            }
            let pad_x = (10.0 * scale) as i32;
            let pad_y = (5.0 * scale) as i32;
            (rect(0, 0, size.cx + 2 * pad_x, size.cy + 2 * pad_y), font, scale)
        }

        fn size_label(&mut self) -> Option<(RECT, String, HFONT, f32)> {
            let h = self.highlight()?;
            let text = format!("{} × {}", h.right - h.left, h.bottom - h.top);
            let corner = POINT { x: h.left, y: h.bottom };
            let (b, font, scale) = self.pill(&text, corner);
            let gap = (8.0 * scale) as i32;
            let (bw, bh) = (b.right, b.bottom);
            let mon = self.monitor_at(corner).map_or(self.whole(), |m| m.rect);
            // Under the highlight, or above it, or inside its top-left corner when neither fits.
            let y = if h.bottom + gap + bh <= mon.bottom {
                h.bottom + gap
            } else if h.top - gap - bh >= mon.top {
                h.top - gap - bh
            } else {
                h.top + gap
            };
            let x = h.left.clamp(mon.left, (mon.right - bw).max(mon.left));
            Some((rect(x, y, x + bw, y + bh), text, font, scale))
        }

        // ---------- The toolbar ----------

        fn place_bar(&mut self) {
            let mon = self.monitor_at(self.cursor).map_or(self.whole(), |m| m.rect);
            let s = self.scale_at(POINT { x: mon.left, y: mon.top });
            let w = ((2.0 * BAR_PAD + 4.0 * BUTTON_W + 2.0 * BUTTON_GAP + BAR_SEP) * s).round() as i32;
            let h = ((2.0 * BAR_PAD + BUTTON_H) * s).round() as i32;
            let x = mon.left + (mon.right - mon.left - w) / 2;
            let y = mon.top + (BAR_TOP * s).round() as i32;
            self.bar = rect(x, y, x + w, y + h);
            self.bar_scale = s;
        }

        fn button_rect(&self, i: usize) -> RECT {
            let s = self.bar_scale;
            let mut x = BAR_PAD + i as f32 * (BUTTON_W + BUTTON_GAP);
            if i == 3 {
                // Close sits after the line, not a gap.
                x += BAR_SEP - BUTTON_GAP;
            }
            let l = self.bar.left + (x * s).round() as i32;
            let t = self.bar.top + (BAR_PAD * s).round() as i32;
            rect(l, t, l + (BUTTON_W * s).round() as i32, t + (BUTTON_H * s).round() as i32)
        }

        /// Hidden while a dragged area comes near it, so it never hides what's being lined up. A
        /// highlighted window or screen leaves it showing: the shot comes from the frozen picture,
        /// so the toolbar is never in it.
        fn bar_shown(&self) -> bool {
            let near = inflate(&self.bar, (8.0 * self.bar_scale) as i32);
            self.drag.is_none_or(|d| intersect(&d, &near).is_none())
        }

        fn button_at(&self, p: POINT) -> Option<Button> {
            if !self.bar_shown() {
                return None;
            }
            (0..BUTTONS.len()).find(|&i| contains(&self.button_rect(i), p)).map(|i| BUTTONS[i])
        }

        /// What a click at `p` would take in the current mode. Nothing in Area mode, which only drags.
        fn hover_at(&self, p: POINT) -> Option<RECT> {
            // Over the toolbar a click is for its buttons.
            if contains(&self.bar, p) {
                return None;
            }
            match self.mode {
                Mode::Area => None,
                Mode::Window => self.target_at(p),
                Mode::Screen => self.monitor_at(p).map(|m| m.rect),
            }
        }

        /// The pointer moved or the mode changed: what's highlighted, and which button is hot.
        fn track(&mut self, p: POINT) {
            self.cursor = p;
            self.hover = self.hover_at(p);
            self.hot = self.button_at(p);
        }

        fn tooltip(&mut self) -> Option<(RECT, &'static str, HFONT, f32)> {
            let b = self.hot?;
            let i = BUTTONS.iter().position(|&x| x == b)?;
            let under = self.button_rect(i);
            let text = b.label();
            let (r, font, scale) = self.pill(text, POINT { x: under.left, y: under.top });
            let x = (under.left + under.right - r.right) / 2;
            let y = self.bar.bottom + (6.0 * scale) as i32;
            Some((rect(x, y, x + r.right, y + r.bottom), text, font, scale))
        }

        /// Every area that changes when the highlight, the label or the toolbar changes. The number
        /// tells apart toolbar states that cover the same area.
        fn marks(&mut self) -> Vec<(RECT, u32)> {
            let mut out = Vec::new();
            if let Some(h) = self.highlight() {
                out.push((inflate(&h, (4.0 * self.scale_at(POINT { x: h.left, y: h.top })) as i32 + 2), 0));
            }
            if let Some((r, ..)) = self.size_label() {
                out.push((r, 0));
            }
            let hot = self.hot.and_then(|b| BUTTONS.iter().position(|&x| x == b)).map_or(0, |i| i as u32 + 1);
            let state = 1 + self.mode as u32 + 4 * hot + 32 * self.bar_shown() as u32;
            out.push((self.bar, state));
            if let Some((r, ..)) = self.tooltip() {
                out.push((r, state));
            }
            out
        }

        /// Changes the state, then repaints the areas that differ.
        fn change(&mut self, f: impl FnOnce(&mut Overlay)) {
            let before = self.marks();
            f(self);
            let after = self.marks();
            if before != after {
                for (r, _) in before.iter().chain(after.iter()) {
                    unsafe {
                        let _ = InvalidateRect(Some(self.hwnd), Some(r as *const RECT), false);
                    }
                }
            }
        }

        unsafe fn paint_bar(&mut self, dc: HDC) {
            let s = self.bar_scale;
            let b = self.bar;
            let brush = CreateSolidBrush(PILL);
            let pen = CreatePen(PS_SOLID, 1, BAR_EDGE);
            let old_brush = SelectObject(dc, HGDIOBJ(brush.0));
            let old_pen = SelectObject(dc, HGDIOBJ(pen.0));
            let round = (16.0 * s) as i32;
            let _ = RoundRect(dc, b.left, b.top, b.right, b.bottom, round, round);
            SelectObject(dc, old_pen);
            SelectObject(dc, old_brush);
            let _ = DeleteObject(HGDIOBJ(pen.0));
            let _ = DeleteObject(HGDIOBJ(brush.0));

            for (i, &button) in BUTTONS.iter().enumerate() {
                let r = self.button_rect(i);
                let on = button == Button::Mode(self.mode);
                let hot = self.hot == Some(button);
                if on || hot {
                    let fill = CreateSolidBrush(if on { BUTTON_ON } else { BUTTON_HOT });
                    SelectObject(dc, HGDIOBJ(fill.0));
                    let pen = SelectObject(dc, GetStockObject(NULL_PEN));
                    let round = (10.0 * s) as i32;
                    let _ = RoundRect(dc, r.left, r.top, r.right + 1, r.bottom + 1, round, round);
                    SelectObject(dc, pen);
                    SelectObject(dc, old_brush);
                    let _ = DeleteObject(HGDIOBJ(fill.0));
                }
                draw_icon(dc, button, r, s, if on { ACCENT } else { ICON });
            }

            // The line between the modes and Close.
            let x = self.button_rect(2).right + ((BAR_SEP - 1.0) / 2.0 * s).round() as i32;
            let inset = (8.0 * s) as i32;
            let line = CreateSolidBrush(BAR_EDGE);
            FillRect(dc, &rect(x, b.top + inset, x + s.round().max(1.0) as i32, b.bottom - inset), line);
            let _ = DeleteObject(HGDIOBJ(line.0));

            if let Some((r, text, font, scale)) = self.tooltip() {
                draw_pill(dc, r, text, font, scale);
            }
        }

        fn finish(&mut self, result: Option<RECT>) {
            self.result = result.and_then(|r| intersect(&r, &self.whole()));
            self.done = true;
        }

        unsafe fn paint(&mut self, hdc: HDC, area: RECT) {
            let (w, h) = (area.right - area.left, area.bottom - area.top);
            if w <= 0 || h <= 0 {
                return;
            }
            // Drawn off screen first, then copied in one go, so nothing flickers.
            let back = CreateCompatibleDC(Some(hdc));
            let bmp = CreateCompatibleBitmap(hdc, w, h);
            let old = SelectObject(back, HGDIOBJ(bmp.0));
            let _ = SetWindowOrgEx(back, area.left, area.top, None);
            let _ = BitBlt(back, area.left, area.top, w, h, Some(self.dim.dc), area.left, area.top, SRCCOPY);
            if let Some(hl) = self.highlight() {
                if let Some(r) = intersect(&hl, &area) {
                    let _ = BitBlt(back, r.left, r.top, r.right - r.left, r.bottom - r.top, Some(self.bright.dc), r.left, r.top, SRCCOPY);
                }
                // A dragged area's border goes just outside, so it never hides an edge being lined
                // up. A window's or screen's goes just inside: outside it would spill onto the next
                // monitor, or off the screen for a maximised window. The shot comes from the frozen
                // picture either way, so the border is never in it.
                let t = (2.0 * self.scale_at(POINT { x: hl.left, y: hl.top })).round().max(1.0) as i32;
                let b = if self.drag.is_some() { inflate(&hl, t) } else { hl };
                let brush = CreateSolidBrush(ACCENT);
                for r in [
                    rect(b.left, b.top, b.right, b.top + t),
                    rect(b.left, b.bottom - t, b.right, b.bottom),
                    rect(b.left, b.top + t, b.left + t, b.bottom - t),
                    rect(b.right - t, b.top + t, b.right, b.bottom - t),
                ] {
                    FillRect(back, &r, brush);
                }
                let _ = DeleteObject(HGDIOBJ(brush.0));
            }
            if let Some((r, text, font, scale)) = self.size_label() {
                draw_pill(back, r, &text, font, scale);
            }
            if self.bar_shown() {
                self.paint_bar(back);
            }
            let _ = BitBlt(hdc, area.left, area.top, w, h, Some(back), area.left, area.top, SRCCOPY);
            SelectObject(back, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0));
            let _ = DeleteDC(back);
        }
    }

    unsafe fn draw_pill(dc: HDC, r: RECT, text: &str, font: HFONT, scale: f32) {
        let brush = CreateSolidBrush(PILL);
        let old_brush = SelectObject(dc, HGDIOBJ(brush.0));
        let old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
        let round = (12.0 * scale) as i32;
        let _ = RoundRect(dc, r.left, r.top, r.right + 1, r.bottom + 1, round, round);
        SelectObject(dc, old_pen);
        SelectObject(dc, old_brush);
        let _ = DeleteObject(HGDIOBJ(brush.0));
        let old_font = SelectObject(dc, HGDIOBJ(font.0));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, PILL_TEXT);
        let mut r = r;
        DrawTextW(dc, &mut wide(text), &mut r, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        SelectObject(dc, old_font);
    }

    /// A toolbar button's icon, centred in `r`: a dashed box for Area, a window with a title bar, a
    /// monitor on its stand, and a cross for Close. Drawn from filled rectangles so lines stay crisp.
    unsafe fn draw_icon(dc: HDC, button: Button, r: RECT, s: f32, color: COLORREF) {
        let px = |v: f32| (v * s).round() as i32;
        let t = (1.5 * s).floor().max(1.0) as i32;
        let brush = CreateSolidBrush(color);
        let fill = |r: RECT| {
            FillRect(dc, &r, brush);
        };
        let outline = |r: RECT| {
            fill(rect(r.left, r.top, r.right, r.top + t));
            fill(rect(r.left, r.bottom - t, r.right, r.bottom));
            fill(rect(r.left, r.top, r.left + t, r.bottom));
            fill(rect(r.right - t, r.top, r.right, r.bottom));
        };
        let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        let boxed = |w: f32, h: f32, dy: f32| {
            let (w, h) = (px(w), px(h));
            let top = cy - h / 2 + px(dy);
            rect(cx - w / 2, top, cx - w / 2 + w, top + h)
        };
        match button {
            Button::Mode(Mode::Area) => {
                let b = boxed(18.0, 14.0, 0.0);
                let (dash, step) = (px(3.0).max(2), px(5.0).max(3));
                let mut x = b.left;
                while x < b.right {
                    let end = (x + dash).min(b.right);
                    fill(rect(x, b.top, end, b.top + t));
                    fill(rect(x, b.bottom - t, end, b.bottom));
                    x += step;
                }
                let mut y = b.top;
                while y < b.bottom {
                    let end = (y + dash).min(b.bottom);
                    fill(rect(b.left, y, b.left + t, end));
                    fill(rect(b.right - t, y, b.right, end));
                    y += step;
                }
                // The corners, so the box reads as closed at any scale.
                fill(rect(b.right - dash, b.top, b.right, b.top + t));
                fill(rect(b.right - dash, b.bottom - t, b.right, b.bottom));
                fill(rect(b.left, b.bottom - dash, b.left + t, b.bottom));
                fill(rect(b.right - t, b.bottom - dash, b.right, b.bottom));
            }
            Button::Mode(Mode::Window) => {
                let b = boxed(18.0, 14.0, 0.0);
                outline(b);
                fill(rect(b.left, b.top, b.right, b.top + px(4.0).max(t + 1)));
            }
            Button::Mode(Mode::Screen) => {
                let b = boxed(18.0, 12.0, -2.0);
                outline(b);
                let stem = rect(cx - t / 2 - t % 2, b.bottom, cx + t / 2 + t % 2, b.bottom + px(3.0));
                fill(stem);
                fill(rect(cx - px(4.0), stem.bottom, cx + px(4.0), stem.bottom + t));
            }
            Button::Close => {
                let pen = CreatePen(PS_SOLID, t, color);
                let old = SelectObject(dc, HGDIOBJ(pen.0));
                let h = px(6.0);
                let _ = MoveToEx(dc, cx - h, cy - h, None);
                let _ = LineTo(dc, cx + h + 1, cy + h + 1);
                let _ = MoveToEx(dc, cx + h, cy - h, None);
                let _ = LineTo(dc, cx - h - 1, cy + h + 1);
                SelectObject(dc, old);
                let _ = DeleteObject(HGDIOBJ(pen.0));
            }
        }
        let _ = DeleteObject(HGDIOBJ(brush.0));
    }

    fn point(lparam: LPARAM) -> POINT {
        // Signed: a captured drag can go past the window's edge.
        POINT { x: (lparam.0 & 0xffff) as i16 as i32, y: ((lparam.0 >> 16) & 0xffff) as i16 as i32 }
    }

    /// What to do once the state is put down, since these calls can send messages straight back.
    enum After {
        Nothing,
        Capture,
        Release,
        Close,
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let handled = OVERLAY.with(|cell| {
            let Ok(mut guard) = cell.try_borrow_mut() else { return None };
            let o = guard.as_mut()?;
            let after = match msg {
                WM_ERASEBKGND => return Some(LRESULT(1)),
                WM_PAINT => {
                    let mut ps = PAINTSTRUCT::default();
                    let hdc = BeginPaint(hwnd, &mut ps);
                    o.paint(hdc, ps.rcPaint);
                    let _ = EndPaint(hwnd, &ps);
                    return Some(LRESULT(0));
                }
                WM_SETCURSOR if (lparam.0 & 0xffff) as u32 == HTCLIENT => {
                    let mut p = POINT::default();
                    let _ = GetCursorPos(&mut p);
                    let p = POINT { x: p.x - o.origin.x, y: p.y - o.origin.y };
                    let over_bar = o.press.is_none() && o.bar_shown() && contains(&o.bar, p);
                    SetCursor(LoadCursorW(None, if over_bar { IDC_ARROW } else { IDC_CROSS }).ok());
                    return Some(LRESULT(1));
                }
                WM_MOUSEMOVE => {
                    let p = point(lparam);
                    o.change(|o| match o.press {
                        Some(s) if o.mode == Mode::Area && (o.drag.is_some() || (p.x - s.x).abs() >= DRAG_START || (p.y - s.y).abs() >= DRAG_START) => {
                            o.cursor = p;
                            let whole = o.whole();
                            let r = rect(s.x.min(p.x), s.y.min(p.y), s.x.max(p.x) + 1, s.y.max(p.y) + 1);
                            o.drag = intersect(&r, &whole);
                        }
                        Some(_) => o.cursor = p,
                        None => o.track(p),
                    });
                    After::Nothing
                }
                WM_LBUTTONDOWN => {
                    let p = point(lparam);
                    match o.button_at(p) {
                        Some(Button::Close) => {
                            o.finish(None);
                            After::Release
                        }
                        Some(Button::Mode(mode)) => {
                            o.change(|o| {
                                o.mode = mode;
                                o.track(p);
                            });
                            After::Nothing
                        }
                        // The toolbar's own edge, or reaching for it: nothing to pick there.
                        None if contains(&o.bar, p) && o.mode != Mode::Area => After::Nothing,
                        None => {
                            o.change(|o| {
                                o.track(p);
                                o.hot = None;
                                o.press = Some(p);
                            });
                            After::Capture
                        }
                    }
                }
                WM_LBUTTONUP if o.press.is_some() => {
                    let p = point(lparam);
                    let result = match o.mode {
                        Mode::Area => o.drag,
                        Mode::Window | Mode::Screen => o.hover_at(p),
                    };
                    if result.is_some() {
                        o.finish(result);
                    } else {
                        // A click without a drag in Area mode picks nothing; keep going.
                        o.change(|o| {
                            o.press = None;
                            o.drag = None;
                            o.track(p);
                        });
                    }
                    After::Release
                }
                WM_SET_MODE => {
                    let mode = [Mode::Area, Mode::Window, Mode::Screen].get(wparam.0).copied().unwrap_or(Mode::Area);
                    let p = o.cursor;
                    o.change(|o| {
                        o.mode = mode;
                        o.track(p);
                    });
                    After::Nothing
                }
                WM_RBUTTONDOWN => {
                    o.finish(None);
                    After::Release
                }
                WM_KEYDOWN => {
                    let key = wparam.0 as u16;
                    if key == VK_ESCAPE.0 {
                        o.finish(None);
                        After::Release
                    } else if key == b'F' as u16 || key == VK_RETURN.0 {
                        let screen = o.monitor_at(o.cursor).map(|m| m.rect);
                        o.finish(screen);
                        After::Release
                    } else {
                        After::Nothing
                    }
                }
                WM_CLOSE => {
                    o.finish(None);
                    After::Close
                }
                _ => return None,
            };
            let done = o.done;
            drop(guard);
            match after {
                After::Capture => {
                    SetCapture(hwnd);
                }
                After::Release | After::Close => {
                    let _ = ReleaseCapture();
                }
                After::Nothing => {}
            }
            if done {
                let _ = DestroyWindow(hwnd);
            }
            Some(LRESULT(0))
        });
        match handled {
            Some(r) => r,
            None => {
                if msg == WM_DESTROY {
                    PostQuitMessage(0);
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
        }
    }

    pub fn pick() -> Option<Shot> {
        unsafe {
            let origin = POINT { x: GetSystemMetrics(SM_XVIRTUALSCREEN), y: GetSystemMetrics(SM_YVIRTUALSCREEN) };
            let (w, h) = (GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
            let bright = grab(origin, w, h)?;
            let windows = windows_on_screen(origin);
            let monitors = monitors(origin);

            let dim = Surface::new(w, h)?;
            {
                let src = bright.bytes();
                let dst = std::slice::from_raw_parts_mut(dim.bits, src.len());
                for (d, s) in dst.iter_mut().zip(src) {
                    *d = ((*s as u16 * 115) >> 8) as u8;
                }
            }

            let instance = GetModuleHandleW(None).ok()?;
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
                lpszClassName: w!("SketchCapture"),
                ..Default::default()
            };
            // Fails after the first capture, when the class is already there.
            RegisterClassExW(&class);
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                w!("SketchCapture"),
                w!("Sketch capture"),
                WS_POPUP,
                origin.x,
                origin.y,
                w,
                h,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .ok()?;
            // No fade-in: the overlay should be there the moment the key is pressed.
            let on: windows::core::BOOL = true.into();
            let _ = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &on as *const _ as *const _, 4);

            let mut cursor = POINT::default();
            let _ = GetCursorPos(&mut cursor);
            cursor = POINT { x: cursor.x - origin.x, y: cursor.y - origin.y };
            let mut overlay = Overlay {
                hwnd,
                bright,
                dim,
                measure: CreateCompatibleDC(None),
                windows,
                monitors,
                origin,
                cursor,
                mode: Mode::Area,
                bar: RECT::default(),
                bar_scale: 1.0,
                hot: None,
                hover: None,
                press: None,
                drag: None,
                fonts: HashMap::new(),
                done: false,
                result: None,
            };
            overlay.place_bar();
            overlay.track(cursor);
            OVERLAY.with(|cell| *cell.borrow_mut() = Some(overlay));

            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
            let _ = SetFocus(Some(hwnd));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }

            let overlay = OVERLAY.with(|cell| cell.borrow_mut().take())?;
            for font in overlay.fonts.values() {
                let _ = DeleteObject(HGDIOBJ(font.0));
            }
            let _ = DeleteDC(overlay.measure);
            let r = overlay.result?;
            Some(crop(&overlay.bright, r))
        }
    }

    /// The picked part of the frozen screen as RGBA. GDI gives blue, green, red and no alpha.
    fn crop(s: &Surface, r: RECT) -> Shot {
        let (w, h) = ((r.right - r.left) as usize, (r.bottom - r.top) as usize);
        let src = s.bytes();
        let mut rgba = Vec::with_capacity(w * h * 4);
        for y in r.top as usize..r.bottom as usize {
            let row = &src[(y * s.w as usize + r.left as usize) * 4..][..w * 4];
            for px in row.chunks_exact(4) {
                rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
            }
        }
        Shot { width: w as u32, height: h as u32, rgba }
    }
}
