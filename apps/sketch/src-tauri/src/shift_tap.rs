//! Opening a capture with Left Shift (F16): for 1 second after a capture's notification shows, a
//! lone tap of Left Shift opens it, as clicking the notification does. Used by the capture helper
//! (Sketch closed) and by Sketch's own captures (Sketch open), so both behave the same.
//!
//! A low-level keyboard hook listens only during that second, on a thread of its own with its own
//! message loop, and is removed after it. It passes every key on and never swallows one, so Shift
//! keeps working in every app throughout. Its callback only records the key; the capture opens on
//! the loop once the hook is gone, since Windows drops hooks whose callbacks are slow.
//!
//! Windows doesn't call a process's low-level hook for keys going to that process's own windows, and
//! after Sketch's own capture its window is in front, so Sketch never watches in its own process: it
//! starts `sketch-capture.exe --shift-tap=<id>` (`watch_elsewhere`), which watches and tells Sketch
//! about a tap over its pipe. The helper watches in its own process, since its windows are hidden.
//!
//! A tap is Left Shift going down inside the second and coming up within 500 ms, with no other key
//! pressed or held meanwhile, so Shift+letter while typing, Right Shift and a held Shift don't count.
//! A Shift already held as the second starts (from capture keys like Alt+Shift+S) is ignored until
//! it's released.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after the notification shows a tap counts.
pub const WINDOW: Duration = Duration::from_secs(1);
/// Longest press that's still a tap.
const TAP: Duration = Duration::from_millis(500);

/// Hooks installed right now, for checks (no hook may be left after its second).
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
    /// Left Shift went down; `others` is whether another key was held at that moment.
    ShiftDown { others: bool },
    ShiftUp,
    /// Any other key went down.
    Other,
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
}

impl Taps {
    fn new(start: Instant, held: bool) -> Self {
        Taps { start, held, down: None, spoiled: false }
    }

    /// A key at `now`. True when it completes a tap.
    fn key(&mut self, key: Key, now: Instant) -> bool {
        match key {
            Key::ShiftDown { others } => {
                // Windows repeats the key down while Shift is held; only the first counts.
                if !self.held && self.down.is_none() && now.duration_since(self.start) <= WINDOW {
                    self.down = Some(now);
                    self.spoiled = others;
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
            Key::Other => {
                if self.down.is_some() {
                    self.spoiled = true;
                }
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
    use std::time::Instant;

    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_LSHIFT, VK_RSHIFT};
    use windows::Win32::UI::WindowsAndMessaging::*;

    use super::{Key, Taps, ACTIVE, WATCHES};

    /// Posted to a watch's own thread when a tap completes.
    const WM_TAP: u32 = WM_APP + 1;

    fn down(vk: VIRTUAL_KEY) -> bool {
        unsafe { GetAsyncKeyState(vk.0 as i32) < 0 }
    }

    /// Whether a key other than the Shift keys is held: Ctrl, Alt or Windows with Shift is a shortcut.
    fn others_held() -> bool {
        use windows::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN};
        [VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN].into_iter().any(down)
    }

    /// A key for the watch run by `thread`.
    fn record(thread: u32, key: Key) {
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

    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let msg = wparam.0 as u32;
            let pressed = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let key = match (info.vkCode, pressed) {
                (vk, true) if vk == VK_LSHIFT.0 as u32 => Some(Key::ShiftDown { others: others_held() || down(VK_RSHIFT) }),
                (vk, false) if vk == VK_LSHIFT.0 as u32 => Some(Key::ShiftUp),
                (_, true) => Some(Key::Other),
                _ => None,
            };
            if let Some(key) = key {
                record(GetCurrentThreadId(), key);
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// Runs a watch on this thread. True when a tap came.
    pub fn run() -> bool {
        let thread = unsafe { GetCurrentThreadId() };
        let taps = Taps::new(Instant::now(), down(VK_LSHIFT));
        WATCHES.lock().unwrap().push((thread, taps));
        let module = unsafe { GetModuleHandleW(None) }.ok();
        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module.map(Into::into), 0) }.ok();
        if hook.is_some() {
            ACTIVE.fetch_add(1, Ordering::Relaxed);
        }
        let mut tapped = false;
        while !tapped {
            let end = WATCHES.lock().unwrap().iter().find(|(t, _)| *t == thread).map(|(_, taps)| taps.end());
            let Some(left) = end.and_then(|e| e.checked_duration_since(Instant::now())).filter(|d| !d.is_zero()) else { break };
            // Wakes for the hook's calls too, which `PeekMessageW` hands to `hook`.
            unsafe { MsgWaitForMultipleObjects(None, false, left.as_millis().max(1) as u32, QS_ALLINPUT) };
            let mut msg = MSG::default();
            while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                if msg.message == WM_TAP {
                    tapped = true;
                }
                unsafe { DispatchMessageW(&msg) };
            }
        }
        if let Some(hook) = hook {
            unsafe {
                let _ = UnhookWindowsHookEx(hook);
            }
            ACTIVE.fetch_sub(1, Ordering::Relaxed);
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
        t.key(Key::Other, at(s, 150));
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
}
