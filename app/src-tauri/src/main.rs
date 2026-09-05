// Prevents an extra console window on Windows release builds; debug builds
// keep it so `cargo tauri dev` output is visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    qrdrop_lib::run()
}
