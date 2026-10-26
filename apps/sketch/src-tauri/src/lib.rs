mod capture;
mod clip;
mod cutout;
mod helper;
mod instance;
mod layout;
mod mouse;
mod note;
mod place;
mod recovery;
mod shell;
mod shift_tap;
mod update;
mod stamp;
mod fetch;
mod download;

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Largest file `fetch_url` will download (100 MB).
const MAX_FETCH_BYTES: u64 = 100 * 1024 * 1024;

pub(crate) fn header(request: &Request, name: &str) -> Result<String, String> {
    let value = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing {name} header"))?
        .to_str()
        .map_err(|e| e.to_string())?;
    urlencoding::decode(value)
        .map(|v| v.into_owned())
        .map_err(|e| e.to_string())
}

pub(crate) fn raw_body<'a>(request: &'a Request<'a>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(data) => Ok(data),
        _ => Err("expected raw bytes".into()),
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// Writes to a temporary file first, so a failed save never leaves a half-written file.
pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut tmp = path.to_path_buf().into_os_string();
    tmp.push(".sktch-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let data = raw_body(&request)?;
    write_atomic(&PathBuf::from(header(&request, "path")?), data)
}

/// Puts a PNG from the page on the clipboard.
#[tauri::command]
fn copy_png(request: Request) -> Result<(), String> {
    clip::set_png(raw_body(&request)?)
}

/// The picture on the clipboard as raw RGBA, after an 8-byte header holding the width and
/// height (little-endian u32). Empty when the clipboard holds no picture.
#[tauri::command]
fn read_clipboard_image() -> Response {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return Response::new(Vec::new());
    };
    match clipboard.get_image() {
        Ok(image) => {
            let mut out = Vec::with_capacity(8 + image.bytes.len());
            out.extend_from_slice(&(image.width as u32).to_le_bytes());
            out.extend_from_slice(&(image.height as u32).to_le_bytes());
            out.extend_from_slice(&image.bytes);
            Response::new(out)
        }
        Err(_) => Response::new(Vec::new()),
    }
}

/// The text on the clipboard, or an empty string.
#[tauri::command]
fn read_clipboard_text() -> String {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .unwrap_or_default()
}

/// Windows' clipboard change count. It goes up whenever anything is put on the clipboard.
#[tauri::command]
fn clipboard_seq() -> u32 {
    #[cfg(windows)]
    {
        clipboard_win::seq_num().map(|n| n.get()).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Paths of files copied in Explorer, if any.
#[tauri::command]
fn clipboard_file_paths() -> Vec<String> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats, get_clipboard};
        get_clipboard::<Vec<String>, _>(formats::FileList).unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
async fn fetch_url(url: String) -> Result<Response, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http and https links can be pasted".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_FETCH_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Data folder ----------

/// `--data-dir=…` on the command line or `SKETCH_DATA_DIR`: checks give the app a folder of its own,
/// so they never touch the user's autosaves or updates, or reach the user's running Sketch.
pub(crate) fn data_dir_override() -> Option<&'static PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        std::env::args()
            .find_map(|a| a.strip_prefix("--data-dir=").map(PathBuf::from))
            .or_else(|| std::env::var_os("SKETCH_DATA_DIR").map(PathBuf::from))
    })
    .as_ref()
}

/// The data folder worked out without Tauri, for the single-instance key and the capture helper:
/// the default one is where Tauri puts it.
pub(crate) fn default_data_dir() -> PathBuf {
    data_dir_override().cloned().unwrap_or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join(shell::APP_ID))
}

/// Where autosaves, updates and builds live: `%LOCALAPPDATA%\app.sketch.desktop`, unless overridden.
pub(crate) fn data_dir(app: &AppHandle) -> PathBuf {
    data_dir_override()
        .cloned()
        .or_else(|| app.path().app_local_data_dir().ok())
        .unwrap_or_else(std::env::temp_dir)
}

// ---------- Launches and windows ----------

/// What a window should start with.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
struct Launch {
    /// A file to open (from Explorer, "Open with" or the command line).
    file: Option<String>,
    /// Paste the clipboard picture (the "Paste into Sketch" shortcut).
    paste: bool,
    /// An autosave slot to reopen.
    recover: Option<String>,
    /// A screen capture to open, from `capture_take`.
    capture: Option<u32>,
    /// Started by the capture shortcut: the screen is being picked, and the window waits for it
    /// (`capture_wait`) before it shows.
    capturing: bool,
    /// A capture the capture helper saved (`--open-capture=…`), read into `Shots` before delivering.
    #[serde(skip)]
    capture_file: Option<PathBuf>,
    /// The capture was opened by clicking its notification (`--from-note` from the helper), so
    /// closing it doesn't ask about saving.
    #[serde(default)]
    quick: bool,
    /// F12: the window loads its capture but stays hidden until the capture's notification is
    /// clicked (`hidden_wait`), and closes if it never is.
    #[serde(default)]
    hidden: bool,
    /// The notification a hidden window waits for (`--hidden=<id>` from the helper).
    #[serde(skip)]
    hidden_note: Option<u32>,
    /// The notification that was clicked (`--reveal=<id>`): shows the hidden window waiting for it,
    /// or opens the capture as usual when there's none.
    #[serde(skip)]
    reveal: Option<u32>,
    /// The notification went without a click (`--drop-hidden=<id>`): closes its hidden window.
    #[serde(skip)]
    drop_hidden: Option<u32>,
    /// Left Shift was tapped for capture `id`'s notification (F16, `--shift-tap=<id>` from the
    /// watcher process): opens it as the click does.
    #[serde(skip)]
    shift_tap: Option<u32>,
    /// A build for an update started or finished (`--update-check`, sent by `dev-update.mjs`):
    /// every window checks for updates now, so its spinner or ready icon shows at once.
    #[serde(skip)]
    update_check: bool,
    /// This run restarted into a new version (F6): "quiet" brings the windows back without the
    /// focus and shows no messages, "front" brings them back as usual. The window shows itself
    /// once it has reopened its picture, so it can go back where it was first.
    #[serde(default)]
    restart: Option<String>,
}

fn launch_from_args(args: &[String], cwd: &Path) -> Launch {
    let mut launch = Launch::default();
    for a in args.iter().skip(1) {
        if a == "--paste" {
            launch.paste = true;
        } else if a == "--capture" {
            launch.capturing = true;
        } else if let Some(f) = a.strip_prefix("--open-capture=") {
            launch.capture_file = Some(PathBuf::from(f));
        } else if a == "--from-note" {
            launch.quick = true;
        } else if let Some(id) = a.strip_prefix("--hidden=") {
            launch.hidden_note = id.parse().ok();
        } else if let Some(id) = a.strip_prefix("--reveal=") {
            launch.reveal = id.parse().ok();
        } else if let Some(id) = a.strip_prefix("--drop-hidden=") {
            launch.drop_hidden = id.parse().ok();
        } else if let Some(id) = a.strip_prefix("--shift-tap=") {
            launch.shift_tap = id.parse().ok();
        } else if a == "--update-check" {
            launch.update_check = true;
        } else if !a.starts_with('-') && launch.file.is_none() {
            let p = PathBuf::from(a);
            launch.file = Some(if p.is_absolute() { p } else { cwd.join(p) }.to_string_lossy().into_owned());
        }
    }
    launch
}

/// Launches waiting for their window's page to ask for them.
#[derive(Default)]
struct Launches(Mutex<HashMap<String, Launch>>);

/// The window used last, which gets files opened while Sketch is running.
struct LastFocused(Mutex<String>);

#[tauri::command]
fn launch_info(window: WebviewWindow, launches: tauri::State<Launches>) -> Launch {
    launches.0.lock().unwrap().remove(window.label()).unwrap_or_default()
}

fn apply_mica(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    return window_vibrancy::apply_mica(window, None).is_ok();
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// A new window, set up like the first one. It shows itself once its page has drawn.
fn new_window(app: &AppHandle, launch: Launch) -> Result<(), String> {
    static NEXT: AtomicU32 = AtomicU32::new(2);
    let label = format!("w{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let hidden_note = launch.hidden_note;
    app.state::<Launches>().0.lock().unwrap().insert(label.clone(), launch);
    let replaced = hidden_note.and_then(|note| prepare_hidden(app, &label, note));
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Untitled - Sketch")
        .inner_size(1280.0, 820.0)
        .min_inner_size(640.0, 420.0)
        .visible(false)
        .transparent(true)
        .build()
        .map_err(|e| e.to_string())?;
    apply_mica(&window);
    place::apply(&window);
    let w = window.clone();
    let _ = window.run_on_main_thread(move || set_relaunch(&w));
    // Closed only now the new window exists, so Sketch doesn't quit for having no windows.
    if let Some(old) = replaced {
        let _ = old.tx.send(false);
    }
    Ok(())
}

/// A taskbar pin made from the window starts the launcher, not this version's folder (F6.1).
fn set_relaunch(window: &WebviewWindow) {
    if let Ok(h) = window.hwnd() {
        layout::set_relaunch(h.0 as isize);
    }
}

/// Async: building a window inside a synchronous command deadlocks on Windows.
#[tauri::command]
async fn open_window(app: AppHandle, launch: Launch) -> Result<(), String> {
    new_window(&app, launch)
}

/// A later launch (a file opened from Explorer, the paste shortcut): the window used last decides
/// whether it opens in a new window or in itself.
fn on_second_launch(app: &AppHandle, message: instance::Message) {
    let mut launch = launch_from_args(&message.args, Path::new(&message.cwd));
    if launch.update_check {
        let _ = app.emit("update-check", ());
        return;
    }
    if let Some(id) = launch.shift_tap {
        // Waits for the notification if the tap beat it, so off the main thread.
        std::thread::spawn(move || note::click_soon(id));
        return;
    }
    if let Some(note) = launch.drop_hidden {
        end_hidden(app, |h| h.note == note, false);
        return;
    }
    if let Some(note) = launch.reveal {
        if end_hidden(app, |h| h.note == note, true) {
            // The hidden window already has the picture; the helper's copy can go.
            if let Some(file) = &launch.capture_file {
                let _ = fs::remove_file(file);
            }
            return;
        }
    }
    if launch.hidden_note.is_some() {
        // A running Sketch takes captures when they're clicked, as before; only a hidden window
        // waiting for an older capture is replaced by one with this capture.
        if !hidden_waiting(app) {
            return;
        }
        let Some(shot) = launch.capture_file.take().as_deref().and_then(helper::read_shot) else { return };
        launch.capture = Some(store_shot(app, shot));
        launch.hidden = true;
        let _ = new_window(app, launch);
        return;
    }
    if let Some(file) = launch.capture_file.take() {
        if let Some(shot) = helper::take_shot(&file) {
            launch.capture = Some(store_shot(app, shot));
        }
    }
    if launch.capturing {
        // Sketch is hidden first only when the shortcut was pressed in it.
        start_capture(app, capture::sketch_in_front());
        return;
    }
    deliver(app, launch);
}

/// Hands a launch to the window used last, or to a new window when none is open. Hidden windows are
/// passed over: a window the capture shortcut started is waiting for its own capture.
fn deliver(app: &AppHandle, launch: Launch) {
    let label = app.state::<LastFocused>().0.lock().unwrap().clone();
    let shown = |w: &WebviewWindow| w.is_visible().unwrap_or(false);
    let target = app.get_webview_window(&label).filter(shown).or_else(|| app.webview_windows().into_values().find(shown));
    match target {
        Some(w) => {
            let _ = w.emit_to(w.label(), "launch", launch);
        }
        None => {
            let _ = new_window(app, launch);
        }
    }
}

// ---------- Screen capture ----------

/// Captures waiting for a window to open them.
#[derive(Default)]
struct Shots(Mutex<HashMap<u32, capture::Shot>>);

/// The capture a cold start (the capture shortcut with Sketch closed) began before Tauri started,
/// and whether it's opened by a click on its notification.
struct ColdCapture(Mutex<Option<mpsc::Receiver<Option<(capture::Shot, bool)>>>>);

/// How long a cold start waits for its notification to be clicked before Sketch quits and takes it
/// away. Nothing shows meanwhile; Sketch only waits, hidden.
const COLD_NOTE_WAIT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// The id of the capture a cold start began, for its notification. Captures stored later start at 1.
const COLD_NOTE: u32 = 0;

pub(crate) fn copy_shot(shot: &capture::Shot) {
    let _ = clip::set_image(shot.width as usize, shot.height as usize, &shot.rgba);
}

fn next_shot_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Whether a capture is waiting for its notification to be clicked, which a restart would lose.
pub(crate) fn captures_waiting(app: &AppHandle) -> bool {
    !app.state::<Shots>().0.lock().unwrap().is_empty()
}

fn store_shot(app: &AppHandle, shot: capture::Shot) -> u32 {
    let id = next_shot_id();
    app.state::<Shots>().0.lock().unwrap().insert(id, shot);
    id
}

/// Freezes the screen and lets the user pick, on a thread of its own. `hide` hides Sketch's windows
/// first, so they're never in the picture, when "Hide Sketch when capturing" is on. The capture goes
/// on the clipboard, and a notification opens it like a paste when clicked.
fn start_capture(app: &AppHandle, hide: bool) {
    if !capture::begin() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let dir = data_dir(&app);
        let hidden: Vec<WebviewWindow> = if hide && helper::load(&dir).hide {
            app.webview_windows().into_values().filter(|w| w.is_visible().unwrap_or(false)).collect()
        } else {
            Vec::new()
        };
        let handle = |w: &WebviewWindow| w.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        for w in &hidden {
            capture::set_fade(handle(w), false);
            let _ = w.hide();
        }
        // Asking goes through the same queue as hiding, so the answer means the windows are hidden.
        for w in &hidden {
            let _ = w.is_visible();
        }
        if !hidden.is_empty() {
            capture::wait_for_screen();
        }
        let shot = capture::pick();
        capture::end();
        let settings = helper::load(&dir);
        let id = next_shot_id();
        // F16: a tap of Left Shift opens it as the notification's click does. Listening starts now,
        // before Sketch's windows come back (a few hundred ms), so the whole second counts, and in
        // another process, since Sketch's own hook doesn't hear keys going to its windows.
        if shot.is_some() && settings.after == helper::After::Notify && settings.shift_open {
            shift_tap::watch_elsewhere(id);
        }
        for w in &hidden {
            let _ = w.show();
            capture::set_fade(handle(w), true);
        }
        let label = app.state::<LastFocused>().0.lock().unwrap().clone();
        if let Some(w) = hidden.iter().find(|w| w.label() == label) {
            let _ = w.set_focus();
        }
        if let Some(shot) = shot {
            copy_shot(&shot);
            // `quick`: opened by a click on the notification, so closing it won't ask.
            let open = {
                let app = app.clone();
                move |quick: bool| {
                    let h = app.clone();
                    let _ = app.run_on_main_thread(move || deliver(&h, Launch { capture: Some(id), quick, ..Default::default() }));
                }
            };
            if settings.after == helper::After::Open {
                app.state::<Shots>().0.lock().unwrap().insert(id, shot);
                return open(false);
            }
            let shots = app.clone();
            let clicked = open.clone();
            let shown = note::show(&dir, id, &shot, move |event| match event {
                note::Event::Clicked => clicked(true),
                note::Event::Closed => {
                    shots.state::<Shots>().0.lock().unwrap().remove(&id);
                }
            });
            app.state::<Shots>().0.lock().unwrap().insert(id, shot);
            if shown {
                note::close_older(id);
            } else {
                open(false);
            }
        }
    });
}

/// Capture Screen in the menu, the toolbar or the command palette.
#[tauri::command]
fn capture_screen(app: AppHandle) {
    start_capture(&app, true);
}

/// The capture a window started by the capture shortcut opens.
#[derive(Serialize)]
struct Waited {
    id: u32,
    /// Opened by a click on its notification, so closing it doesn't ask about saving.
    quick: bool,
}

/// For a window started by the capture shortcut: waits for the user to pick and click the capture's
/// notification, then gives the capture's id. Cancelling, or a notification that's dismissed or never
/// clicked, quits Sketch, since nothing else was asked for; if windows were opened meanwhile, only
/// this one closes. None when no capture was started.
#[tauri::command]
async fn capture_wait(app: AppHandle, window: WebviewWindow) -> Option<Waited> {
    let rx = app.state::<ColdCapture>().0.lock().unwrap().take()?;
    let shot = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten()).await.ok().flatten();
    match shot {
        Some((shot, quick)) => Some(Waited { id: store_shot(&app, shot), quick }),
        None => {
            close_unshown(&app, &window);
            // Never answers, so the window doesn't show itself on the way out.
            std::future::pending::<()>().await;
            None
        }
    }
}

/// Closes a window that never showed: Sketch quits, unless other windows were opened meanwhile.
fn close_unshown(app: &AppHandle, window: &WebviewWindow) {
    if app.webview_windows().len() > 1 {
        let _ = window.destroy();
    } else {
        app.exit(0);
    }
}

// ---------- Hidden windows for captures (F12) ----------

/// A window loaded with a capture but kept hidden until the capture's notification is clicked, so
/// the click shows it at once instead of starting Sketch (about 355 ms). There's at most one: a
/// newer capture replaces it.
struct HiddenWindow {
    label: String,
    note: u32,
    /// True shows the window, false (or dropping it) closes it.
    tx: mpsc::Sender<bool>,
}

#[derive(Default)]
struct Prepared {
    current: Mutex<Option<HiddenWindow>>,
    /// The other end of each hidden window's channel, until its page asks for it (`hidden_wait`).
    waits: Mutex<HashMap<String, mpsc::Receiver<bool>>>,
}

/// A hidden window closes by itself after this, or 10 s after its notification's time if that's
/// longer (Windows lets it be up to 5 minutes), in case the helper's word that its notification went
/// never arrives (it went while this Sketch was still starting, say).
const HIDDEN_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Makes window `label` the hidden window for notification `note`. Gives back the hidden window it
/// replaces, for the caller to close once the new one exists.
fn prepare_hidden(app: &AppHandle, label: &str, note: u32) -> Option<HiddenWindow> {
    let (tx, rx) = mpsc::channel();
    let state = app.state::<Prepared>();
    state.waits.lock().unwrap().insert(label.into(), rx);
    let old = state.current.lock().unwrap().replace(HiddenWindow { label: label.into(), note, tx });
    let limit = HIDDEN_LIMIT.max(note::life(&data_dir(app)) + std::time::Duration::from_secs(10));
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(limit);
        end_hidden(&app, |h| h.label == label, false);
    });
    old
}

/// Shows (`show`) or closes the hidden window, if there is one and `which` picks it.
fn end_hidden(app: &AppHandle, which: impl Fn(&HiddenWindow) -> bool, show: bool) -> bool {
    let Some(hidden) = app.state::<Prepared>().current.lock().unwrap().take_if(|h| which(h)) else { return false };
    let _ = hidden.tx.send(show);
    true
}

/// Whether a hidden window is waiting for its notification, which a quiet restart mustn't bring back.
pub(crate) fn hidden_waiting(app: &AppHandle) -> bool {
    app.state::<Prepared>().current.lock().unwrap().is_some()
}

/// For a hidden window: answers true once its notification is clicked. If the notification goes
/// without a click, it never answers, and the window closes (Sketch quits if it was the only one).
/// Other windows get true at once.
#[tauri::command]
async fn hidden_wait(app: AppHandle, window: WebviewWindow) -> bool {
    let Some(rx) = app.state::<Prepared>().waits.lock().unwrap().remove(window.label()) else { return true };
    let show = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false)).await.unwrap_or(false);
    if !show {
        close_unshown(&app, &window);
        std::future::pending::<()>().await;
    }
    true
}

/// A capture as raw RGBA after an 8-byte header holding the width and height (little-endian u32),
/// like `read_clipboard_image`. Empty when there's no capture with that id.
#[tauri::command]
fn capture_take(id: u32, shots: tauri::State<Shots>) -> Response {
    let Some(shot) = shots.0.lock().unwrap().remove(&id) else {
        return Response::new(Vec::new());
    };
    let mut out = Vec::with_capacity(8 + shot.rgba.len());
    out.extend_from_slice(&shot.width.to_le_bytes());
    out.extend_from_slice(&shot.height.to_le_bytes());
    out.extend_from_slice(&shot.rgba);
    Response::new(out)
}

/// What happens after a capture, whether Sketch hides first, whether the capture helper updates
/// Sketch while it's closed, and why the capture keys aren't working.
#[tauri::command]
fn capture_options(app: AppHandle) -> helper::Options {
    helper::options(&data_dir(&app))
}

/// Changes the capture helper's settings given; the rest stay as they are.
#[tauri::command]
async fn capture_options_set(app: AppHandle, after: Option<helper::After>, hide: Option<bool>, shift_open: Option<bool>, updates: Option<bool>) -> Result<(), String> {
    let dir = data_dir(&app);
    tauri::async_runtime::spawn_blocking(move || helper::set_options(&dir, after, hide, shift_open, updates)).await.map_err(|e| e.to_string())?
}

/// Windows Settings' keyboard page, where Windows' own use of Print Screen is turned off.
#[tauri::command]
fn open_keyboard_settings() {
    helper::open_keyboard_settings();
}

/// For checks: acts as if the newest capture notification was clicked. False when there's none.
#[tauri::command]
fn capture_click_note() -> bool {
    test_hooks() && note::click_newest()
}

/// Brings a window to the front when a launch opens in it.
#[tauri::command]
fn bring_to_front(window: WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// True when a check started the app: the page then exposes its state for the check to read.
#[tauri::command]
fn test_hooks() -> bool {
    std::env::var("SKETCH_TEST_HOOKS").is_ok_and(|v| v == "1")
}

/// Whether the window got the Windows 11 Mica background (false on Windows 10).
struct Mica(bool);

#[tauri::command]
fn mica_enabled(mica: tauri::State<Mica>) -> bool {
    mica.0
}

/// Called after the first frame. For the start-up check, writes the probe file and quits.
#[tauri::command]
fn app_ready(app: tauri::AppHandle) {
    if let Ok(path) = std::env::var("SKETCH_STARTUP_PROBE") {
        let _ = fs::write(path, "ready");
        app.exit(0);
    }
}

pub fn run() {
    capture::dpi_aware();
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    // The instance key is the data folder, worked out before Tauri starts: the default one is
    // where Tauri will put it.
    let key = default_data_dir();
    let message = instance::Message { args: args.clone(), cwd: cwd.to_string_lossy().into_owned() };
    let server = match instance::claim(&key.to_string_lossy(), &message) {
        instance::Claim::Forwarded => return,
        instance::Claim::First(server) => server,
    };
    shell::set_app_id();
    // 1.5.0: a new data folder gets the default capture keys, before Tauri and WebView2 write
    // anything there and before the page asks for the keys. It's a millisecond, on the first start only.
    if helper::is_new(&key) {
        helper::claim_defaults(&key);
    }
    let mut first_launch = launch_from_args(&args, &cwd);
    // The capture shortcut with Sketch closed: freeze the screen now, before Tauri and the webview
    // start, so the picture is the moment the keys were pressed.
    let cold = (first_launch.capturing && capture::begin()).then(|| {
        let (tx, rx) = mpsc::channel();
        let dir = key.clone();
        std::thread::spawn(move || {
            let shot = capture::pick();
            capture::end();
            let shot = shot.and_then(|shot| {
                let settings = helper::load(&dir);
                // F16: listening starts before the clipboard and the notification, so a quick tap
                // isn't missed; one that beats the notification waits for it (`note::click_soon`).
                if settings.after == helper::After::Notify && settings.shift_open {
                    shift_tap::watch_elsewhere(COLD_NOTE);
                }
                copy_shot(&shot);
                if settings.after == helper::After::Open {
                    return Some((shot, false));
                }
                let (events, event) = mpsc::channel();
                if !note::show(&dir, COLD_NOTE, &shot, move |e| {
                    let _ = events.send(e);
                }) {
                    return Some((shot, false));
                }
                match event.recv_timeout(COLD_NOTE_WAIT) {
                    Ok(note::Event::Clicked) => Some((shot, true)),
                    Ok(note::Event::Closed) => None,
                    Err(_) => {
                        note::close(COLD_NOTE);
                        None
                    }
                }
            });
            let _ = tx.send(shot);
        });
        rx
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // The window is transparent so Mica can show through the page's see-through parts.
            // Where Mica isn't available the page keeps solid colours, so nothing shows through.
            let mica = app.get_webview_window("main").map(|w| apply_mica(&w)).unwrap_or(false);
            app.manage(Mica(mica));
            place::init(app.handle());
            if let Some(w) = app.get_webview_window("main") {
                place::apply(&w);
                set_relaunch(&w);
            }
            app.manage(Shots::default());
            app.manage(Prepared::default());
            if let Some(file) = first_launch.capture_file.take() {
                // A hidden start leaves the helper's file, which it deletes if the click never comes.
                let shot = if first_launch.hidden_note.is_some() { helper::read_shot(&file) } else { helper::take_shot(&file) };
                if let Some(shot) = shot {
                    first_launch.capture = Some(store_shot(app.handle(), shot));
                }
            }
            if let Some(note) = first_launch.hidden_note {
                first_launch.hidden = true;
                prepare_hidden(app.handle(), "main", note);
            }
            recovery::init(app.handle());
            update::init(app.handle());
            first_launch.restart = app.state::<update::Restored>().mode.map(String::from);
            let launches = Launches::default();
            launches.0.lock().unwrap().insert("main".into(), first_launch);
            app.manage(launches);
            app.manage(LastFocused(Mutex::new("main".into())));
            app.manage(ColdCapture(Mutex::new(cold)));
            mouse::init(app.handle());
            helper::init(data_dir(app.handle()), shell::capture_shortcut_keys);
            let handle = app.handle().clone();
            server.serve(move |message| {
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || on_second_launch(&h, message));
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) => *window.state::<LastFocused>().0.lock().unwrap() = window.label().to_string(),
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => place::track(window),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            copy_png,
            clipboard_file_paths,
            clipboard_seq,
            read_clipboard_image,
            read_clipboard_text,
            mica_enabled,
            fetch_url,
            launch_info,
            open_window,
            bring_to_front,
            test_hooks,
            app_ready,
            capture_screen,
            capture_wait,
            hidden_wait,
            capture_take,
            capture_click_note,
            capture_options,
            capture_options_set,
            open_keyboard_settings,
            place::show_window,
            shell::add_recent,
            shell::set_shortcut,
            shell::shortcut,
            recovery::recovery_orphans,
            recovery::recovery_slot,
            recovery::recovery_claim,
            recovery::recovery_read,
            recovery::recovery_write,
            recovery::recovery_meta,
            recovery::recovery_delete,
            update::update_status,
            update::update_restart,
            layout::test_relaunch_command,
            update::update_window_saved,
            update::update_start_note,
            mouse::mouse_speed_set,
            mouse::mouse_ctrl,
            mouse::mouse_speed_force,
            cutout::cutout_ready,
            cutout::cutout_install,
            cutout::cutout_cancel,
            cutout::cutout_mask
        ])
        .build(tauri::generate_context!())
        .expect("error while running Sketch")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                place::save(app);
                mouse::shutdown();
                note::close_all();
            }
        });
}

/// `sketch-capture.exe`: holds the capture keys and captures while Sketch is closed (`helper.rs`).
pub fn capture_helper() {
    helper::main()
}
