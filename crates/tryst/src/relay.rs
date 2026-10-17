//! One WebSocket per relay, kept open for as long as the room wants it.
//!
//! This is where `tryst` departs from Trystero on purpose. Trystero 0.25.4's
//! `makeSocket` backs off 3.3, 6.7, 13, 27 and 53 s after a close and then
//! marks the client closed for good, and every later room is handed that
//! dead client: on Android 15, whose background firewall blocks an app's uid
//! within seconds of it leaving the screen, that is "Timed out waiting for
//! the other device" until the app is force-stopped. So, here:
//!
//! - **A dropped socket is never a reason to stop.** The delay doubles to
//!   [`MAX_BACKOFF`] and stays there; the connection is retried forever.
//! - **Only the relay's own words retire it** -- a Nostr `CLOSED`, or an
//!   `OK false` that is not rate limiting -- and that is the caller's call,
//!   through [`Relay::retire`], because only the caller parses messages.
//! - **[`Relay::resume`] redials now** with the backoff reset, for the moment
//!   an app returns to the foreground.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rand_core::{OsRng, RngCore};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{Connector, connect_async_tls_with_config};

/// The first retry delay, Trystero's.
pub const FIRST_BACKOFF: Duration = Duration::from_millis(3_333);
/// The longest delay between two attempts, and the delay from then on.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// How a relay's retries are paced: doubling from `first` to `max`, then
/// `max` for ever.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    pub first: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            first: FIRST_BACKOFF,
            max: MAX_BACKOFF,
        }
    }
}
/// How long one connection attempt may take, TLS and upgrade included.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// What a relay's task reports. `index` is the relay's place in the list
/// it was opened from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelayEvent {
    Up(usize),
    Down(usize),
    Text(usize, String),
}

enum Cmd {
    Send(String),
    Resume,
    Retire,
}

/// A handle to one relay's task. Dropping it ends the task.
#[derive(Debug)]
pub struct Relay {
    url: String,
    tx: mpsc::UnboundedSender<Cmd>,
}

impl Relay {
    /// Start a task that keeps a WebSocket to `url` open and reports to
    /// `events`. Must be called inside a tokio runtime.
    pub fn open(
        index: usize,
        url: &str,
        backoff: Backoff,
        events: mpsc::UnboundedSender<RelayEvent>,
    ) -> Relay {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(index, url.to_owned(), backoff, rx, events));
        Relay {
            url: url.to_owned(),
            tx,
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// Send a text frame if the socket is up. Dropped otherwise, as a
    /// Trystero client drops it: every message here is repeated on a
    /// schedule, or answered by a peer that will ask again.
    pub fn send(&self, text: String) {
        let _ = self.tx.send(Cmd::Send(text));
    }

    /// Redial now if down, with the backoff reset.
    pub fn resume(&self) {
        let _ = self.tx.send(Cmd::Resume);
    }

    /// The relay refused us in words. Close and never dial it again.
    pub fn retire(&self) {
        let _ = self.tx.send(Cmd::Retire);
    }
}

fn tls() -> Arc<rustls::ClientConfig> {
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let roots = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            // ring, set here rather than through rustls' process default, which
            // is the host application's to choose.
            let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
            Arc::new(cfg)
        })
        .clone()
}

async fn run(
    index: usize,
    url: String,
    pace: Backoff,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
    events: mpsc::UnboundedSender<RelayEvent>,
) {
    let mut backoff = pace.first;
    loop {
        let attempt = tokio::time::timeout(
            CONNECT_TIMEOUT,
            connect_async_tls_with_config(&url, None, false, Some(Connector::Rustls(tls()))),
        );
        tokio::pin!(attempt);
        let ws = loop {
            tokio::select! {
                r = &mut attempt => break r.ok().and_then(Result::ok).map(|(ws, _)| ws),
                c = cmds.recv() => match c {
                    None | Some(Cmd::Retire) => return,
                    // Already dialing; a send has nowhere to go yet.
                    Some(Cmd::Resume) => backoff = pace.first,
                    Some(Cmd::Send(_)) => {}
                },
            }
        };
        if let Some(ws) = ws {
            backoff = pace.first;
            if events.send(RelayEvent::Up(index)).is_err() {
                return;
            }
            let (mut sink, mut stream) = ws.split();
            let retired = loop {
                tokio::select! {
                    m = stream.next() => match m {
                        Some(Ok(Message::Text(t))) => {
                            if events.send(RelayEvent::Text(index, t.to_string())).is_err() {
                                return;
                            }
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = sink.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break false,
                        Some(Ok(_)) => {}
                    },
                    c = cmds.recv() => match c {
                        Some(Cmd::Send(t)) => {
                            if sink.send(Message::Text(t.into())).await.is_err() {
                                break false;
                            }
                        }
                        Some(Cmd::Resume) => {}
                        None | Some(Cmd::Retire) => break true,
                    },
                }
            };
            let _ = sink.close().await;
            if retired || events.send(RelayEvent::Down(index)).is_err() {
                return;
            }
        }
        // Jittered, as Trystero's is, so a room's relays do not all redial
        // in the same instant after a network change.
        let wait = backoff.mul_f64(0.5 + (OsRng.next_u32() as f64 / u32::MAX as f64) * 0.5);
        backoff = (backoff * 2).min(pace.max);
        let sleep = tokio::time::sleep(wait);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                c = cmds.recv() => match c {
                    None | Some(Cmd::Retire) => return,
                    Some(Cmd::Resume) => {
                        backoff = pace.first;
                        break;
                    }
                    Some(Cmd::Send(_)) => {}
                },
            }
        }
    }
}
