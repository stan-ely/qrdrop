mod sink;

/// The app shell. `run()` is the mobile entry point too -- Android and iOS
/// load this crate as a library rather than exec'ing a binary, so this
/// function (not main.rs) is where anything shared across all five targets
/// belongs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // plugin-dialog's save() picks the destination for the native sink
        // (app/src/tauri-sink.js). The bytes go through this crate's own
        // sink_* commands instead of plugin-fs -- see src/sink.rs for the
        // measured reason. plugin-fs is still registered because the
        // throwaway app/bench/ harness uses it; the sink itself no longer
        // touches it.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(sink::SinkState::default())
        .invoke_handler(tauri::generate_handler![
            sink::sink_open,
            sink::sink_write,
            sink::sink_close,
            sink::sink_abort,
        ])
        .run(tauri::generate_context!())
        .expect("error while running qrdrop")
}
