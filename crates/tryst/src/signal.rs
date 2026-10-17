//! Who offers to whom, and what happens to each offer: Trystero's signal
//! handler (`core/dist/signal-handler.mjs`), sans-IO.
//!
//! One `Signaller` per strategy, as each Trystero strategy module keeps its
//! own peer states. It never touches a socket or a peer connection. Relay
//! messages come in already parsed out of their Nostr event or tracker
//! envelope, connections are made through a [`Connector`] the driver passes
//! to each call, and what to publish comes out of [`Signaller::poll_output`].
//! A [`Connector`] is synchronous because str0m is: an offer or an answer is
//! a function call, so none of Trystero's half-made-offer states exist here.
//!
//! The rules that make two peers agree without talking first:
//! - **The lower ID offers.** A peer that hears an announce from a lower ID
//!   nudges it with an announce of its own, addressed to that peer's topic.
//! - **Glare.** An offer that arrives while we have one out to the same peer
//!   is ignored if our ID is lower, and wins over ours otherwise.
//! - **An answer must name our offer.** One with another `offerId` is stale.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::crypto::{SignalCipher, Topics, gen_id};

/// A connection the driver made, named by the driver.
pub type ConnId = u64;

/// How long an offer stands before it is replaced by a fresh one.
pub const OFFER_TTL: Duration = Duration::from_millis(57_333);
/// How long an answered offer has to connect.
pub const OFFER_POST_ANSWER_TTL: Duration = Duration::from_millis(23_333);
/// How long an answer we sent has to connect.
pub const ANSWERING_TTL: Duration = Duration::from_millis(23_333);
/// Trystero's announce interval before a relay reports its own, which paces
/// re-sending one offer on one relay (at nine tenths of it).
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_millis(5_333);
/// The most trickled candidates held for an offer we have not seen yet.
const MAX_BUFFERED_CANDIDATES: usize = 64;

/// What a strategy's signalling is made of on the peer-connection side.
pub trait Connector {
    /// A new offering connection, its data channel created, and its offer
    /// SDP. `None` if one cannot be made.
    fn offer(&mut self) -> Option<(ConnId, String)>;
    /// A new answering connection for `offer`, and its answer SDP.
    fn answer(&mut self, offer: &str) -> Option<(ConnId, String)>;
    /// Apply the remote answer to an offering connection.
    fn accept_answer(&mut self, conn: ConnId, answer: &str) -> bool;
    /// A trickled ICE candidate, as the JSON Trystero encrypts:
    /// `{candidate, sdpMid, sdpMLineIndex, usernameFragment}`.
    fn add_candidate(&mut self, conn: ConnId, candidate: &str);
    /// Tear a connection down. Never called for a connection after the
    /// driver reported it [`Signaller::disconnected`].
    fn close(&mut self, conn: ConnId);
}

/// Which wire the strategy speaks. Nostr signals through topics and
/// trickles candidates; a tracker carries offers in announces and answers
/// addressed by `offer_id`, with the whole SDP in each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    Nostr,
    Torrent,
}

impl Strategy {
    fn offer_id_len(self) -> usize {
        match self {
            Strategy::Nostr => 12,
            Strategy::Torrent => 20,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Output {
    /// Publish `content` (a JSON object, as a string) to `topic` on `relay`.
    /// Nostr only: the client wraps it in a signed event.
    Publish {
        relay: usize,
        topic: String,
        content: String,
    },
    /// A tracker answer: `{answer: {type: "answer", sdp}, offer_id,
    /// to_peer_id}`, sent through `relay`.
    TrackerAnswer {
        relay: usize,
        to_peer: String,
        offer_id: String,
        sdp: String,
    },
    /// A peer's offer or answer did not decrypt: its password differs.
    /// Trystero reports this through `onJoinError` and carries on.
    WrongPassword { peer: String },
    /// The connection is up and belongs to `peer`; hand it to the room.
    Connected { peer: String, conn: ConnId },
    /// Announce again on every relay now, as Trystero does after a
    /// connection drops, so the peer can find us again quickly.
    Reannounce,
}

#[derive(Debug)]
struct Offer {
    conn: ConnId,
    id: String,
    cipher: String,
    answered: bool,
    expires: Instant,
    /// Per relay, when this offer may be sent on it again.
    sent: HashMap<usize, Instant>,
}

#[derive(Debug, Default)]
struct PeerState {
    offer: Option<Offer>,
    answering: Option<(ConnId, Instant)>,
    connected: Option<ConnId>,
    /// Candidates that arrived before the connection they belong to, keyed
    /// by offer ID ("" for none).
    candidates: HashMap<String, Vec<String>>,
}

#[derive(Debug)]
pub struct Signaller {
    strategy: Strategy,
    self_id: String,
    topics: Topics,
    self_topic: String,
    cipher: SignalCipher,
    peers: HashMap<String, PeerState>,
    /// Every connection we made, and the peer it is for once that is known.
    conns: HashMap<ConnId, Option<String>>,
    outputs: std::collections::VecDeque<Output>,
    left: bool,
}

impl Signaller {
    pub fn new(
        strategy: Strategy,
        app_id: &str,
        room_id: &str,
        password: &str,
        self_id: &str,
    ) -> Self {
        let topics = Topics::new(app_id, room_id);
        Signaller {
            strategy,
            self_id: self_id.to_owned(),
            self_topic: topics.peer_topic(self_id),
            topics,
            cipher: SignalCipher::new(password, app_id, room_id),
            peers: HashMap::new(),
            conns: HashMap::new(),
            outputs: Default::default(),
            left: false,
        }
    }

    pub fn topics(&self) -> &Topics {
        &self.topics
    }

    /// Our own topic, which a Nostr client subscribes to beside the root.
    pub fn self_topic(&self) -> &str {
        &self.self_topic
    }

    /// The announce Nostr publishes to the root topic: `{"peerId": selfId}`.
    pub fn announce(&self) -> String {
        json!({"peerId": self.self_id}).to_string()
    }

    /// A message from a Nostr topic (root or ours), its event's `content`.
    pub fn handle_topic(
        &mut self,
        relay: usize,
        topic: &str,
        content: &str,
        now: Instant,
        c: &mut impl Connector,
    ) {
        if self.left || (topic != self.topics.root() && topic != self.self_topic) {
            return;
        }
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(content) else {
            return;
        };
        let Some(msg) = Msg::parse(&m) else { return };
        if msg.peer == self.self_id || self.is_connected(&msg.peer) {
            return;
        }
        match (msg.offer, msg.answer, msg.candidate) {
            (None, None, None) => self.on_announce(relay, &msg.peer, now, c),
            (Some(offer), _, _) => {
                if let Some(answer) =
                    self.on_offer(&msg.peer, &offer, msg.offer_id.as_deref(), false, now, c)
                {
                    let mut payload = json!({"peerId": self.self_id, "answer": answer});
                    if let Some(id) = msg.offer_id {
                        payload["offerId"] = Value::String(id);
                    }
                    let topic = self.topics.peer_topic(&msg.peer);
                    self.outputs.push_back(Output::Publish {
                        relay,
                        topic,
                        content: payload.to_string(),
                    });
                }
            }
            (None, _, Some(candidate)) => {
                self.on_candidate(&msg.peer, &candidate, msg.offer_id.as_deref(), c)
            }
            (None, Some(answer), None) => {
                self.on_answer(&msg.peer, &answer, msg.offer_id.as_deref(), now, c)
            }
        }
    }

    fn on_announce(&mut self, relay: usize, peer: &str, now: Instant, c: &mut impl Connector) {
        let leads = self.self_id.as_str() < peer;
        let state = self.peers.entry(peer.to_owned()).or_default();
        if state.answering.is_some() || state.offer.as_ref().is_some_and(|o| o.answered) {
            return;
        }
        let topic = self.topics.peer_topic(peer);
        if !leads && state.offer.is_none() {
            // The other side offers. Tell it we are here, on its own topic,
            // so it need not wait for our next announce on the root.
            let content = json!({"peerId": self.self_id}).to_string();
            self.outputs.push_back(Output::Publish {
                relay,
                topic,
                content,
            });
            return;
        }
        if state
            .offer
            .as_ref()
            .and_then(|o| o.sent.get(&relay))
            .is_some_and(|&until| now < until)
        {
            return;
        }
        if state.offer.is_none() {
            let Some((conn, sdp)) = c.offer() else { return };
            let cipher = self.cipher.encrypt(&sdp);
            self.conns.insert(conn, Some(peer.to_owned()));
            state.offer = Some(Offer {
                conn,
                id: gen_id(self.strategy.offer_id_len()),
                cipher,
                answered: false,
                expires: now + OFFER_TTL,
                sent: HashMap::new(),
            });
        }
        let offer = state.offer.as_mut().expect("made above");
        offer
            .sent
            .insert(relay, now + ANNOUNCE_INTERVAL.mul_f32(0.9));
        let content =
            json!({"peerId": self.self_id, "offerId": offer.id, "offer": offer.cipher}).to_string();
        self.outputs.push_back(Output::Publish {
            relay,
            topic,
            content,
        });
    }

    /// An offer from `peer`. Returns the encrypted answer to send back, or
    /// `None` if the offer is ignored. `has_outgoing_hint` is the tracker's
    /// "we have offers out" flag, which counts as an offer to this peer.
    fn on_offer(
        &mut self,
        peer: &str,
        offer: &str,
        offer_id: Option<&str>,
        has_outgoing_hint: bool,
        now: Instant,
        c: &mut impl Connector,
    ) -> Option<String> {
        let lower = self.self_id.as_str() < peer;
        let state = self.peers.entry(peer.to_owned()).or_default();
        if state.answering.is_some() || state.offer.as_ref().is_some_and(|o| o.answered) {
            return None;
        }
        let ours = state.offer.is_some();
        if (ours || has_outgoing_hint) && lower {
            return None;
        }
        let Some(plain) = self.cipher.decrypt(offer) else {
            self.outputs.push_back(Output::WrongPassword {
                peer: peer.to_owned(),
            });
            return None;
        };
        // Theirs wins: ours is withdrawn.
        if let Some(o) = state.offer.take() {
            self.conns.remove(&o.conn);
            c.close(o.conn);
        }
        let (conn, answer) = c.answer(&plain)?;
        self.conns.insert(conn, Some(peer.to_owned()));
        state.answering = Some((conn, now + ANSWERING_TTL));
        for key in [offer_id.unwrap_or(""), ""] {
            for cand in state.candidates.remove(key).unwrap_or_default() {
                c.add_candidate(conn, &cand);
            }
        }
        Some(self.cipher.encrypt(&answer))
    }

    fn on_answer(
        &mut self,
        peer: &str,
        answer: &str,
        offer_id: Option<&str>,
        now: Instant,
        c: &mut impl Connector,
    ) {
        let Some(plain) = self.cipher.decrypt(answer) else {
            self.outputs.push_back(Output::WrongPassword {
                peer: peer.to_owned(),
            });
            return;
        };
        let Some(state) = self.peers.get_mut(peer) else {
            return;
        };
        let Some(offer) = state.offer.as_mut() else {
            return;
        };
        if offer.answered || offer_id.is_some_and(|id| id != offer.id) {
            return;
        }
        offer.answered = true;
        offer.expires = now + OFFER_POST_ANSWER_TTL;
        let conn = offer.conn;
        c.accept_answer(conn, &plain);
        for cand in state
            .candidates
            .remove(offer_id.unwrap_or(""))
            .unwrap_or_default()
        {
            c.add_candidate(conn, &cand);
        }
    }

    fn on_candidate(
        &mut self,
        peer: &str,
        candidate: &str,
        offer_id: Option<&str>,
        c: &mut impl Connector,
    ) {
        let Some(plain) = self.cipher.decrypt(candidate) else {
            return;
        };
        let state = self.peers.entry(peer.to_owned()).or_default();
        let target = match offer_id {
            Some(id) => state.offer.as_ref().filter(|o| o.id == id).map(|o| o.conn),
            None => None,
        }
        .or(state.answering.map(|(conn, _)| conn))
        .or(if offer_id.is_none() {
            state.offer.as_ref().map(|o| o.conn)
        } else {
            None
        });
        match target {
            Some(conn) => c.add_candidate(conn, &plain),
            None => {
                let held = state
                    .candidates
                    .entry(offer_id.unwrap_or("").to_owned())
                    .or_default();
                if held.len() < MAX_BUFFERED_CANDIDATES {
                    held.push(plain);
                }
            }
        }
    }

    /// An offering connection for a tracker announce, not yet bound to any
    /// peer, and its encrypted SDP. The tracker client keeps it under an
    /// offer ID of its own until an answer names it or it ages out.
    pub fn pooled_offer(&mut self, c: &mut impl Connector) -> Option<(ConnId, String)> {
        let (conn, sdp) = c.offer()?;
        self.conns.insert(conn, None);
        Some((conn, self.cipher.encrypt(&sdp)))
    }

    /// A pooled offer the tracker client has given up on.
    pub fn reclaim(&mut self, conn: ConnId, c: &mut impl Connector) {
        if self.conns.get(&conn).is_some_and(Option::is_none) {
            self.conns.remove(&conn);
            c.close(conn);
        }
    }

    /// A tracker relayed a peer's offer.
    pub fn tracker_offer(&mut self, o: TrackerOffer<'_>, now: Instant, c: &mut impl Connector) {
        if self.left || o.peer == self.self_id || self.is_connected(o.peer) {
            return;
        }
        if let Some(sdp) = self.on_offer(o.peer, o.offer, None, o.has_outgoing, now, c) {
            self.outputs.push_back(Output::TrackerAnswer {
                relay: o.relay,
                to_peer: o.peer.to_owned(),
                offer_id: o.offer_id.to_owned(),
                sdp,
            });
        }
    }

    /// A tracker relayed `peer`'s answer to our pooled offer `conn`.
    pub fn tracker_answer(
        &mut self,
        peer: &str,
        conn: ConnId,
        answer: &str,
        c: &mut impl Connector,
    ) {
        if self.left || peer == self.self_id {
            return;
        }
        let Some(plain) = self.cipher.decrypt(answer) else {
            self.outputs.push_back(Output::WrongPassword {
                peer: peer.to_owned(),
            });
            return;
        };
        self.conns.insert(conn, Some(peer.to_owned()));
        c.accept_answer(conn, &plain);
    }

    fn is_connected(&self, peer: &str) -> bool {
        self.peers.get(peer).is_some_and(|s| s.connected.is_some())
    }

    /// The driver saw `conn`'s data channel open. Emits `Connected` if the
    /// connection is the one this peer should keep, and closes it if the
    /// peer already has one.
    pub fn connected(&mut self, conn: ConnId, c: &mut impl Connector) {
        let Some(Some(peer)) = self.conns.get(&conn).cloned() else {
            return;
        };
        let state = self.peers.entry(peer.clone()).or_default();
        if state.connected.is_some_and(|k| k != conn) || self.left {
            self.conns.remove(&conn);
            c.close(conn);
            return;
        }
        state.connected = Some(conn);
        if let Some((a, _)) = state.answering.take()
            && a != conn
        {
            self.conns.remove(&a);
            c.close(a);
        }
        if let Some(o) = state.offer.take()
            && o.conn != conn
        {
            self.conns.remove(&o.conn);
            c.close(o.conn);
        }
        state.candidates.clear();
        self.outputs.push_back(Output::Connected { peer, conn });
    }

    /// `conn` closed or failed, by itself or because the room dropped it.
    pub fn disconnected(&mut self, conn: ConnId) {
        let Some(peer) = self.conns.remove(&conn).flatten() else {
            return;
        };
        let Some(state) = self.peers.get_mut(&peer) else {
            return;
        };
        if state.connected == Some(conn) {
            state.connected = None;
            if self.strategy == Strategy::Nostr && !self.left {
                self.outputs.push_back(Output::Reannounce);
            }
        }
        if state.answering.is_some_and(|(a, _)| a == conn) {
            state.answering = None;
        }
        if state.offer.as_ref().is_some_and(|o| o.conn == conn) {
            state.offer = None;
        }
    }

    /// Offers and answers whose time is up.
    pub fn handle_timeout(&mut self, now: Instant, c: &mut impl Connector) {
        for state in self.peers.values_mut() {
            if state.connected.is_some() {
                continue;
            }
            if let Some(o) = state.offer.as_ref()
                && o.expires <= now
            {
                let o = state.offer.take().expect("checked");
                self.conns.remove(&o.conn);
                c.close(o.conn);
            }
            if let Some((a, until)) = state.answering
                && until <= now
            {
                state.answering = None;
                self.conns.remove(&a);
                c.close(a);
            }
        }
    }

    pub fn poll_timeout(&self) -> Option<Instant> {
        self.peers
            .values()
            .filter(|s| s.connected.is_none())
            .flat_map(|s| {
                s.offer
                    .as_ref()
                    .map(|o| o.expires)
                    .into_iter()
                    .chain(s.answering.map(|(_, t)| t))
            })
            .min()
    }

    pub fn poll_output(&mut self) -> Option<Output> {
        self.outputs.pop_front()
    }

    /// Stop signalling and close every connection still being negotiated.
    /// Connected ones are the room's to close.
    pub fn leave(&mut self, c: &mut impl Connector) {
        self.left = true;
        for state in self.peers.values_mut() {
            if let Some(o) = state.offer.take()
                && state.connected != Some(o.conn)
            {
                c.close(o.conn);
            }
            if let Some((a, _)) = state.answering.take()
                && state.connected != Some(a)
            {
                c.close(a);
            }
        }
        self.conns.retain(|conn, peer| {
            let keep = peer.as_ref().is_some_and(|p| {
                self.peers
                    .get(p)
                    .is_some_and(|s| s.connected == Some(*conn))
            });
            if !keep && peer.is_none() {
                c.close(*conn);
            }
            keep
        });
    }
}

/// An offer a tracker relayed: its `peer_id`, its `offer.sdp` and its
/// `offer_id`, which the answer must name.
#[derive(Clone, Copy, Debug)]
pub struct TrackerOffer<'a> {
    pub relay: usize,
    pub peer: &'a str,
    pub offer: &'a str,
    pub offer_id: &'a str,
    /// Whether we hold pooled offers, which is what makes glare apply on
    /// this wire: both sides always have offers out.
    pub has_outgoing: bool,
}

/// A topic message's fields, with Trystero's validation: `peerId` must be a
/// non-empty string, and `offer`, `answer` and `candidate`, where present,
/// non-empty strings too -- a message with a malformed one is dropped whole.
struct Msg {
    peer: String,
    offer_id: Option<String>,
    offer: Option<String>,
    answer: Option<String>,
    candidate: Option<String>,
}

impl Msg {
    fn parse(m: &Map<String, Value>) -> Option<Msg> {
        let s = |k: &str| {
            m.get(k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        for k in ["offer", "answer", "candidate"] {
            if m.contains_key(k) && s(k).is_none() {
                return None;
            }
        }
        Some(Msg {
            peer: s("peerId")?,
            offer_id: s("offerId"),
            offer: s("offer"),
            answer: s("answer"),
            candidate: s("candidate"),
        })
    }
}
