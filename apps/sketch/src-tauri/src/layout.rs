//! The install layout (F6.1): `%LOCALAPPDATA%\Sketch` holds the launcher as `sketch.exe`,
//! `current.json` naming the version folder to start, and one `app-<short commit>` folder per version
//! with that build's `sketch.exe` and `sketch-capture.exe` (the launcher is `src/bin/sketch-launcher.rs`).
//! Sketch runs from a version folder, so anything that starts Sketch again later (shortcuts, the
//! capture helper's sign-in entry, taskbar pins) has to point at the launcher instead, or it would
//! keep starting a version that's later deleted.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

/// The launcher's name in the install folder, and each version's own Sketch.
pub const LAUNCHER_EXE: &str = "sketch.exe";

/// The install folder when this Sketch runs from a version folder beside the launcher; None for a
/// dev build, `target\release` or anything else outside the layout, which never updates itself.
pub fn install_root() -> Option<&'static PathBuf> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        root_of(&exe)
    })
    .as_ref()
}

/// The install folder for an exe inside a version folder (`<root>\app-…\<exe>`, with the launcher
/// beside the version folder).
pub fn root_of(exe: &Path) -> Option<PathBuf> {
    let folder = exe.parent()?;
    let name = folder.file_name()?.to_string_lossy();
    if !name.starts_with("app-") || name.ends_with(".part") {
        return None;
    }
    let root = folder.parent()?;
    root.join(LAUNCHER_EXE).is_file().then(|| root.to_path_buf())
}

/// What starts Sketch from outside it: the launcher in the layout, or this exe outside it.
pub fn launcher_exe() -> Option<PathBuf> {
    match install_root() {
        Some(root) => Some(root.join(LAUNCHER_EXE)),
        None => std::env::current_exe().ok(),
    }
}

/// Whether `path` is a Sketch program (not the launcher, which never has a window): this one, or
/// any version's in this install folder.
pub fn is_sketch_exe(path: &Path) -> bool {
    let same = |a: &Path, b: &Path| a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy());
    if std::env::current_exe().is_ok_and(|me| same(path, &me.with_file_name(LAUNCHER_EXE))) {
        return true;
    }
    let (Some(root), Some(theirs)) = (install_root(), root_of(path)) else { return false };
    same(root, &theirs) && path.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(LAUNCHER_EXE))
}

/// `current.json`: the version folder the launcher starts, its commit, and the one before it.
#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct Current {
    pub folder: String,
    pub commit: String,
    pub previous: String,
}

pub fn current(root: &Path) -> Option<Current> {
    let text = std::fs::read(root.join("current.json")).ok()?;
    serde_json::from_slice(&text).ok()
}

/// Sets a window's taskbar identity and its relaunch command (the launcher), so a taskbar pin made
/// from a Sketch window starts the launcher rather than a version folder that will be deleted.
pub fn set_relaunch(hwnd: isize) {
    #[cfg(windows)]
    {
        let Some(root) = install_root() else { return };
        let launcher = root.join(LAUNCHER_EXE).to_string_lossy().into_owned();
        imp::set_relaunch(hwnd, &format!("\"{launcher}\""), &format!("{launcher},0"));
    }
    #[cfg(not(windows))]
    let _ = hwnd;
}

/// For checks (test hooks only): the relaunch command a window carries.
#[tauri::command]
pub fn test_relaunch_command(window: tauri::WebviewWindow) -> Option<String> {
    if !std::env::var("SKETCH_TEST_HOOKS").is_ok_and(|v| v == "1") {
        return None;
    }
    #[cfg(windows)]
    return imp::relaunch_command(window.hwnd().ok()?.0 as isize);
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{HWND, PROPERTYKEY};
    use windows::Win32::Storage::EnhancedStorage::{
        PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand, PKEY_AppUserModel_RelaunchDisplayNameResource, PKEY_AppUserModel_RelaunchIconResource,
    };
    use windows::Win32::System::Com::CoTaskMemAlloc;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};

    fn set(store: &IPropertyStore, key: &PROPERTYKEY, value: &str) {
        // The string must come from CoTaskMemAlloc, as InitPropVariantFromString makes it: the
        // window's store frees it later, and a buffer of Sketch's own crashed Sketch with heap
        // corruption about 2 s after start (only in the install layout, where this runs).
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let mut v = PROPVARIANT::default();
        unsafe {
            let buf = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
            if buf.is_null() {
                return;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), buf, wide.len());
            (*v.Anonymous.Anonymous).vt = VT_LPWSTR;
            (*v.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(buf);
            let _ = store.SetValue(key, &v);
        }
    }

    pub fn relaunch_command(hwnd: isize) -> Option<String> {
        unsafe {
            let store = SHGetPropertyStoreForWindow::<IPropertyStore>(HWND(hwnd as _)).ok()?;
            let v = store.GetValue(&PKEY_AppUserModel_RelaunchCommand).ok()?;
            if v.Anonymous.Anonymous.vt != VT_LPWSTR {
                return None;
            }
            v.Anonymous.Anonymous.Anonymous.pwszVal.to_string().ok()
        }
    }

    pub fn set_relaunch(hwnd: isize, command: &str, icon: &str) {
        unsafe {
            let Ok(store) = SHGetPropertyStoreForWindow::<IPropertyStore>(HWND(hwnd as _)) else { return };
            // Windows reads the relaunch command only when the window has its own ID too.
            set(&store, &PKEY_AppUserModel_ID, crate::shell::APP_ID);
            set(&store, &PKEY_AppUserModel_RelaunchCommand, command);
            set(&store, &PKEY_AppUserModel_RelaunchDisplayNameResource, "Sketch");
            set(&store, &PKEY_AppUserModel_RelaunchIconResource, icon);
            let _ = store.Commit();
        }
    }
}
