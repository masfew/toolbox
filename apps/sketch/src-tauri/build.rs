fn main() {
    // The build stamp (scripts/build-info.mjs writes stamp.json before each build), for `stamp.rs`.
    println!("cargo:rerun-if-changed=stamp.json");
    if let Ok(stamp) = std::fs::read_to_string("stamp.json") {
        println!("cargo:rustc-env=SKETCH_STAMP={}", stamp.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    tauri_build::build()
}
