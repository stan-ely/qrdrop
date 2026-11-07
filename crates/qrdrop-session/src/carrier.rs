//! What a paired session rides on, from the key exchange to the leave.
//!
//! Today that is always the room the pairing was made in. An offline pairing
//! (`docs/notes/offline-pairing.md`, phase B) has no room: the two sides meet
//! over a WebSocket on the local network, and that socket has to carry the
//! whole session -- the control stream, the path verdict, the manifest and
//! Accept, all of which ride the room's `frame` action now. So everything
//! after pairing reaches the peer through this type rather than through a
//! [`RoomHandle`], and a socket becomes a second variant here without the
//! hold or the run loop learning which one they have.
//!
//! The surface is the four things a session does with its peer, and nothing
//! a room can do besides: send a frame, take the next thing the peer did,
//! notice it leave, and leave. Pairing itself stays on the room -- the race
//! between networks, the key exchange and the host's pick happen before
//! there is a carrier, and a socket's rendezvous does its own.
//!
//! **The peer filter lives here, both halves of it.** A room is shared by
//! anyone holding the code, so [`Carrier::next`] drops every member but the
//! paired one and [`CarrierTx::send_frame`] targets that one alone. Before
//! this the two halves were in two files (`pair.rs`'s hold and
//! `session.rs`'s reader each matched the peer ID themselves); a third reader
//! written later could have forgotten one, which is the `room.js` bug the
//! invariant in CLAUDE.md is about.

use std::time::Duration;

use qrdrop_protocol::NetworkPath;
use tryst::join::{RoomEvent, RoomHandle, RoomSender};
use tryst::wire::Payload;

use crate::pair::FRAME_ACTION;
use crate::path;

/// What the paired peer did, as [`Carrier::next`] reports it.
pub(crate) enum Arrival {
    /// A frame, still sealed.
    Frame(Vec<u8>),
    /// Something on the frame action that was not bytes. A room's message
    /// can be text or JSON as well; a sealed frame never is. The hold drops
    /// it and the session reads it as an empty frame, a clean failure one
    /// layer down rather than garbage decrypted -- the two behaviours this
    /// had before there was a carrier, kept apart on purpose.
    Runt,
    /// The peer left. The carrier may still deliver more, so a reader that
    /// stops here does so by choice.
    Left,
}

/// The receiving half, and the owner: leaving consumes it.
pub(crate) enum Carrier {
    Room { room: RoomHandle, peer: String },
}

impl Carrier {
    pub(crate) fn room(room: RoomHandle, peer: String) -> Carrier {
        Carrier::Room { room, peer }
    }

    /// The next thing the paired peer did, or `None` once the carrier is
    /// gone for good -- which the callers read as the peer leaving too. A
    /// stranger's messages and every other action are skipped, never held.
    pub(crate) async fn next(&mut self) -> Option<Arrival> {
        match self {
            Carrier::Room { room, peer } => loop {
                match room.next_event().await? {
                    RoomEvent::Left(p) if p == *peer => return Some(Arrival::Left),
                    RoomEvent::Message { peer: p, message }
                        if p == *peer && message.action == FRAME_ACTION =>
                    {
                        return Some(match message.payload {
                            Payload::Binary(b) => Arrival::Frame(b),
                            _ => Arrival::Runt,
                        });
                    }
                    _ => {}
                }
            },
        }
    }

    /// A sending half, for the writer task and the path query, which run
    /// while this half is being read.
    pub(crate) fn sender(&self) -> CarrierTx {
        match self {
            Carrier::Room { room, peer } => CarrierTx::Room {
                sender: room.sender(),
                peer: peer.clone(),
            },
        }
    }

    /// Leave, waiting at most `bound` for the leave to go out: bounded, so a
    /// room that hangs cannot stop Ctrl-C from exiting.
    pub(crate) async fn leave(self, bound: Duration) {
        match self {
            Carrier::Room { room, .. } => {
                let _ = tokio::time::timeout(bound, room.leave()).await;
            }
        }
    }
}

/// The sending half. Cheap to clone; the carrier stays open until
/// [`Carrier::leave`], whatever senders remain.
#[derive(Clone)]
pub(crate) enum CarrierTx {
    Room { sender: RoomSender, peer: String },
}

impl CarrierTx {
    /// Send one sealed frame to the paired peer, resolving once the
    /// transport has taken it -- which is the backpressure. An error is the
    /// peer gone, and its leave says so, so there is nothing to return.
    pub(crate) async fn send_frame(&self, frame: Vec<u8>) {
        match self {
            CarrierTx::Room { sender, peer } => {
                let _ = sender
                    .send(FRAME_ACTION, Payload::Binary(frame), None, Some(peer))
                    .await;
            }
        }
    }

    /// This side's path verdict, or `None` while the transport cannot say
    /// yet: str0m reports the selected pair about a second after it
    /// connects, so the caller polls.
    pub(crate) async fn path(&self) -> Option<NetworkPath> {
        match self {
            CarrierTx::Room { sender, peer } => {
                sender.selected_pair(peer).await.map(|p| path::classify(&p))
            }
        }
    }
}
