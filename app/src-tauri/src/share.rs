//! The Android share sheet's Rust half -- the pickup end of a handoff whose
//! other end is Kotlin.
//!
//! WHY A FILE ON DISK IS THE BRIDGE, and not JNI. An ACTION_SEND intent
//! arrives in `MainActivity` as a `content://` URI, which only Android's
//! ContentResolver can read -- there is no path for Rust to open and no way
//! to hand the descriptor across without a Tauri Android plugin, which is a
//! Kotlin class, a Rust binding, a build.gradle entry and a permissions
//! manifest for what is, in the end, one filename and one number.
//!
//! So MainActivity copies the shared stream into the app's own cache
//! directory -- a real filesystem path -- and writes this JSON beside it. All
//! this side does is read that file and delete it. Nothing here is
//! Android-specific: it is `std::fs` on a path the app already owns, which is
//! why it compiles and is tested on the desktop host where no share sheet
//! exists.
//!
//! IT IS A TAKE, NOT A READ. `take_shared_file` deletes the handoff before it
//! returns, so a share is consumed exactly once. Leaving it in place was the
//! first shape and is wrong in both directions: the JS side polls on resume
//! (app/src/main.js), so a handoff that survived would re-offer the same file
//! every time the app came back to the foreground, and a file the person has
//! already sent would sit in the cache indefinitely afterwards.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The handoff MainActivity writes, and the shape this returns to JS.
///
/// `size` is carried rather than stat'd on this side because the JS caller
/// shows it on the send screen before a byte is read, and because a mismatch
/// between what Kotlin copied and what is on disk is worth being able to see
/// rather than silently papering over with a fresh `metadata()` call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SharedFile {
    /// The display name from the content provider. Peer-supplied in the sense
    /// that matters: another app chose it. It reaches the UI through the same
    /// vnode path every other filename does (no innerHTML anywhere -- see
    /// src/web/vdom.js), and it is never used to build a path here.
    pub name: String,
    /// Absolute path inside the app's cache directory.
    pub path: String,
    pub size: u64,
}

/// The handoff's filename inside the app cache directory. A constant shared
/// with MainActivity.kt, which writes it; the two must agree and there is no
/// compiler that can check that, so both name this comment.
pub const HANDOFF: &str = "qrdrop-share.json";

/// Reads and removes the handoff, if MainActivity left one.
///
/// `Ok(None)` is the ordinary case -- the app was opened from its launcher
/// icon and nothing was shared into it. Only a malformed or unreadable
/// handoff is an error, and even that is reported rather than swallowed: a
/// share that silently does nothing is the failure mode this whole path is
/// most likely to have, and the hardest to tell apart from the share sheet
/// not being wired up at all.
#[tauri::command]
pub fn take_shared_file(app: tauri::AppHandle) -> Result<Option<SharedFile>, String> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    take_shared_file_in(&dir)
}

/// The testable half: everything above resolves a directory, this does the
/// work. Split so the behaviour can be pinned on the desktop host, where
/// there is no AppHandle worth building and no share sheet to produce one.
pub fn take_shared_file_in(dir: &Path) -> Result<Option<SharedFile>, String> {
    let handoff: PathBuf = dir.join(HANDOFF);
    let raw = match fs::read_to_string(&handoff) {
        Ok(raw) => raw,
        // NotFound is the ordinary case and must not be an error -- see above.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    // Deleted before it is parsed, deliberately. A handoff this side cannot
    // understand would otherwise be re-read on every resume, failing the same
    // way forever, and the person would have no way to clear it but to
    // reinstall.
    let _ = fs::remove_file(&handoff);

    let shared: SharedFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    // The copied file may be gone even though the handoff is not -- Android
    // clears an app's cache directory under storage pressure, and it is free
    // to take the payload and leave this JSON. Reporting "nothing shared" is
    // right: there is no file to send, and an error here would blame the
    // share sheet for the OS reclaiming disk.
    if !Path::new(&shared.path).exists() {
        return Ok(None);
    }

    Ok(Some(shared))
}

/// The launch handoff's filename. Written by MainActivity.kt, same agreement
/// and same lack of a compiler to check it as `HANDOFF` above.
pub const LAUNCH_HANDOFF: &str = "qrdrop-launch.json";

/// What a launcher shortcut or the Quick Settings tile asked for.
///
/// One string, and it is deliberately not an enum on this side. The set of
/// actions is defined twice already -- in res/xml/shortcuts.xml, which names
/// them, and in element.js's `startAction`, which maps them to intents -- and
/// a third definition here would be a third place to edit and the only one
/// that cannot be tested against the other two. This layer's job is to carry
/// the string and delete the file.
///
/// IT IS NOT TRUSTED INPUT, despite coming from our own manifest. MainActivity
/// is an exported activity, so any app on the device can fire an intent at it
/// carrying whatever it likes in that extra. That is harmless because nothing
/// ever interpolates this value -- Kotlin checks it against a fixed list
/// before writing it, and element.js looks it up in a fixed map that returns
/// nothing for anything else -- but the reason it is harmless is worth
/// writing down, since the obvious "just pass it through" is only safe while
/// both of those hold.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LaunchAction {
    pub action: String,
}

/// Reads and removes the launch handoff, if MainActivity left one.
///
/// The share handoff's twin in every respect that matters: `Ok(None)` on the
/// ordinary launch, a take rather than a read so a resume does not re-run the
/// same shortcut, and registered on every target rather than gated behind
/// `#[cfg(target_os = "android")]` so it compiles and tests on a desktop host
/// and JS never has to special-case a missing command.
#[tauri::command]
pub fn take_launch_action(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    take_launch_action_in(&dir)
}

/// The testable half -- see `take_shared_file_in`.
pub fn take_launch_action_in(dir: &Path) -> Result<Option<String>, String> {
    let handoff: PathBuf = dir.join(LAUNCH_HANDOFF);
    let raw = match fs::read_to_string(&handoff) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    // Deleted before parsing, for the reason take_shared_file_in gives: a
    // handoff this side cannot understand would otherwise fail identically on
    // every resume with no way to clear it short of reinstalling.
    let _ = fs::remove_file(&handoff);

    let launch: LaunchAction = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(launch.action))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qrdrop-share-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn no_handoff_is_not_an_error() {
        let dir = temp();
        assert_eq!(take_shared_file_in(&dir).unwrap(), None);
    }

    #[test]
    fn a_handoff_is_returned_once_and_then_gone() {
        let dir = temp();
        let payload = dir.join("holiday.jpg");
        fs::write(&payload, b"jpeg bytes").unwrap();
        fs::write(
            dir.join(HANDOFF),
            serde_json::to_string(&SharedFile {
                name: "holiday.jpg".into(),
                path: payload.to_string_lossy().into_owned(),
                size: 10,
            })
            .unwrap(),
        )
        .unwrap();

        let first = take_shared_file_in(&dir).unwrap().expect("a share");
        assert_eq!(first.name, "holiday.jpg");
        assert_eq!(first.size, 10);

        // The take, which is the point: resuming the app must not re-offer a
        // file the person has already been shown.
        assert_eq!(take_shared_file_in(&dir).unwrap(), None);
    }

    #[test]
    fn a_handoff_whose_payload_the_os_reclaimed_reports_nothing() {
        let dir = temp();
        fs::write(
            dir.join(HANDOFF),
            serde_json::to_string(&SharedFile {
                name: "gone.pdf".into(),
                path: dir.join("gone.pdf").to_string_lossy().into_owned(),
                size: 4096,
            })
            .unwrap(),
        )
        .unwrap();
        // Android clears app cache under storage pressure and may take the
        // payload while leaving the JSON. That is not an error to report.
        assert_eq!(take_shared_file_in(&dir).unwrap(), None);
    }

    #[test]
    fn a_malformed_handoff_errors_but_does_not_come_back() {
        let dir = temp();
        fs::write(dir.join(HANDOFF), "{not json").unwrap();
        assert!(take_shared_file_in(&dir).is_err());
        // Deleted before parsing, so it cannot fail the same way forever.
        assert_eq!(take_shared_file_in(&dir).unwrap(), None);
    }

    #[test]
    fn no_launch_handoff_is_not_an_error() {
        let dir = temp();
        assert_eq!(take_launch_action_in(&dir).unwrap(), None);
    }

    #[test]
    fn a_launch_action_is_returned_once_and_then_gone() {
        let dir = temp();
        fs::write(
            dir.join(LAUNCH_HANDOFF),
            serde_json::to_string(&LaunchAction { action: "receive".into() }).unwrap(),
        )
        .unwrap();

        assert_eq!(take_launch_action_in(&dir).unwrap().as_deref(), Some("receive"));
        // The JS side calls this again on every window focus, and a shortcut
        // that re-ran itself on every resume would drag a person back to the
        // scanner from wherever they had got to.
        assert_eq!(take_launch_action_in(&dir).unwrap(), None);
    }

    #[test]
    fn a_malformed_launch_handoff_errors_but_does_not_come_back() {
        let dir = temp();
        fs::write(dir.join(LAUNCH_HANDOFF), "{not json").unwrap();
        assert!(take_launch_action_in(&dir).is_err());
        assert_eq!(take_launch_action_in(&dir).unwrap(), None);
    }

    #[test]
    fn the_two_handoffs_do_not_collide() {
        // They live in one directory and are taken by two callers on the same
        // resume. A share must survive a launch pickup and the other way
        // round, or a file shared into a cold app would be dropped by the
        // shortcut check that runs beside it.
        let dir = temp();
        let payload = dir.join("notes.txt");
        fs::write(&payload, b"bytes").unwrap();
        fs::write(
            dir.join(HANDOFF),
            serde_json::to_string(&SharedFile {
                name: "notes.txt".into(),
                path: payload.to_string_lossy().into_owned(),
                size: 5,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(LAUNCH_HANDOFF),
            serde_json::to_string(&LaunchAction { action: "send".into() }).unwrap(),
        )
        .unwrap();

        assert_eq!(take_launch_action_in(&dir).unwrap().as_deref(), Some("send"));
        assert_eq!(
            take_shared_file_in(&dir).unwrap().expect("a share").name,
            "notes.txt"
        );
    }
}
