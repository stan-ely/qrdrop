//! The app's History: a list of past transfers, kept in the app data
//! directory, and the switch that says whether to keep one.
//!
//! WHY RUST HOLDS IT, and not localStorage. Webview storage is the browser's to
//! clear: WebView2 drops it with its profile, and Android's "Clear cache" can
//! take it with the rest of the WebView's data. A history that vanished on its
//! own would be worse than none, and so would a switch that came back on by
//! itself after the person turned it off. One file in the app data directory
//! goes only when the app is uninstalled or its data is cleared, both of which
//! a person does on purpose.
//!
//! WHAT IT NEVER HOLDS. A pairing code, a key, a digest or the text of a
//! message. src/web/events.js builds the record as an explicit list of fields
//! and is tested to leave those out; `Entry` below is that list again, with
//! `deny_unknown_fields`, so a record that grew a field on the JS side is
//! refused here rather than written. A message is recorded as `kind: text`, and
//! `sanitise` drops any name or location one arrives with. Two fences, on the
//! two sides of the IPC, because this is the one place qrdrop puts anything
//! about a transfer at rest on a disk.
//!
//! WHAT IT DOES HOLD, which docs/threat-model.md and PRIVACY.md now say: the
//! names of files sent and received, their sizes, when, and where a received
//! one was saved. That rests on the device in the clear, readable by anything
//! that can read the app's data. It is on by default, by decision
//! (docs/notes/app-ui-revamp.md), and the switch and Clear history are the
//! answer to it.
//!
//! The same split as share.rs: each command resolves a directory and a `*_in`
//! function does the work, so the behaviour is tested on any host.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The store's filename inside the app data directory.
pub const FILE: &str = "history.json";

/// The most entries kept, newest first; an append past it drops the oldest.
/// A number rather than an age, because a list that empties itself on a
/// schedule is a second thing for a person to keep in mind, and 200 lines is
/// more than anyone scrolls while staying a few tens of kilobytes on disk.
pub const MAX_ENTRIES: usize = 200;

/// Lengths past which a string is cut. A filename is chosen by the peer, so
/// nothing about its length can be assumed; these keep one hostile name from
/// making the file megabytes long. Counted in chars, so a cut never lands
/// inside a UTF-8 sequence.
const MAX_NAME: usize = 512;
const MAX_LOCATION: usize = 1024;
const MAX_DATE: usize = 40;

/// Overrides the directory, for e2e/app-native.e2e.mjs: that suite drives the
/// real debug binary, which shares its data directory with an installed copy,
/// and its transfers do not belong in a person's own History.
const DIR_ENV: &str = "QRDROP_HISTORY_DIR";

/// Commands may run on more than one thread, and each is a read, a change
/// and a write of one file. Held across all three, so two appends at once
/// cannot both read the old list and lose one of them.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Sent,
    Received,
}

/// How the bytes travelled. Closed, like the rest, so the field cannot become
/// a place to put anything else.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Local,
    Direct,
    Relay,
    Unknown,
    Lan,
    Quic,
    Beam,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Sent,
    Received,
    Declined,
    Failed,
    TooLarge,
    Mismatch,
    Cancelled,
    Beamed,
}

/// One past transfer: `TransferRecord` in src/web/events.js, field for field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub kind: Kind,
    pub name: Option<String>,
    pub size: Option<u64>,
    pub direction: Option<Direction>,
    pub route: Option<Route>,
    pub outcome: Outcome,
    pub location: Option<String>,
    pub date: String,
}

/// The whole file, and what `history_list` returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Store {
    /// Whether to record. Default on, which is the plan's decision; a store
    /// that does not say is a first run.
    #[serde(default = "on")]
    pub enabled: bool,
    /// Newest first.
    #[serde(default)]
    pub entries: Vec<Entry>,
}

fn on() -> bool {
    true
}

impl Default for Store {
    fn default() -> Self {
        Store { enabled: true, entries: Vec::new() }
    }
}

fn cut(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    s.chars().take(max).collect()
}

/// What is written, from what arrived. A message keeps nothing but its kind,
/// its size and how it ended, whatever the page sent with it.
fn sanitise(mut entry: Entry) -> Entry {
    if entry.kind == Kind::Text {
        entry.name = None;
        entry.location = None;
    }
    entry.name = entry.name.map(|n| cut(n, MAX_NAME));
    entry.location = entry.location.map(|l| cut(l, MAX_LOCATION));
    entry.date = cut(entry.date, MAX_DATE);
    entry
}

fn read(dir: &Path) -> Result<Store, String> {
    match fs::read_to_string(dir.join(FILE)) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("history could not be read: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.to_string()),
    }
}

/// Written beside the file and renamed over it, so a crash mid-write leaves
/// the old list rather than half of a new one. Unparseable would be the worst
/// outcome here: see `clear_in` for what that costs the switch.
fn write(dir: &Path, store: &Store) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    let json = serde_json::to_vec(store).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(FILE)).map_err(|e| e.to_string())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // A panic while holding it left nothing half-done that the next caller
    // could see: every write is a rename.
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn list_in(dir: &Path) -> Result<Store, String> {
    let _held = lock();
    read(dir)
}

/// Records one transfer, newest first. `Ok(false)` when the switch is off:
/// refused here as well as in shell.js, so a page that forgot to ask still
/// cannot record what the person said not to.
pub fn append_in(dir: &Path, entry: Entry) -> Result<bool, String> {
    let _held = lock();
    let mut store = read(dir)?;
    if !store.enabled {
        return Ok(false);
    }
    store.entries.insert(0, sanitise(entry));
    store.entries.truncate(MAX_ENTRIES);
    write(dir, &store)?;
    Ok(true)
}

/// Empties the list and keeps the switch where it was. A store that cannot
/// be read is replaced, with recording OFF: the switch's last position is
/// unknown, and a person who had turned it off must not find it back on.
pub fn clear_in(dir: &Path) -> Result<Store, String> {
    let _held = lock();
    let enabled = read(dir).map(|s| s.enabled).unwrap_or(false);
    let store = Store { enabled, entries: Vec::new() };
    write(dir, &store)?;
    Ok(store)
}

/// Turns recording on or off. Off stops the next append and leaves what is
/// there: whether to clear it is a separate question, which Settings asks.
pub fn set_enabled_in(dir: &Path, enabled: bool) -> Result<Store, String> {
    let _held = lock();
    // An unreadable list is dropped rather than kept unreadable under a new
    // switch; nothing could ever show it.
    let mut store = read(dir).unwrap_or_default();
    store.enabled = enabled;
    write(dir, &store)?;
    Ok(store)
}

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os(DIR_ENV) {
        return Ok(PathBuf::from(dir));
    }
    use tauri::Manager;
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_list(app: tauri::AppHandle) -> Result<Store, String> {
    list_in(&dir(&app)?)
}

#[tauri::command]
pub fn history_append(app: tauri::AppHandle, entry: Entry) -> Result<bool, String> {
    append_in(&dir(&app)?, entry)
}

#[tauri::command]
pub fn history_clear(app: tauri::AppHandle) -> Result<Store, String> {
    clear_in(&dir(&app)?)
}

#[tauri::command]
pub fn history_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<Store, String> {
    set_enabled_in(&dir(&app)?, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qrdrop-history-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(name: &str) -> Entry {
        Entry {
            kind: Kind::File,
            name: Some(name.into()),
            size: Some(42),
            direction: Some(Direction::Received),
            route: Some(Route::Local),
            outcome: Outcome::Received,
            location: Some(format!("Downloads/qrdrop/{name}")),
            date: "2026-11-03T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn a_first_run_is_empty_and_recording() {
        let store = list_in(&temp()).unwrap();
        assert!(store.enabled);
        assert!(store.entries.is_empty());
    }

    #[test]
    fn entries_come_back_newest_first() {
        let dir = temp();
        assert!(append_in(&dir, entry("first.pdf")).unwrap());
        assert!(append_in(&dir, entry("second.pdf")).unwrap());
        let names: Vec<_> = list_in(&dir).unwrap().entries.into_iter().map(|e| e.name.unwrap()).collect();
        assert_eq!(names, ["second.pdf", "first.pdf"]);
    }

    #[test]
    fn the_list_is_capped_and_the_oldest_go() {
        let dir = temp();
        for i in 0..MAX_ENTRIES + 5 {
            append_in(&dir, entry(&format!("{i}.bin"))).unwrap();
        }
        let entries = list_in(&dir).unwrap().entries;
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].name.as_deref(), Some(format!("{}.bin", MAX_ENTRIES + 4).as_str()));
        assert_eq!(entries[MAX_ENTRIES - 1].name.as_deref(), Some("5.bin"));
    }

    #[test]
    fn nothing_is_recorded_while_the_switch_is_off() {
        let dir = temp();
        append_in(&dir, entry("kept.pdf")).unwrap();
        set_enabled_in(&dir, false).unwrap();
        assert!(!append_in(&dir, entry("refused.pdf")).unwrap());
        let store = list_in(&dir).unwrap();
        assert!(!store.enabled);
        // Off leaves what was there: clearing it is Settings' question.
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries[0].name.as_deref(), Some("kept.pdf"));
    }

    #[test]
    fn clear_empties_and_keeps_the_switch() {
        let dir = temp();
        append_in(&dir, entry("a.pdf")).unwrap();
        set_enabled_in(&dir, false).unwrap();
        let store = clear_in(&dir).unwrap();
        assert!(store.entries.is_empty());
        assert!(!store.enabled);
        assert_eq!(list_in(&dir).unwrap(), store);
    }

    #[test]
    fn an_unreadable_store_is_reported_and_clear_replaces_it_switched_off() {
        let dir = temp();
        fs::write(dir.join(FILE), "{not json").unwrap();
        assert!(list_in(&dir).is_err());
        assert!(append_in(&dir, entry("a.pdf")).is_err());
        // The switch's last position is unknown, so off: a person who had
        // turned it off must not find it back on.
        let store = clear_in(&dir).unwrap();
        assert!(!store.enabled);
        assert!(store.entries.is_empty());
    }

    #[test]
    fn a_message_keeps_no_name_and_no_location() {
        let dir = temp();
        append_in(
            &dir,
            Entry { kind: Kind::Text, name: Some("message.txt".into()), ..entry("ignored") },
        )
        .unwrap();
        let saved = &list_in(&dir).unwrap().entries[0];
        assert_eq!(saved.kind, Kind::Text);
        assert_eq!(saved.name, None);
        assert_eq!(saved.location, None);
    }

    #[test]
    fn a_record_with_a_field_this_does_not_name_is_refused() {
        // The JS record growing a field -- the code, the digest, the text --
        // must fail here at the IPC rather than reach the disk.
        let raw = r#"{"kind":"file","name":"a.pdf","size":1,"direction":"sent","route":"lan",
            "outcome":"sent","location":null,"date":"2026-11-03T10:00:00.000Z","digest":"abc"}"#;
        assert!(serde_json::from_str::<Entry>(raw).is_err());
    }

    #[test]
    fn the_shape_events_js_sends_is_accepted() {
        // Every outcome and route the page can produce, spelled as it spells them.
        for outcome in ["sent", "received", "declined", "failed", "too-large", "mismatch", "cancelled", "beamed"] {
            for route in ["local", "direct", "relay", "unknown", "lan", "quic", "beam"] {
                let raw = format!(
                    r#"{{"kind":"file","name":null,"size":null,"direction":null,"route":"{route}",
                    "outcome":"{outcome}","location":null,"date":"2026-11-03T10:00:00.000Z"}}"#
                );
                serde_json::from_str::<Entry>(&raw).unwrap_or_else(|e| panic!("{outcome}/{route}: {e}"));
            }
        }
    }

    #[test]
    fn a_hostile_name_is_cut_on_a_char_boundary() {
        let dir = temp();
        append_in(&dir, entry(&"é".repeat(MAX_NAME * 4))).unwrap();
        let saved = &list_in(&dir).unwrap().entries[0];
        assert_eq!(saved.name.as_ref().unwrap().chars().count(), MAX_NAME);
    }

    #[test]
    fn a_write_leaves_no_temporary_file_behind() {
        let dir = temp();
        append_in(&dir, entry("a.pdf")).unwrap();
        assert!(!dir.join(format!("{FILE}.tmp")).exists());
    }
}
