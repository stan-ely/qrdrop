//! The native sink's byte path -- app/src/tauri-sink.js's Rust half.
//!
//! Why this exists instead of `tauri-plugin-fs`'s `write()`: on WebView2 that
//! plugin moves bytes across the IPC boundary at ~2 MB/s no matter how they
//! are chunked (16 KiB or 4 MiB -- app/bench/ measured both, flat). A command
//! that takes the bytes in the invoke request's RAW body reaches ~40 MB/s once
//! the caller coalesces frames to >=256 KiB blocks. tauri-sink.js does that
//! coalescing to 1 MiB; this file is deliberately dumb -- open, append, close.
//!
//! The destination is no longer picked by a dialog: `sink_open` asks
//! src/storage.rs, which answers Downloads/qrdrop or a folder the person
//! granted on Android, and creates the file without ever opening one that
//! exists. That module carries the reasoning, which starts with ColorOS
//! freezing the app behind the save dialog.
//!
//! A granted Android folder hands back a `content://` URI, and plugin-fs still
//! OPENS that -- through its Rust API, never its JS one, and for exactly one
//! reason: `fs::File::create` on a content URI fails with `No such file or
//! directory (os error 2)`, which is why the Android app once shipped unable
//! to receive (when the URI came from `save()`). `app.fs().open()` hands a
//! content URI to Android's ContentResolver and gets back a real file
//! descriptor, wrapped as an ordinary `std::fs::File`. Do not "simplify" that
//! open back to `File::create`: it is silently wrong on the one route that
//! does not deal in paths. (iOS still takes a path from `save()`.)
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
use serde::Serialize;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::storage;

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
    /// Whether this sink made the file, and so may delete it on abort. A path
    /// from iOS's `save()` names a file the person chose, possibly one that
    /// already existed, and is only truncated.
    created: bool,
}

/// What `sink_open` tells tauri-sink.js.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// See [`RAW_BODY`].
    raw_body: bool,
    /// The name the file was actually saved under, `report (1).pdf` when
    /// `report.pdf` was taken.
    name: String,
    /// What the done screen says, `Downloads/qrdrop/report (1).pdf`. None for
    /// a path the person picked in a dialog, which they already know.
    location: Option<String>,
}

/// Creates the destination for one received file and holds it open. The
/// received bytes never pass through this call -- see `sink_write`.
///
/// Without `path`, src/storage.rs chooses: a new file in Downloads/qrdrop, or
/// a new document in the folder the person granted on Android -- never an
/// existing file in either. With `path` (iOS, whose save dialog is kept), the
/// chosen file is opened truncating, as before.
///
/// `async`, unlike `sink_write`, and that is not decoration. A synchronous
/// command runs on the main thread, and on Android both creating a document
/// and `fs().open()` of a content URI are round-trips into Kotlin, which has
/// to be scheduled to run before the call can return -- a blocking wait on
/// the thread that would run it.
#[tauri::command]
pub async fn sink_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, SinkState>,
    name: String,
    mime: Option<String>,
    path: Option<String>,
) -> Result<Opened, String> {
    let (open, name, location) = match path {
        Some(path) => {
            // Infallible: a string that does not parse as a URL -- or parses
            // as one with a one-letter scheme, which is a Windows drive -- is
            // a path.
            let Ok(path) = path.parse::<FilePath>();
            // `truncate` is what makes overwriting a longer file the person
            // chose correct: on a content URI it becomes `"wt"`, where a bare
            // `"w"` may leave the old tail in place.
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            let file = app.fs().open(path.clone(), options).map_err(|e| e.to_string())?;
            (Open { path, file, created: false }, name, None)
        }
        None => match storage::destination(&app).await? {
            storage::Destination::Folder(dir) => {
                let (file, path) = storage::create_unique(&dir, &name)
                    .map_err(|e| format!("Could not save into {}: {e}", dir.display()))?;
                let saved = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(name);
                let location = storage::display_location(&path);
                (Open { path: FilePath::Path(path), file, created: true }, saved, Some(location))
            }
            storage::Destination::Granted => open_granted(&app, &name, mime.as_deref()).await?,
        },
    };
    *state.0.lock().unwrap() = Some(open);
    Ok(Opened { raw_body: RAW_BODY, name, location })
}

/// A new document in the folder the person granted, opened the way a
/// `save()` URI used to be. `createDocument` made it a moment ago, so it is
/// empty and `"wt"` truncates nothing; the mode is kept for symmetry with the
/// dialog path rather than because anything here depends on it.
#[cfg(target_os = "android")]
async fn open_granted(
    app: &tauri::AppHandle,
    name: &str,
    mime: Option<&str>,
) -> Result<(Open, String, Option<String>), String> {
    let created = storage::android::create_file(
        app,
        name,
        mime.filter(|m| !m.is_empty()).unwrap_or("application/octet-stream"),
    )
    .await?;
    let Ok(path) = created.uri.parse::<FilePath>();
    let mut options = OpenOptions::new();
    options.write(true).truncate(true);
    let file = match app.fs().open(path.clone(), options) {
        Ok(file) => file,
        Err(e) => {
            // Created and then unopenable: leave nothing empty behind.
            let _ = storage::android::delete_file(app, &created.uri).await;
            return Err(e.to_string());
        }
    };
    let location = format!("{}/{}", created.folder, created.name);
    Ok((Open { path, file, created: true }, created.name, Some(location)))
}

#[cfg(not(target_os = "android"))]
async fn open_granted(
    _app: &tauri::AppHandle,
    _name: &str,
    _mime: Option<&str>,
) -> Result<(Open, String, Option<String>), String> {
    unreachable!("storage::destination grants a folder only on Android")
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
    let Some(Open { path, mut file, .. }) = state.0.lock().unwrap().take() else {
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
/// Truncating through the handle we hold comes first, because it works on
/// every route, so the partial bytes are gone whatever happens next. Then the
/// file itself goes, but only one this sink created: a path is unlinked, and
/// a document in a granted Android folder is deleted through
/// `DocumentsContract.deleteDocument` (StoragePlugin.kt). That second half
/// could not exist while the destination came from `save()` -- there was no
/// Kotlin to call -- and a cancelled Android receive left an empty file under
/// the chosen name. A file the person picked on iOS is left, emptied: it may
/// have existed before they chose it.
///
/// `async` for `sink_open`'s reason: the delete is a round-trip into Kotlin.
#[tauri::command]
pub async fn sink_abort(
    app: tauri::AppHandle,
    state: tauri::State<'_, SinkState>,
) -> Result<(), String> {
    let Some(open) = state.0.lock().unwrap().take() else {
        return Ok(());
    };
    // Best effort throughout: the transfer is already being torn down, and a
    // failure to clean up a partial file is not worth surfacing as an error on
    // top of whatever caused the abort.
    let _ = open.file.set_len(0);
    drop(open.file);
    if !open.created {
        return Ok(());
    }
    match &open.path {
        FilePath::Path(path) => {
            let _ = fs::remove_file(path);
        }
        #[cfg(target_os = "android")]
        FilePath::Url(url) => {
            let _ = storage::android::delete_file(&app, url.as_str()).await;
        }
        #[cfg(not(target_os = "android"))]
        FilePath::Url(_) => {
            let _ = &app;
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
