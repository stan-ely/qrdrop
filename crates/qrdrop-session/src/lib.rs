//! A qrdrop session over tryst: the Rust counterpart of `src/transport/` and
//! the run loops in `src/cli.js`, for the apps and the Rust CLI.
//!
//! The order a transfer goes in:
//!
//! 1. [`open_room`] races every signalling network, does the key exchange on
//!    the first to deliver a peer, and returns a [`Paired`] holding the SAS.
//! 2. The person compares the SAS on both screens. [`Paired::confirm`] is
//!    their yes and the only way to a session; [`Paired::reject`] their no.
//! 3. The [`SessionHandle`] sends a file or answers an offer, and
//!    [`SessionEvents`] reports what happened, until the session fails or
//!    [`SessionHandle::close`] leaves the room.
//!
//! Features add paths and never change one: `lan-dial` and `lan-listen` for
//! the local-network fast path, `fs` for std files as source and sink.

#![forbid(unsafe_code)]

pub mod io;
pub mod lan;
pub mod networks;
pub mod pair;
pub mod path;
pub mod session;
#[cfg(test)]
mod tests;

pub use io::{Sink, Source};
pub use networks::Network;
pub use pair::{OpenConfig, OpenError, Paired, open_room};
pub use session::{LanConfig, SessionEvent, SessionEvents, SessionHandle, SessionOptions};
/// Which signalling network a [`Network`] is, from tryst.
pub use tryst::signal::Strategy;
