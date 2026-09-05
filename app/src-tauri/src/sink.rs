//! The native sink's byte path -- app/src/tauri-sink.js's Rust half.
//!
//! Why this exists instead of `tauri-plugin-fs`'s `write()`: on WebView2 that
//! plugin moves bytes across the IPC boundary at ~2 MB/s no matter how they
//! are chunked (16 KiB or 4 MiB -- app/bench/ measured both, flat). A command
//! that takes the bytes in the invoke request's RAW body reaches ~40 MB/s once
//! the caller coalesces frames to >=256 KiB blocks. tauri-sink.js does that
//! coalescing to 1 MiB; this file is deliberately dumb -- open, append, close.
//!
//! plugin-dialog still picks the path (`save()`); only the byte transport
//! moved here.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// The open destination for the transfer in progress.
///
/// One slot, not a map keyed by id: the app is a single window doing one
/// transfer at a time (README, "One file at a time"), and element.js's Accept
/// gate serialises the callers that could open one. A second concurrent
/// `sink_open` would replace this -- tolerable only because the UI cannot
/// reach that state, and worth revisiting if a multi-file queue ever lands.
#[derive(Default)]
pub struct SinkState(Mutex<Option<Open>>);

struct Open {
    path: PathBuf,
    file: fs::File,
}

/// Opens (truncating) the path plugin-dialog's `save()` returned. The received
/// bytes never pass through this call -- see `sink_write`.
#[tauri::command]
pub fn sink_open(state: tauri::State<'_, SinkState>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let file = fs::File::create(&path).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(Open { path, file });
    Ok(())
}

/// Appends one coalesced block, carried in the invoke request's raw body --
/// never a JSON array of numbers, and never through plugin-fs. See the module
/// comment for the measured reason.
#[tauri::command]
pub fn sink_write(
    state: tauri::State<'_, SinkState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        // A JSON body here means the JS side passed something other than a
        // Uint8Array/ArrayBuffer as the sole argument -- a caller bug, and one
        // that would otherwise write nothing and look like a silent stall.
        tauri::ipc::InvokeBody::Json(_) => return Err("sink_write expects a raw body".into()),
    };
    let mut guard = state.0.lock().unwrap();
    let open = guard.as_mut().ok_or("sink_write before sink_open")?;
    open.file.write_all(bytes).map_err(|e| e.to_string())
}

/// Flushes and drops the handle. After this the file on disk is complete.
#[tauri::command]
pub fn sink_close(state: tauri::State<'_, SinkState>) -> Result<(), String> {
    if let Some(mut open) = state.0.lock().unwrap().take() {
        open.file.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drops the handle and deletes the partial file -- the native equivalent of a
/// cancelled File System Access writable, which the web Blob fallback cannot
/// do (tauri-sink.js's header spells out why an abandoned web transfer leaves
/// an empty file with no handle able to remove it).
#[tauri::command]
pub fn sink_abort(state: tauri::State<'_, SinkState>) -> Result<(), String> {
    if let Some(open) = state.0.lock().unwrap().take() {
        drop(open.file);
        // Best effort: the transfer is already being torn down, and a failure
        // to unlink a temp-ish partial file is not worth surfacing as an error
        // on top of whatever caused the abort.
        let _ = fs::remove_file(&open.path);
    }
    Ok(())
}
