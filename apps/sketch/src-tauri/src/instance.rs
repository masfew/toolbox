//! One Sketch process per data folder. A second launch hands its command line to the first one
//! through a named pipe and exits, so files opened from Explorer become windows of the running app.
//! The pipe's name comes from the data folder, so checks that use their own folder never reach
//! the user's running Sketch.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Message {
    pub args: Vec<String>,
    pub cwd: String,
}

pub enum Claim {
    /// This is the first process: serve the pipe.
    First(Server),
    /// The command line went to the running process; this one should exit.
    Forwarded,
}

pub struct Server {
    name: String,
    #[cfg(windows)]
    first: Option<isize>,
}

/// A short name for a data folder (FNV-1a of its path), with no characters a pipe, mutex or window
/// title can't hold.
pub fn key_hash(key: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn pipe_name(key: &str) -> String {
    format!(r"\\.\pipe\sketch-{}", key_hash(key))
}

/// Hands a command line to the running Sketch, as a second launch would. False when none is running.
/// The capture helper uses it, so Sketch can hide itself before a capture taken while it's in front.
pub fn send(key: &str, message: &Message) -> bool {
    const ERROR_PIPE_BUSY: i32 = 231;
    let name = pipe_name(key);
    let body = serde_json::to_vec(message).unwrap_or_default();
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }
    for _ in 0..10 {
        match OpenOptions::new().write(true).open(&name) {
            Ok(mut pipe) => return pipe.write_all(&body).is_ok(),
            // Sketch is reading the last message: try again in a moment.
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return false,
        }
    }
    false
}

/// Whether a Sketch is running for this data folder, without sending it anything: its pipe exists.
pub fn running(key: &str) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::{GetLastError, ERROR_SEM_TIMEOUT};
        use windows::Win32::System::Pipes::WaitNamedPipeW;
        if WaitNamedPipeW(&HSTRING::from(pipe_name(key)), 1).as_bool() {
            return true;
        }
        // It exists, but every instance is busy for the moment.
        GetLastError() == ERROR_SEM_TIMEOUT
    }
    #[cfg(not(windows))]
    {
        let _ = key;
        false
    }
}

pub fn claim(key: &str, message: &Message) -> Claim {
    let name = pipe_name(key);
    let body = serde_json::to_vec(message).unwrap_or_default();
    // Windows lets the process the user just started come to the front, not the one it hands over
    // to; passing that on lets the running Sketch show the window or the capture overlay in front.
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }
    for _ in 0..40 {
        if let Ok(mut pipe) = OpenOptions::new().write(true).open(&name) {
            if pipe.write_all(&body).is_ok() {
                return Claim::Forwarded;
            }
        }
        #[cfg(windows)]
        if let Some(handle) = create(&name, true) {
            return Claim::First(Server { name, first: Some(handle) });
        }
        #[cfg(not(windows))]
        return Claim::First(Server { name });
        // The pipe is busy, or another process created it a moment ago: try again.
        std::thread::sleep(Duration::from_millis(50));
    }
    // Rather than refuse to start, run without single-instance.
    Claim::First(Server {
        name,
        #[cfg(windows)]
        first: None,
    })
}

#[cfg(windows)]
fn create(name: &str, first: bool) -> Option<isize> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND};
    use windows::Win32::System::Pipes::{CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT};
    let mode = if first { PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE } else { PIPE_ACCESS_INBOUND };
    let handle = unsafe {
        CreateNamedPipeW(&HSTRING::from(name), mode, PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 0, 64 * 1024, 0, None)
    };
    if handle.is_invalid() {
        None
    } else {
        Some(handle.0 as isize)
    }
}

impl Server {
    /// Listens on a background thread, calling `on_message` for each later launch.
    pub fn serve(self, on_message: impl Fn(Message) + Send + 'static) {
        #[cfg(windows)]
        std::thread::spawn(move || {
            use std::os::windows::io::FromRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::System::Pipes::ConnectNamedPipe;
            let mut next = self.first;
            loop {
                let Some(raw) = next.take().or_else(|| create(&self.name, false)) else {
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                };
                // Fails with ERROR_PIPE_CONNECTED when the client was quicker, which is fine.
                let _ = unsafe { ConnectNamedPipe(HANDLE(raw as _), None) };
                let mut pipe = unsafe { std::fs::File::from_raw_handle(raw as _) };
                let mut body = Vec::new();
                let _ = pipe.read_to_end(&mut body);
                drop(pipe);
                if let Ok(message) = serde_json::from_slice::<Message>(&body) {
                    on_message(message);
                }
            }
        });
        #[cfg(not(windows))]
        let _ = on_message;
    }
}
