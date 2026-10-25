// No console window, ever: the helper runs in the background.
#![windows_subsystem = "windows"]

fn main() {
    sketch_lib::capture_helper()
}
