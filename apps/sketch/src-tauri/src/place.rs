//! Where a window opens: where the user last moved or resized one, and whether it was maximised.
//! Kept in the data folder's `window.json`, so an update keeps it, and checks (which have a data
//! folder of their own) never change the user's.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, Window};

use crate::{data_dir, write_atomic};

/// How far each further open window is moved down and right, in logical pixels, so it doesn't
/// cover the one before exactly.
const CASCADE: f64 = 32.0;

/// How long after the last move or resize the place is written, since dragging sends a stream of them.
const WRITE_DELAY: Duration = Duration::from_millis(500);

/// In physical pixels: the window's outer top-left corner and its inner size when it isn't
/// maximised, as `set_position` and `set_size` take them.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
struct Place {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

#[derive(Default)]
pub struct Placement {
    /// The newest place, written to `window.json` a moment after it changes.
    last: Mutex<Option<Place>>,
    /// A write is waiting.
    pending: Mutex<bool>,
    /// Windows to maximise when they first show.
    maximize: Mutex<HashSet<String>>,
}

fn file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("window.json")
}

pub fn init(app: &AppHandle) {
    let last = fs::read(file(app)).ok().and_then(|b| serde_json::from_slice::<Place>(&b).ok());
    app.manage(Placement { last: Mutex::new(last), ..Default::default() });
}

/// The place, with its size cut down to fit, when the middle of its title bar is on a screen.
/// None when it isn't (that screen was unplugged, or its resolution went down), so the window
/// isn't lost off screen.
fn fit(window: &WebviewWindow, p: Place) -> Option<Place> {
    let (cx, cy) = (p.x + p.width as i32 / 2, p.y + 16);
    let monitors = window.available_monitors().ok()?;
    let area = monitors.iter().map(|m| *m.work_area()).find(|a| {
        cx >= a.position.x && cx < a.position.x + a.size.width as i32 && cy >= a.position.y && cy < a.position.y + a.size.height as i32
    })?;
    Some(Place { width: p.width.min(area.size.width), height: p.height.min(area.size.height), ..p })
}

/// Puts a new, still hidden window where the user last left one, a step down and right for each
/// other open window. With no saved place (the first run) it opens centred.
pub fn apply(window: &WebviewWindow) {
    let app = window.app_handle();
    let state = app.state::<Placement>();
    let saved = *state.last.lock().unwrap();
    let others = app.webview_windows().values().filter(|w| w.label() != window.label() && w.is_visible().unwrap_or(false)).count() as i32;
    let step = (CASCADE * window.scale_factor().unwrap_or(1.0)).round() as i32 * others;
    let place = saved.and_then(|p| fit(window, Place { x: p.x + step, y: p.y + step, ..p }).or_else(|| fit(window, p)));
    match place {
        Some(p) => {
            // Position first: moving onto a screen with another scale makes Windows resize the window.
            let _ = window.set_position(PhysicalPosition::new(p.x, p.y));
            let _ = window.set_size(PhysicalSize::new(p.width, p.height));
            if p.maximized {
                state.maximize.lock().unwrap().insert(window.label().to_string());
            }
        }
        None => {
            let _ = window.center();
        }
    }
    // So maximising a window that was never moved still remembers a size to come back to.
    let mut last = state.last.lock().unwrap();
    if last.is_none() {
        *last = window.outer_position().ok().zip(window.inner_size().ok()).map(|(pos, size)| normal(pos, size));
    }
}

fn normal(pos: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Place {
    Place { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false }
}

/// The window that had the focus when a quiet restart showed its first window. Every window of the
/// restart gives the focus back to it: one shown later could otherwise see no window in front (a
/// minimised window just shown leaves none) and keep a focus it took.
static FOCUS_BEFORE: AtomicIsize = AtomicIsize::new(0);

fn focus_before() -> isize {
    let kept = FOCUS_BEFORE.load(Ordering::Relaxed);
    if kept != 0 {
        return kept;
    }
    let now = imp::foreground();
    FOCUS_BEFORE.store(now, Ordering::Relaxed);
    now
}

/// Shows a window for the first time, maximised if it was when the user left it. After a restart
/// into a new version, the window goes back exactly where its picture's window was, minimised if
/// it was; a quiet restart hands the focus back to whatever had it.
#[tauri::command]
pub fn show_window(window: WebviewWindow, state: State<Placement>, restored: State<crate::update::Restored>) {
    let quiet = restored.mode == Some("quiet");
    let before = if quiet { focus_before() } else { 0 };
    let maximize = state.maximize.lock().unwrap().remove(window.label());
    match restored.place_for(window.label()) {
        Some(p) => {
            set_normal_place(&window, &p);
            let _ = window.show();
            if p.maximized {
                let _ = window.maximize();
            }
            if p.minimized {
                let _ = window.minimize();
            }
        }
        None => {
            if maximize {
                let _ = window.maximize();
            }
            let _ = window.show();
        }
    }
    if quiet {
        imp::give_back(before);
    }
}

/// A window's place as Windows keeps it, for bringing it back after a restart: its normal
/// (restored) rectangle in workspace coordinates, and whether it's maximised or minimised.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct WindowPlace {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    pub maximized: bool,
    pub minimized: bool,
}

pub fn window_place(window: &WebviewWindow) -> Option<WindowPlace> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, IsIconic, IsZoomed, WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED};
        let h = HWND(window.hwnd().ok()?.0 as _);
        let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
        unsafe {
            GetWindowPlacement(h, &mut wp).ok()?;
            let minimized = IsIconic(h).as_bool();
            let maximized = if minimized { wp.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0 } else { IsZoomed(h).as_bool() };
            let r = wp.rcNormalPosition;
            return Some(WindowPlace { left: r.left, top: r.top, right: r.right, bottom: r.bottom, maximized, minimized });
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

/// Puts a still hidden window's normal rectangle back, without showing it.
fn set_normal_place(window: &WebviewWindow, p: &WindowPlace) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPlacement, SW_HIDE, WINDOWPLACEMENT};
        let Ok(h) = window.hwnd() else { return };
        let wp = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            showCmd: SW_HIDE.0 as u32,
            rcNormalPosition: RECT { left: p.left, top: p.top, right: p.right, bottom: p.bottom },
            ..Default::default()
        };
        unsafe {
            let _ = SetWindowPlacement(HWND(h.0 as _), &wp);
        }
    }
    #[cfg(not(windows))]
    let _ = (window, p);
}

mod imp {
    /// The window in front, as a raw handle (0 for none).
    pub fn foreground() -> isize {
        #[cfg(windows)]
        unsafe {
            return windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize;
        }
        #[cfg(not(windows))]
        0
    }

    /// Showing (or maximising) a window activates it: if that took the focus from another app's
    /// window, it goes back there.
    pub fn give_back(before: isize) {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow};
            let pid_of = |h: HWND| {
                let mut pid = 0;
                GetWindowThreadProcessId(h, Some(&mut pid));
                pid
            };
            let me = std::process::id();
            let before = HWND(before as _);
            if before.0.is_null() || !IsWindow(Some(before)).as_bool() || pid_of(before) == me {
                return;
            }
            if pid_of(GetForegroundWindow()) == me {
                let _ = SetForegroundWindow(before);
            }
        }
        #[cfg(not(windows))]
        let _ = before;
    }
}

/// A window moved or changed size. Only the user's own moves count: a hidden window is being set
/// up (or hidden for a capture), and a minimised one has no real place.
pub fn track(window: &Window) {
    let (maximized, minimized) = shape(window);
    if !window.is_visible().unwrap_or(false) || minimized {
        return;
    }
    let state = window.state::<Placement>();
    let mut last = state.last.lock().unwrap();
    // A maximised window keeps the place it comes back to when it's restored.
    let place = if maximized {
        last.map(|p| Place { maximized: true, ..p })
    } else {
        window.outer_position().ok().zip(window.inner_size().ok()).map(|(pos, size)| normal(pos, size))
    };
    if place.is_none() || place == *last {
        return;
    }
    *last = place;
    drop(last);
    let mut pending = state.pending.lock().unwrap();
    if *pending {
        return;
    }
    *pending = true;
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(WRITE_DELAY);
        *app.state::<Placement>().pending.lock().unwrap() = false;
        save(&app);
    });
}

/// Whether the window is maximised and whether it's minimised, from Windows itself: Tauri's own
/// answer lags behind, so the first move of a maximise looked like a move to full screen size.
fn shape(window: &Window) -> (bool, bool) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsZoomed};
        if let Ok(h) = window.hwnd() {
            let h = HWND(h.0 as _);
            return unsafe { (IsZoomed(h).as_bool(), IsIconic(h).as_bool()) };
        }
    }
    (window.is_maximized().unwrap_or(false), window.is_minimized().unwrap_or(false))
}

/// Writes the newest place now (as Sketch quits, before a waiting write runs).
pub fn save(app: &AppHandle) {
    let Some(place) = *app.state::<Placement>().last.lock().unwrap() else { return };
    let path = file(app);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(&place) {
        let _ = write_atomic(&path, &json);
    }
}
