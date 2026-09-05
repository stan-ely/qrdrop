/// The app shell. `run()` is the mobile entry point too -- Android and iOS
/// load this crate as a library rather than exec'ing a binary, so this
/// function (not main.rs) is where anything shared across all five targets
/// belongs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running qrdrop")
}
