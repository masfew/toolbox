//! The mouse speed slider. Windows' pointer speed is one setting for the whole PC, so Sketch changes
//! it only while the user holds Left Ctrl in a focused Sketch window (the page says so with
//! `mouse_ctrl`); drawing without Ctrl keeps the user's own speed. It puts the user's own speed back
//! the moment that ends: Left Ctrl comes up, another window takes focus, Sketch minimises or closes.
//! At normal (offset 0, the slider's right end) the setting is never touched.
//!
//! Safety nets for a crash, where none of that runs:
//! - The change is made without writing it to the user's profile (no `SPIF_UPDATEINIFILE`), so
//!   signing out or restarting Windows always brings back their own speed.
//! - The user's own speed is saved to `mouse-speed.json` in the data folder before every change and
//!   deleted when it's put back. If the file is still there at the next start, Sketch didn't close
//!   cleanly, and the speed is put back then.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// How often Left Ctrl and focus are checked during a hold. Checking costs a few µs (see
/// `docs/decisions.md`), so the end of a stroke can be followed closely.
const TICK: Duration = Duration::from_millis(20);
/// Windows' pointer speeds: 1 to 20, where 10 is the default.
const MIN_SPEED: i32 = 1;
const MAX_SPEED: i32 = 20;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
struct Applied {
    /// The user's own speed.
    base: u32,
    /// The speed Sketch set.
    set: u32,
}

struct State {
    /// Steps away from the user's own speed that the slider asks for.
    offset: i32,
    applied: Option<Applied>,
    /// Left Ctrl went down in a Sketch window and hasn't been seen coming up since.
    ctrl: bool,
    /// Checks don't press the real keyboard, so they say whether Left Ctrl is held instead.
    forced_ctrl: Option<bool>,
    file: PathBuf,
    worker: Option<thread::Thread>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State { offset: 0, applied: None, ctrl: false, forced_ctrl: None, file: PathBuf::new(), worker: None }))
}

// ---------- The system setting ----------

/// Checks set `SKETCH_TEST_MOUSE_SPEED` to a file that stands in for the Windows setting, so they
/// never change the real mouse speed.
fn test_store() -> Option<&'static PathBuf> {
    static FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
    FILE.get_or_init(|| std::env::var_os("SKETCH_TEST_MOUSE_SPEED").map(PathBuf::from)).as_ref()
}

fn get_speed() -> Option<u32> {
    if let Some(file) = test_store() {
        return fs::read_to_string(file).ok()?.trim().parse().ok();
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETMOUSESPEED, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
        let mut speed: u32 = 0;
        SystemParametersInfoW(SPI_GETMOUSESPEED, 0, Some(&mut speed as *mut u32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).ok()?;
        Some(speed)
    }
    #[cfg(not(windows))]
    None
}

fn set_speed(speed: u32) -> bool {
    if let Some(file) = test_store() {
        return fs::write(file, speed.to_string()).is_ok();
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_SETMOUSESPEED, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
        // The speed goes in pvParam as a value, not a pointer. Flags 0: not saved to the profile and
        // not broadcast, so a crash can't make it stick past signing out, and other apps aren't
        // sent a settings message every time the pointer crosses the window's edge.
        SystemParametersInfoW(SPI_SETMOUSESPEED, 0, Some(speed as usize as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = speed;
        false
    }
}

fn target(base: u32, offset: i32) -> u32 {
    (base as i32 + offset).clamp(MIN_SPEED, MAX_SPEED) as u32
}

// ---------- Whether a Ctrl hold is still going ----------

/// Whether Left Ctrl is down while the window with focus is one of Sketch's. Open and Save dialogs
/// and message boxes belong to Sketch's process but aren't its windows.
fn ctrl_in_focused_sketch() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LCONTROL};
        use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId};
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid != std::process::id() {
            return false;
        }
        let mut class = [0u16; 16];
        let n = GetClassNameW(fg, &mut class) as usize;
        if class[..n] == *"#32770".encode_utf16().collect::<Vec<_>>() {
            return false;
        }
        GetAsyncKeyState(VK_LCONTROL.0 as i32) as u16 & 0x8000 != 0
    }
    #[cfg(not(windows))]
    false
}

// ---------- Applying and putting back ----------

fn save_file(s: &State) {
    match s.applied {
        Some(a) => {
            if let Ok(json) = serde_json::to_vec(&a) {
                let _ = crate::write_atomic(&s.file, &json);
            }
        }
        None => {
            let _ = fs::remove_file(&s.file);
        }
    }
}

/// Puts the user's own speed back, unless something else changed it since Sketch set it.
fn restore(s: &mut State) {
    if let Some(a) = s.applied.take() {
        if get_speed() == Some(a.set) {
            set_speed(a.base);
        }
        save_file(s);
    }
}

/// One check: Sketch's speed is in force exactly when `active`.
fn step(s: &mut State, active: bool) {
    if !active || s.offset == 0 {
        return restore(s);
    }
    match s.applied {
        None => {
            let Some(base) = get_speed() else { return };
            let set = target(base, s.offset);
            if set == base {
                return;
            }
            // Saved before the change, so a crash right after it can still be put right.
            s.applied = Some(Applied { base, set });
            save_file(s);
            if !set_speed(set) {
                s.applied = None;
                save_file(s);
            }
        }
        Some(a) => {
            let now = get_speed();
            if now != Some(a.set) {
                // The user changed their speed in Windows meanwhile: that's their own speed now, and
                // the next check applies the slider to it.
                s.applied = None;
                save_file(s);
            } else if target(a.base, s.offset) == a.base {
                restore(s);
            } else if target(a.base, s.offset) != a.set {
                // The slider moved while Sketch's speed is in force.
                let set = target(a.base, s.offset);
                s.applied = Some(Applied { base: a.base, set });
                save_file(s);
                set_speed(set);
            }
        }
    }
}

fn worker() {
    loop {
        let (idle, forced) = {
            let s = state().lock().unwrap();
            ((s.offset == 0 || !s.ctrl) && s.applied.is_none(), s.forced_ctrl)
        };
        if idle {
            thread::park();
            continue;
        }
        // Found outside the lock, so the page asking for the speed never waits on Windows calls.
        let held = forced.unwrap_or_else(ctrl_in_focused_sketch);
        let mut s = state().lock().unwrap();
        // A hold ends when Left Ctrl comes up or Sketch loses focus, even if the page never says so.
        if !held {
            s.ctrl = false;
        }
        let active = s.ctrl;
        step(&mut s, active);
        drop(s);
        thread::sleep(TICK);
    }
}

fn wake() {
    if let Some(t) = &state().lock().unwrap().worker {
        t.unpark();
    }
}

/// At start: puts the user's speed back if the last run didn't, and starts the worker.
pub fn init(app: &AppHandle) {
    let file = crate::data_dir(app).join("mouse-speed.json");
    if let Some(a) = fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Applied>(&b).ok()) {
        if get_speed() == Some(a.set) {
            set_speed(a.base);
        }
    }
    let _ = fs::remove_file(&file);
    let mut s = state().lock().unwrap();
    s.file = file;
    s.worker = Some(thread::Builder::new().name("mouse-speed".into()).spawn(worker).expect("mouse speed thread").thread().clone());
}

/// When Sketch closes.
pub fn shutdown() {
    restore(&mut state().lock().unwrap());
}

#[derive(Serialize)]
pub struct MouseSpeed {
    /// The user's own Windows pointer speed (1 to 20).
    base: u32,
}

/// Sets the slider (steps from the user's own speed; 0 for normal). Returns the user's own speed,
/// or nothing where the setting can't be read.
#[tauri::command]
pub fn mouse_speed_set(offset: i32) -> Option<MouseSpeed> {
    let base = {
        let mut s = state().lock().unwrap();
        s.offset = offset.clamp(-(MAX_SPEED - MIN_SPEED), MAX_SPEED - MIN_SPEED);
        match s.applied {
            Some(a) => a.base,
            None => get_speed()?,
        }
    };
    wake();
    Some(MouseSpeed { base })
}

/// The page says Left Ctrl went down or came up in a Sketch window.
#[tauri::command]
pub fn mouse_ctrl(on: bool) {
    state().lock().unwrap().ctrl = on;
    wake();
}

/// For checks: says Left Ctrl is down in a focused Sketch window (true) or up (false), or goes back
/// to reading the real key (null).
#[tauri::command]
pub fn mouse_speed_force(ctrl: Option<bool>) -> Result<(), String> {
    if !crate::test_hooks() {
        return Err("only for checks".into());
    }
    state().lock().unwrap().forced_ctrl = ctrl;
    wake();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_stays_in_range() {
        assert_eq!(target(10, -4), 6);
        assert_eq!(target(3, -6), 1);
        assert_eq!(target(18, 4), 20);
    }

    /// Changes the real Windows setting by one step for a moment and puts it back.
    /// Run with `cargo test --release -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_setting_round_trip() {
        let base = get_speed().expect("read the pointer speed");
        let other = if base > MIN_SPEED as u32 { base - 1 } else { base + 1 };
        assert!(set_speed(other));
        let changed = get_speed();
        assert!(set_speed(base));
        assert_eq!(changed, Some(other));
        assert_eq!(get_speed(), Some(base));
        println!("pointer speed {base}, changed to {other} and back");
    }

    /// Times the Windows calls the Ctrl check makes every tick, all of them, as when a Sketch
    /// window has focus (here the test's own process never does, so the check would stop early).
    /// Run with `cargo test --release -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn button_check_cost() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LCONTROL};
        use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId};
        let n = 100_000;
        let t = std::time::Instant::now();
        for _ in 0..n {
            unsafe {
                let fg = GetForegroundWindow();
                let mut pid = 0u32;
                GetWindowThreadProcessId(fg, Some(&mut pid));
                let mut class = [0u16; 16];
                GetClassNameW(fg, &mut class);
                std::hint::black_box(GetAsyncKeyState(VK_LCONTROL.0 as i32));
            }
        }
        println!("ctrl check: {:.2} µs each", t.elapsed().as_secs_f64() * 1e6 / n as f64);
    }
}
