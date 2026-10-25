//! Background capture, as the Snipping Tool does it: a small process of its own,
//! `sketch-capture.exe`, holds the capture keys with `RegisterHotKey` (so they can be any keys,
//! Print Screen included) and captures with the same overlay and notification as Sketch, without
//! starting Sketch. Clicking the notification opens the capture in Sketch.
//!
//! So that the click opens it at once (F12), a hidden Sketch starts with the capture as the
//! notification shows. The click shows it; the notification going without a click (after 3
//! seconds, `note.rs`) closes it.
//!
//! The helper has no window anyone sees and does nothing until the keys are pressed. It runs
//! whenever capture keys are set, with Sketch open or closed: it starts when you sign in to Windows
//! (a `Run` entry) and Sketch leaves it running when it quits.
//!
//! Sketch and the helper share `capture.json` in the data folder: the keys and what happens after a
//! capture. Sketch changes it and restarts the helper, which reads it as it starts.
//! The helper's hidden window, found by its class and a title made from the data folder, is how
//! Sketch and the installer find it and tell it to quit.

use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::capture::{self, Shot};
use crate::{instance, note};

/// The helper's file name, next to `sketch.exe`.
pub const HELPER_EXE: &str = "sketch-capture.exe";
/// The class of the helper's hidden window. The installer looks for it too (`windows/hooks.nsh`).
const CLASS: &str = "SketchCaptureHelper";
/// The sign-in entry that starts the helper.
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Sketch Capture";

/// What happens once a capture is picked.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum After {
    /// On the clipboard, with a notification that opens it in Sketch, like the Snipping Tool.
    #[default]
    Notify,
    /// Straight into Sketch (and on the clipboard too).
    Open,
}

/// `capture.json` in the data folder.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Settings {
    /// Like "PrintScreen" or "Ctrl+Alt+S"; None when capture has no keys. Files from before 22 Oct
    /// 2026 also hold `background`, a switch that's gone: the keys always work with Sketch closed.
    pub keys: Option<String>,
    pub after: After,
    /// Hide Sketch's windows before a capture taken while it's open. Off by default (also for files
    /// from before 22 Oct 2026, which don't have it), so Sketch can be in the shot.
    pub hide: bool,
    /// A tap of Left Shift within a second of the notification opens the capture (F16). On by
    /// default, also for files from before it.
    pub shift_open: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { keys: None, after: After::Notify, hide: false, shift_open: true }
    }
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("capture.json")
}

/// Why the helper couldn't hold the keys, written by the helper and shown in Settings.
fn error_path(dir: &Path) -> PathBuf {
    dir.join("capture-error.txt")
}

pub fn load(dir: &Path) -> Settings {
    fs::read(settings_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(dir: &Path, settings: &Settings) -> Result<(), String> {
    let _ = fs::create_dir_all(dir);
    let body = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    crate::write_atomic(&settings_path(dir), &body)
}

/// Captures waiting for their notification, and the notification thumbnails, live in `captures`.
/// Anything there older than a day was left by a run that ended without tidying up.
pub fn clean_old(dir: &Path) {
    let Ok(list) = fs::read_dir(dir.join("captures")) else { return };
    let day = Duration::from_secs(24 * 60 * 60);
    for entry in list.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > day);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// ---------- Capture files ----------

/// A capture saved for Sketch to open: the width and height (little-endian u32), then straight RGBA.
/// Not compressed, so writing and reading it takes milliseconds.
fn write_shot(path: &Path, shot: &Shot) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = BufWriter::new(fs::File::create(path)?);
    f.write_all(&shot.width.to_le_bytes())?;
    f.write_all(&shot.height.to_le_bytes())?;
    f.write_all(&shot.rgba)?;
    f.flush()
}

/// Reads a capture the helper saved, and deletes the file.
pub fn take_shot(path: &Path) -> Option<Shot> {
    let shot = read_shot(path);
    let _ = fs::remove_file(path);
    shot
}

/// Reads a capture the helper saved and leaves the file, for a hidden Sketch (F12): the helper
/// deletes it if the notification goes unclicked, and Sketch once it's shown.
pub fn read_shot(path: &Path) -> Option<Shot> {
    let bytes = fs::read(path).ok()?;
    let width = u32::from_le_bytes(bytes.get(0..4)?.try_into().ok()?);
    let height = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?);
    let rgba = bytes.get(8..)?.to_vec();
    (rgba.len() == width as usize * height as usize * 4).then_some(Shot { width, height, rgba })
}

// ---------- Keys ----------

/// "Ctrl+Alt+S" (Sketch's order), "Alt+Ctrl+S" (Windows') or "PrintScreen" as hotkey modifiers and a
/// virtual key.
pub fn parse_keys(keys: &str) -> Option<(u32, u32)> {
    const MOD_ALT: u32 = 1;
    const MOD_CONTROL: u32 = 2;
    const MOD_SHIFT: u32 = 4;
    let parts: Vec<String> = keys.split('+').map(|p| p.trim().to_uppercase()).collect();
    let (key, mods) = parts.split_last()?;
    let mut bits = 0;
    for m in mods {
        bits |= match m.as_str() {
            "CTRL" => MOD_CONTROL,
            "ALT" => MOD_ALT,
            "SHIFT" => MOD_SHIFT,
            _ => return None,
        };
    }
    let vk = match key.as_str() {
        "PRINTSCREEN" => VK_SNAPSHOT,
        k if k.len() == 1 && (k.as_bytes()[0].is_ascii_uppercase() || k.as_bytes()[0].is_ascii_digit()) => k.as_bytes()[0] as u32,
        k if k.len() > 1 && k.starts_with('F') => 0x6f + k[1..].parse::<u32>().ok().filter(|n| (1..=12).contains(n))?,
        _ => return None,
    };
    Some((bits, vk))
}

pub const VK_SNAPSHOT: u32 = 0x2c;

/// Whether Windows itself takes Print Screen to open its own screen capture (Settings >
/// Accessibility > Keyboard, "Use the Print screen key to open screen capture"). On Windows 11 that's
/// on until someone turns it off; Windows only writes the setting once it has been changed.
pub fn windows_owns_print_screen() -> bool {
    #[cfg(windows)]
    {
        if let Some(v) = reg_dword(r"Control Panel\Keyboard", "PrintScreenKeyForSnippingEnabled") {
            return v != 0;
        }
        // Windows 11 is build 22000 and later; the default changed to on in 2023 (22621).
        windows_build() >= 22621
    }
    #[cfg(not(windows))]
    false
}

pub const PRINT_SCREEN_TAKEN: &str =
    "Windows uses Print Screen for its own screen capture. Turn off \"Use the Print screen key to open screen capture\" in Windows Settings, then pick Print Screen again.";

// ---------- Finding and controlling the helper ----------

/// The helper's window title, and the end of its mutex's name: one helper per data folder, like
/// Sketch's own pipe, so a check's helper never meets the user's.
fn tag(dir: &Path) -> String {
    format!("sketch-capture-{}", instance::key_hash(&dir.to_string_lossy()))
}

fn helper_exe() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.with_file_name(HELPER_EXE))
}

/// What the helper starts to open a capture: the launcher in the install layout (F6.1), so the
/// capture opens in the newest Sketch, or the Sketch beside the helper outside it.
fn sketch_exe() -> Option<PathBuf> {
    match crate::layout::install_root() {
        Some(root) => Some(root.join(crate::layout::LAUNCHER_EXE)),
        None => Some(std::env::current_exe().ok()?.with_file_name("sketch.exe")),
    }
}

/// The sign-in entry's command: through the launcher in the install layout, so it always starts
/// the newest version's helper rather than one in a version folder that will be deleted.
fn run_command() -> Option<String> {
    Some(match crate::layout::install_root() {
        Some(root) => format!("\"{}\" --capture-helper", root.join(crate::layout::LAUNCHER_EXE).to_string_lossy()),
        None => format!("\"{}\"", helper_exe()?.to_string_lossy()),
    })
}

pub fn running(dir: &Path) -> bool {
    #[cfg(windows)]
    return imp::find(&tag(dir)).is_some();
    #[cfg(not(windows))]
    {
        let _ = dir;
        false
    }
}

/// Starts the helper if it isn't running, and waits until it holds the keys. Err when it couldn't.
/// A helper from another version (Sketch has restarted into an update since it started) is
/// replaced with this version's.
pub fn start(dir: &Path) -> Result<(), String> {
    if running(dir) {
        #[cfg(windows)]
        let other = imp::helper_path(&tag(dir)).zip(helper_exe()).is_some_and(|(theirs, mine)| !theirs.to_string_lossy().eq_ignore_ascii_case(&mine.to_string_lossy()));
        #[cfg(not(windows))]
        let other = false;
        if !other {
            return Ok(());
        }
        stop(dir);
    }
    let exe = helper_exe().filter(|p| p.exists()).ok_or("sketch-capture.exe is missing, so capture keys can't work. Reinstall Sketch.")?;
    let _ = fs::remove_file(error_path(dir));
    let mut cmd = std::process::Command::new(exe);
    if let Some(over) = crate::data_dir_override() {
        cmd.arg(format!("--data-dir={}", over.to_string_lossy()));
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the capture helper: {e}"))?;
    for _ in 0..100 {
        if running(dir) {
            return Ok(());
        }
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    Err(fs::read_to_string(error_path(dir)).unwrap_or_else(|_| "The capture helper didn't start.".into()))
}

/// Tells the helper to quit, and waits until it has.
pub fn stop(dir: &Path) {
    #[cfg(windows)]
    imp::stop(&tag(dir));
    #[cfg(not(windows))]
    let _ = dir;
}

/// Starts the helper when you sign in to Windows, or stops doing so. Checks (a data folder of their
/// own) write a stand-in file instead, so they never touch the user's sign-in entries.
fn set_run_entry(on: bool) -> Result<(), String> {
    if let Some(over) = crate::data_dir_override() {
        let file = over.join("run-entry.txt");
        return if on {
            fs::write(&file, run_command().unwrap_or_default().as_bytes()).map_err(|e| e.to_string())
        } else {
            let _ = fs::remove_file(&file);
            Ok(())
        };
    }
    #[cfg(windows)]
    {
        if on {
            imp::reg_set(RUN_KEY, RUN_VALUE, &run_command().ok_or("no exe path")?)
        } else {
            imp::reg_delete(RUN_KEY, RUN_VALUE);
            Ok(())
        }
    }
    #[cfg(not(windows))]
    Ok(())
}

/// Makes the helper match the settings: running with the keys (or not), and the sign-in entry.
fn apply(dir: &Path, settings: &Settings) -> Result<(), String> {
    if settings.keys.is_none() {
        stop(dir);
        return set_run_entry(false);
    }
    set_run_entry(true)?;
    start(dir)
}

/// Sets the capture keys, or removes them (None). Keys Windows or another app already holds are
/// refused, since the helper would never hear them.
pub fn set_keys(dir: &Path, keys: Option<String>, paste_keys: Option<(u32, u32)>) -> Result<(), String> {
    let mut settings = load(dir);
    let Some(keys) = keys else {
        settings.keys = None;
        save(dir, &settings)?;
        return apply(dir, &settings);
    };
    let wanted = parse_keys(&keys).ok_or_else(|| format!("{keys} can't be a Windows shortcut"))?;
    if paste_keys == Some(wanted) {
        return Err(format!("{keys} already opens Sketch with the clipboard picture. Pick other keys."));
    }
    if wanted == (0, VK_SNAPSHOT) && windows_owns_print_screen() {
        return Err(PRINT_SCREEN_TAKEN.into());
    }
    // The helper holds the keys it has now, so they'd look taken.
    stop(dir);
    if capture::hotkey_taken(wanted.0, wanted.1) {
        let _ = apply(dir, &settings);
        return Err(format!("Another app already uses {}. Pick other keys.", keys.replace("PrintScreen", "Print Screen")));
    }
    settings.keys = Some(keys);
    save(dir, &settings)?;
    apply(dir, &settings)
}

/// What happens after a capture, whether Sketch hides first and whether Left Shift opens it; the
/// keys stay as they are, and so does anything not given.
pub fn set_options(dir: &Path, after: Option<After>, hide: Option<bool>, shift_open: Option<bool>) -> Result<(), String> {
    let mut settings = load(dir);
    if let Some(after) = after {
        settings.after = after;
    }
    if let Some(hide) = hide {
        settings.hide = hide;
    }
    if let Some(shift_open) = shift_open {
        settings.shift_open = shift_open;
    }
    save(dir, &settings)
}

/// What Settings shows: the after-capture choice, whether Sketch hides while capturing, whether
/// Left Shift opens a capture, and why the keys aren't working, if they aren't.
#[derive(Serialize)]
pub struct Options {
    after: After,
    hide: bool,
    #[serde(rename = "shiftOpen")]
    shift_open: bool,
    error: Option<String>,
}

pub fn options(dir: &Path) -> Options {
    let s = load(dir);
    let error = s.keys.as_ref().and_then(|_| fs::read_to_string(error_path(dir)).ok());
    Options { after: s.after, hide: s.hide, shift_open: s.shift_open, error }
}

/// As Sketch starts: the capture shortcut Sketch used to keep in the Start menu (until Oct 2026)
/// moves to the helper, so the same keys keep working with Sketch closed, and the helper starts if
/// capture has keys. Runs on a thread of its own, so it never slows the start.
pub fn init(dir: PathBuf, old_keys: impl FnOnce() -> Option<String> + Send + 'static) {
    std::thread::spawn(move || {
        clean_old(&dir);
        if crate::data_dir_override().is_none() && !settings_path(&dir).exists() {
            if let Some(keys) = old_keys().filter(|k| parse_keys(k).is_some()) {
                let settings = Settings { keys: Some(keys), ..Settings::default() };
                if save(&dir, &settings).is_ok() {
                    crate::shell::remove_capture_shortcut();
                }
            }
        }
        let settings = load(&dir);
        if settings.keys.is_some() {
            // Also puts back the sign-in entry that the old "Keep capture ready" switch took out.
            let _ = apply(&dir, &settings);
        }
    });
}

/// Opens Windows Settings at the keyboard page, where the Print Screen setting is.
pub fn open_keyboard_settings() {
    #[cfg(windows)]
    let _ = crate::shell::quiet("explorer.exe").arg("ms-settings:easeofaccess-keyboard").spawn();
}

// ---------- The helper process ----------

struct Helper {
    dir: PathBuf,
    sketch: PathBuf,
}

static HELPER: OnceLock<Helper> = OnceLock::new();

/// For checks (test hooks only): act as if the keys were pressed, as if the newest notification
/// was clicked, and as if it was dismissed.
pub const WM_TEST_KEYS: u32 = 0x8000 + 3;
pub const WM_TEST_CLICK: u32 = 0x8000 + 4;
pub const WM_TEST_DISMISS: u32 = 0x8000 + 5;
/// Answers how many Left Shift hooks (F16) are installed.
pub const WM_TEST_WATCHING: u32 = 0x8000 + 6;

/// `sketch-capture.exe`'s whole life: hold the keys until told to quit.
pub fn main() {
    // Run by Sketch for its own captures (F16): only watch for the Left Shift tap, then quit.
    if let Some(id) = std::env::args().find_map(|a| a.strip_prefix("--shift-tap=").and_then(|id| id.parse().ok())) {
        crate::shift_tap::watch_for_sketch(id);
        return;
    }
    capture::dpi_aware();
    let dir = crate::default_data_dir();
    let settings = load(&dir);
    let Some((mods, vk)) = settings.keys.as_deref().and_then(parse_keys) else { return };
    let Some(sketch) = sketch_exe() else { return };
    #[cfg(windows)]
    {
        let tag = tag(&dir);
        // One helper per data folder: a second start (the sign-in entry and Sketch at once) quits.
        let Some(_mutex) = imp::claim(&tag) else { return };
        imp::com_init();
        clean_old(&dir);
        // Notifications left in the notification centre by Sketch before F12, which do nothing
        // when clicked. Not for checks, which mustn't touch the user's.
        if crate::data_dir_override().is_none() {
            note::clear_centre();
        }
        let _ = HELPER.set(Helper { dir: dir.clone(), sketch });
        if let Err(e) = imp::serve(&tag, mods, vk) {
            let _ = fs::write(error_path(&dir), e);
        }
        note::close_all();
    }
    #[cfg(not(windows))]
    let _ = (mods, vk, sketch);
}

/// The keys were pressed.
fn on_keys() {
    let Some(h) = HELPER.get() else { return };
    // In Sketch, Sketch takes it: it hides its own windows before freezing the screen.
    if imp_sketch_in_front(&h.sketch) {
        let message = instance::Message { args: vec![h.sketch.to_string_lossy().into_owned(), "--capture".into()], cwd: String::new() };
        if instance::send(&h.dir.to_string_lossy(), &message) {
            return;
        }
    }
    if !capture::begin() {
        return;
    }
    std::thread::spawn(|| {
        let shot = capture::pick();
        capture::end();
        if let Some(shot) = shot {
            deliver(shot);
        }
    });
}

fn imp_sketch_in_front(sketch: &Path) -> bool {
    #[cfg(windows)]
    return imp::foreground_path().is_some_and(|p| crate::layout::is_sketch_exe(&p) || p == sketch);
    #[cfg(not(windows))]
    {
        let _ = sketch;
        false
    }
}

/// On the clipboard, then a notification that opens it in Sketch, or straight into Sketch.
fn deliver(shot: Shot) {
    let Some(h) = HELPER.get() else { return };
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    // Read now rather than at start, so a change in Settings counts without restarting the helper.
    let settings = load(&h.dir);
    // F16: a tap of Left Shift in the next second opens it, as the click does. Listening starts
    // before the clipboard, the file and the notification, which take a few hundred ms on a big
    // capture: until 24 Oct 2026 it started after them, and a quick tap went unheard. A tap that
    // beats the notification waits for it.
    if settings.after == After::Notify && settings.shift_open {
        crate::shift_tap::watch(move || note::click_soon(id));
    }
    crate::copy_shot(&shot);
    let file = h.dir.join("captures").join(format!("{}-{id}.rgba", std::process::id()));
    if write_shot(&file, &shot).is_err() {
        return;
    }
    if settings.after == After::Open {
        open_in_sketch(&file, false);
        return;
    }
    let waiting = file.clone();
    let shown = note::show(&h.dir, id, &shot, move |event| match event {
        note::Event::Clicked => hand_to_sketch(&waiting, &["--from-note".into(), format!("--reveal={id}")]),
        note::Event::Closed => {
            let _ = fs::remove_file(&waiting);
            // The hidden Sketch waiting for this notification closes with it.
            let _ = send_to_sketch(&h.dir, &h.sketch, &[format!("--drop-hidden={id}")]);
        }
    });
    if !shown {
        open_in_sketch(&file, false);
        return;
    }
    // F12: with Sketch closed, a hidden Sketch starts now with the capture loaded, so clicking the
    // notification only has to show it. A running Sketch ignores this unless its own hidden window
    // is waiting for an older capture, which this one replaces.
    hand_to_sketch(&file, &["--from-note".into(), format!("--hidden={id}")]);
    note::close_older(id);
}

/// Hands a command line to the running Sketch over its pipe, as a second launch would, without
/// starting a process. False when no Sketch is running.
fn send_to_sketch(dir: &Path, sketch: &Path, args: &[String]) -> bool {
    let mut all = vec![sketch.to_string_lossy().into_owned()];
    all.extend_from_slice(args);
    instance::send(&dir.to_string_lossy(), &instance::Message { args: all, cwd: String::new() })
}

/// The capture and `args` to the running Sketch, or to a new one started with them.
fn hand_to_sketch(file: &Path, args: &[String]) {
    let Some(h) = HELPER.get() else { return };
    let mut all = vec![format!("--open-capture={}", file.to_string_lossy())];
    all.extend_from_slice(args);
    // `send_to_sketch` passes the foreground on too, so a shown capture comes to the front.
    if !send_to_sketch(&h.dir, &h.sketch, &all) {
        let _ = std::process::Command::new(&h.sketch).args(&all).spawn();
    }
}

/// Starts Sketch with the capture, or hands it to the running Sketch, which opens it like a paste.
/// `from_note`: the notification was clicked, so closing the capture won't ask about saving.
fn open_in_sketch(file: &Path, from_note: bool) {
    let Some(h) = HELPER.get() else { return };
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }
    let mut cmd = std::process::Command::new(&h.sketch);
    cmd.arg(format!("--open-capture={}", file.to_string_lossy()));
    if from_note {
        cmd.arg("--from-note");
    }
    let _ = cmd.spawn();
}

#[cfg(windows)]
fn reg_dword(key: &str, value: &str) -> Option<u32> {
    imp::reg_dword(key, value)
}

#[cfg(windows)]
fn windows_build() -> u32 {
    imp::reg_string_hklm(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber").and_then(|s| s.parse().ok()).unwrap_or(0)
}

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Registry::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT};
    use windows::Win32::UI::WindowsAndMessaging::*;

    use super::{on_keys, CLASS, WM_TEST_CLICK, WM_TEST_DISMISS, WM_TEST_KEYS, WM_TEST_WATCHING};

    pub fn find(tag: &str) -> Option<HWND> {
        unsafe { FindWindowW(&HSTRING::from(super::CLASS), &HSTRING::from(tag)).ok().filter(|h| !h.is_invalid()) }
    }

    pub fn stop(tag: &str) {
        let Some(hwnd) = find(tag) else { return };
        unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            let process = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, false, pid).ok();
            let _ = SendMessageTimeoutW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 2000, None);
            if let Some(p) = process {
                if WaitForSingleObject(p, 3000) != windows::Win32::Foundation::WAIT_OBJECT_0 {
                    let _ = TerminateProcess(p, 1);
                    let _ = WaitForSingleObject(p, 1000);
                }
                let _ = CloseHandle(p);
            }
        }
    }

    /// Held for the helper's whole life; None when another helper for this data folder has it.
    pub fn claim(tag: &str) -> Option<HANDLE> {
        unsafe {
            let m = CreateMutexW(None, true, &HSTRING::from(format!(r"Local\{tag}"))).ok()?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(m);
                return None;
            }
            Some(m)
        }
    }

    /// Notifications are WinRT, which needs COM on the threads that show them.
    pub fn com_init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn test_hooks() -> bool {
        std::env::var("SKETCH_TEST_HOOKS").is_ok_and(|v| v == "1")
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            WM_HOTKEY => on_keys(),
            WM_TEST_KEYS if test_hooks() => on_keys(),
            WM_TEST_CLICK if test_hooks() => {
                std::thread::spawn(|| crate::note::click_newest());
            }
            WM_TEST_DISMISS if test_hooks() => {
                std::thread::spawn(|| crate::note::dismiss_newest());
            }
            WM_TEST_WATCHING if test_hooks() => return LRESULT(crate::shift_tap::watching() as isize),
            WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
            }
            WM_ENDSESSION if wparam.0 != 0 => {
                // Signing out: the process ends without WM_DESTROY, so tidy the notifications now.
                crate::note::close_all();
            }
            WM_DESTROY => PostQuitMessage(0),
            _ => return DefWindowProcW(hwnd, msg, wparam, lparam),
        }
        LRESULT(0)
    }

    /// Makes the hidden window, holds the keys and runs until told to quit.
    pub fn serve(tag: &str, mods: u32, vk: u32) -> Result<(), String> {
        unsafe {
            let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
            let class = HSTRING::from(CLASS);
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wndproc),
                hInstance: instance.into(),
                lpszClassName: PCWSTR(class.as_ptr()),
                ..Default::default()
            };
            RegisterClassExW(&wc);
            // A top-level window that's never shown, rather than a message-only one, so FindWindow
            // (Sketch, the installer) can find it.
            let hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, &class, &HSTRING::from(tag), WS_POPUP, 0, 0, 0, 0, None, None, Some(instance.into()), None)
                .map_err(|e| e.to_string())?;
            if RegisterHotKey(Some(hwnd), 1, HOT_KEY_MODIFIERS(mods) | MOD_NOREPEAT, vk).is_err() {
                let _ = DestroyWindow(hwnd);
                return Err("Another app took the capture keys, so they don't work right now. Pick other keys in Settings.".into());
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
        }
        Ok(())
    }

    /// The program a process runs.
    fn process_path(pid: u32) -> Option<std::path::PathBuf> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(p);
            ok.then(|| std::path::PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    /// The program of the window in front.
    pub fn foreground_path() -> Option<std::path::PathBuf> {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid as *mut u32)) };
        process_path(pid)
    }

    /// The program of the running helper for this data folder.
    pub fn helper_path(tag: &str) -> Option<std::path::PathBuf> {
        let hwnd = find(tag)?;
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32)) };
        process_path(pid)
    }

    pub fn reg_set(key: &str, value: &str, data: &str) -> Result<(), String> {
        let wide: Vec<u16> = data.encode_utf16().chain(std::iter::once(0)).collect();
        let err = unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &HSTRING::from(value), REG_SZ.0, Some(wide.as_ptr() as *const _), (wide.len() * 2) as u32)
        };
        if err.is_ok() {
            Ok(())
        } else {
            Err(format!("Couldn't add Sketch's capture to Windows sign-in ({})", err.0))
        }
    }

    pub fn reg_delete(key: &str, value: &str) {
        unsafe {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &HSTRING::from(value));
        }
    }

    pub fn reg_dword(key: &str, value: &str) -> Option<u32> {
        let mut data = 0u32;
        let mut size = 4u32;
        let err = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &HSTRING::from(value), RRF_RT_REG_DWORD, None, Some(&mut data as *mut u32 as *mut _), Some(&mut size))
        };
        err.is_ok().then_some(data)
    }

    pub fn reg_string_hklm(key: &str, value: &str) -> Option<String> {
        let mut buf = [0u16; 64];
        let mut size = (buf.len() * 2) as u32;
        let err = unsafe {
            RegGetValueW(HKEY_LOCAL_MACHINE, &HSTRING::from(key), &HSTRING::from(value), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size))
        };
        if err.is_err() {
            return None;
        }
        let n = (size as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..n]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_parse_in_either_order_and_take_print_screen() {
        assert_eq!(parse_keys("Ctrl+Alt+S"), Some((3, b'S' as u32)));
        assert_eq!(parse_keys("Alt+Ctrl+S"), Some((3, b'S' as u32)));
        assert_eq!(parse_keys("Ctrl+Shift+F12"), Some((6, 0x7b)));
        assert_eq!(parse_keys("PrintScreen"), Some((0, VK_SNAPSHOT)));
        assert_eq!(parse_keys("Ctrl+PrintScreen"), Some((2, VK_SNAPSHOT)));
        assert_eq!(parse_keys("Ctrl+Shift+F13"), None);
        assert_eq!(parse_keys("Ctrl+Win+S"), None);
    }

    #[test]
    fn a_saved_capture_reads_back_once() {
        let dir = std::env::temp_dir().join(format!("sketch-helper-test-{}", std::process::id()));
        let path = dir.join("shot.rgba");
        let shot = Shot { width: 3, height: 2, rgba: (0..24).collect() };
        write_shot(&path, &shot).unwrap();
        let back = take_shot(&path).unwrap();
        assert_eq!((back.width, back.height, back.rgba), (3, 2, shot.rgba));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_settings_mean_no_keys() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings { keys: None, after: After::Notify, hide: false, shift_open: true });
    }

    #[test]
    fn an_old_file_with_the_background_switch_still_reads() {
        let s: Settings = serde_json::from_str(r#"{"keys":"Alt+Shift+S","background":false,"after":"open"}"#).unwrap();
        assert_eq!(s, Settings { keys: Some("Alt+Shift+S".into()), after: After::Open, hide: false, shift_open: true });
    }

    #[test]
    fn hiding_while_capturing_is_off_unless_turned_on() {
        let old: Settings = serde_json::from_str(r#"{"keys":null,"after":"notify"}"#).unwrap();
        assert!(!old.hide);
        let on: Settings = serde_json::from_str(r#"{"keys":null,"after":"notify","hide":true}"#).unwrap();
        assert!(on.hide);
    }
}
