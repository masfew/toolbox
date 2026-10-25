//! Remove Background (F13): the U²-Net cutout model, run on this PC through ONNX Runtime, so
//! pictures never leave it. Both come as an add-on, downloaded on first use into the data
//! folder's `cutout` folder, so the installer and start-up stay as they were. Each file is
//! checked against its SHA-256 before it's used.
//!
//! The page shrinks the picture to the model's size itself and sends those few hundred KB of
//! raw pixels; the mask comes back at the same size and the page scales it up on the GPU.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, Request, Response};
use tauri::AppHandle;

/// The model's input and the mask's size, in pixels each way.
const SIZE: usize = 320;

struct AddOnFile {
    name: &'static str,
    bytes: u64,
    sha256: &'static str,
}

/// ONNX Runtime 1.31.0 from Microsoft's release, and U²-Net (Apache 2.0) as rembg converted it.
const FILES: [AddOnFile; 2] = [
    AddOnFile { name: "onnxruntime.dll", bytes: 17_253_176, sha256: "0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c" },
    AddOnFile { name: "u2net.onnx", bytes: 175_997_641, sha256: "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491" },
];

/// Where the add-on's files are published: a release of their own, whose tag has no `-v` so the
/// release workflow doesn't take it for a version of Sketch. `SKETCH_CUTOUT_URL` replaces it for
/// checks, which serve the same files locally; the SHA-256 check still applies.
const BASE_URL: &str = "https://github.com/masfew/toolbox/releases/download/sketch-cutout-1/";

static CANCEL: AtomicBool = AtomicBool::new(false);

fn dir(app: &AppHandle) -> PathBuf {
    crate::data_dir(app).join("cutout")
}

fn present(dir: &Path) -> bool {
    FILES.iter().all(|f| fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.bytes))
}

/// True once the add-on is downloaded.
#[tauri::command]
pub fn cutout_ready(app: AppHandle) -> bool {
    present(&dir(&app))
}

/// Downloads the add-on, sending how far it has got (0 to 1000) as it goes. Files already finished
/// are kept, so a cancelled or failed download starts again from the file it stopped in.
#[tauri::command]
pub async fn cutout_install(app: AppHandle, progress: Channel<u32>) -> Result<(), String> {
    let dir = dir(&app);
    CANCEL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || install(&dir, &progress)).await.map_err(|e| e.to_string())?
}

/// Stops a download in progress; `cutout_install` then fails with "cancelled".
#[tauri::command]
pub fn cutout_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

fn install(dir: &Path, progress: &Channel<u32>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = std::env::var("SKETCH_CUTOUT_URL").unwrap_or_else(|_| BASE_URL.into());
    let total: u64 = FILES.iter().map(|f| f.bytes).sum();
    let mut done = 0u64;
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(30)).build();
    for f in &FILES {
        let path = dir.join(f.name);
        if fs::metadata(&path).is_ok_and(|m| m.len() == f.bytes) {
            done += f.bytes;
            continue;
        }
        let part = dir.join(format!("{}.part", f.name));
        if let Err(e) = fetch(&agent, &format!("{base}{}", f.name), f, &part, progress, done, total) {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        fs::rename(&part, &path).map_err(|e| e.to_string())?;
        done += f.bytes;
    }
    let _ = progress.send(1000);
    Ok(())
}

/// Downloads one file to `part`, checking its size and SHA-256. The caller removes `part` on an error.
fn fetch(agent: &ureq::Agent, url: &str, f: &AddOnFile, part: &Path, progress: &Channel<u32>, done: u64, total: u64) -> Result<(), String> {
    let response = agent.get(url).call().map_err(|e| format!("couldn't download {}: {e}", f.name))?;
    let mut reader = response.into_reader().take(f.bytes + 1);
    let mut out = fs::File::create(part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = 0u64;
    let mut last = u32::MAX;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("the download of {} stopped: {e}", f.name))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        let share = ((done + got) * 1000 / total) as u32;
        if share != last {
            last = share;
            let _ = progress.send(share);
        }
    }
    let hash: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != f.bytes || hash != f.sha256 {
        return Err(format!("{} didn't match the file Sketch expects, so it wasn't kept", f.name));
    }
    Ok(())
}

/// ONNX Runtime, loaded from the add-on once per run of Sketch. A failed load isn't kept, so the
/// next use tries again (once antivirus lets the file go, say) without restarting Sketch.
fn runtime(dir: &Path) -> Result<&'static ort::environment::Environment, String> {
    static ENV: OnceLock<ort::environment::Environment> = OnceLock::new();
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = ort::init_from(dir.join("onnxruntime.dll")).map_err(|e| e.to_string())?.with_name("sketch").build().map_err(|e| e.to_string())?;
    Ok(ENV.get_or_init(|| env))
}

/// How much of each pixel is in front, from raw RGBA at `SIZE` × `SIZE`: one byte per pixel,
/// 255 for the object. The model is loaded for each call (0.3 s) rather than kept, so it holds
/// no memory between uses.
#[tauri::command]
pub async fn cutout_mask(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
    let rgba = crate::raw_body(&request)?.to_vec();
    if rgba.len() != SIZE * SIZE * 4 {
        return Err(format!("expected {SIZE} × {SIZE} pixels"));
    }
    let dir = dir(&app);
    tauri::async_runtime::spawn_blocking(move || mask(&dir, &rgba).map(Response::new)).await.map_err(|e| e.to_string())?
}

const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

fn mask(dir: &Path, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if !present(dir) {
        return Err("the Remove Background add-on isn't downloaded".into());
    }
    let env = runtime(dir)?;
    let mut session = Session::builder(env)
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .commit_from_file(dir.join("u2net.onnx"))
        .map_err(|e| e.to_string())?;
    // U²-Net was trained on pictures scaled by their brightest value, then the usual ImageNet mean and spread.
    let plane = SIZE * SIZE;
    let max = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).max().unwrap_or(255).max(1) as f32;
    let mut data = vec![0f32; 3 * plane];
    for (i, p) in rgba.chunks_exact(4).enumerate() {
        for c in 0..3 {
            data[c * plane + i] = (p[c] as f32 / max - MEAN[c]) / STD[c];
        }
    }
    let input = Tensor::from_array(([1usize, 3, SIZE, SIZE], data)).map_err(|e| e.to_string())?;
    // `panic = "abort"`, so a model without the expected input or output must fail, not close Sketch.
    let name = session.inputs().first().ok_or("the model has no input")?.name().to_string();
    let outputs = session.run(ort::inputs![name => input]).map_err(|e| e.to_string())?;
    let (_, first) = outputs.iter().next().ok_or("the model gave no mask")?;
    let (_, values) = first.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    let values = values.get(..plane).ok_or("the model gave a mask of the wrong size")?;
    // Its output is relative, so stretch it to the full range, as U²-Net's own code does.
    let (lo, hi) = values.iter().fold((f32::MAX, f32::MIN), |(a, b), &v| (a.min(v), b.max(v)));
    let range = (hi - lo).max(1e-6);
    Ok(values.iter().map(|&v| ((v - lo) / range * 255.0).round().clamp(0.0, 255.0) as u8).collect())
}
