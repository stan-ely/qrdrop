// Phase 0's log_capabilities command (and the AppManifest it needed) is gone
// with app/spike/ -- the real frontend (site/dist, built with --channel app)
// has no custom commands to declare yet. Phase 2's native sink will be the
// next thing that needs one.
fn main() {
    tauri_build::build()
}
