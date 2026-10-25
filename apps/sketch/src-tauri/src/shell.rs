//! Fitting into Windows: the taskbar identity, recent files in the jump list, and the keys that
//! paste into Sketch (a Start menu shortcut) or capture the screen (the capture helper, `helper.rs`)
//! from anywhere.

use std::path::PathBuf;
use std::process::Command;

use serde::Deserialize;

use crate::helper::{self, parse_keys};

/// Matches the Start menu shortcut the installer makes, so the taskbar groups the windows under it
/// and the jump list shows Sketch's recent files.
pub const APP_ID: &str = "app.sketch.desktop";

/// Runs a program without flashing a console window.
pub fn quiet(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn set_app_id() {
    #[cfg(windows)]
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(APP_ID));
    }
}

/// Adds a file to Windows' recent files, which the jump list shows.
#[tauri::command]
pub fn add_recent(path: String) {
    // Checks run with their own data folder; their test files stay out of the user's recent files.
    if crate::data_dir_override().is_some() {
        return;
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Shell::{SHAddToRecentDocs, SHARD_PATHW};
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        SHAddToRecentDocs(SHARD_PATHW.0 as u32, Some(wide.as_ptr() as *const _));
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// Keys that work anywhere in Windows, even with Sketch closed. Paste lives on a Start menu
/// shortcut: Windows runs it, which starts Sketch (or hands over to the running one) with its
/// argument. Capture's keys are held by the capture helper; until Oct 2026 they were on a "Capture
/// with Sketch" shortcut too, which Sketch moves to the helper (`capture_shortcut_keys`).
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Shortcut {
    Paste,
    Capture,
}

impl Shortcut {
    fn file(self) -> &'static str {
        match self {
            Shortcut::Paste => "Paste into Sketch.lnk",
            Shortcut::Capture => "Capture with Sketch.lnk",
        }
    }

    fn argument(self) -> &'static str {
        match self {
            Shortcut::Paste => "--paste",
            Shortcut::Capture => "--capture",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Shortcut::Paste => "Opens Sketch with the picture on the clipboard",
            Shortcut::Capture => "Captures part of the screen with Sketch",
        }
    }

    fn path(self) -> Option<PathBuf> {
        let appdata = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs").join(self.file()))
    }
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn powershell(script: &str) -> Result<String, String> {
    let out = quiet("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The keys on a shortcut as Windows reports them ("Alt+Ctrl+S"), or None when there isn't one.
fn read_keys(kind: Shortcut) -> Option<String> {
    let link = kind.path()?;
    if !link.exists() {
        return None;
    }
    let keys = powershell(&format!("(New-Object -ComObject WScript.Shell).CreateShortcut({}).Hotkey", ps_quote(&link.to_string_lossy()))).ok()?;
    (!keys.is_empty()).then_some(keys)
}

/// The keys of the "Capture with Sketch" shortcut Sketch made before the capture helper, if it's
/// still there. Sketch moves them to the helper once (`helper::init`).
pub fn capture_shortcut_keys() -> Option<String> {
    read_keys(Shortcut::Capture)
}

pub fn remove_capture_shortcut() {
    if let Some(link) = Shortcut::Capture.path() {
        let _ = std::fs::remove_file(link);
    }
}

/// Sets, changes or removes the keys for pasting into Sketch or capturing the screen. `keys` is like
/// "Ctrl+Alt+S" (or "PrintScreen" for capture). Keys another app already holds are refused, since
/// Windows would give them to that app and they'd do nothing here.
#[tauri::command]
pub async fn set_shortcut(app: tauri::AppHandle, kind: Shortcut, keys: Option<String>) -> Result<(), String> {
    let dir = crate::data_dir(&app);
    if kind == Shortcut::Capture {
        return tauri::async_runtime::spawn_blocking(move || {
            let paste = read_keys(Shortcut::Paste).and_then(|k| parse_keys(&k));
            helper::set_keys(&dir, keys, paste)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let link = kind.path().ok_or("no Start menu folder")?;
    let Some(keys) = keys else {
        return match std::fs::remove_file(&link) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    };
    let wanted = parse_keys(&keys).filter(|k| k.1 != helper::VK_SNAPSHOT).ok_or_else(|| format!("{keys} can't be a Windows shortcut"))?;
    // The launcher in the install layout, so the shortcut always opens the newest version (F6.1).
    let exe = crate::layout::launcher_exe().ok_or("no exe path")?;
    let script = format!(
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({}); $s.TargetPath = {}; $s.Arguments = {}; $s.Hotkey = {}; $s.Description = {}; $s.Save()",
        ps_quote(&link.to_string_lossy()),
        ps_quote(&exe.to_string_lossy()),
        ps_quote(kind.argument()),
        ps_quote(&keys.to_uppercase()),
        ps_quote(kind.description()),
    );
    tauri::async_runtime::spawn_blocking(move || {
        if helper::load(&dir).keys.and_then(|k| parse_keys(&k)) == Some(wanted) {
            return Err(format!("{keys} already captures the screen. Pick other keys."));
        }
        // Keys this shortcut already has are held by Windows for it, so they'd look taken.
        if read_keys(kind).and_then(|k| parse_keys(&k)) != Some(wanted) && crate::capture::hotkey_taken(wanted.0, wanted.1) {
            return Err(format!("Another app already uses {keys}. Pick other keys."));
        }
        powershell(&script).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The keys for pasting or capturing, or None when there aren't any.
#[tauri::command]
pub async fn shortcut(app: tauri::AppHandle, kind: Shortcut) -> Option<String> {
    if kind == Shortcut::Capture {
        return helper::load(&crate::data_dir(&app)).keys;
    }
    tauri::async_runtime::spawn_blocking(move || read_keys(kind)).await.ok().flatten()
}
