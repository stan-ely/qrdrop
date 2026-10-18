//! The native session: a transfer run by `qrdrop-session` in Rust, with the
//! page drawing what it reports. app/src/native.js is the other half, and
//! `getPlatform().session` in src/web/platform.js is the seam element.js
//! branches on.
//!
//! Why the app has this at all is in docs/notes/rust-session.md ("Why"): the
//! JS session's ceilings on a phone are main-thread time per frame sending
//! and the base64 sink receiving, and Linux's WebKitGTK has no WebRTC, so
//! there the JS session cannot run at all.
//!
//! One task per transfer owns everything -- the pairing, the session, the
//! sink -- and the page reaches it only through `native_control`, as words:
//! confirm, reject, accept, decline, cancel. What the person decides stays
//! the page's, exactly as on the JS path:
//!
//! - **The sender's SAS confirm** is the page's "They match", and nothing
//!   leaves for the peer until it arrives. `native_send` pairs and then waits.
//! - **The receiver's Accept** is the page's Accept, as on the web, where the
//!   receiver's one gesture answers the SAS and the offer together. So the
//!   receiver confirms its pairing at once, which is what the JS receiver
//!   does by attaching its receiver straight away, and the file is written
//!   only after Accept.
//!
//! Events go back over a Tauri `Channel`, in order, one per transfer.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use qrdrop_protocol::{Manifest, NetworkPath, PEER_DISCONNECTED, Role, Secret};
use qrdrop_session::path::RELAYED_MAX_BYTES;
use qrdrop_session::{
    LanConfig, OpenConfig, Paired, SessionEvent, SessionEvents, SessionHandle, SessionOptions, Sink,
    Source, messages, open_room,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use tokio::sync::mpsc;

use crate::sink;

/// Progress is reported at most this often, plus the last: one event per
/// 16 KiB frame would be thousands a second across the IPC, for a bar the
/// page redraws every 100 ms anyway (element.js's PROGRESS_INTERVAL_MS).
const PROGRESS_EVERY: Duration = Duration::from_millis(50);

/// What the page is told, in the order it happened.
#[derive(Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum NativeEvent {
    /// room.js's status lines, as the JS session's `onStatus` gives them.
    Status { text: String },
    /// Paired: the four emoji, joined by spaces as `session.sas` is, and their
    /// words in order.
    Paired { sas: String, words: Vec<String> },
    /// The route, both sides' verdicts combined.
    Path { path: NetworkPath },
    /// An offer, for the receiver's Accept.
    Offer { name: String, size: u64 },
    /// An offer refused before it was shown: over the relay cap on a relayed
    /// connection. Already declined.
    TooLarge { message: String },
    /// The sink is open and the transfer is under way.
    Accepted,
    Progress { moved: u64, total: u64 },
    /// The sender's frames now cross the local network.
    Lan,
    Sent { digest: String },
    Received { name: String, size: u64, digest: String, location: String },
    Declined,
    /// The transfer is over, for the reason given.
    Error { message: String },
}

/// The person's words to a running transfer.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Word {
    Confirm,
    Reject,
    Accept,
    Decline,
    Cancel,
}

/// The running transfers, by id. In practice one: the app does one transfer
/// at a time, and a new one cancels nothing on its own -- the page tears the
/// old one down first.
#[derive(Default)]
pub struct NativeState {
    next: AtomicU32,
    running: Mutex<HashMap<u32, mpsc::UnboundedSender<Word>>>,
}

impl NativeState {
    fn add(&self) -> (u32, mpsc::UnboundedReceiver<Word>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        self.running.lock().unwrap().insert(id, tx);
        (id, rx)
    }
}

fn forget(app: &tauri::AppHandle, id: u32) {
    use tauri::Manager;
    app.state::<NativeState>().running.lock().unwrap().remove(&id);
}

/// Whether this build runs transfers natively unless the page says
/// otherwise. On Linux, where the webview has no WebRTC, it is the only way a
/// network transfer can run. Elsewhere the JS session stays the default until
/// the device runs in docs/notes/rust-session.md's phase 7 have passed;
/// `QRDROP_NATIVE_SESSION=1` (or `0`) overrides it on a desktop, and the page
/// keeps an override of its own for a phone (app/src/native.js).
#[tauri::command]
pub fn native_session_default() -> bool {
    match std::env::var("QRDROP_NATIVE_SESSION").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => cfg!(target_os = "linux"),
    }
}

/// A file the page has a path for, and what it is called.
#[derive(Serialize)]
pub struct NativeFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// Name and size of a path, for the page's send screen before anything is
/// opened for real. A dialog's pick and a desktop drop are both a path.
#[tauri::command]
pub fn native_stat(path: String) -> Result<NativeFile, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let name = std::path::Path::new(&path)
        .file_name()
        .map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
    Ok(NativeFile {
        path,
        name,
        size: meta.len(),
    })
}

/// A file read front to back, opened through plugin-fs so that a
/// `content://` URI works as well as a path.
struct FileSource {
    name: String,
    size: u64,
    file: std::fs::File,
}

impl Source for FileSource {
    fn name(&self) -> &str {
        &self.name
    }
    fn size(&self) -> u64 {
        self.size
    }
    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        self.file.read_exact(buf)
    }
}

/// The destination sink.rs opened, written on the session's sink thread.
/// Closing and aborting are round trips into Kotlin on Android, so they block
/// that thread on the runtime; it is a plain thread of its own, never one of
/// the runtime's.
struct NativeSink {
    app: tauri::AppHandle,
    open: Option<sink::Open>,
    name: String,
    location: Option<String>,
}

impl Sink for NativeSink {
    fn write(&mut self, data: &[u8]) -> io::Result<()> {
        self.open
            .as_mut()
            .expect("written only while open")
            .file
            .write_all(data)
    }

    fn close(mut self: Box<Self>) -> io::Result<String> {
        let open = self.open.take().expect("closed once");
        let closed = tauri::async_runtime::block_on(sink::finish(&self.app, open))
            .map_err(io::Error::other)?;
        Ok(match closed {
            // A MediaStore download is named for good only when published.
            Some(c) => c.location,
            None => self.location.take().unwrap_or_else(|| self.name.clone()),
        })
    }

    fn abort(mut self: Box<Self>) {
        if let Some(open) = self.open.take() {
            tauri::async_runtime::block_on(sink::discard(&self.app, open));
        }
    }
}

impl Drop for NativeSink {
    /// Dropped open is a partial file; gone, as abort would have it.
    fn drop(&mut self) {
        if let Some(open) = self.open.take() {
            tauri::async_runtime::block_on(sink::discard(&self.app, open));
        }
    }
}

/// No QUIC yet: the app is built without the feature until phase 9's gate
/// is measured on the phone (docs/notes/rust-session.md).
fn options() -> SessionOptions {
    SessionOptions {
        lan: Some(LanConfig::default()),
        quic: None,
    }
}

fn status_to(events: &Channel<NativeEvent>) -> qrdrop_session::pair::StatusFn {
    let events = events.clone();
    Arc::new(move |text: &str| {
        let _ = events.send(NativeEvent::Status { text: text.into() });
    })
}

/// What `native_send` hands back at once: the code is shown, as a QR and as
/// text, while the pairing waits for the other device.
#[derive(Serialize)]
pub struct Started {
    id: u32,
    code: String,
}

/// Start a send of `path`: generate the secret, return the code, and pair in
/// the background. The SAS goes to the page as `paired`, and nothing more
/// happens until it says `confirm` or `reject`.
#[tauri::command]
pub async fn native_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
    path: String,
    name: Option<String>,
    events: Channel<NativeEvent>,
) -> Result<Started, String> {
    let Ok(parsed) = path.parse::<FilePath>();
    let mut opts = OpenOptions::new();
    opts.read(true);
    let file = app.fs().open(parsed, opts).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let name = name.unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned())
    });
    let source = FileSource { name, size, file };
    let secret = Secret::generate();
    let code = secret.code();
    let (id, words) = state.add();
    tauri::async_runtime::spawn(async move {
        run_send(source, secret, &events, words).await;
        forget(&app, id);
    });
    Ok(Started { id, code })
}

/// Start a receive: the code is the person's, checked here as `decodeSecret`
/// checks it, fragment only.
#[tauri::command]
pub async fn native_receive(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
    code: String,
    events: Channel<NativeEvent>,
) -> Result<u32, String> {
    let secret = Secret::decode(&code).map_err(|e| e.to_string())?;
    let (id, words) = state.add();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        run_receive(app2.clone(), secret, &events, words).await;
        forget(&app2, id);
    });
    Ok(id)
}

/// The person's word to transfer `id`. A word for a transfer that has ended
/// is dropped, as a click on a screen that has moved on would be.
#[tauri::command]
pub fn native_control(state: tauri::State<'_, NativeState>, id: u32, word: Word) {
    if let Some(tx) = state.running.lock().unwrap().get(&id) {
        let _ = tx.send(word);
    }
}

async fn run_send(
    source: FileSource,
    secret: Secret,
    events: &Channel<NativeEvent>,
    mut words: mpsc::UnboundedReceiver<Word>,
) {
    let Some(paired) = pair(secret, Role::Host, events, &mut words).await else {
        return;
    };
    // The sender's half of the two safety gestures: the manifest -- the
    // file's name and size -- leaves only after this.
    loop {
        match words.recv().await {
            Some(Word::Confirm) => break,
            Some(Word::Reject | Word::Cancel) | None => return paired.reject().await,
            Some(_) => {}
        }
    }
    let (handle, mut session) = paired.confirm(Role::Host, options()).await;
    // Free TURN is metered: refuse before the manifest goes out, as the CLI
    // and element.js do.
    if source.size > RELAYED_MAX_BYTES && handle.path().await == NetworkPath::Relay {
        let _ = events.send(NativeEvent::Error {
            message: messages::relay_cap(&source.name, source.size),
        });
        return handle.close().await;
    }
    handle.send_file(Box::new(source));
    drive(None, &handle, &mut session, &mut words, events).await;
}

async fn run_receive(
    app: tauri::AppHandle,
    secret: Secret,
    events: &Channel<NativeEvent>,
    mut words: mpsc::UnboundedReceiver<Word>,
) {
    let Some(paired) = pair(secret, Role::Guest, events, &mut words).await else {
        return;
    };
    // The receiver's Accept answers the SAS and the offer together, as on the
    // web, so the pairing is confirmed now and nothing is written before it.
    let (handle, mut session) = paired.confirm(Role::Guest, options()).await;
    drive(Some(&app), &handle, &mut session, &mut words, events).await;
}

/// Pair, and tell the page the SAS. `None` when the page cancelled or the
/// pairing failed, which the page has then been told.
async fn pair(
    secret: Secret,
    role: Role,
    events: &Channel<NativeEvent>,
    words: &mut mpsc::UnboundedReceiver<Word>,
) -> Option<Paired> {
    let mut cfg = OpenConfig::new(secret, role);
    cfg.on_status = Some(status_to(events));
    let paired = tokio::select! {
        r = open_room(cfg) => r,
        () = cancelled(words) => return None,
    };
    match paired {
        Ok(p) => {
            let _ = events.send(NativeEvent::Paired {
                sas: p.sas().emoji(),
                words: p.sas().words().map(String::from).to_vec(),
            });
            Some(p)
        }
        Err(e) => {
            let _ = events.send(NativeEvent::Error {
                message: e.to_string(),
            });
            None
        }
    }
}

/// One running session to its end: its events to the page, the page's words
/// to it, and then the room left. `app` is the receive side's, which is the
/// only side that opens a sink -- and so the only side an offer may reach.
async fn drive(
    app: Option<&tauri::AppHandle>,
    handle: &SessionHandle,
    session: &mut SessionEvents,
    words: &mut mpsc::UnboundedReceiver<Word>,
    events: &Channel<NativeEvent>,
) {
    let emit = |e| {
        let _ = events.send(e);
    };
    let mut offered: Option<Manifest> = None;
    let mut reported: Option<Instant> = None;
    let mut progress = |moved: u64, total: u64| {
        let now = Instant::now();
        if moved < total && reported.is_some_and(|t| now - t < PROGRESS_EVERY) {
            return;
        }
        reported = Some(now);
        emit(NativeEvent::Progress { moved, total });
    };
    loop {
        tokio::select! {
            e = session.next() => match e {
                Some(SessionEvent::Path { combined, .. }) => emit(NativeEvent::Path { path: combined }),
                Some(SessionEvent::Offer(m)) => {
                    if app.is_none() {
                        emit(NativeEvent::Error { message: messages::OFFERED_WHILE_SENDING.into() });
                        break;
                    }
                    if m.size > RELAYED_MAX_BYTES && handle.path().await == NetworkPath::Relay {
                        handle.decline();
                        emit(NativeEvent::TooLarge { message: messages::relay_cap_decline(&m.name, m.size) });
                        break;
                    }
                    emit(NativeEvent::Offer { name: m.name.clone(), size: m.size });
                    offered = Some(m);
                }
                Some(SessionEvent::ReceiveProgress { received, total }) => progress(received, total),
                Some(SessionEvent::SendProgress { sent, total }) => progress(sent, total),
                Some(SessionEvent::SendAccepted) => {}
                Some(SessionEvent::Lan) => emit(NativeEvent::Lan),
                // Never, while options() leaves QUIC out.
                Some(SessionEvent::Quic) => {}
                Some(SessionEvent::Sent { digest }) => {
                    emit(NativeEvent::Sent { digest });
                    break;
                }
                Some(SessionEvent::Received { name, size, digest, location }) => {
                    // The name it was saved under -- `report (1).pdf` -- is
                    // what the done screen shows, and the location ends in it.
                    let saved = location.rsplit(['/', '\\']).next().filter(|s| !s.is_empty());
                    let name = saved.map_or(name, str::to_owned);
                    emit(NativeEvent::Received { name, size, digest, location });
                    break;
                }
                Some(SessionEvent::Declined) => {
                    emit(NativeEvent::Declined);
                    break;
                }
                Some(SessionEvent::Failed(message)) => {
                    emit(NativeEvent::Error { message });
                    break;
                }
                None => {
                    emit(NativeEvent::Error { message: PEER_DISCONNECTED.into() });
                    break;
                }
            },
            w = words.recv() => match w {
                Some(Word::Accept) => {
                    let (Some(app), Some(m)) = (app, offered.take()) else { continue };
                    match sink::open_new(app, m.name.clone(), Some(&m.mime)).await {
                        Ok((open, name, location)) => {
                            handle.accept(Box::new(NativeSink {
                                app: app.clone(),
                                open: Some(open),
                                name,
                                location,
                            }));
                            emit(NativeEvent::Accepted);
                        }
                        // Saving failed, which is not the person declining
                        // and must not be worded as though it were (the
                        // sink contract in CLAUDE.md). The peer learns from
                        // the room closing.
                        Err(message) => {
                            handle.cancel();
                            emit(NativeEvent::Error { message });
                            break;
                        }
                    }
                }
                // The page resets itself on a decline; nothing more to say.
                Some(Word::Decline) => {
                    handle.decline();
                    break;
                }
                Some(Word::Cancel) | None => {
                    handle.cancel();
                    break;
                }
                Some(_) => {}
            },
        }
    }
    handle.close().await;
}

/// Resolves when the page cancels, or goes away.
async fn cancelled(words: &mut mpsc::UnboundedReceiver<Word>) {
    loop {
        match words.recv().await {
            Some(Word::Cancel) | None => return,
            Some(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names app/src/native.js and platform.js's `NativeEvent` switch
    /// on. A rename here is silent on the page: an event nothing matches is
    /// dropped by `_nativeCommon`'s default.
    #[test]
    fn the_events_are_the_names_the_page_reads() {
        let json = |e: NativeEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(NativeEvent::TooLarge { message: "m".into() }),
            serde_json::json!({ "t": "tooLarge", "message": "m" }),
        );
        assert_eq!(
            json(NativeEvent::Path { path: NetworkPath::Local }),
            serde_json::json!({ "t": "path", "path": "local" }),
        );
        assert_eq!(
            json(NativeEvent::Progress { moved: 1, total: 2 }),
            serde_json::json!({ "t": "progress", "moved": 1, "total": 2 }),
        );
        assert_eq!(json(NativeEvent::Accepted), serde_json::json!({ "t": "accepted" }));

        let platform = include_str!("../../../src/web/platform.js");
        for t in [
            "status", "paired", "path", "offer", "tooLarge", "accepted", "progress", "lan", "sent",
            "received", "declined", "error",
        ] {
            assert!(platform.contains(&format!("{{ t: '{t}'")), "platform.js has no `{t}` event");
        }
    }

    #[test]
    fn the_words_are_the_page_words() {
        for (text, word) in [
            ("confirm", Word::Confirm),
            ("reject", Word::Reject),
            ("accept", Word::Accept),
            ("decline", Word::Decline),
            ("cancel", Word::Cancel),
        ] {
            assert_eq!(serde_json::from_value::<Word>(text.into()).unwrap(), word);
        }
        assert!(serde_json::from_value::<Word>("start".into()).is_err());
    }
}
