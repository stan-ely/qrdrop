/// The app shell. `run()` is the mobile entry point too -- Android and iOS
/// load this crate as a library rather than exec'ing a binary, so this
/// function (not main.rs) is where anything shared across all five targets
/// belongs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The native sink (app/src/tauri-sink.js): plugin-dialog's save()
        // picks the destination, plugin-fs streams bytes to it. Both plugins
        // are gated in capabilities/default.json, not opened wide here --
        // registering a plugin only makes its commands callable, it does not
        // grant them.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running qrdrop")
}
