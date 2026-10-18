//! Rooms that interoperate with [Trystero](https://github.com/dmotz/trystero)
//! 0.25 peers: a Rust peer joins the same room as a browser running Trystero,
//! finds it through the same Nostr relays or WebTorrent trackers, passes the
//! same password handshake, and exchanges the same actions with it.
//!
//! ```no_run
//! use tryst::join::{JoinConfig, RoomEvent, join};
//! use tryst::signal::Strategy;
//! use tryst::wire::Payload;
//!
//! # #[tokio::main(flavor = "current_thread")]
//! # async fn main() -> Result<(), tryst::join::JoinError> {
//! // The app ID, room and password a Trystero page would pass to joinRoom.
//! let mut cfg = JoinConfig::new(
//!     Strategy::Nostr,
//!     "my-app",
//!     "my-room",
//!     "a shared password",
//!     &["wss://relay.example.com"],
//! );
//! cfg.stun = vec!["stun.l.google.com:19302".into()];
//!
//! let mut room = join(cfg).await?;
//! while let Some(event) = room.next_event().await {
//!     match event {
//!         RoomEvent::Joined(peer) => {
//!             // makeAction('chat')'s send, to that one peer.
//!             let _ = room
//!                 .send("chat", Payload::Text("hello".into()), None, Some(&peer))
//!                 .await;
//!         }
//!         RoomEvent::Message { peer, message } if message.action == "chat" => {
//!             println!("{peer}: {:?}", message.payload);
//!         }
//!         RoomEvent::Left(peer) => println!("{peer} left"),
//!         _ => {}
//!     }
//! }
//! room.leave().await;
//! # Ok(())
//! # }
//! ```
//!
//! The wire this speaks is written down in qrdrop's
//! `docs/notes/rust-session.md`, under "The wire, as the Rust side must speak
//! it". `vectors/trystero.json` (computed by Trystero's own modules) and the
//! two recordings of real Trystero traffic beside it are what it is tested
//! against.
//!
//! The split this crate keeps: a sans-IO core with no feature gates, and the
//! parts that do IO behind `nostr`, `torrent` and `webrtc`. The core is four
//! modules, each driven by plain calls and drained by `poll_*`:
//!
//! - [`crypto`]: topics, the room token, the signal cipher, the handshake hash.
//! - [`wire`]: the action chunk, its reassembly, and the room frame.
//! - [`room`]: the password handshake, `@_leave`, and messages between peers
//!   whose channels are open.
//! - [`signal`]: who offers, glare, and the life of each offer and answer.
//!
//! Behind `webrtc`, [`webrtc`] is the str0m peer connection the signaller
//! makes connections through -- sans-IO as well, since str0m is.
//!
//! Behind `nostr` or `torrent` with `webrtc`, [`join`] is the one part that
//! does IO: relays over WebSocket ([`relay`]), a UDP socket, and the core
//! driven on tokio. [`join::join`] is Trystero's `joinRoom`.

#![forbid(unsafe_code)]
// Published: every public item is a promise to someone reading docs.rs.
#![warn(missing_docs)]

pub mod crypto;
pub mod room;
pub mod signal;
pub mod wire;

#[cfg(feature = "webrtc")]
pub mod webrtc;

#[cfg(feature = "nostr")]
pub mod nostr;
#[cfg(feature = "relay")]
pub mod relay;

#[cfg(feature = "turn")]
pub mod turn;

#[cfg(all(feature = "webrtc", feature = "relay"))]
pub mod join;
#[cfg(all(feature = "webrtc", feature = "relay"))]
mod stun;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;
#[cfg(all(test, feature = "webrtc"))]
mod webrtc_tests;
