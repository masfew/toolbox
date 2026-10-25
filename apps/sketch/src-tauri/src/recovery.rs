//! Autosaved pictures, one slot per window, in the data folder's `recovery` folder: `<slot>.json`
//! says what the window had open, and `<slot>.sktch` holds the picture when it had unsaved changes.
//! Slots left behind by an earlier run (a crash, an update) are handed to the
//! first window of the next run, once.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::{data_dir, header, raw_body, write_atomic};

#[derive(Default)]
pub struct Recovery {
    /// Slots that belong to a window of this run.
    claimed: Mutex<HashSet<String>>,
    /// Whether this run has already handed out the slots left by an earlier one.
    handed_out: Mutex<bool>,
}

#[derive(Serialize)]
pub struct Slot {
    id: String,
    /// The window's saved state, as the page wrote it.
    meta: String,
    has_picture: bool,
}

fn folder(app: &AppHandle) -> PathBuf {
    data_dir(app).join("recovery")
}

fn valid(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("bad slot id".into())
    }
}

/// Slots from an earlier run. Only the first call in a run gets them; they're claimed for the caller.
#[tauri::command]
pub fn recovery_orphans(app: AppHandle, state: State<Recovery>) -> Vec<Slot> {
    let mut handed_out = state.handed_out.lock().unwrap();
    if *handed_out {
        return Vec::new();
    }
    *handed_out = true;
    let mut claimed = state.claimed.lock().unwrap();
    let mut slots = Vec::new();
    let Ok(entries) = fs::read_dir(folder(&app)) else {
        return slots;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            let id = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            if valid(&id).is_err() || claimed.contains(&id) {
                continue;
            }
            let Ok(meta) = fs::read_to_string(&path) else { continue };
            claimed.insert(id.clone());
            slots.push(Slot { has_picture: path.with_extension("sktch").exists(), id, meta });
        }
    }
    // After a restart into a new version, in the order the windows were in, so this window gets
    // the first one.
    let restored = app.state::<crate::update::Restored>();
    slots.sort_by_key(|s| restored.rank(&s.id));
    slots
}

/// One slot, for a window opened to reopen it.
#[tauri::command]
pub fn recovery_slot(app: AppHandle, id: String) -> Option<Slot> {
    valid(&id).ok()?;
    let path = folder(&app).join(format!("{id}.json"));
    let meta = fs::read_to_string(&path).ok()?;
    Some(Slot { has_picture: path.with_extension("sktch").exists(), id, meta })
}

#[tauri::command]
pub fn recovery_claim(app: AppHandle, window: WebviewWindow, id: String, state: State<Recovery>) -> Result<(), String> {
    valid(&id)?;
    // After a restart, the window goes back where the slot's window was.
    app.state::<crate::update::Restored>().took(window.label(), &id);
    state.claimed.lock().unwrap().insert(id);
    Ok(())
}

#[tauri::command]
pub fn recovery_read(app: AppHandle, id: String) -> Result<Response, String> {
    valid(&id)?;
    fs::read(folder(&app).join(format!("{id}.sktch"))).map(Response::new).map_err(|e| e.to_string())
}

/// Saves a window's state. The body is the picture as `.sktch`, or empty when it has no unsaved changes.
#[tauri::command]
pub fn recovery_write(app: AppHandle, request: Request) -> Result<(), String> {
    let id = header(&request, "slot")?;
    valid(&id)?;
    let meta = header(&request, "meta")?;
    let body = raw_body(&request)?;
    let dir = folder(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let picture = dir.join(format!("{id}.sktch"));
    if body.is_empty() {
        let _ = fs::remove_file(&picture);
    } else {
        write_atomic(&picture, body)?;
    }
    write_atomic(&dir.join(format!("{id}.json")), meta.as_bytes())
}

/// Rewrites only a slot's state (a tab's place in its window, F14), leaving its picture. Does
/// nothing for a slot that's gone, so a late call never brings a deleted one back.
#[tauri::command]
pub fn recovery_meta(app: AppHandle, id: String, meta: String) -> Result<(), String> {
    valid(&id)?;
    let path = folder(&app).join(format!("{id}.json"));
    if !path.exists() {
        return Ok(());
    }
    write_atomic(&path, meta.as_bytes())
}

#[tauri::command]
pub fn recovery_delete(app: AppHandle, id: String, state: State<Recovery>) -> Result<(), String> {
    valid(&id)?;
    let dir = folder(&app);
    let _ = fs::remove_file(dir.join(format!("{id}.sktch")));
    let _ = fs::remove_file(dir.join(format!("{id}.json")));
    state.claimed.lock().unwrap().remove(&id);
    Ok(())
}

pub fn init(app: &AppHandle) {
    app.manage(Recovery::default());
}
