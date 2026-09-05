// Phase 0 note: `log_capabilities` and the page that calls it are the
// throwaway part of this crate -- see app/CAPABILITIES.md. Everything else
// here (the crate layout, `run()` as the mobile entry point, the window
// setup) is the real app shell and stays past Phase 0.

use serde_json::Value;

/// Receives the capability-probe results from app/spike/index.html and puts
/// them somewhere a human or a CI job can read them without a devtools
/// console attached.
///
/// Printed to stdout with a greppable prefix for the CI path (Linux/macOS
/// runners capture the process's own output), AND written to a file beside
/// the executable for the local-run path -- `cargo tauri dev` on Windows
/// buffers stdout unpredictably depending on the terminal it was launched
/// from, so a file next to the binary is the one place both paths can find
/// the same result.
#[tauri::command]
fn log_capabilities(payload: Value) -> Result<(), String> {
    println!("QRDROP_CAPABILITIES {payload}");

    let mut path = std::env::current_exe().map_err(|e| e.to_string())?;
    path.pop();
    path.push("capabilities.json");
    std::fs::write(&path, serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![log_capabilities])
        .run(tauri::generate_context!())
        .expect("error while running qrdrop");
}
