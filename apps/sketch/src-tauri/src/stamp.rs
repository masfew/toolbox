//! The build stamp (F16): which commit this build is and where its updates come from. The page has
//! it as `__SKETCH_BUILD__`; Rust gets the same values from `src-tauri/stamp.json`, which
//! `scripts/build-info.mjs --nsis` writes before each build and `build.rs` compiles in, so the
//! capture helper knows them too without a page. A build without the file (a plain `cargo check`)
//! has an empty stamp and never updates.

use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Stamp {
    pub commit: String,
    pub subject: String,
    /// The main checkout of the repo this build came from (empty in a release build).
    pub repo: String,
    /// Sketch's folder inside that repo (`apps/sketch`; empty when it's the repo's root).
    pub path: String,
    /// The number of commits that changed Sketch's folder, for comparing release versions.
    pub build: u64,
    /// `release` for a build made by the release workflow, `source` for one built from a clone.
    pub channel: String,
    /// The repo's releases page, `https://github.com/<owner>/<repo>/releases` (release builds).
    pub releases: String,
    /// The Ed25519 public key (hex) that signs each release's latest.json (release builds).
    pub key: String,
}

pub fn get() -> &'static Stamp {
    static STAMP: OnceLock<Stamp> = OnceLock::new();
    STAMP.get_or_init(|| option_env!("SKETCH_STAMP").and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default())
}
