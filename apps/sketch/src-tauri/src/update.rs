//! In-app updates (F6, Silent Updates). The app watches `origin/main` of the repo it was built from
//! (the build stamp's `repo`) for new commits that change Sketch's folder in it (the stamp's `path`,
//! so it works wherever the folder sits), builds each one in its own git worktree (never the shared
//! project folder), and the build script stages it as a new version folder beside the
//! running one in the install folder (`layout.rs`), with `current.json` naming it. Nothing is
//! installed: the next start of Sketch opens the new version. A Sketch left open restarts into it
//! when nobody is using the PC (the quiet restart), or straight away from Restart to Update.
//!
//! Files, in the data folder: `build/sketch-update-build` (the worktree), `build/build.lock` (a
//! build is running; the build script touches it every few seconds), `build/last-error.json` (the
//! commit whose build failed, so it isn't retried until the next push), `build/build.log`, and
//! `restart.json` (the windows' places, from a restart to the new Sketch that starts after it).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::layout::{self, LAUNCHER_EXE};
use crate::shell::quiet;
use crate::{data_dir, data_dir_override};

const WORKTREE: &str = "sketch-update-build";
/// A build whose lock hasn't been touched for this long has died.
const LOCK_STALE: Duration = Duration::from_secs(90);
/// How long a quiet restart waits with no keyboard or mouse input (or a locked screen).
/// `SKETCH_IDLE_SECONDS` shortens it for checks.
const QUIET_IDLE_SECONDS: u64 = 300;
/// How long a restart waits for every window to save itself.
const SAVE_LIMIT: Duration = Duration::from_secs(8);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    commit: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// A newer version staged and waiting for Sketch to restart.
    ready: Option<Ready>,
    /// The commit being built, if a build of a newer commit is running.
    building: Option<String>,
}

/// One window's answer to `update-prepare`.
struct Reply {
    slot: Option<String>,
    busy: bool,
}

#[derive(Default)]
pub struct Updater {
    /// The commit of the staged version, while one is ready (for the quiet restart).
    ready: Mutex<Option<String>>,
    /// Set from the moment a restart starts asking windows to save.
    restarting: Mutex<Option<Restarting>>,
    note_given: Mutex<bool>,
}

struct Restarting {
    quiet: bool,
    /// Windows that haven't answered yet.
    waiting: Vec<String>,
    replies: HashMap<String, Reply>,
}

fn build_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("build")
}

/// The repo to watch. Checks point this at a throwaway clone.
fn repo_for(stamped: &str) -> PathBuf {
    PathBuf::from(std::env::var("SKETCH_UPDATE_REPO").unwrap_or_else(|_| stamped.to_string()))
}

fn watched_ref() -> String {
    std::env::var("SKETCH_UPDATE_REF").unwrap_or_else(|_| "refs/remotes/origin/main".into())
}

/// What `git rev-list -- <path>` and friends take for Sketch's folder: `.` when it's the repo's root.
fn pathspec(path: &str) -> &str {
    if path.is_empty() { "." } else { path }
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = quiet("git").arg("-C").arg(repo).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn is_ancestor(repo: &Path, older: &str, newer: &str) -> bool {
    quiet("git")
        .arg("-C")
        .arg(repo)
        .args(["merge-base", "--is-ancestor", older, newer])
        .status()
        .is_ok_and(|s| s.success())
}

/// True when `candidate` is a newer Sketch than `running`.
fn is_newer(repo: &Path, running: &str, candidate: &str) -> bool {
    if candidate == running || is_ancestor(repo, candidate, running) {
        return false;
    }
    // Usually `running` comes before it. If git doesn't know the running commit (a build from a
    // commit that was rewritten), any other commit counts as newer.
    true
}

/// The version current.json names, when its folder is complete: both programs and its stamp.
fn staged(root: &Path) -> Option<(layout::Current, PathBuf)> {
    let current = layout::current(root)?;
    let folder = root.join(&current.folder);
    let complete = current.folder.starts_with("app-")
        && !current.commit.is_empty()
        && folder.join(LAUNCHER_EXE).is_file()
        && folder.join("sketch-capture.exe").is_file()
        && folder.join("version.json").is_file();
    complete.then_some((current, folder))
}

fn lock_alive(lock: &Path) -> bool {
    fs::metadata(lock)
        .and_then(|m| m.modified())
        .is_ok_and(|t| SystemTime::now().duration_since(t).unwrap_or_default() < LOCK_STALE)
}

fn building(app: &AppHandle) -> Option<String> {
    let lock = build_dir(app).join("build.lock");
    if !lock_alive(&lock) {
        return None;
    }
    let text = fs::read_to_string(lock).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["commit"].as_str().map(String::from)
}

fn failed_commit(app: &AppHandle) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&fs::read(build_dir(app).join("last-error.json")).ok()?).ok()?;
    v["commit"].as_str().map(String::from)
}

/// True when the folder is a worktree of `repo`. One made for another clone (Sketch was reinstalled
/// from a clone somewhere else, or its folder moved to another repo) can't check out this repo's
/// commits, so it's made again.
fn worktree_of(src: &Path, repo: &Path) -> bool {
    let common = |dir: &Path| git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map(|c| c.to_lowercase().replace('\\', "/"));
    src.join(".git").exists() && common(src).is_some() && common(src) == common(repo)
}

/// Checks out `commit` in the build worktree and starts the build script there in the background,
/// from Sketch's folder in it (`path`). The script stages the build in `root`, the install folder.
fn start_build(app: &AppHandle, repo: &Path, path: &str, commit: &str, root: &Path) -> Result<(), String> {
    let dir = build_dir(app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let src = dir.join(WORKTREE);
    let run = |cmd: &mut std::process::Command| -> Result<(), String> {
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    };
    if worktree_of(&src, repo) {
        run(quiet("git").arg("-C").arg(&src).args(["checkout", "--detach", "--force", commit]))?;
        // Leftovers from the last build go, but the npm packages and Cargo's build cache stay.
        run(quiet("git").arg("-C").arg(&src).args(["clean", "-fdxq", "-e", "node_modules", "-e", "target"]))?;
    } else {
        let _ = fs::remove_dir_all(&src);
        let _ = run(quiet("git").arg("-C").arg(repo).args(["worktree", "prune"]));
        run(quiet("git").arg("-C").arg(repo).args(["worktree", "add", "--detach", "--force"]).arg(&src).arg(commit))?;
    }
    let log = fs::File::create(dir.join("build.log")).map_err(|e| e.to_string())?;
    let mut cmd = quiet("node");
    cmd.current_dir(src.join(path))
        .arg("scripts/update-build.mjs")
        .arg(commit)
        .arg(data_dir(app).join("updates"))
        .arg(&dir)
        .arg(root)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    // Written before the script starts, so a second check right away doesn't start another build.
    fs::write(dir.join("build.lock"), serde_json::json!({ "commit": commit }).to_string()).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A new group with a console of its own that has no window. Not DETACHED_PROCESS: Windows
        // then ignores CREATE_NO_WINDOW, and every console program the build runs (npm's cmd.exe)
        // opened a terminal window of its own.
        const DETACHED: u32 = 0x0000_0200 | 0x0800_0000;
        const BREAKAWAY: u32 = 0x0100_0000;
        // Out of the app's job, if it has one, so closing Sketch doesn't stop the build.
        cmd.creation_flags(DETACHED | BREAKAWAY);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(DETACHED);
    }
    cmd.spawn().map(|_| ()).map_err(|e| {
        let _ = fs::remove_file(dir.join("build.lock"));
        e.to_string()
    })
}

/// Whether a version is staged and waiting, and whether a newer one is building. Starts a
/// background build when a newer commit is waiting. Only a Sketch running from the install layout
/// updates itself; a dev or test build outside it never builds.
#[tauri::command]
pub async fn update_status(app: AppHandle, state: State<'_, Updater>, repo: String, path: String, commit: String) -> Result<UpdateStatus, String> {
    let Some(root) = layout::install_root() else {
        return Ok(UpdateStatus { ready: None, building: None });
    };
    let handle = app.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let app = handle;
        let repo = repo_for(&repo);
        let latest_pushed = git(&repo, &["rev-list", "-1", &watched_ref(), "--", pathspec(&path)]).filter(|c| !c.is_empty());
        let staged = staged(root);
        let mut running_build = building(&app);
        if let Some(pushed) = &latest_pushed {
            let have = staged.as_ref().is_some_and(|(c, _)| &c.commit == pushed);
            if !have && running_build.is_none() && failed_commit(&app).as_ref() != Some(pushed) && is_newer(&repo, &commit, pushed) {
                match start_build(&app, &repo, &path, pushed, root) {
                    Ok(()) => running_build = Some(pushed.clone()),
                    // Not tried again until the next push, like a failed build.
                    Err(error) => {
                        let note = serde_json::json!({ "commit": pushed, "error": error });
                        let _ = fs::write(build_dir(&app).join("last-error.json"), note.to_string());
                    }
                }
            }
        }
        let ready = staged.filter(|(c, _)| is_newer(&repo, &commit, &c.commit)).map(|(c, folder)| {
            let stamp: serde_json::Value = fs::read(folder.join("version.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let subject = stamp["subject"].as_str().map(String::from).or_else(|| git(&repo, &["log", "-1", "--format=%s", &c.commit])).unwrap_or_default();
            Ready { commit: c.commit, subject }
        });
        // A lock left by a build of this commit or an older one isn't an update on its way.
        let building = running_build.filter(|b| is_newer(&repo, &commit, b));
        UpdateStatus { ready, building }
    })
    .await
    .map_err(|e| e.to_string())?;
    *state.ready.lock().unwrap() = status.ready.as_ref().map(|r| r.commit.clone());
    Ok(status)
}

// ---------- Restarting into the new version ----------

/// Restart to Update: every window saves itself, then Sketch restarts into the staged version with
/// its windows back in front.
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<(), String> {
    begin_restart(&app, false)
}

/// Asks every window to save itself for recovery (`update-prepare`). Windows answer with
/// `update_window_saved`; a quiet restart is called off if any of them is busy.
fn begin_restart(app: &AppHandle, quiet: bool) -> Result<(), String> {
    layout::install_root().ok_or("This Sketch isn't installed, so it can't restart into an update.")?;
    let state = app.state::<Updater>();
    if state.ready.lock().unwrap().is_none() {
        return Err("No update is ready yet.".into());
    }
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    {
        let mut restarting = state.restarting.lock().unwrap();
        if restarting.is_some() {
            return Ok(());
        }
        *restarting = Some(Restarting { quiet, waiting: labels, replies: HashMap::new() });
    }
    app.emit("update-prepare", serde_json::json!({ "quiet": quiet })).map_err(|e| e.to_string())?;
    // A window that doesn't answer (a stuck page) mustn't block the restart for ever.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_LIMIT);
        let taken = handle.state::<Updater>().restarting.lock().unwrap().take();
        if let Some(r) = taken {
            finish(&handle, r);
        }
    });
    Ok(())
}

/// A window has saved itself (`slot` is its autosave slot), or says it's busy (a dialog is open or
/// it's in the middle of something), which calls a quiet restart off.
#[tauri::command]
pub fn update_window_saved(app: AppHandle, window: WebviewWindow, state: State<Updater>, slot: Option<String>, busy: bool) {
    let mut restarting = state.restarting.lock().unwrap();
    let Some(r) = restarting.as_mut() else { return };
    r.waiting.retain(|l| l != window.label());
    r.replies.insert(window.label().to_string(), Reply { slot, busy });
    if r.waiting.is_empty() {
        let r = restarting.take().unwrap();
        drop(restarting);
        finish(&app, r);
    }
}

fn finish(app: &AppHandle, r: Restarting) {
    if r.quiet && r.replies.values().any(|reply| reply.busy) {
        return;
    }
    // Each window's place, so the new Sketch puts it back where it was.
    let windows: Vec<Placed> = app
        .webview_windows()
        .values()
        .filter_map(|w| {
            let slot = r.replies.get(w.label())?.slot.clone()?;
            let place = crate::place::window_place(w)?;
            Some(Placed { slot, place })
        })
        .collect();
    let note = RestartFile { quiet: r.quiet, windows };
    let _ = crate::write_atomic(&data_dir(app).join("restart.json"), &serde_json::to_vec(&note).unwrap_or_default());
    match start_launcher(r.quiet) {
        Ok(()) => app.exit(0),
        Err(e) => {
            let _ = fs::remove_file(data_dir(app).join("restart.json"));
            if !r.quiet {
                let _ = app.emit("update-failed", format!("Sketch couldn't restart: {e}"));
            }
        }
    }
}

/// Starts the launcher, which waits for this Sketch to close and opens the staged version. The
/// launcher is a windowed program: the hand-off starts no console program, which would open a
/// terminal window from a process that has no console.
fn start_launcher(quiet_restore: bool) -> Result<(), String> {
    let root = layout::install_root().ok_or("not installed")?;
    let mut cmd = std::process::Command::new(root.join(LAUNCHER_EXE));
    cmd.arg("--wait-pid").arg(std::process::id().to_string());
    cmd.arg(if quiet_restore { "--quiet-restore" } else { "--restart" });
    if let Some(dir) = data_dir_override() {
        cmd.arg(format!("--data-dir={}", dir.to_string_lossy()));
    }
    // The install folder, never a version folder, which a working folder would keep from being deleted.
    cmd.current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Out of the app's job, if it has one, so it outlives Sketch.
        cmd.creation_flags(0x0100_0000);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(0);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------- The quiet restart ----------

/// `SKETCH_IDLE_SECONDS`, or for checks (test hooks) `idle-seconds.txt` in their data folder, read
/// each time so a check can hold the quiet restart back until it's ready for it.
fn idle_limit() -> u64 {
    let from_file = || {
        let dir = data_dir_override().filter(|_| std::env::var("SKETCH_TEST_HOOKS").is_ok_and(|v| v == "1"))?;
        fs::read_to_string(dir.join("idle-seconds.txt")).ok()?.trim().parse().ok()
    };
    from_file()
        .or_else(|| std::env::var("SKETCH_IDLE_SECONDS").ok().and_then(|s| s.parse().ok()))
        .filter(|&s| s > 0)
        .unwrap_or(QUIET_IDLE_SECONDS)
}

/// Whether now is the moment for a quiet restart: a version is staged, no Sketch window has the
/// focus, no capture or file dialog is open and no capture waits for its notification, and nobody
/// has touched the keyboard or mouse for a while (or the screen is locked). The windows still get
/// the last word (`update-prepare`): one with a dialog open or something half done says it's busy.
fn quiet_moment(app: &AppHandle) -> bool {
    let state = app.state::<Updater>();
    if state.ready.lock().unwrap().is_none() || state.restarting.lock().unwrap().is_some() {
        return false;
    }
    if crate::capture::sketch_in_front() || crate::capture::busy() || crate::captures_waiting(app) || crate::hidden_waiting(app) {
        return false;
    }
    #[cfg(windows)]
    {
        if imp::dialog_open() {
            return false;
        }
        imp::screen_locked() || imp::idle_seconds() >= idle_limit()
    }
    #[cfg(not(windows))]
    false
}

#[cfg(windows)]
mod imp {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible};

    pub fn idle_seconds() -> u64 {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe {
            if !GetLastInputInfo(&mut info).as_bool() {
                return 0;
            }
            (GetTickCount().wrapping_sub(info.dwTime) / 1000) as u64
        }
    }

    /// The lock screen runs on another desktop, which this process can't switch to.
    pub fn screen_locked() -> bool {
        unsafe {
            match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) {
                Ok(desk) => {
                    let _ = CloseDesktop(desk);
                    false
                }
                Err(_) => true,
            }
        }
    }

    /// A visible dialog box (the Open and Save dialogs, a message box) belonging to Sketch.
    pub fn dialog_open() -> bool {
        unsafe extern "system" fn each(hwnd: HWND, found: LPARAM) -> BOOL {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == std::process::id() && IsWindowVisible(hwnd).as_bool() {
                let mut class = [0u16; 16];
                let n = GetClassNameW(hwnd, &mut class) as usize;
                if String::from_utf16_lossy(&class[..n]) == "#32770" {
                    *(found.0 as *mut bool) = true;
                    return BOOL(0);
                }
            }
            BOOL(1)
        }
        let mut found = false;
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut bool as isize));
        }
        found
    }
}

// ---------- After a restart ----------

/// `restart.json`, written by a restart for the Sketch that starts after it.
#[derive(Serialize, Deserialize, Default)]
pub struct RestartFile {
    quiet: bool,
    windows: Vec<Placed>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Placed {
    slot: String,
    place: crate::place::WindowPlace,
}

/// What this run brings back after a restart into a new version: each autosave slot's window
/// place, and which window took which slot.
#[derive(Default)]
pub struct Restored {
    /// "quiet" (windows come back without the focus, no messages) or "front"; None for a normal start.
    pub mode: Option<&'static str>,
    order: Vec<String>,
    places: HashMap<String, crate::place::WindowPlace>,
    /// Window label to the slot it reopened.
    taken: Mutex<HashMap<String, String>>,
}

impl Restored {
    /// Slots in the order their windows were in, so the first window gets the first one.
    pub fn rank(&self, slot: &str) -> usize {
        self.order.iter().position(|s| s == slot).unwrap_or(usize::MAX)
    }

    pub fn took(&self, label: &str, slot: &str) {
        if self.places.contains_key(slot) {
            self.taken.lock().unwrap().insert(label.to_string(), slot.to_string());
        }
    }

    pub fn place_for(&self, label: &str) -> Option<crate::place::WindowPlace> {
        let slot = self.taken.lock().unwrap().get(label).cloned()?;
        self.places.get(&slot).copied()
    }
}

/// Reads (and removes) what a restart left, when this run was started by one.
fn restored(app: &AppHandle) -> Restored {
    let args: Vec<String> = std::env::args().collect();
    let mode = if args.iter().any(|a| a == "--quiet-restore") {
        "quiet"
    } else if args.iter().any(|a| a == "--restart") {
        "front"
    } else {
        return Restored::default();
    };
    let path = data_dir(app).join("restart.json");
    let file: RestartFile = fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let _ = fs::remove_file(&path);
    Restored {
        mode: Some(mode),
        order: file.windows.iter().map(|w| w.slot.clone()).collect(),
        places: file.windows.into_iter().map(|w| (w.slot, w.place)).collect(),
        taken: Mutex::new(HashMap::new()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartNote {
    /// The version folder the launcher couldn't start, when it fell back to an older one.
    fallback: Option<String>,
}

/// Once per run: whether the launcher had to start an older version than the newest.
#[tauri::command]
pub fn update_start_note(state: State<Updater>) -> StartNote {
    let mut given = state.note_given.lock().unwrap();
    if *given {
        return StartNote { fallback: None };
    }
    *given = true;
    let fallback = std::env::args().find_map(|a| a.strip_prefix("--launcher-fallback=").map(String::from));
    StartNote { fallback }
}

/// What the installer-based updates (until F6) left in the data folder.
fn clean_old_updates(app: &AppHandle) {
    let dir = data_dir(app).join("updates");
    let Ok(entries) = fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with("-setup.exe") || ["latest.json", "install.ps1", "install.log", "install-helper.log", "install-error.txt"].contains(&name.as_str()) {
            let _ = fs::remove_file(entry.path());
        }
    }
    let _ = fs::remove_dir(&dir);
    let _ = fs::remove_file(data_dir(app).join("last-run-commit.txt"));
}

pub fn init(app: &AppHandle) {
    app.manage(Updater::default());
    let restored = restored(app);
    app.manage(restored);
    if layout::install_root().is_none() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        clean_old_updates(&handle);
        loop {
            std::thread::sleep(Duration::from_secs(idle_limit().clamp(1, 60)));
            if quiet_moment(&handle) {
                let _ = begin_restart(&handle, true);
            }
        }
    });
}
