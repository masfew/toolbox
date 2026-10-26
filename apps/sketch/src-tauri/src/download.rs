//! Updates for release installs (F16.5). A Sketch installed from a release's installer has no clone,
//! Node or Rust, so it can't build itself. Instead it reads `latest.json` from the repo's fixed
//! `sketch-latest` release at start, every 5 minutes and on window focus (the page's checks, and the
//! capture helper's while no window is open), downloads a newer version folder and stages it exactly
//! as a local build is staged (`update-build.mjs`): a new `app-<short>` folder, the launcher swapped
//! in when it changed, then `current.json`. So the spinner while it downloads (F4), the ready icon
//! (F11), Restart to Update, the quiet restart and the launcher all work unchanged.
//!
//! `latest.json` is `{"signed": "<JSON>", "signature": "<hex>"}`: the inner JSON names the version,
//! its build number, and the zip's address, size and SHA-512, and it's signed with the release
//! workflow's Ed25519 key, whose public half is in the build stamp. A file that isn't signed with
//! that key, a zip that doesn't match, or a build number no newer than the running one is refused.
//! The repo's releases page is a plain download, not GitHub's rate-limited API.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use sha2::{Digest, Sha512};

use crate::layout::LAUNCHER_EXE;
use crate::shell::quiet;
use crate::stamp;
use crate::update::{self, build_dir, Notify, Ready, UpdateStatus};

/// `latest.json` is read again after this, however often windows check.
const LATEST_FRESH: Duration = Duration::from_secs(60);
/// No version folder is anywhere near this big (the zip is about 4 MB).
const MAX_ZIP: u64 = 200 << 20;

#[derive(Deserialize)]
struct Envelope {
    signed: String,
    signature: String,
}

/// The signed part of `latest.json`.
#[derive(Deserialize, Clone, Debug)]
pub struct Latest {
    pub version: String,
    pub build: u64,
    pub commit: String,
    pub url: String,
    pub size: u64,
    pub sha512: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

/// Checks `latest.json` against the stamp's public key, and that what it names makes sense.
pub fn verify(text: &str, key_hex: &str) -> Result<Latest, String> {
    use ed25519_dalek::{Signature, VerifyingKey};
    let envelope: Envelope = serde_json::from_str(text).map_err(|e| format!("latest.json isn't readable: {e}"))?;
    let key: [u8; 32] = unhex(key_hex).and_then(|k| k.try_into().ok()).ok_or("this build has no update key")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "this build's update key is invalid")?;
    let signature = unhex(&envelope.signature).and_then(|s| Signature::from_slice(&s).ok()).ok_or("latest.json's signature is malformed")?;
    key.verify_strict(envelope.signed.as_bytes(), &signature).map_err(|_| "latest.json isn't signed with this build's key")?;
    let latest: Latest = serde_json::from_str(&envelope.signed).map_err(|e| format!("latest.json's contents aren't readable: {e}"))?;
    // The commit names the version folder, so it must be a plain commit id.
    if latest.commit.len() != 40 || !latest.commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("latest.json names no commit".into());
    }
    if !(latest.url.starts_with("https://") || latest.url.starts_with("http://")) || latest.sha512.len() != 128 || latest.size == 0 || latest.size > MAX_ZIP {
        return Err("latest.json names no usable download".into());
    }
    Ok(latest)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(20)).timeout_read(Duration::from_secs(60)).build()
}

/// Where `latest.json` is: the `sketch-latest` release of the stamp's repo. Checks point
/// `SKETCH_RELEASES_URL` at a local server; what it serves still has to be signed.
fn latest_url() -> String {
    let base = std::env::var("SKETCH_RELEASES_URL").unwrap_or_else(|_| stamp::get().releases.clone());
    format!("{}/download/sketch-latest/latest.json", base.trim_end_matches('/'))
}

/// The newest release, read at most once a minute. None when it can't be read or isn't trusted.
fn latest(data: &Path) -> Option<Latest> {
    static CACHE: Mutex<Option<(Instant, Option<Latest>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap();
    if let Some((at, latest)) = cache.as_ref() {
        if at.elapsed() < LATEST_FRESH.min(crate::fetch::every()) {
            return latest.clone();
        }
    }
    let read = agent()
        .get(&latest_url())
        .call()
        .map_err(|e| e.to_string())
        .and_then(|r| r.into_string().map_err(|e| e.to_string()))
        .and_then(|text| verify(&text, &stamp::get().key));
    let streak = read.as_ref().map(|_| ()).map_err(Clone::clone);
    update::note_streak(data, "release-check", streak, "Couldn't read the latest release (tried again at each check)", "Reading the latest release works again");
    let latest = read.ok();
    *cache = Some((Instant::now(), latest.clone()));
    latest
}

/// A version folder's build number, from its `version.json` (0 when it has none).
fn build_of(folder: &Path) -> u64 {
    fs::read(folder.join("version.json")).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).and_then(|v| v["build"].as_u64()).unwrap_or(0)
}

pub fn check(data: &Path, root: &Path, done: Notify) -> UpdateStatus {
    let me = stamp::get();
    let staged = update::staged(root);
    let staged_build = staged.as_ref().map(|(_, folder)| build_of(folder)).unwrap_or(0);
    let ready = staged.as_ref().filter(|(c, folder)| c.commit != me.commit && build_of(folder) > me.build).map(|(c, folder)| {
        let v: serde_json::Value = fs::read(folder.join("version.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Ready { commit: c.commit.clone(), subject: v["subject"].as_str().unwrap_or_default().to_string() }
    });
    let mut building = update::building(data);
    if building.is_none() {
        // Never an older release, or one already staged.
        if let Some(latest) = latest(data).filter(|l| l.build > me.build.max(staged_build)) {
            if start(data, root, latest.clone(), done) {
                building = Some(latest.commit);
            }
        }
    }
    UpdateStatus { ready, building: building.filter(|b| b != &me.commit) }
}

/// Starts downloading `latest` on a thread of its own, holding `build.lock` as a build does.
fn start(data: &Path, root: &Path, latest: Latest, done: Notify) -> bool {
    let dir = build_dir(data);
    if fs::create_dir_all(&dir).is_err() || !update::claim_lock(&dir, &latest.commit) {
        return false;
    }
    let (data, root) = (data.to_path_buf(), root.to_path_buf());
    std::thread::spawn(move || {
        let lock = dir.join("build.lock");
        let work = dir.join("download");
        let result = download_and_stage(&root, &work, &lock, &latest);
        let _ = fs::remove_dir_all(&work);
        if result.is_err() {
            // A refused or cut-off download leaves nothing; the next check tries again.
            let _ = fs::remove_dir_all(root.join(format!("app-{}.part", &latest.commit[..7])));
        } else {
            update::log(&data, &format!("Staged Sketch {} (build {})", latest.version, latest.build));
        }
        update::note_streak(&data, "download", result, &format!("Couldn't download Sketch {} (tried again at each check)", latest.version), "Downloading updates works again");
        let _ = fs::remove_file(&lock);
        done();
    });
    true
}

fn download_and_stage(root: &Path, work: &Path, lock: &Path, latest: &Latest) -> Result<(), String> {
    let _ = fs::remove_dir_all(work);
    fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let zip = work.join("app.zip");
    let response = agent().get(&latest.url).call().map_err(|e| e.to_string())?;
    let mut reader = response.into_reader().take(latest.size + 1);
    let mut file = fs::File::create(&zip).map_err(|e| e.to_string())?;
    let mut hasher = Sha512::new();
    let (mut total, mut touched) = (0u64, Instant::now());
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("the download stopped: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        total += n as u64;
        if touched.elapsed() > Duration::from_secs(10) {
            update::touch(lock);
            touched = Instant::now();
        }
    }
    drop(file);
    if total != latest.size || hex(&hasher.finalize()) != latest.sha512.to_lowercase() {
        return Err("the download doesn't match latest.json, so it was refused".into());
    }
    let short = &latest.commit[..7];
    let folder = format!("app-{short}");
    let part = root.join(format!("{folder}.part"));
    let _ = fs::remove_dir_all(&part);
    fs::create_dir_all(&part).map_err(|e| e.to_string())?;
    unzip(&zip, &part)?;
    for f in [LAUNCHER_EXE, crate::helper::HELPER_EXE, "version.json"] {
        if !part.join(f).is_file() {
            return Err(format!("the download has no {f}"));
        }
    }
    let v: serde_json::Value = fs::read(part.join("version.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if v["commit"].as_str() != Some(latest.commit.as_str()) {
        return Err("the download's version.json names another commit".into());
    }
    stage(root, &part, &folder, &latest.commit)
}

/// Unpacks with Windows' own `tar`, which reads zip files (Windows 10 1803 and later).
fn unzip(zip: &Path, into: &Path) -> Result<(), String> {
    let tar = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join(r"System32\tar.exe");
    let out = quiet(&tar.to_string_lossy()).arg("-xf").arg(zip).arg("-C").arg(into).output().map_err(|e| format!("couldn't run tar: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("couldn't unpack the download: {}", update::first_line(&String::from_utf8_lossy(&out.stderr))))
    }
}

/// Moves a folder aside, then deletes it. A folder with a running program inside can't be moved, so
/// it stays whole.
fn remove_folder(root: &Path, name: &str) -> bool {
    let trash = root.join(format!(".trash-{name}"));
    let _ = fs::remove_dir_all(&trash);
    if fs::rename(root.join(name), &trash).is_err() {
        return false;
    }
    let _ = fs::remove_dir_all(&trash);
    true
}

/// The same staging as `update-build.mjs`: the folder takes its name, the launcher is swapped in when
/// it changed, and only then does `current.json` name it, so a start mid-way opens the version before.
fn stage(root: &Path, part: &Path, folder: &str, commit: &str) -> Result<(), String> {
    let target = root.join(folder);
    if target.exists() && !remove_folder(root, folder) {
        return Err(format!("{folder} is in use, so it can't be replaced"));
    }
    fs::rename(part, &target).map_err(|e| e.to_string())?;

    // The zip carries the launcher too. A running exe can be renamed aside; the launcher deletes the .old one.
    let built = target.join("sketch-launcher.exe");
    if built.is_file() {
        let launcher = root.join(LAUNCHER_EXE);
        let same = fs::read(&launcher).ok().zip(fs::read(&built).ok()).is_some_and(|(a, b)| a == b);
        if !same {
            let (new, old) = (root.join("sketch.exe.new"), root.join("sketch.exe.old"));
            fs::copy(&built, &new).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&old);
            let had = launcher.exists() && fs::rename(&launcher, &old).is_ok();
            if let Err(e) = fs::rename(&new, &launcher) {
                if had {
                    let _ = fs::rename(&old, &launcher);
                }
                return Err(e.to_string());
            }
        }
        let _ = fs::remove_file(&built);
    }

    let before = crate::layout::current(root);
    let previous = before.map(|c| c.folder).filter(|f| f != folder && root.join(f).exists()).unwrap_or_default();
    let current = serde_json::json!({ "folder": folder, "commit": commit, "previous": previous });
    crate::write_atomic(&root.join("current.json"), serde_json::to_string_pretty(&current).unwrap_or_default().as_bytes())?;

    // Versions older than the one before go, unless one is still running.
    for entry in fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("app-") && name != folder && name != previous {
            if name.ends_with(".part") {
                let _ = fs::remove_dir_all(entry.path());
            } else {
                remove_folder(root, &name);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed(key: &SigningKey, inner: &str) -> String {
        serde_json::json!({ "signed": inner, "signature": hex(&key.sign(inner.as_bytes()).to_bytes()) }).to_string()
    }

    const INNER: &str = r#"{"version":"1.4.0","build":12,"commit":"0123456789abcdef0123456789abcdef01234567","subject":"s","url":"https://example.com/a.zip","size":10,"sha512":"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"}"#;

    #[test]
    fn accepts_only_its_own_key() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let other = SigningKey::from_bytes(&[8; 32]);
        let public = hex(key.verifying_key().as_bytes());
        assert_eq!(verify(&signed(&key, INNER), &public).unwrap().build, 12);
        assert!(verify(&signed(&other, INNER), &public).is_err());
        // A changed byte after signing.
        let tampered = signed(&key, INNER).replace("\\\"build\\\":12", "\\\"build\\\":99");
        assert!(tampered.contains("99") && verify(&tampered, &public).is_err());
        assert!(verify(&signed(&key, INNER), "").is_err());
    }

    #[test]
    fn refuses_odd_contents() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let public = hex(key.verifying_key().as_bytes());
        let bad_commit = INNER.replace("0123456789abcdef0123456789abcdef01234567", "../../evil");
        assert!(verify(&signed(&key, &bad_commit), &public).is_err());
        let bad_url = INNER.replace("https://example.com/a.zip", "file:///C:/a.zip");
        assert!(verify(&signed(&key, &bad_url), &public).is_err());
    }
}
