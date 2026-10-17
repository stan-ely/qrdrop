//! Where a received file goes, decided without asking at Accept.
//!
//! Every receive used to open plugin-dialog's `save()` the moment Accept was
//! pressed, and on Android that dialog is its own task: opening it is qrdrop
//! leaving the screen. ColorOS freezes a backgrounded app about 11 s later,
//! and a freeze longer than the sender's 30 s ICE consent timeout lost the
//! transfer (CLAUDE.md, "ColorOS freezes the app while the save dialog is
//! open"). That is not something a better dialog fixes, so there is no dialog.
//! The offer screen already shows the name and size, and that is the whole
//! decision: Accept saves, Decline declines.
//!
//! The rule, in order:
//!
//! - **A folder the person granted on Android** (a persisted SAF tree grant),
//!   if one is held. Files are created in it with `DocumentsContract`, through
//!   the Kotlin half of this module (`gen/.../StoragePlugin.kt`).
//! - **`Download/qrdrop`**. On desktop, the Downloads folder with plain
//!   `std::fs`. On Android 10+ (API 29+), a `MediaStore.Downloads` entry with
//!   that relative path, created pending and finished on close.
//! - **Otherwise** -- Android 7 to 9, which can write to neither without a
//!   storage permission -- the person picks a folder once, and it becomes the
//!   first rule from then on. That pick happens on the Receive tap, before any
//!   pairing exists (`save_prepare`), so a freeze inside the picker has no
//!   peer to lose.
//!
//! WHY MEDIASTORE AND NOT A PATH ON ANDROID. Scoped storage does let an app
//! create its own files in the shared Download folder by plain path on
//! Android 11+, and that was the first version of this module. MEASURED on an
//! Android 15 emulator, it does not index them reliably: FUSE inserts the
//! MediaStore row at create as `is_pending=1` with no size, and closing the
//! file does not settle it. Some rows were still pending minutes later, some
//! settled on their own, one file had no row at all, and an explicit
//! `MediaScannerConnection.scanFile` straight after close raced the same way.
//! A pending row is hidden from every other app and purged after about a
//! week. Inserting through MediaStore is the documented route and settles by
//! construction: the row exists before a byte is written, and clearing
//! `IS_PENDING` at close is what makes the provider scan the finished file.
//! It also reaches Android 10, where a path cannot.
//!
//! `download_dir()` is **not** the shared folder on Android, and that is the
//! trap if anyone reaches for a path again. Tauri resolves it through
//! `getExternalFilesDir(DIRECTORY_DOWNLOADS)`, which is
//! `Android/data/com.stan_ely.qrdrop/files/Download`: private to the app,
//! hidden from most file managers since Android 11, and deleted with it.
//!
//! Nothing is ever overwritten. A desktop path is opened `create_new`, which
//! is atomic, and the next free `name (n).ext` is tried on a collision -- the
//! scheme Android uses, so every route names a second copy alike. A MediaStore
//! insert and `createDocument` both always make a new entry and de-duplicate
//! the name themselves.

#[cfg(not(target_os = "android"))]
use std::fs;
#[cfg(not(target_os = "android"))]
use std::io;
#[cfg(not(target_os = "android"))]
use std::path::{Path, PathBuf};

#[cfg(not(target_os = "android"))]
use tauri::Manager;

/// The subfolder received files land in, under Downloads.
pub const FOLDER_NAME: &str = "qrdrop";

/// How far `name (n).ext` may count before giving up. Not a limit anyone
/// will meet by receiving files; it is what stops a directory that refuses
/// every name with `AlreadyExists` from looping forever.
#[cfg(not(target_os = "android"))]
const MAX_SUFFIX: u32 = 999;

/// How this target decides where a received file goes. Returned to the JS
/// side by `save_mode`, so tauri-sink.js never has to sniff a user agent.
///
/// - `"fixed"`: desktop, always Downloads/qrdrop.
/// - `"android"`: the rule in the module comment, and the done screen offers
///   "Change folder".
/// - `"dialog"`: iOS, which keeps plugin-dialog's `save()`. It ships to nobody
///   (CLAUDE.md), and its sandbox has no shared Downloads to write into.
const MODE: &str = if cfg!(target_os = "android") {
    "android"
} else if cfg!(target_os = "ios") {
    "dialog"
} else {
    "fixed"
};

#[tauri::command]
pub fn save_mode() -> &'static str {
    MODE
}

/// Splits `name` at its last dot into a stem and an extension that keeps the
/// dot. A leading dot is not an extension (`.bashrc` is all stem), and only
/// the last dot counts, so `a.tar.gz` becomes `a.tar (1).gz` -- what Android's
/// provider and most file managers do, and better than inventing a rule.
#[cfg(not(target_os = "android"))]
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        None | Some(0) => (name, ""),
        Some(i) => (&name[..i], &name[i..]),
    }
}

/// The `n`th name to try: the name itself, then `stem (n).ext`.
#[cfg(not(target_os = "android"))]
fn candidate(name: &str, n: u32) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, ext) = split_name(name);
    format!("{stem} ({n}){ext}")
}

/// One path component, whatever the peer sent. tauri-sink.js has already run
/// `safeFilename` over it; this is the second check rather than the first,
/// because a name is about to become a path on this side of the boundary and
/// a separator surviving into `dir.join` would be a path traversal.
#[cfg(not(target_os = "android"))]
fn component(name: &str) -> String {
    let last = name
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .next_back()
        .unwrap_or("");
    let cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim_start_matches('.').trim();
    if cleaned.is_empty() {
        "received.bin".into()
    } else {
        cleaned.into()
    }
}

/// Creates a file in `dir` under `name` or the first free `name (n).ext`, and
/// never opens one that exists. Returns the file and its path.
#[cfg(not(target_os = "android"))]
pub fn create_unique(dir: &Path, name: &str) -> io::Result<(fs::File, PathBuf)> {
    let name = component(name);
    for n in 0..=MAX_SUFFIX {
        let path = dir.join(candidate(&name, n));
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("{} already holds {MAX_SUFFIX} copies of {name}", dir.display()),
    ))
}

/// Downloads/qrdrop on a desktop, created if missing.
#[cfg(not(target_os = "android"))]
pub fn downloads_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join(FOLDER_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// What the done screen says, `Downloads/qrdrop/report (1).pdf`: the last two
/// folders and the name. The full path is true and too long for a phone, and
/// the last two components are what a person looks for in a file manager.
#[cfg(not(target_os = "android"))]
pub fn display_location(path: &Path) -> String {
    let parts: Vec<_> = path
        .components()
        .rev()
        .take(3)
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

/// The destination one receive is about to be written to.
pub enum Destination {
    /// A directory std::fs can write into: a desktop's Downloads/qrdrop.
    #[cfg(not(target_os = "android"))]
    Folder(PathBuf),
    /// A folder the person granted on Android; files go through Kotlin.
    #[cfg(target_os = "android")]
    Granted,
    /// Download/qrdrop through MediaStore, Android 10+.
    #[cfg(target_os = "android")]
    Downloads,
}

/// Which destination applies right now. Fails, rather than falling through to
/// a dialog, when Android has nowhere to write: `save_prepare` runs before
/// pairing to make sure that never happens at Accept, so reaching it here means
/// the grant vanished in between, and the error says so.
pub async fn destination(app: &tauri::AppHandle) -> Result<Destination, String> {
    #[cfg(target_os = "android")]
    {
        let status = android::status(app).await?;
        if status.folder.is_some() {
            return Ok(Destination::Granted);
        }
        if status.sdk >= android::MEDIASTORE_DOWNLOADS_SDK {
            return Ok(Destination::Downloads);
        }
        Err(NO_FOLDER.into())
    }
    #[cfg(not(target_os = "android"))]
    {
        downloads_folder(app).map(Destination::Folder)
    }
}

/// Said when Android has no folder to write into. Reaches the error sheet as
/// itself, through `accept()`'s reject path, never as "the dialog was closed".
#[cfg(target_os = "android")]
const NO_FOLDER: &str =
    "The folder qrdrop saves into is no longer available. Start a new receive to choose another.";

/// Makes sure a receive has somewhere to go before it starts, which is the
/// one moment a picker cannot cost a transfer: no room is joined and no camera
/// is open yet. Resolves false only when the person dismissed the picker.
///
/// Desktop and Android 10+ have their answer already and return at once, so
/// for nearly everyone this is a no-op on every Receive tap.
#[tauri::command]
pub async fn save_prepare(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let status = android::status(&app).await?;
        if status.folder.is_some() || status.sdk >= android::MEDIASTORE_DOWNLOADS_SDK {
            return Ok(true);
        }
        Ok(android::pick_folder(&app).await?.is_some())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(true)
    }
}

/// The done screen's "Change folder": asks for a folder whatever is held now,
/// and a chosen folder then overrides Download/qrdrop. Resolves to the new
/// folder's label, or null when the picker was dismissed and nothing changed.
/// Android only; the JS side never offers it elsewhere.
#[tauri::command]
pub async fn save_change_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        android::pick_folder(&app).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Changing the save folder is only available on Android".into())
    }
}

/// The Rust end of `StoragePlugin.kt`, the only Kotlin this module needs.
///
/// An app-local Tauri plugin rather than another hand-edit in MainActivity.kt,
/// because a folder grant is `startActivityForResult` with a result to wait
/// for, and only a Plugin gets Tauri's activity-result plumbing. It is not a
/// plugin crate either: the class lives in the app's own package in `gen/`, is
/// compiled with the app, and is found through the activity's class loader, so
/// it needs no Gradle entry. JS never invokes it directly -- the commands
/// above do, from Rust -- so it needs no ACL permission manifest.
#[cfg(target_os = "android")]
pub mod android {
    use serde::{Deserialize, Serialize};
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Wry};

    /// An entry created for one receive, in either Android route.
    #[derive(Deserialize)]
    pub struct Created {
        /// The `content://` URI, opened by plugin-fs exactly as `save()`'s was.
        pub uri: String,
        /// The name after the provider's own de-duplication -- final for a
        /// document, provisional for a MediaStore download, which is renamed
        /// on a clash only when published (`finish_download`).
        pub name: String,
        /// The folder's display name: the granted one, or `Download/qrdrop`.
        pub folder: String,
    }

    /// Android 10: the first version with `MediaStore.Downloads`, which
    /// creates a file in the shared Download folder without a permission.
    pub const MEDIASTORE_DOWNLOADS_SDK: i32 = 29;

    struct Storage(PluginHandle<Wry>);

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("qrdrop-storage")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.stan_ely.qrdrop", "StoragePlugin")?;
                app.manage(Storage(handle));
                Ok(())
            })
            .build()
    }

    #[derive(Deserialize)]
    pub struct Status {
        pub sdk: i32,
        /// The held folder's display name; None when no grant is held, or
        /// when the one held no longer resolves (Kotlin releases it then).
        pub folder: Option<String>,
    }

    #[derive(Deserialize)]
    struct Picked {
        folder: Option<String>,
    }

    #[derive(Serialize)]
    struct CreateArgs<'a> {
        name: &'a str,
        mime: Option<&'a str>,
    }

    #[derive(Serialize)]
    struct UriArgs<'a> {
        uri: &'a str,
    }

    fn handle(app: &tauri::AppHandle) -> PluginHandle<Wry> {
        app.state::<Storage>().0.clone()
    }

    async fn call<T: serde::de::DeserializeOwned>(
        app: &tauri::AppHandle,
        command: &str,
        args: impl Serialize,
    ) -> Result<T, String> {
        handle(app)
            .run_mobile_plugin_async(command, args)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn status(app: &tauri::AppHandle) -> Result<Status, String> {
        call(app, "status", ()).await
    }

    pub async fn pick_folder(app: &tauri::AppHandle) -> Result<Option<String>, String> {
        call::<Picked>(app, "pickFolder", ()).await.map(|p| p.folder)
    }

    /// A new document in the granted folder.
    pub async fn create_in_folder(
        app: &tauri::AppHandle,
        name: &str,
        mime: Option<&str>,
    ) -> Result<Created, String> {
        call(app, "createFile", CreateArgs { name, mime }).await
    }

    /// A new, pending MediaStore entry in Download/qrdrop.
    pub async fn create_download(
        app: &tauri::AppHandle,
        name: &str,
        mime: Option<&str>,
    ) -> Result<Created, String> {
        call(app, "createDownload", CreateArgs { name, mime }).await
    }

    #[derive(Deserialize)]
    struct Finished {
        name: Option<String>,
    }

    /// Clears a MediaStore entry's pending flag once its file is closed --
    /// the update that makes the provider scan it and publish its size -- and
    /// returns the name it was published under, which the provider settles
    /// only now (see finishDownload in StoragePlugin.kt).
    pub async fn finish_download(app: &tauri::AppHandle, uri: &str) -> Result<Option<String>, String> {
        call::<Finished>(app, "finishDownload", UriArgs { uri }).await.map(|f| f.name)
    }

    /// Deletes either kind of entry; best effort on the Kotlin side.
    pub async fn delete(app: &tauri::AppHandle, uri: &str) -> Result<(), String> {
        call::<serde_json::Value>(app, "deleteFile", UriArgs { uri }).await.map(|_| ())
    }
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    #[test]
    fn names_a_second_copy_the_way_android_does() {
        assert_eq!(candidate("report.pdf", 0), "report.pdf");
        assert_eq!(candidate("report.pdf", 1), "report (1).pdf");
        assert_eq!(candidate("a.tar.gz", 2), "a.tar (2).gz");
        assert_eq!(candidate("Makefile", 1), "Makefile (1)");
        assert_eq!(candidate(".bashrc", 1), ".bashrc (1)");
    }

    #[test]
    fn a_name_cannot_leave_the_folder() {
        assert_eq!(component("../../etc/passwd"), "passwd");
        assert_eq!(component(r"..\..\boot.ini"), "boot.ini");
        assert_eq!(component("..."), "received.bin");
        assert_eq!(component("a\u{0}b.txt"), "ab.txt");
        assert_eq!(component(""), "received.bin");
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qrdrop-storage-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn never_opens_a_file_that_exists() {
        let dir = scratch("unique");
        fs::write(dir.join("report.pdf"), b"keep me").unwrap();
        fs::write(dir.join("report (1).pdf"), b"and me").unwrap();

        let (_file, path) = create_unique(&dir, "report.pdf").unwrap();
        assert_eq!(path, dir.join("report (2).pdf"));
        assert_eq!(fs::read(dir.join("report.pdf")).unwrap(), b"keep me");
        assert_eq!(fs::read(dir.join("report (1).pdf")).unwrap(), b"and me");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_where_the_file_went_in_three_components() {
        let path = Path::new("/home/someone/Downloads/qrdrop/report (1).pdf");
        assert_eq!(display_location(path), "Downloads/qrdrop/report (1).pdf");
    }
}
