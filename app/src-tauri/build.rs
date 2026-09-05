// Phase 0's log_capabilities command (and the AppManifest it needed) is gone
// with app/spike/. Phase 2's native sink (app/src/tauri-sink.js) turned out
// not to need a custom command either -- plugin-dialog and plugin-fs cover
// it, registered in src/lib.rs -- so this crate still has none of its own.
fn main() {
    tauri_build::build()
}
