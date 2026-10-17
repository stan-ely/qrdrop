//! A room over connections that are already open: the password handshake,
//! `@_leave`, and action messages to and from joined peers. Sans-IO, like
//! qrdrop-protocol's Session: the driver says a channel opened, hands in
//! what arrived, and polls for what to send and what happened.
//!
//! Trystero 0.25.4's `core/dist/room.mjs` and `handshake.mjs` are the source.
//! Left out, because nothing on qrdrop's wire uses them: media
//! (`@_stream`, `@_track`), renegotiation over the channel (`@_signal`),
//! passive rooms, and one connection shared by several rooms.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::crypto::{Topics, gen_id, handshake_response};
use crate::wire::{
    Frame, Message, Payload, Reassembler, WireError, decode_chunk, encode_action, unwrap_frame,
    wrap_room,
};

/// How long a peer has to finish the handshake before it is dropped.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

const HS_DATA: &str = "@_hsdata";
const HS_READY: &str = "@_hsready";
const LEAVE: &str = "@_leave";
const PING: &str = "@_ping";
const PONG: &str = "@_pong";

/// Trystero's own message for a failed password check, which a JS peer
/// reports the same way.
pub const WRONG_PASSWORD: &str = "incorrect password for overlapping room";

#[derive(Clone, Debug)]
pub struct RoomConfig {
    pub app_id: String,
    pub room_id: String,
    pub password: String,
    pub self_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The handshake has passed both ways: the peer is in the room, and
    /// messages to and from it now flow. Trystero's `onPeerJoin`.
    Joined(String),
    /// A message from a joined peer, on an action the caller owns.
    Message { peer: String, message: Message },
    /// The peer is gone from the room and its connection should be closed.
    /// `joined` says whether a `Joined` was ever reported for it, which is
    /// when Trystero fires `onPeerLeave`.
    Closed {
        peer: String,
        joined: bool,
        reason: CloseReason,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseReason {
    /// It sent `@_leave`.
    Left,
    /// Its connection closed under it (the driver said so).
    Disconnected,
    /// The handshake failed or timed out; the string is Trystero's wording.
    Handshake(String),
    /// We left the room.
    SelfLeft,
}

/// One data-channel message for one peer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transmit {
    pub peer: String,
    pub data: Vec<u8>,
}

#[derive(Debug)]
struct PeerState {
    joined: bool,
    local_passed: bool,
    remote_ready: bool,
    /// Ours, when we are the initiator and are waiting for the answer to it.
    challenge: Option<String>,
    deadline: Instant,
    reassembler: Reassembler,
}

#[derive(Debug)]
pub struct Room {
    cfg: RoomConfig,
    topics: Topics,
    peers: HashMap<String, PeerState>,
    nonces: HashMap<String, u16>,
    transmits: VecDeque<Transmit>,
    events: VecDeque<Event>,
    left: bool,
    challenge: fn() -> String,
}

fn challenge() -> String {
    gen_id(36)
}

impl Room {
    pub fn new(cfg: RoomConfig) -> Self {
        Room {
            topics: Topics::new(&cfg.app_id, &cfg.room_id),
            cfg,
            peers: HashMap::new(),
            nonces: HashMap::new(),
            transmits: VecDeque::new(),
            events: VecDeque::new(),
            left: false,
            challenge,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_challenge(mut self, f: fn() -> String) -> Self {
        self.challenge = f;
        self
    }

    pub fn self_id(&self) -> &str {
        &self.cfg.self_id
    }

    pub fn topics(&self) -> &Topics {
        &self.topics
    }

    /// A connection to `peer` has opened its channel: start the handshake.
    /// A second open for the same ID replaces the first, as Trystero's
    /// "peer replaced" does, without reporting a leave in between.
    pub fn add_peer(&mut self, peer: &str, now: Instant) {
        if self.left {
            return;
        }
        self.peers.insert(
            peer.to_owned(),
            PeerState {
                joined: false,
                local_passed: false,
                remote_ready: false,
                challenge: None,
                deadline: now + HANDSHAKE_TIMEOUT,
                reassembler: Reassembler::default(),
            },
        );
        if self.cfg.password.is_empty() {
            // No password, no check: Trystero still sends its ready.
            self.local_passed(peer);
        } else if self.cfg.self_id.as_str() < peer {
            let c = (self.challenge)();
            self.send_internal(HS_DATA, json!({"__trystero_pw": "challenge", "c": c}), peer);
            if let Some(p) = self.peers.get_mut(peer) {
                p.challenge = Some(c);
            }
        }
    }

    /// The connection to `peer` closed without a `@_leave`.
    pub fn remove_peer(&mut self, peer: &str) {
        self.close(peer, CloseReason::Disconnected);
    }

    /// One data-channel message from `peer`.
    pub fn handle_data(&mut self, peer: &str, data: &[u8]) {
        let Some(Frame::Room { token, chunk }) = unwrap_frame(data) else {
            // Presence frames say which rooms the peer is in. This room is
            // the only one on the connection, so there is nothing to learn.
            return;
        };
        if token != self.topics.room_token() {
            return;
        }
        let Some(chunk) = decode_chunk(chunk) else {
            return;
        };
        let Some(state) = self.peers.get_mut(peer) else {
            return;
        };
        // A pending peer may speak only the handshake's three actions.
        let internal = matches!(chunk.action.as_str(), HS_DATA | HS_READY | LEAVE);
        if !state.joined && !internal {
            return;
        }
        let Some(message) = state.reassembler.push(&chunk) else {
            return;
        };
        match message.action.as_str() {
            LEAVE => self.close(peer, CloseReason::Left),
            HS_DATA => self.handshake_data(peer, message.payload),
            HS_READY => {
                if let Some(p) = self.peers.get_mut(peer) {
                    p.remote_ready = true;
                }
                self.maybe_join(peer);
            }
            PING => self.send_internal(PONG, Value::String(String::new()), peer),
            // Media and renegotiation, which this room never offers.
            a if a.starts_with("@_") => {}
            _ => self.events.push_back(Event::Message {
                peer: peer.to_owned(),
                message,
            }),
        }
    }

    fn handshake_data(&mut self, peer: &str, payload: Payload) {
        let Some(state) = self.peers.get_mut(peer) else {
            return;
        };
        if state.joined || state.local_passed {
            return;
        }
        let Payload::Json(data) = payload else {
            return self.fail(peer, WRONG_PASSWORD);
        };
        let field = |k: &str| data.get(k).and_then(Value::as_str);
        if let Some(ours) = state.challenge.take() {
            let expected = handshake_response(
                &ours,
                &self.cfg.password,
                &self.cfg.app_id,
                &self.cfg.room_id,
            );
            if field("__trystero_pw") != Some("response") || field("h") != Some(expected.as_str()) {
                return self.fail(peer, WRONG_PASSWORD);
            }
        } else {
            let (Some("challenge"), Some(c)) = (field("__trystero_pw"), field("c")) else {
                return self.fail(peer, WRONG_PASSWORD);
            };
            let h = handshake_response(c, &self.cfg.password, &self.cfg.app_id, &self.cfg.room_id);
            self.send_internal(HS_DATA, json!({"__trystero_pw": "response", "h": h}), peer);
        }
        self.local_passed(peer);
    }

    fn local_passed(&mut self, peer: &str) {
        if let Some(p) = self.peers.get_mut(peer) {
            p.local_passed = true;
        }
        self.send_internal(HS_READY, Value::String(String::new()), peer);
        self.maybe_join(peer);
    }

    fn maybe_join(&mut self, peer: &str) {
        let Some(p) = self.peers.get_mut(peer) else {
            return;
        };
        if p.joined || !p.local_passed || !p.remote_ready {
            return;
        }
        p.joined = true;
        self.events.push_back(Event::Joined(peer.to_owned()));
    }

    fn fail(&mut self, peer: &str, why: &str) {
        self.close(
            peer,
            CloseReason::Handshake(format!("handshake failed: {why}")),
        );
    }

    fn close(&mut self, peer: &str, reason: CloseReason) {
        if let Some(p) = self.peers.remove(peer) {
            self.events.push_back(Event::Closed {
                peer: peer.to_owned(),
                joined: p.joined,
                reason,
            });
        }
    }

    /// Whether `peer` has joined.
    pub fn is_joined(&self, peer: &str) -> bool {
        self.peers.get(peer).is_some_and(|p| p.joined)
    }

    /// The peers that have joined.
    pub fn joined(&self) -> impl Iterator<Item = &str> {
        self.peers
            .iter()
            .filter(|(_, p)| p.joined)
            .map(|(id, _)| id.as_str())
    }

    /// Send a message on `action` to one joined peer, or to every joined peer
    /// with `None`. A target that has not joined is skipped, as Trystero
    /// skips it with a warning; the return value says how many it went to.
    pub fn send(
        &mut self,
        action: &str,
        payload: &Payload,
        meta: Option<&Value>,
        to: Option<&str>,
    ) -> Result<usize, WireError> {
        if action.starts_with("@_") {
            // Trystero's own namespace; a caller writing into it could forge
            // a leave or a handshake step.
            return Err(WireError::ActionName);
        }
        let targets: Vec<String> = match to {
            Some(p) if self.is_joined(p) => vec![p.to_owned()],
            Some(_) => vec![],
            None => self.joined().map(str::to_owned).collect(),
        };
        let chunks = encode_action(action, self.next_nonce(action), payload, meta)?;
        for peer in &targets {
            for c in &chunks {
                self.push_chunk(peer, c);
            }
        }
        Ok(targets.len())
    }

    fn send_internal(&mut self, action: &str, v: Value, peer: &str) {
        let chunks = encode_action(action, self.next_nonce(action), &Payload::json(v), None)
            .expect("internal action names are short");
        for c in &chunks {
            self.push_chunk(peer, c);
        }
    }

    fn push_chunk(&mut self, peer: &str, chunk: &[u8]) {
        self.transmits.push_back(Transmit {
            peer: peer.to_owned(),
            data: wrap_room(self.topics.room_token(), chunk),
        });
    }

    fn next_nonce(&mut self, action: &str) -> u16 {
        let n = self.nonces.entry(action.to_owned()).or_insert(0);
        let current = *n;
        *n = n.wrapping_add(1);
        current
    }

    /// Leave the room: a `@_leave` to every peer, pending ones included, then
    /// a `Closed` for each. The driver should flush the transmits and give
    /// them a moment -- Trystero waits 99 ms -- before closing connections.
    pub fn leave(&mut self) {
        if self.left {
            return;
        }
        self.left = true;
        let mut ids: Vec<String> = self.peers.keys().cloned().collect();
        ids.sort();
        for id in &ids {
            self.send_internal(LEAVE, Value::String(String::new()), id);
        }
        for id in ids {
            self.close(&id, CloseReason::SelfLeft);
        }
    }

    pub fn has_left(&self) -> bool {
        self.left
    }

    /// Handshake deadlines that have passed.
    pub fn handle_timeout(&mut self, now: Instant) {
        let expired: Vec<String> = self
            .peers
            .iter()
            .filter(|(_, p)| !p.joined && p.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            let ms = HANDSHAKE_TIMEOUT.as_millis();
            self.fail(&id, &format!("handshake timed out after {ms}ms"));
        }
    }

    /// The next handshake deadline, if any peer is still pending.
    pub fn poll_timeout(&self) -> Option<Instant> {
        self.peers
            .values()
            .filter(|p| !p.joined)
            .map(|p| p.deadline)
            .min()
    }

    pub fn poll_transmit(&mut self) -> Option<Transmit> {
        self.transmits.pop_front()
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }
}
