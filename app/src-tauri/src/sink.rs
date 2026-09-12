//! The native sink's byte path -- app/src/tauri-sink.js's Rust half.
//!
//! Why this exists instead of `tauri-plugin-fs`'s `write()`: on WebView2 that
//! plugin moves bytes across the IPC boundary at ~2 MB/s no matter how they
//! are chunked (16 KiB or 4 MiB -- app/bench/ measured both, flat). A command
//! that takes the bytes in the invoke request's RAW body reaches ~40 MB/s once
//! the caller coalesces frames to >=256 KiB blocks. tauri-sink.js does that
//! coalescing to 1 MiB; this file is deliberately dumb -- open, append, close.
//!
//! plugin-dialog still picks the destination (`save()`), and plugin-fs still
//! OPENS it -- through its Rust API, never its JS one, and for exactly one
//! reason: on Android `save()` goes through the Storage Access Framework and
//! returns a `content://` URI, not a path. `fs::File::create` on that string
//! failed with `No such file or directory (os error 2)`, which is why the
//! Android app shipped unable to receive. `app.fs().open()` hands a content
//! URI to Android's ContentResolver and gets back a real file descriptor,
//! wrapped as an ordinary `std::fs::File`; on desktop it is
//! `std::fs::OpenOptions::open` on the same path as before. Do not "simplify"
//! `sink_open` back to `File::create`: it is correct on every desktop and
//! silently wrong on the one platform whose save dialog does not deal in paths.
//!
//! And Android cannot have the raw body either. Tauri's IPC script never uses
//! the custom-protocol transport there (`canUseCustomProtocol = osName !==
//! 'android'` -- the WebView's request interceptor cannot read a POST body), so
//! every invoke arrives through `postMessage` as JSON, and `InvokeBody::Raw`
//! documents itself as unsupported on Android. Fixing `sink_open` alone got a
//! device to 1020 KB of a 2.9 MB file and then `sink_write expects a raw body`
//! at the first 1 MiB flush. So `sink_write` takes either shape: the raw body
//! where the IPC carries one, and `{ data: <base64> }` where it cannot -- the
//! encoding Tauri itself recommends there, against a JSON array of numbers that
//! turns a megabyte into a million of them. `sink_open` tells the JS side which
//! to send, from the same `target_os` Tauri's own script keys on, so nothing in
//! JS has to sniff a user agent to guess it.

use std::fs;
use std::io::Write;
use std::sync::Mutex;

use base64::Engine as _;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// Whether this platform's IPC delivers an invoke request's raw body. Mirrors
/// the one condition in Tauri's ipc-protocol.js that decides it; returned from
/// `sink_open` so tauri-sink.js picks the matching shape for `sink_write`.
const RAW_BODY: bool = !cfg!(target_os = "android");

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
    path: FilePath,
    file: fs::File,
}

/// Opens (truncating) whatever plugin-dialog's `save()` returned: a filesystem
/// path on desktop, a `content://` URI on Android. The received bytes never
/// pass through this call -- see `sink_write`. Resolves to [`RAW_BODY`].
///
/// `async`, unlike the three commands below, and that is not decoration. A
/// synchronous command runs on the main thread, and on Android `fs().open()`
/// of a content URI is a round-trip into plugin-fs's Kotlin half, which has to
/// be scheduled to run before the call can return -- a blocking wait on the
/// thread that would run it. The other three only touch the `File` already
/// held, so they stay synchronous.
///
/// `truncate` is what makes overwriting a longer existing file correct: on a
/// content URI it becomes the `"wt"` mode, where a bare `"w"` is allowed by
/// the platform to leave the old tail in place. `create` matters on desktop
/// only; the Storage Access Framework has already created the document by the
/// time `save()` returns its URI.
#[tauri::command]
pub async fn sink_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, SinkState>,
    path: String,
) -> Result<bool, String> {
    // Infallible: a string that does not parse as a URL -- or parses as one
    // with a one-letter scheme, which is a Windows drive -- is a path.
    let Ok(path) = path.parse::<FilePath>();
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let file = app.fs().open(path.clone(), options).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(Open { path, file });
    Ok(RAW_BODY)
}

/// Appends one coalesced block: in the invoke request's raw body where the IPC
/// has one, as `{ data: <base64> }` on Android where it does not. Never a JSON
/// array of numbers, and never through plugin-fs. See the module comment for
/// the measured reasons behind both shapes.
#[tauri::command]
pub fn sink_write(
    state: tauri::State<'_, SinkState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let decoded;
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeBody::Json(value) => {
            // Anything else here is a caller bug -- a Uint8Array passed where
            // this platform needed base64, or the reverse -- and one that would
            // otherwise write nothing and look like a silent stall.
            let Some(encoded) = value.get("data").and_then(|d| d.as_str()) else {
                return Err("sink_write expects a raw body, or { data: <base64> } where the IPC has none".into());
            };
            decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| format!("sink_write: {e}"))?;
            &decoded
        }
    };
    let mut guard = state.0.lock().unwrap();
    let open = guard.as_mut().ok_or("sink_write before sink_open")?;
    open.file.write_all(bytes).map_err(|e| e.to_string())
}

/// Flushes and drops the handle. After this the file on disk is complete --
/// and on Android, the second half is what makes the rest of the phone agree.
///
/// Every file the app received on Android was listed as 0 B by the Files app
/// and anything else reading the media index, while `ls` gave its true size and
/// its bytes were whole. The cause is in how the descriptor is handed over.
/// plugin-fs's Kotlin half opens the `content://` URI and calls `detachFd()`,
/// so Rust can own an ordinary `File`. MediaProvider wraps every write open in
/// a close listener that rescans the file, and `ParcelFileDescriptor` reports a
/// detach to that listener exactly as it reports a close: immediately. So the
/// scan ran at `sink_open`, on a file `"wt"` had just emptied, and when Rust
/// closed the real descriptor there was nobody left listening. Measured on the
/// Realme RMX3868: the index row's `date_modified` was the very second of the
/// open, `W/ParcelFileDescriptor: Peer expected signal when closed; unable to
/// deliver after detach` was logged by this process in that same second, and
/// the row still said 0 bytes ten minutes later.
///
/// So once the bytes are written and the descriptor closed, a content URI is
/// opened again and dropped. The mode is `"wa"`, and both letters are load-
/// bearing: MediaProvider attaches its listener only to a *write* open, so a
/// harmless `"r"` rescans nothing, and without append the mode is the one that
/// is allowed to truncate -- which would reproduce the bug by wiping the file
/// the index is being asked to look at. Fixing it from the Kotlin side instead,
/// closing rather than detaching, would mean a Tauri plugin of our own or a
/// patched plugin-fs, for what one open achieves.
///
/// `async` now, for `sink_open`'s reason: that open is a round-trip into
/// Kotlin. Best effort, too. The file is complete before the reopen is tried,
/// and failing a finished transfer because a listing is stale would report the
/// wrong thing about the one part that worked.
#[tauri::command]
pub async fn sink_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, SinkState>,
) -> Result<(), String> {
    let Some(Open { path, mut file }) = state.0.lock().unwrap().take() else {
        return Ok(());
    };
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if needs_media_rescan(&path) {
        let mut options = OpenOptions::new();
        options.write(true).append(true);
        let _ = app.fs().open(path, options);
    }
    Ok(())
}

/// Whether closing `path` leaves Android's media index stale -- a `content://`
/// URI, and nothing else. Keyed on the scheme rather than `target_os`, so it is
/// testable on a desktop host, and a `file://` URL, which plugin-fs opens as a
/// plain path, is not reopened for nothing.
fn needs_media_rescan(path: &FilePath) -> bool {
    matches!(path, FilePath::Url(url) if url.scheme() == "content")
}

/// Drops the handle and discards the partial file -- the native equivalent of
/// a cancelled File System Access writable, which the web Blob fallback cannot
/// do (tauri-sink.js's header spells out why an abandoned web transfer leaves
/// an empty file with no handle able to remove it).
///
/// Two steps, because only one of them works everywhere. Truncating through
/// the handle we hold does, so the partial bytes are gone on every platform.
/// Unlinking needs a path, and a `content://` document has none: removing it
/// is `DocumentsContract.deleteDocument`, which is Kotlin, which is a hand-edit
/// in gen/ for a cleanup. So on Android a cancelled receive leaves an EMPTY
/// file under the name the person chose -- the same outcome the website's
/// File System Access path has always had, and an honest one: they picked
/// that name a moment ago and can see what happened to it.
#[tauri::command]
pub fn sink_abort(state: tauri::State<'_, SinkState>) -> Result<(), String> {
    if let Some(open) = state.0.lock().unwrap().take() {
        // Best effort throughout: the transfer is already being torn down, and
        // a failure to clean up a partial file is not worth surfacing as an
        // error on top of whatever caused the abort.
        let _ = open.file.set_len(0);
        drop(open.file);
        if let FilePath::Path(path) = &open.path {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(s: &str) -> FilePath {
        let Ok(path) = s.parse::<FilePath>();
        path
    }

    #[test]
    fn only_a_content_uri_is_reopened_for_the_media_index() {
        // The shape plugin-dialog's save() returned on the device.
        assert!(needs_media_rescan(&parsed(
            "content://com.android.providers.downloads.documents/document/1512"
        )));
        assert!(!needs_media_rescan(&parsed("file:///tmp/report.pdf")));
        assert!(!needs_media_rescan(&parsed("/tmp/report.pdf")));
        assert!(!needs_media_rescan(&parsed(r"C:\Users\someone\report.pdf")));
    }
}
