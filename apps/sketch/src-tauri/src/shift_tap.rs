//! Opening a capture with Left Shift (F16): for 1 second after a capture's notification shows, a
//! lone tap of Left Shift opens it, as clicking the notification does. Used by the capture helper
//! (Sketch closed) and by Sketch's own captures (Sketch open), so both behave the same.
//!
//! It listens with raw input (`RIDEV_INPUTSINK`, to a message-only window on a thread of its own),
//! only during that second. Raw input is a copy of the keyboard's input that Windows hands to every
//! app asking for it: Sketch is never in the path of anyone's keys, so it can't hold up, drop or
//! change a key on its way to the app in front, whatever its own thread is doing. Until 29 Oct 2026
//! it was a low-level keyboard hook, which every key on the PC has to wait for (decisions doc,
//! "Fixes to opening a capture with Left Shift (29 Oct 2026)").
//!
//! Sketch watches from another process (`sketch-capture.exe --shift-tap=<id>`, `watch_elsewhere`),
//! which tells Sketch about a tap over its pipe: the hook it began with never heard keys going to its
//! own process's windows, and after Sketch's own capture its window is in front. The helper watches
//! in its own process.
//!
//! A tap is Left Shift going down inside the second and coming up within 500 ms, with no other key
//! pressed or held meanwhile, so Shift+letter while typing, Ctrl+Shift+anything, Right Shift and a
//! held Shift don't count. A Shift already held as the second starts (from capture keys like
//! Alt+Shift+S) is ignored until it's released.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after the notification shows a tap counts.
pub const WINDOW: Duration = Duration::from_secs(1);
/// Longest press that's still a tap.
const TAP: Duration = Duration::from_millis(500);

/// Watches listening right now, for checks (none may be left after its second).
static ACTIVE: AtomicU32 = AtomicU32::new(0);

pub fn watching() -> u32 {
    ACTIVE.load(Ordering::Relaxed)
}

/// The watches running now, each by the thread that runs it.
#[cfg_attr(not(windows), allow(dead_code))]
static WATCHES: Mutex<Vec<(u32, Taps)>> = Mutex::new(Vec::new());

/// Watches the next second for a tap of Left Shift, and calls `on_tap` if one comes.
pub fn watch(on_tap: impl FnOnce() + Send + 'static) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        if imp::run() {
            on_tap();
        }
    });
    #[cfg(not(windows))]
    let _ = on_tap;
}

/// For Sketch's own captures: watches in a `sketch-capture.exe` of its own, which hands a tap to
/// Sketch as `--shift-tap=<id>`.
pub fn watch_elsewhere(id: u32) {
    let Some(exe) = std::env::current_exe().ok().map(|p| p.with_file_name(crate::helper::HELPER_EXE)) else { return };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(format!("--shift-tap={id}"));
    if let Some(over) = crate::data_dir_override() {
        cmd.arg(format!("--data-dir={}", over.to_string_lossy()));
    }
    let _ = cmd.spawn();
}

/// `sketch-capture.exe --shift-tap=<id>`: watches its second and, on a tap, hands `--shift-tap=<id>`
/// to the Sketch of this data folder (passing the foreground on, as a notification click does).
pub fn watch_for_sketch(id: u32) {
    #[cfg(windows)]
    if imp::run() {
        let dir = crate::default_data_dir();
        let message = crate::instance::Message { args: vec!["sketch.exe".into(), format!("--shift-tap={id}")], cwd: String::new() };
        crate::instance::send(&dir.to_string_lossy(), &message);
    }
    #[cfg(not(windows))]
    let _ = id;
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Key {
    /// Left Shift went down; `others` is whether Ctrl, Alt, Windows or Right Shift was held at that
    /// moment, as Windows reports it (for keys pressed before the watch began).
    ShiftDown { others: bool },
    ShiftUp,
    /// Any other key went down, or came up: its scan code, with 0xE0 in the high byte for E0 keys.
    Other(u16),
    OtherUp(u16),
}

const MAKE_LSHIFT: u16 = 0x2a;
const VK_SHIFT: u16 = 0x10;
const VK_LSHIFT: u16 = 0xa0;
const RI_KEY_BREAK: u16 = 1;
const RI_KEY_E0: u16 = 2;

/// A raw keyboard event (`RAWKEYBOARD`'s make code, flags and virtual key) as the watch sees it.
/// None for the "fake" Shifts Windows sends round some E0 keys (an E0 Left Shift scan code, or the
/// virtual key 0xFF), which no hand pressed. `others` is only asked for a Left Shift press.
#[cfg_attr(not(windows), allow(dead_code))]
fn key_of(make: u16, flags: u16, vkey: u16, others: impl FnOnce() -> bool) -> Option<Key> {
    let e0 = flags & RI_KEY_E0 != 0;
    let up = flags & RI_KEY_BREAK != 0;
    if vkey == 0xff || (make == MAKE_LSHIFT && e0) {
        return None;
    }
    let left_shift = (vkey == VK_SHIFT && make == MAKE_LSHIFT) || vkey == VK_LSHIFT;
    let code = if e0 {
        0xe000 | make
    } else if make == 0 {
        0xff00 | vkey
    } else {
        make
    };
    Some(match (left_shift, up) {
        (true, false) => Key::ShiftDown { others: others() },
        (true, true) => Key::ShiftUp,
        (false, false) => Key::Other(code),
        (false, true) => Key::OtherUp(code),
    })
}

/// What a watch has seen so far.
#[derive(Debug)]
struct Taps {
    start: Instant,
    /// Left Shift was held as the watch began, and hasn't been released since.
    held: bool,
    /// When the press that may become a tap began.
    down: Option<Instant>,
    /// Another key came during that press, so it isn't a tap.
    spoiled: bool,
    /// Other keys that went down during the watch and haven't come up yet.
    pressed: Vec<u16>,
}

impl Taps {
    fn new(start: Instant, held: bool) -> Self {
        Taps { start, held, down: None, spoiled: false, pressed: Vec::new() }
    }

    /// A key at `now`. True when it completes a tap.
    fn key(&mut self, key: Key, now: Instant) -> bool {
        match key {
            Key::ShiftDown { others } => {
                // Windows repeats the key down while Shift is held; only the first counts.
                if !self.held && self.down.is_none() && now.duration_since(self.start) <= WINDOW {
                    self.down = Some(now);
                    self.spoiled = others || !self.pressed.is_empty();
                }
                false
            }
            Key::ShiftUp => {
                if self.held {
                    self.held = false;
                    return false;
                }
                let Some(down) = self.down.take() else { return false };
                !self.spoiled && now.duration_since(down) <= TAP
            }
            Key::Other(code) => {
                if !self.pressed.contains(&code) {
                    self.pressed.push(code);
                }
                if self.down.is_some() {
                    self.spoiled = true;
                }
                false
            }
            Key::OtherUp(code) => {
                self.pressed.retain(|c| *c != code);
                false
            }
        }
    }

    /// When the watch ends: a second after it began, or later for a press begun inside it that
    /// may still become a tap.
    fn end(&self) -> Instant {
        match self.down {
            Some(down) if !self.spoiled => (self.start + WINDOW).max(down + TAP),
            _ => self.start + WINDOW,
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;
    use std::time::Instant;

    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RSHIFT, VK_RWIN};
    use windows::Win32::UI::Input::{GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTDEVICE_FLAGS, RAWINPUTHEADER, RIDEV_INPUTSINK, RIDEV_REMOVE, RID_INPUT, RIM_TYPEKEYBOARD};
    use windows::Win32::UI::WindowsAndMessaging::*;

    use super::{key_of, ACTIVE, WATCHES};
    use super::Taps;

    /// Posted to a watch's own thread when a tap completes.
    const WM_TAP: u32 = WM_APP + 1;

    /// The watch (by thread) whose window gets this process's raw keyboard input. Windows keeps one
    /// such window per process, so a newer watch (a second capture inside the second) takes it over,
    /// and only the watch still holding it lets it go.
    static OWNER: Mutex<u32> = Mutex::new(0);

    fn down(vk: VIRTUAL_KEY) -> bool {
        unsafe { GetAsyncKeyState(vk.0 as i32) < 0 }
    }

    /// Whether a key other than Left Shift is held: Ctrl, Alt or Windows with Shift is a shortcut.
    fn others_held() -> bool {
        [VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN, VK_RSHIFT].into_iter().any(down)
    }

    /// A key for the watch run by `thread`.
    fn record(thread: u32, raw: &RAWINPUT) {
        if raw.header.dwType != RIM_TYPEKEYBOARD.0 {
            return;
        }
        let kb = unsafe { raw.data.keyboard };
        let Some(key) = key_of(kb.MakeCode, kb.Flags, kb.VKey, others_held) else { return };
        let now = Instant::now();
        let Ok(mut watches) = WATCHES.lock() else { return };
        for (t, taps) in watches.iter_mut().filter(|(t, _)| *t == thread) {
            if taps.key(key, now) {
                unsafe {
                    let _ = PostThreadMessageW(*t, WM_TAP, WPARAM(0), LPARAM(0));
                }
            }
        }
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_INPUT {
            let mut raw = RAWINPUT::default();
            let mut size = std::mem::size_of::<RAWINPUT>() as u32;
            let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
            let got = GetRawInputData(HRAWINPUT(lparam.0 as _), RID_INPUT, Some(&mut raw as *mut RAWINPUT as *mut _), &mut size, header);
            if got != u32::MAX && got >= header {
                record(GetCurrentThreadId(), &raw);
            }
        }
        // WM_INPUT goes on to DefWindowProc too, which frees the input.
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// The message-only window this thread's raw input goes to.
    fn listener() -> Option<HWND> {
        unsafe {
            let module = GetModuleHandleW(None).ok()?;
            let class = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: module.into(), lpszClassName: w!("SketchShiftTap"), ..Default::default() };
            // Fails harmlessly when an earlier watch in this process registered it.
            RegisterClassW(&class);
            CreateWindowExW(WINDOW_EX_STYLE(0), w!("SketchShiftTap"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(module.into()), None).ok()
        }
    }

    /// Asks for (or with `RIDEV_REMOVE`, stops) the keyboard's raw input.
    fn keyboard(flags: RAWINPUTDEVICE_FLAGS, target: HWND) -> bool {
        let device = RAWINPUTDEVICE { usUsagePage: 1, usUsage: 6, dwFlags: flags, hwndTarget: target };
        unsafe { RegisterRawInputDevices(&[device], std::mem::size_of::<RAWINPUTDEVICE>() as u32) }.is_ok()
    }

    /// Runs a watch on this thread. True when a tap came.
    pub fn run() -> bool {
        let thread = unsafe { GetCurrentThreadId() };
        let taps = Taps::new(Instant::now(), down(VK_LSHIFT));
        WATCHES.lock().unwrap().push((thread, taps));
        let window = listener();
        let listening = window.is_some_and(|w| {
            let mut owner = OWNER.lock().unwrap();
            let ok = keyboard(RIDEV_INPUTSINK, w);
            if ok {
                *owner = thread;
            }
            ok
        });
        if listening {
            ACTIVE.fetch_add(1, Ordering::Relaxed);
        }
        let mut tapped = false;
        while listening && !tapped {
            let end = WATCHES.lock().unwrap().iter().find(|(t, _)| *t == thread).map(|(_, taps)| taps.end());
            let Some(left) = end.and_then(|e| e.checked_duration_since(Instant::now())).filter(|d| !d.is_zero()) else { break };
            // Wakes for raw input too, which `PeekMessageW` hands to `wndproc`.
            unsafe { MsgWaitForMultipleObjects(None, false, left.as_millis().max(1) as u32, QS_ALLINPUT) };
            let mut msg = MSG::default();
            while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                if msg.message == WM_TAP {
                    tapped = true;
                }
                unsafe { DispatchMessageW(&msg) };
            }
        }
        if listening {
            let mut owner = OWNER.lock().unwrap();
            if *owner == thread {
                keyboard(RIDEV_REMOVE, HWND::default());
                *owner = 0;
            }
            ACTIVE.fetch_sub(1, Ordering::Relaxed);
        }
        if let Some(w) = window {
            unsafe {
                let _ = DestroyWindow(w);
            }
        }
        WATCHES.lock().unwrap().retain(|(t, _)| *t != thread);
        tapped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn a_lone_tap_inside_the_second_counts() {
        let s = Instant::now();
        let mut t = Taps::new(s, false);
        assert!(!t.key(Key::ShiftDown { others: false }, at(s, 300)));
        assert!(!t.key(Key::ShiftDown { others: false }, at(s, 330)), "a repeat");
        assert!(t.key(Key::ShiftUp, at(s, 420)));
    }

    #[test]
    fn a_press_late_in_the_second_may_end_after_it() {
        let s = Instant::now();
        let mut t = Taps::new(s, false);
        t.key(Key::ShiftDown { others: false }, at(s, 900));
        assert_eq!(t.end(), at(s, 1400));
        assert!(t.key(Key::ShiftUp, at(s, 1100)));
    }

    #[test]
    fn shift_with_another_key_a_long_press_or_a_late_press_doesnt() {
        let s = Instant::now();
        let mut t = Taps::new(s, false);
        t.key(Key::ShiftDown { others: false }, at(s, 100));
        t.key(Key::Other(0x1e), at(s, 150));
        assert!(!t.key(Key::ShiftUp, at(s, 200)), "Shift+letter");
        assert_eq!(t.end(), at(s, 1000));

        let mut t = Taps::new(s, false);
        t.key(Key::ShiftDown { others: true }, at(s, 100));
        assert!(!t.key(Key::ShiftUp, at(s, 200)), "Ctrl+Shift");

        let mut t = Taps::new(s, false);
        t.key(Key::ShiftDown { others: false }, at(s, 100));
        assert!(!t.key(Key::ShiftUp, at(s, 700)), "held 600 ms");

        let mut t = Taps::new(s, false);
        t.key(Key::ShiftDown { others: false }, at(s, 1200));
        assert!(!t.key(Key::ShiftUp, at(s, 1250)), "after the second");
    }

    #[test]
    fn a_shift_held_from_before_counts_only_after_its_release() {
        let s = Instant::now();
        let mut t = Taps::new(s, true);
        t.key(Key::ShiftDown { others: false }, at(s, 100));
        assert!(!t.key(Key::ShiftUp, at(s, 200)), "the held Shift's release");
        t.key(Key::ShiftDown { others: false }, at(s, 500));
        assert!(t.key(Key::ShiftUp, at(s, 600)), "a fresh tap");
    }

    /// Raw keyboard events as Windows reports them: (make code, flags, virtual key).
    fn feed(t: &mut Taps, s: Instant, events: &[(u64, u16, u16, u16)]) -> bool {
        let mut tapped = false;
        for &(ms, make, flags, vkey) in events {
            if let Some(key) = key_of(make, flags, vkey, || false) {
                tapped |= t.key(key, at(s, ms));
            }
        }
        tapped
    }

    // Left Ctrl, Left Shift, Right Shift and X, down (flags 0) and up (flags 1).
    const CTRL: (u16, u16) = (0x1d, 0x11);
    const LSHIFT: (u16, u16) = (0x2a, 0x10);
    const RSHIFT: (u16, u16) = (0x36, 0x10);
    const X: (u16, u16) = (0x2d, 0x58);

    #[test]
    fn ctrl_shift_and_a_key_in_any_order_is_never_a_tap() {
        let s = Instant::now();
        let d = |ms, k: (u16, u16)| (ms, k.0, 0, k.1);
        let u = |ms, k: (u16, u16)| (ms, k.0, 1, k.1);
        let orders: [&[(u64, u16, u16, u16)]; 4] = [
            // Ctrl, Shift, X, let go in reverse: the usual way.
            &[d(100, CTRL), d(150, LSHIFT), d(200, X), u(260, X), u(300, LSHIFT), u(320, CTRL)],
            // Shift first, Ctrl last to go.
            &[d(100, LSHIFT), d(140, CTRL), d(180, X), u(220, X), u(250, LSHIFT), u(400, CTRL)],
            // Ctrl let go before Shift, after X.
            &[d(100, CTRL), d(130, LSHIFT), d(160, X), u(190, X), u(210, CTRL), u(240, LSHIFT)],
            // Ctrl held before Shift and let go before Shift, with Windows not reporting it held.
            &[d(100, CTRL), d(130, LSHIFT), u(150, CTRL), d(160, X), u(170, X), u(200, LSHIFT)],
        ];
        for (i, events) in orders.into_iter().enumerate() {
            let mut t = Taps::new(s, false);
            assert!(!feed(&mut t, s, events), "order {i} counted as a tap");
        }
        // Ctrl+Shift with no other key, Ctrl still held as Shift goes down (the watch saw it go down).
        let mut t = Taps::new(s, false);
        assert!(!feed(&mut t, s, &[d(100, CTRL), d(150, LSHIFT), u(200, LSHIFT), u(250, CTRL)]), "Ctrl+Shift");
        // A tap after the chord still counts.
        assert!(feed(&mut t, s, &[d(500, LSHIFT), u(560, LSHIFT)]), "a tap after Ctrl+Shift");
    }

    #[test]
    fn raw_input_tells_left_shift_from_right_shift_and_fake_shifts() {
        let s = Instant::now();
        let mut t = Taps::new(s, false);
        assert!(feed(&mut t, s, &[(100, LSHIFT.0, 0, LSHIFT.1), (150, LSHIFT.0, 1, LSHIFT.1)]), "Left Shift");
        // Sent with SendInput as VK_LSHIFT, as checks do.
        let mut t = Taps::new(s, false);
        assert!(feed(&mut t, s, &[(100, 0x2a, 0, 0xa0), (150, 0x2a, 1, 0xa0)]), "VK_LSHIFT");
        let mut t = Taps::new(s, false);
        assert!(!feed(&mut t, s, &[(100, RSHIFT.0, 0, RSHIFT.1), (150, RSHIFT.0, 1, RSHIFT.1)]), "Right Shift");
        // Windows' fake Shifts round an E0 key (here an arrow key with Num Lock on) are no key at all.
        assert_eq!(key_of(0x2a, 2, 0x10, || false), None);
        assert_eq!(key_of(0x2a, 3, 0x10, || false), None);
        assert_eq!(key_of(0, 0, 0xff, || false), None);
        // Right Shift held as Left Shift goes down spoils it, as Windows reports it held.
        assert_eq!(key_of(0x2a, 0, 0x10, || true), Some(Key::ShiftDown { others: true }));
        assert_eq!(key_of(0x48, 2, 0x26, || false), Some(Key::Other(0xe048)));
        assert_eq!(key_of(0, 0, 0x87, || false), Some(Key::Other(0xff87)));
    }
}
