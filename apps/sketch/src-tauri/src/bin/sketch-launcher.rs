//! Sketch's launcher (F6.1), the way Discord and Slack install. The install folder holds this program
//! as `sketch.exe` (so the Start menu, the taskbar pins, Explorer's "Edit with Sketch" and the file
//! types all start it), `current.json` naming the version folder to start, and one
//! `app-<short commit>` folder per version, each holding that build's `sketch.exe`,
//! `sketch-capture.exe` and `version.json`. It starts the version current.json names with the
//! arguments it was given, then deletes version folders other than that one and the one before it,
//! and exits. It opens no window and no console, and uses no crates, so it starts in milliseconds.
//!
//! `--wait-pid N` first waits (up to 2 minutes) for process N to end, so a restart into a new version
//! doesn't hand its launch to the closing Sketch's pipe (`instance.rs`). `--capture-helper` starts the
//! version's capture helper instead of Sketch: the helper's sign-in entry points here, so it always
//! starts the newest one. When current.json names a folder that can't be started, the newest other
//! version starts instead, told so with `--launcher-fallback=<folder>`, and Sketch says so once.

#![windows_subsystem = "windows"]

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn WaitForSingleObject(handle: isize, ms: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

const SYNCHRONIZE: u32 = 0x0010_0000;
/// Started from inside a job (a terminal's, say), Sketch would otherwise end with it.
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
const WAIT_LIMIT_MS: u32 = 120_000;
/// Each version folder's own programs, and the stamp the build wrote beside them.
const APP_EXE: &str = "sketch.exe";
const HELPER_EXE: &str = "sketch-capture.exe";
const STAMP: &str = "version.json";
/// A copy the update build left half done this long ago is abandoned.
const PART_ABANDONED: Duration = Duration::from_secs(3600);

fn wait_for(pid: u32) {
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        // No handle: the process has already ended (or the pid was never there).
        if handle == 0 {
            return;
        }
        WaitForSingleObject(handle, WAIT_LIMIT_MS);
        CloseHandle(handle);
    }
}

/// A top-level string value in one of Sketch's own small JSON files (their values hold no escapes).
fn json_str(text: &str, key: &str) -> Option<String> {
    let at = text.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = text[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// A finished version folder's name: `app-` and no path parts (a half-done copy ends in `.part`).
fn is_version(name: &str) -> bool {
    name.starts_with("app-") && !name.ends_with(".part") && !name.contains(['\\', '/', ':']) && !name.contains("..")
}

/// When a version folder was built, if it holds both programs and a readable stamp.
fn built_at(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(STAMP)).ok()?;
    if !dir.join(APP_EXE).is_file() || !dir.join(HELPER_EXE).is_file() {
        return None;
    }
    Some(json_str(&text, "builtAt").unwrap_or_default())
}

fn start(exe: &Path, args: &[OsString], cwd: &Path) -> bool {
    let run = |flags: u32| Command::new(exe).args(args).current_dir(cwd).creation_flags(flags).spawn().is_ok();
    run(CREATE_BREAKAWAY_FROM_JOB) || run(0)
}

/// Moves a folder aside, then deletes it. A folder with a running program inside can't be moved, so
/// a version in use is never half deleted.
fn remove_folder(root: &Path, path: &Path, name: &str) {
    let trash = root.join(format!(".trash-{name}"));
    if fs::rename(path, &trash).is_ok() {
        let _ = fs::remove_dir_all(&trash);
    }
}

fn clean_up(root: &Path, keep: &HashSet<String>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && is_version(&name) && !keep.contains(&name) {
            remove_folder(root, &path, &name);
        } else if is_dir && name.starts_with(".trash-") {
            let _ = fs::remove_dir_all(&path);
        } else if is_dir && name.starts_with("app-") && name.ends_with(".part") {
            let age = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
            if age.is_some_and(|a| a > PART_ABANDONED) {
                remove_folder(root, &path, &name);
            }
        } else if !is_dir && name.eq_ignore_ascii_case("sketch.exe.old") {
            // The launcher an update build replaced while it ran.
            let _ = fs::remove_file(&path);
        }
    }
}

fn say(text: &str) {
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    unsafe {
        MessageBoxW(0, wide(text).as_ptr(), wide("Sketch").as_ptr(), 0x30);
    }
}

fn main() {
    let mut args: Vec<OsString> = env::args_os().skip(1).collect();
    if let Some(i) = args.iter().position(|a| a == "--wait-pid") {
        if let Some(pid) = args.get(i + 1).and_then(|p| p.to_str()).and_then(|p| p.parse().ok()) {
            wait_for(pid);
        }
        args.drain(i..(i + 2).min(args.len()));
    }
    let helper = args.iter().position(|a| a == "--capture-helper").map(|i| args.remove(i)).is_some();
    let Some(root) = env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) else { return };
    // The caller's working folder, so a relative file name still opens, unless it's inside the
    // install folder: a version folder used as a working folder couldn't be deleted.
    let cwd = env::current_dir().ok().filter(|d| !d.starts_with(&root)).unwrap_or_else(|| root.clone());

    let current = fs::read_to_string(root.join("current.json")).unwrap_or_default();
    let wanted = json_str(&current, "folder").filter(|f| is_version(f));
    let previous = json_str(&current, "previous").filter(|f| is_version(f));

    // The folder current.json names first, then every other version folder, newest build first.
    let mut others: Vec<(String, String)> = fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| is_version(n) && Some(n) != wanted.as_ref())
                .filter_map(|n| built_at(&root.join(&n)).map(|at| (at, n)))
                .collect()
        })
        .unwrap_or_default();
    others.sort_by(|a, b| b.cmp(a));
    let mut order: Vec<String> = Vec::new();
    if let Some(w) = wanted.as_ref().filter(|w| built_at(&root.join(w)).is_some()) {
        order.push(w.clone());
    }
    order.extend(others.into_iter().map(|(_, n)| n));

    let mut started = None;
    for name in order {
        let mut with = args.clone();
        let exe = if helper {
            root.join(&name).join(HELPER_EXE)
        } else {
            if let Some(w) = wanted.as_ref().filter(|w| **w != name) {
                with.push(OsString::from(format!("--launcher-fallback={w}")));
            }
            root.join(&name).join(APP_EXE)
        };
        if start(&exe, &with, &cwd) {
            started = Some(name);
            break;
        }
    }
    if started.is_none() && !helper {
        say("Sketch couldn't find a version of itself to open. Install Sketch again to fix it.");
    }

    let keep: HashSet<String> = [wanted, previous, started].into_iter().flatten().collect();
    clean_up(&root, &keep);
}
