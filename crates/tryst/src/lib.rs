//! Trystero 0.25-compatible rooms.
//!
//! Empty until phase 3. What goes here, and the wire it must speak, is in
//! `docs/notes/rust-session.md` under "The wire, as the Rust side must speak
//! it"; `test/vectors/trystero.json` and the recordings beside it are what it
//! is tested against.
//!
//! The split this crate keeps: a sans-IO core (topics, signal crypto, the
//! action wire, the room frame, the `@_hsdata` / `@_hsready` handshake and the
//! offer and glare state machine) with no feature gates, and an async shell
//! behind `nostr`, `torrent` and `webrtc`.

#![forbid(unsafe_code)]
