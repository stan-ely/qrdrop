//! A qrdrop session over tryst.
//!
//! Empty until phase 5: `open_room`, the send and receive run loops, the
//! `Source` and `Sink` traits (std files behind `fs`), the LAN listener and
//! dialer (`lan-listen`, `lan-dial`) and, if phase 9 earns it, `quic`.

#![forbid(unsafe_code)]
