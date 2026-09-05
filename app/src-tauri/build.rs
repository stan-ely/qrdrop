// Tauri v2's ACL gates app-defined commands the same as plugin commands --
// `log_capabilities` would otherwise fail at compile time with "Permission
// qrdrop:allow-log-capabilities not found", because nothing tells tauri-build
// that command exists until AppManifest names it. This is the one line that
// makes capabilities/default.json's `qrdrop:allow-log-capabilities` entry
// resolve to something real.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["log_capabilities"])),
    )
    .expect("failed to run tauri-build")
}
