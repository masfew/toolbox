//! Fetching new commits (F16.2). A Sketch built from a clone fetches `origin/main` at start and every
//! 10 minutes, so a commit pushed from any machine reaches it within about 10 minutes and is built as
//! if it had been pushed from here, with no `git pull`. The capture helper does the same while no
//! Sketch window is open (`update::run_in_helper`). Only `origin/main` moves: the checkout, its branch
//! and uncommitted work stay as they are, since updates build in a worktree of their own, and a
//! fork's install follows the fork's `origin`.
//!
//! The git settings are the ones another of the author's apps settled on: no gc or maintenance in the
//! shared clone, a stalled transfer ends after a minute, and git never asks for a sign-in or opens a
//! credential window. A failed fetch (offline, a fork with no saved sign-in) is logged to `build.log`
//! once per run of failures, and the check goes on with the ref it has.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use crate::update::{self, build_dir, git};

/// How often to fetch. `SKETCH_FETCH_SECONDS`, or for checks (test hooks) `fetch-seconds.txt` in
/// their data folder, shortens it, and with it the capture helper's waits and how long `latest.json`
/// is kept (`download.rs`), so checks needn't wait minutes.
const EVERY_SECONDS: u64 = 600;
/// A fetch still running after this is stopped; the next one starts afresh.
const LIMIT: Duration = Duration::from_secs(300);
/// `fetch.lock`, one fetch at a time between Sketch and the helper. Older than this, it's left over.
const LOCK_STALE: Duration = Duration::from_secs(360);
const MAIN: &str = "refs/remotes/origin/main";

pub(crate) fn every() -> Duration {
    let from_file = || {
        let dir = crate::data_dir_override().filter(|_| std::env::var("SKETCH_TEST_HOOKS").is_ok_and(|v| v == "1"))?;
        fs::read_to_string(dir.join("fetch-seconds.txt")).ok()?.trim().parse().ok()
    };
    let seconds = from_file()
        .or_else(|| std::env::var("SKETCH_FETCH_SECONDS").ok().and_then(|s| s.parse().ok()))
        .filter(|&s: &u64| s > 0)
        .unwrap_or(EVERY_SECONDS);
    Duration::from_secs(seconds)
}

/// Takes `fetch.lock`, or None while another process is fetching.
fn claim(dir: &Path) -> Option<PathBuf> {
    let lock = dir.join("fetch.lock");
    for _ in 0..2 {
        if fs::OpenOptions::new().write(true).create_new(true).open(&lock).is_ok() {
            return Some(lock);
        }
        let stale = fs::metadata(&lock).and_then(|m| m.modified()).is_ok_and(|t| SystemTime::now().duration_since(t).unwrap_or_default() > LOCK_STALE);
        if !stale {
            return None;
        }
        let _ = fs::remove_file(&lock);
    }
    None
}

/// Runs one `git fetch` of `origin/main` in `repo`: Ok(true) when it moved.
fn run(dir: &Path, repo: &Path) -> Result<bool, String> {
    let before = git(repo, &["rev-parse", "--verify", "-q", MAIN]);
    let errors = dir.join("fetch-errors.txt");
    let mut cmd = Command::new("git");
    cmd.args(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "-C"])
        .arg(repo)
        .args(["fetch", "--quiet", "--no-tags", "origin", &format!("+refs/heads/main:{MAIN}")])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(fs::File::create(&errors).map_err(|e| e.to_string())?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't run git: {e}"))?;
    let end = Instant::now() + LIMIT;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() > end {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("git fetch took over {} minutes, so it was stopped", LIMIT.as_secs() / 60));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let text = fs::read_to_string(&errors).unwrap_or_default();
    let _ = fs::remove_file(&errors);
    if !status.success() {
        return Err(update::first_line(&text));
    }
    Ok(git(repo, &["rev-parse", "--verify", "-q", MAIN]) != before)
}

/// One fetch, unless another process is fetching: Some(true) when `origin/main` moved.
pub fn fetch(data: &Path, repo: &Path) -> Option<bool> {
    let dir = build_dir(data);
    fs::create_dir_all(&dir).ok()?;
    let lock = claim(&dir)?;
    let result = run(&dir, repo);
    let _ = fs::remove_file(lock);
    let streak = result.as_ref().map(|_| ()).map_err(Clone::clone);
    update::note_streak(data, "fetch", streak, &format!("Couldn't fetch origin/main (tried again every {} minutes)", every().as_secs().div_ceil(60)), "Fetching origin/main works again");
    result.ok()
}

/// Fetches after `first`, then every 10 minutes, on a thread of its own so a slow network never
/// holds up a check. `skip` says when someone else is fetching (the helper skips while Sketch is
/// open). `after` gets whether the fetch moved `origin/main`; Sketch then checks at once, so a build
/// starts within seconds of the fetch. Commits that only touch other folders of the repo move the
/// ref but never start a build (the check looks at Sketch's folder only).
pub fn spawn(data: PathBuf, repo: PathBuf, first: Duration, skip: impl Fn() -> bool + Send + 'static, after: impl Fn(bool) + Send + 'static) {
    // A check pointed at another ref (`SKETCH_UPDATE_REF`) has nothing to fetch.
    if update::watched_ref() != MAIN {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(first);
        loop {
            if !skip() {
                let moved = fetch(&data, &repo).unwrap_or(false);
                after(moved);
            }
            std::thread::sleep(every());
        }
    });
}
