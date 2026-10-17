//! Trystero 0.25-compatible rooms.
//!
//! What goes here, and the wire it must speak, is in
//! `docs/notes/rust-session.md` under "The wire, as the Rust side must speak
//! it"; `test/vectors/trystero.json` and the recordings beside it are what it
//! is tested against.
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

#![forbid(unsafe_code)]

pub mod crypto;
pub mod room;
pub mod signal;
pub mod wire;

#[cfg(feature = "webrtc")]
pub mod webrtc;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;
#[cfg(all(test, feature = "webrtc"))]
mod webrtc_tests;
