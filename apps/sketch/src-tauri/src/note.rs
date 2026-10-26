//! The Windows notification a capture shows, as the Snipping Tool does: "Screenshot copied to
//! clipboard" with a small picture of it. Clicking it opens the capture in Sketch; otherwise nothing
//! opens, so a capture taken only to paste somewhere else never brings up a window.
//!
//! The click reaches Sketch through the notification's own event, so it only works while this
//! Sketch runs. Its notifications are taken off the screen and out of the notification centre when
//! it quits (`close_all`), so none are left that do nothing when clicked.
//!
//! Each notification goes after the user's own Windows notification time (F12; 5 seconds unless
//! changed): a capture not clicked by then is one taken only to paste elsewhere. It's taken off the
//! screen and out of the notification centre, so none pile up there, and its capture is dropped.

use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::capture::Shot;

/// What happened to a notification. Each one gets exactly one.
pub enum Event {
    Clicked,
    /// Gone after its time, dismissed, replaced by a newer capture's, or taken away when Sketch
    /// quit.
    Closed,
}

/// Windows' own notification time when it can't be read.
const LIFE: Duration = Duration::from_secs(5);

/// How long a notification stays before Sketch takes it away: the user's "Dismiss notifications
/// after this amount of time" (Settings, Accessibility, Visual effects), as Windows' own pop-ups
/// get. Until 1.5.1 it was a fixed 3 seconds, which went before people looked for it. Sketch still
/// times it itself, since a notification that skips its pop-up reports timing out at once (see
/// `Dismissed` below). Checks (test hooks only) can hold notifications longer with `note-ms.txt` in
/// the data folder, so a slow step between a capture and its click doesn't lose the notification.
pub fn life(dir: &Path) -> Duration {
    let from_file = || -> Option<u64> {
        if !std::env::var("SKETCH_TEST_HOOKS").is_ok_and(|v| v == "1") {
            return None;
        }
        fs::read_to_string(dir.join("note-ms.txt")).ok()?.trim().parse().ok()
    };
    from_file().map(Duration::from_millis).or_else(windows_life).unwrap_or(LIFE)
}

fn windows_life() -> Option<Duration> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETMESSAGEDURATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
        let mut secs: u32 = 0;
        SystemParametersInfoW(SPI_GETMESSAGEDURATION, 0, Some(&mut secs as *mut u32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).ok()?;
        (secs > 0).then(|| Duration::from_secs(secs.into()))
    }
    #[cfg(not(windows))]
    None
}

type Handler = Arc<dyn Fn(Event) + Send + Sync>;

struct Note {
    id: u32,
    image: PathBuf,
    on: Handler,
}

/// Notifications still on screen, oldest first.
static NOTES: Mutex<Vec<Note>> = Mutex::new(Vec::new());

/// Longest side of the picture in the notification.
const THUMB: u32 = 728;

/// Shows capture `id`'s notification; `on` hears whether it was clicked or closed. False when
/// Windows won't show it (notifications turned off for Sketch, or no Start menu entry to show it
/// under), and the caller then opens the capture itself. Older notifications stay until
/// `close_older`, so the caller can get the new capture ready first.
pub fn show(dir: &Path, id: u32, shot: &Shot, on: impl Fn(Event) + Send + Sync + 'static) -> bool {
    let folder = dir.join("captures");
    let image = folder.join(format!("{}-{id}.png", std::process::id()));
    let _ = fs::create_dir_all(&folder);
    let has_image = write_thumb(shot, &image).is_ok();
    // Added before showing, since a click can arrive before `imp::show` returns.
    NOTES.lock().unwrap().push(Note { id, image: image.clone(), on: Arc::new(on) });
    if !imp::show(id, has_image.then_some(image.as_path())) {
        take(id);
        let _ = fs::remove_file(&image);
        return false;
    }
    let life = life(dir);
    std::thread::spawn(move || {
        std::thread::sleep(life);
        close(id);
    });
    true
}

/// A newer capture replaces the older ones: takes their notifications away.
pub fn close_older(id: u32) {
    let old: Vec<Note> = {
        let mut notes = NOTES.lock().unwrap();
        let (old, keep) = notes.drain(..).partition(|n| n.id != id);
        *notes = keep;
        old
    };
    for note in old {
        imp::remove(note.id);
        end(note, Event::Closed);
    }
}

/// Takes capture `id`'s notification away, as if dismissed.
pub fn close(id: u32) {
    if let Some(note) = take(id) {
        imp::remove(id);
        end(note, Event::Closed);
    }
}

/// Sketch is quitting: takes all its notifications away.
pub fn close_all() {
    let notes: Vec<Note> = NOTES.lock().unwrap().drain(..).collect();
    for note in notes {
        imp::remove(note.id);
        end(note, Event::Closed);
    }
}

/// For checks: acts as if the newest notification was clicked. False when there's none.
pub fn click_newest() -> bool {
    let Some(note) = NOTES.lock().unwrap().pop() else { return false };
    // Taken first: hiding it raises its Dismissed event, which would otherwise count as a close.
    imp::remove(note.id);
    end(note, Event::Clicked);
    true
}

/// Opens capture `id` as clicking its notification does (a tap of Left Shift, F16), and takes the
/// notification away. False when it's gone already.
pub fn click(id: u32) -> bool {
    let Some(note) = take(id) else { return false };
    imp::remove(id);
    end(note, Event::Clicked);
    true
}

/// As `click`, waiting up to a second for the notification when it isn't showing yet: a tap can come
/// before it does.
pub fn click_soon(id: u32) {
    for _ in 0..50 {
        if click(id) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// For checks: acts as if the newest notification was dismissed. False when there's none.
pub fn dismiss_newest() -> bool {
    let Some(id) = NOTES.lock().unwrap().last().map(|n| n.id) else { return false };
    close(id);
    true
}

/// Empties Sketch's part of the notification centre.
pub fn clear_centre() {
    imp::clear();
}

fn take(id: u32) -> Option<Note> {
    let mut notes = NOTES.lock().unwrap();
    let i = notes.iter().position(|n| n.id == id)?;
    Some(notes.remove(i))
}

fn end(note: Note, event: Event) {
    let _ = fs::remove_file(&note.image);
    (note.on)(event);
}

/// A click or dismissal from Windows. Only the first reaches the handler.
fn fire(id: u32, event: Event) {
    if let Some(note) = take(id) {
        end(note, event);
    }
}

/// A smaller copy of the capture as a PNG, for the notification to show.
fn write_thumb(shot: &Shot, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let (w, h) = (shot.width.max(1), shot.height.max(1));
    let scale = (w.max(h) as f64 / THUMB as f64).max(1.0);
    let (tw, th) = (((w as f64 / scale).round() as u32).max(1), ((h as f64 / scale).round() as u32).max(1));
    // Each pixel of the copy is the average of the pixels it covers.
    let mut rgb = Vec::with_capacity((tw * th * 3) as usize);
    for ty in 0..th {
        let (y0, y1) = (ty * h / th, ((ty + 1) * h / th).max(ty * h / th + 1));
        for tx in 0..tw {
            let (x0, x1) = (tx * w / tw, ((tx + 1) * w / tw).max(tx * w / tw + 1));
            let mut sum = [0u32; 3];
            for y in y0..y1 {
                let row = &shot.rgba[((y * w + x0) * 4) as usize..((y * w + x1) * 4) as usize];
                for px in row.chunks_exact(4) {
                    sum[0] += px[0] as u32;
                    sum[1] += px[1] as u32;
                    sum[2] += px[2] as u32;
                }
            }
            let n = (x1 - x0) * (y1 - y0);
            rgb.extend(sum.iter().map(|s| (s / n) as u8));
        }
    }
    let mut encoder = png::Encoder::new(BufWriter::new(fs::File::create(path)?), tw, th);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    encoder.write_header()?.write_image_data(&rgb)?;
    Ok(())
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;

    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{NotificationSetting, ToastDismissalReason, ToastDismissedEventArgs, ToastNotification, ToastNotificationManager, ToastNotifier};

    use super::{fire, Event};
    use crate::shell::APP_ID;

    /// The notifications on screen, kept so `remove` can hide them.
    static SHOWN: Mutex<Option<HashMap<u32, (ToastNotifier, ToastNotification)>>> = Mutex::new(None);

    /// Each Sketch's notifications are a group of their own, so quitting one (a check's, say) never
    /// takes away another's.
    fn group() -> HSTRING {
        HSTRING::from(format!("capture-{}", std::process::id()))
    }

    fn escape(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }

    pub fn show(id: u32, image: Option<&Path>) -> bool {
        try_show(id, image).is_ok()
    }

    fn try_show(id: u32, image: Option<&Path>) -> windows::core::Result<()> {
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?;
        // Setting() fails with "Element not found" for apps known only by a Start menu shortcut,
        // which Sketch is, so only a clear "off" counts.
        if notifier.Setting().is_ok_and(|s| s != NotificationSetting::Enabled) {
            return Err(windows::core::Error::empty());
        }
        let image = image.map_or(String::new(), |p| {
            let url = format!("file:///{}", p.to_string_lossy().replace('\\', "/").replace(' ', "%20"));
            format!(r#"<image src="{}"/>"#, escape(&url))
        });
        // Silent: the user just took the capture, so they know it's coming.
        let xml = format!(
            r#"<toast><visual><binding template="ToastGeneric"><text>Screenshot copied to clipboard</text><text>Click to open it in Sketch.</text>{image}</binding></visual><audio silent="true"/></toast>"#
        );
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        toast.SetTag(&HSTRING::from(id.to_string()))?;
        toast.SetGroup(&group())?;
        // Checks put theirs straight in the notification centre, so none pop up while they run.
        if std::env::var("SKETCH_TEST_HOOKS").is_ok_and(|v| v == "1") {
            toast.SetSuppressPopup(true)?;
        }
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            fire(id, Event::Clicked);
            Ok(())
        }))?;
        // Dismissed or hidden: the capture goes with it, and nothing is left in the notification
        // centre. Timing out is left to Sketch's timer (`life`): a notification that skips its
        // pop-up (Do Not Disturb, checks) times out at once.
        toast.Dismissed(&TypedEventHandler::new(move |_, args: windows::core::Ref<ToastDismissedEventArgs>| {
            if args.ok()?.Reason()? != ToastDismissalReason::TimedOut {
                remove(id);
                fire(id, Event::Closed);
            }
            Ok(())
        }))?;
        toast.Failed(&TypedEventHandler::new(move |_, _| {
            remove(id);
            fire(id, Event::Closed);
            Ok(())
        }))?;
        SHOWN.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, (notifier.clone(), toast.clone()));
        let shown = notifier.Show(&toast);
        if shown.is_err() {
            SHOWN.lock().unwrap().as_mut().map(|m| m.remove(&id));
        }
        shown
    }

    pub fn clear() {
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.ClearWithId(&HSTRING::from(APP_ID));
        }
    }

    /// Takes a notification off the screen and out of the notification centre.
    pub fn remove(id: u32) {
        let shown = SHOWN.lock().unwrap().as_mut().and_then(|m| m.remove(&id));
        if let Some((notifier, toast)) = shown {
            let _ = notifier.Hide(&toast);
        }
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(&HSTRING::from(id.to_string()), &group(), &HSTRING::from(APP_ID));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn show(_: u32, _: Option<&std::path::Path>) -> bool {
        false
    }
    pub fn remove(_: u32) {}
    pub fn clear() {}
}
