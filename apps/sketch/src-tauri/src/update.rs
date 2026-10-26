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
//!
//! Updates on every machine (F16): an install built from a clone also fetches `origin/main` itself
//! (`fetch.rs`), so commits pushed from other machines reach it, and an install from a release's
//! installer, with no clone, downloads each new release (`download.rs`) and stages it the same way.
//! Which one an install uses is decided once per run from the build stamp (`source`). While no
//! Sketch window is open, the capture helper does the same checks (`run_in_helper`).

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::layout::{self, LAUNCHER_EXE};
use crate::shell::quiet;
use crate::{data_dir, data_dir_override, stamp};

const WORKTREE: &str = "sketch-update-build";
/// A build whose lock hasn't been touched for this long has died.
const LOCK_STALE: Duration = Duration::from_secs(90);
/// How long a quiet restart waits with no keyboard or mouse input (or a locked screen).
/// `SKETCH_IDLE_SECONDS` shortens it for checks.
const QUIET_IDLE_SECONDS: u64 = 300;
/// How long a restart waits for every window to save itself.
const SAVE_LIMIT: Duration = Duration::from_secs(8);
/// The first fetch waits until start-up is over, like the page's first check.
const APP_FIRST_FETCH: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub(crate) commit: String,
    pub(crate) subject: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// A newer version staged and waiting for Sketch to restart.
    pub(crate) ready: Option<Ready>,
    /// The commit being built or downloaded, if a newer one is on its way.
    pub(crate) building: Option<String>,
}

/// Runs when a download a check started has finished, so the windows check again at once.
pub type Notify = Arc<dyn Fn() + Send + Sync>;

/// Where this install's updates come from, decided once per run from the build stamp: its clone
/// (the stamp's repo exists and has an origin), the repo's releases (a release build), or nowhere.
/// Installing the other kind over an install changes it, since the new build's stamp decides.
pub enum Source {
    Clone(PathBuf),
    Release,
    None,
}

pub fn source() -> &'static Source {
    static SOURCE: OnceLock<Source> = OnceLock::new();
    SOURCE.get_or_init(|| {
        let s = stamp::get();
        let repo = repo_for(&s.repo);
        // `git -C ""` would be the working folder, so an empty repo is never asked.
        if !repo.as_os_str().is_empty() && git(&repo, &["remote", "get-url", "origin"]).is_some() {
            Source::Clone(repo)
        } else if s.channel == "release" && s.releases.starts_with("https://") && s.key.len() == 64 {
            Source::Release
        } else {
            Source::None
        }
    })
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

pub(crate) fn build_dir(data: &Path) -> PathBuf {
    data.join("build")
}

/// The repo to watch. Checks point this at a throwaway clone.
fn repo_for(stamped: &str) -> PathBuf {
    PathBuf::from(std::env::var("SKETCH_UPDATE_REPO").unwrap_or_else(|_| stamped.to_string()))
}

pub(crate) fn watched_ref() -> String {
    std::env::var("SKETCH_UPDATE_REF").unwrap_or_else(|_| "refs/remotes/origin/main".into())
}

/// What `git rev-list -- <path>` and friends take for Sketch's folder: `.` when it's the repo's root.
fn pathspec(path: &str) -> &str {
    if path.is_empty() { "." } else { path }
}

pub(crate) fn git(repo: &Path, args: &[&str]) -> Option<String> {
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
pub(crate) fn staged(root: &Path) -> Option<(layout::Current, PathBuf)> {
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

pub(crate) fn building(data: &Path) -> Option<String> {
    let lock = build_dir(data).join("build.lock");
    if !lock_alive(&lock) {
        return None;
    }
    let text = fs::read_to_string(lock).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["commit"].as_str().map(String::from)
}

/// Takes `build.lock` for a build or download of `commit`, unless a live one holds it. It's created
/// in one step, so Sketch and the capture helper never both start one.
pub(crate) fn claim_lock(dir: &Path, commit: &str) -> bool {
    let lock = dir.join("build.lock");
    for _ in 0..2 {
        match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(mut file) => {
                let _ = file.write_all(serde_json::json!({ "commit": commit }).to_string().as_bytes());
                return true;
            }
            Err(_) if !lock_alive(&lock) => {
                let _ = fs::remove_file(&lock);
            }
            Err(_) => return false,
        }
    }
    false
}

/// Keeps a lock alive while this process works under it (a build script does its own).
pub(crate) fn touch(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

fn failed_commit(data: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&fs::read(build_dir(data).join("last-error.json")).ok()?).ok()?;
    v["commit"].as_str().map(String::from)
}

/// Now as `2026-10-25T21:17:56Z`, like the build script's log lines.
fn iso_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Days since 1970 to a date (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest / 60 % 60, rest % 60)
}

/// Adds a line to the build folder's `build.log`.
pub(crate) fn log(data: &Path, line: &str) {
    let dir = build_dir(data);
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(dir.join("build.log")) {
        let _ = writeln!(file, "[{}] {line}", iso_now());
    }
}

/// Logs a failure (`Err`) once per run of failures, and once more when it works again (`Ok`), so an
/// offline PC doesn't fill the log. `<name>-failing` in the build folder remembers the run, across
/// Sketch and the capture helper. The app shows nothing either way.
pub(crate) fn note_streak(data: &Path, name: &str, result: Result<(), String>, failed: &str, works: &str) {
    let marker = build_dir(data).join(format!("{name}-failing"));
    match result {
        Err(error) if !marker.exists() => {
            let _ = fs::create_dir_all(build_dir(data));
            let _ = fs::write(&marker, &error);
            log(data, &format!("{failed}: {error}"));
        }
        Ok(()) if marker.exists() => {
            let _ = fs::remove_file(&marker);
            log(data, works);
        }
        _ => {}
    }
}

/// The first line of a program's error output, short enough for one log line.
pub(crate) fn first_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no message");
    line.chars().take(200).collect()
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
fn start_build(data: &Path, repo: &Path, path: &str, commit: &str, root: &Path) -> Result<(), String> {
    let dir = build_dir(data);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Taken first, so a second check right away (or the capture helper's) doesn't start another build.
    if !claim_lock(&dir, commit) {
        return Ok(());
    }
    let started = spawn_build(data, &dir, repo, path, commit, root);
    if started.is_err() {
        let _ = fs::remove_file(dir.join("build.lock"));
    }
    started
}

fn spawn_build(data: &Path, dir: &Path, repo: &Path, path: &str, commit: &str, root: &Path) -> Result<(), String> {
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
        .arg(data.join("updates"))
        .arg(dir)
        .arg(root)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
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
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// One check: whether a version is staged and waiting, and whether a newer one is on its way.
/// Starts a background build (an install from a clone) or download (from a release) when a newer
/// version is waiting; `done` runs when a download it starts has finished. Sketch runs it for its
/// windows (`update_status`), and the capture helper while no window is open.
pub fn check(data: &Path, root: &Path, done: Notify) -> UpdateStatus {
    match source() {
        Source::Clone(repo) => check_clone(data, root, repo),
        Source::Release => crate::download::check(data, root, done),
        Source::None => UpdateStatus::default(),
    }
}

fn check_clone(data: &Path, root: &Path, repo: &Path) -> UpdateStatus {
    let me = stamp::get();
    let (commit, path) = (me.commit.as_str(), me.path.as_str());
    let latest_pushed = git(repo, &["rev-list", "-1", &watched_ref(), "--", pathspec(path)]).filter(|c| !c.is_empty());
    let staged = staged(root);
    let mut running_build = building(data);
    if let Some(pushed) = &latest_pushed {
        let have = staged.as_ref().is_some_and(|(c, _)| &c.commit == pushed);
        if !have && running_build.is_none() && failed_commit(data).as_ref() != Some(pushed) && is_newer(repo, commit, pushed) {
            match start_build(data, repo, path, pushed, root) {
                Ok(()) => running_build = building(data).or(Some(pushed.clone())),
                // Not tried again until the next push, like a failed build.
                Err(error) => {
                    let note = serde_json::json!({ "commit": pushed, "error": error });
                    let _ = fs::write(build_dir(data).join("last-error.json"), note.to_string());
                }
            }
        }
    }
    let ready = staged.filter(|(c, _)| is_newer(repo, commit, &c.commit)).map(|(c, folder)| {
        let stamp: serde_json::Value = fs::read(folder.join("version.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let subject = stamp["subject"].as_str().map(String::from).or_else(|| git(repo, &["log", "-1", "--format=%s", &c.commit])).unwrap_or_default();
        Ready { commit: c.commit, subject }
    });
    // A lock left by a build of this commit or an older one isn't an update on its way.
    let building = running_build.filter(|b| is_newer(repo, commit, b));
    UpdateStatus { ready, building }
}

/// Tells every window to check for updates now (as a build script's message does).
fn nudge(app: &AppHandle) -> Notify {
    let handle = app.clone();
    Arc::new(move || {
        let _ = handle.emit("update-check", ());
    })
}

/// Whether a version is staged and waiting, and whether a newer one is building or downloading.
/// Only a Sketch running from the install layout updates itself; a dev or test build outside it
/// never builds.
#[tauri::command]
pub async fn update_status(app: AppHandle, state: State<'_, Updater>) -> Result<UpdateStatus, String> {
    let Some(root) = layout::install_root() else {
        return Ok(UpdateStatus::default());
    };
    let data = data_dir(&app);
    let done = nudge(&app);
    let status = tauri::async_runtime::spawn_blocking(move || check(&data, root, done)).await.map_err(|e| e.to_string())?;
    *state.ready.lock().unwrap() = status.ready.as_ref().map(|r| r.commit.clone());
    Ok(status)
}

/// What the other kind of install left in the build folder: a release install has no use for a
/// build worktree (its clone may be gone), and a clone install none for a half-done download.
fn tidy(data: &Path) {
    let dir = build_dir(data);
    match source() {
        Source::Clone(_) => {
            let _ = fs::remove_dir_all(dir.join("download"));
        }
        Source::Release => {
            let _ = fs::remove_dir_all(dir.join(WORKTREE));
            let _ = fs::remove_file(dir.join("last-error.json"));
        }
        Source::None => {}
    }
}

/// The capture helper's part (F16): while no Sketch window is open, it fetches (a clone install)
/// and checks for updates itself, so a Sketch closed for days is already up to date when it's next
/// opened. With Sketch open, Sketch does this. The helper and Sketch share `build.lock`, so they
/// never build or download at once.
pub fn run_in_helper(data: PathBuf) {
    let Some(root) = layout::install_root() else { return };
    let key = data.to_string_lossy().into_owned();
    let sketch_open = move || crate::instance::running(&key);
    // A download the helper finishes is news for a Sketch opened meanwhile.
    let ping: Notify = {
        let key = data.to_string_lossy().into_owned();
        Arc::new(move || {
            let message = crate::instance::Message { args: vec!["sketch".into(), "--update-check".into()], cwd: String::new() };
            let _ = crate::instance::send(&key, &message);
        })
    };
    tidy(&data);
    match source() {
        Source::Clone(repo) => {
            let (d, open) = (data.clone(), sketch_open.clone());
            crate::fetch::spawn(data, repo.clone(), HELPER_FIRST.min(crate::fetch::every()), sketch_open, move |_| {
                if !open() {
                    let _ = check(&d, root, ping.clone());
                }
            });
        }
        Source::Release => {
            std::thread::spawn(move || {
                std::thread::sleep(HELPER_FIRST.min(crate::fetch::every()));
                loop {
                    if !sketch_open() {
                        let _ = check(&data, root, ping.clone());
                    }
                    std::thread::sleep(RELEASE_CHECK_EVERY.min(crate::fetch::every()));
                }
            });
        }
        Source::None => {}
    }
}

/// The helper starts with Windows, so its first check waits for sign-in to settle.
const HELPER_FIRST: Duration = Duration::from_secs(60);
/// How often the helper checks for a new release (the page checks as often, and on focus).
const RELEASE_CHECK_EVERY: Duration = Duration::from_secs(300);

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
    let data = data_dir(app);
    tidy(&data);
    if let Source::Clone(repo) = source() {
        let moved = nudge(app);
        crate::fetch::spawn(data, repo.clone(), APP_FIRST_FETCH, || false, move |changed| {
            if changed {
                moved();
            }
        });
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
