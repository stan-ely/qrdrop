//! Peer connections on str0m, as a [`Connector`] the signaller drives.
//!
//! Still sans-IO: str0m is, so this is too. Every connection shares the
//! driver's UDP sockets, and the driver hands each datagram to
//! [`WebRtc::handle_datagram`], which finds the connection it belongs to;
//! what to send comes out of [`WebRtc::poll_transmit`]. Phase 1 chose str0m
//! for this shape and measured it against Chromium and node-datachannel
//! (`app/CAPABILITIES.md`, "The Rust WebRTC stacks").
//!
//! Matching Trystero's peer (`core/dist/peer.mjs`) where a JS peer can tell:
//! the offerer creates one channel, `"data"`, ordered and reliable, and the
//! answerer takes whatever the offerer opened. Every local candidate goes in
//! the SDP, so nothing here trickles; a JS peer's trickled candidates are
//! accepted through [`Connector::add_candidate`].

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::ChannelId;
use str0m::config::{CryptoProvider, DtlsCert};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, CandidateKind, Event, IceConnectionState, Input, Output, Rtc};

use crate::signal::{ConnId, Connector};

/// The label Trystero's offerer gives its one channel.
pub const CHANNEL_LABEL: &str = "data";

/// How long ICE may sit disconnected before the connection is given up,
/// as Trystero gives it.
pub const DISCONNECTED_GRACE: Duration = Duration::from_secs(5);

/// The buffered amount below which [`PeerEvent::BufferedLow`] fires:
/// Trystero's `bufferedAmountLowThreshold`.
pub const BUFFERED_LOW: usize = 65_535;

/// The send buffer each association gets. str0m's default is 128 KiB
/// *including* bytes in flight, which pinned a 20 ms path at 3.96 MB/s in
/// phase 1; this is twice the highest mark qrdrop's sender fills to.
pub const SCTP_SEND_BUFFER: usize = 8 * 1024 * 1024;

/// How often str0m reports the selected candidate pair. It reports nothing
/// about the pair otherwise, and a second is how long the JS's
/// `classifyPath` would poll `getStats()` across anyway.
pub const STATS_INTERVAL: Duration = Duration::from_secs(1);

/// What kind of address one end of a candidate pair is, in the words of
/// RTCIceCandidateStats' `candidateType`, which is what qrdrop's path
/// classification reads on the JS side.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CandidateType {
    /// An address of a local interface.
    Host,
    /// Server-reflexive: the address a STUN server saw.
    Srflx,
    /// Peer-reflexive: an address the first check came from, signalled by
    /// no one -- what a peer hiding its host address behind mDNS looks like.
    Prflx,
    /// A TURN server's.
    Relay,
}

impl From<CandidateKind> for CandidateType {
    fn from(k: CandidateKind) -> Self {
        match k {
            CandidateKind::Host => CandidateType::Host,
            CandidateKind::ServerReflexive => CandidateType::Srflx,
            CandidateKind::PeerReflexive => CandidateType::Prflx,
            CandidateKind::Relayed => CandidateType::Relay,
        }
    }
}

/// The candidate pair a connection settled on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectedPair {
    /// The local socket address of the pair.
    pub local: SocketAddr,
    /// The kind of the local candidate.
    pub local_type: CandidateType,
    /// The remote socket address of the pair.
    pub remote: SocketAddr,
    /// The kind of the remote candidate. [`CandidateType::Prflx`] when the
    /// address was never signalled.
    pub remote_type: CandidateType,
}

/// How a [`WebRtc`] is set up.
#[derive(Clone, Debug)]
pub struct Config {
    /// The local addresses to offer as host candidates, one per socket the
    /// driver reads from. Server-reflexive ones are added the same way once
    /// the driver has asked a STUN server.
    pub candidates: Vec<Candidate>,
}

impl Config {
    /// Host candidates for UDP sockets bound at `addrs`.
    pub fn host(addrs: &[SocketAddr]) -> Self {
        Config {
            candidates: addrs
                .iter()
                .filter_map(|a| Candidate::host(*a, "udp").ok())
                .collect(),
        }
    }
}

/// A datagram to send: from one of the driver's sockets to a peer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Datagram {
    /// The local socket the datagram leaves from.
    pub source: SocketAddr,
    /// The remote address it goes to.
    pub destination: SocketAddr,
    /// The datagram's payload.
    pub contents: Vec<u8>,
}

/// Something that happened on a connection, reported by [`WebRtc::poll_event`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerEvent {
    /// The data channel is open: tell the signaller, then the room.
    Open(ConnId),
    /// One data-channel message.
    Data(ConnId, Vec<u8>),
    /// The buffered amount fell below [`BUFFERED_LOW`].
    BufferedLow(ConnId),
    /// The connection is gone: failed, closed by the peer, or closed here.
    /// Reported once, and the ID is not reused.
    Closed(ConnId),
}

struct Conn {
    rtc: Rtc,
    channel: Option<ChannelId>,
    pending: Option<SdpPendingOffer>,
    offerer: bool,
    disconnected_at: Option<Instant>,
    /// Every remote candidate signalled, in the SDP or trickled: str0m keeps
    /// them but does not say which kind the selected one was.
    remote_types: HashMap<SocketAddr, CandidateType>,
    /// Addresses only, from str0m's stats; typed in [`WebRtc::selected_pair`].
    selected: Option<(SocketAddr, SocketAddr)>,
}

/// Every `a=candidate` line in an SDP, by address.
fn sdp_candidates(sdp: &str, into: &mut HashMap<SocketAddr, CandidateType>) {
    for line in sdp.lines() {
        if let Some(c) = line.trim().strip_prefix("a=")
            && c.starts_with("candidate:")
            && let Ok(c) = Candidate::from_sdp_string(c)
        {
            into.insert(c.addr(), c.kind().into());
        }
    }
}

/// The peer connections of one room, sans-IO: datagrams and the current time
/// go in, and [`Datagram`]s and [`PeerEvent`]s come out. It owns no sockets
/// and has no clock of its own.
pub struct WebRtc {
    cfg: Config,
    provider: Arc<CryptoProvider>,
    conns: HashMap<ConnId, Conn>,
    next: ConnId,
    now: Instant,
    transmits: VecDeque<Datagram>,
    events: VecDeque<PeerEvent>,
}

impl std::fmt::Debug for WebRtc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebRtc")
            .field("conns", &self.conns.len())
            .finish()
    }
}

impl WebRtc {
    /// A set of connections with none made yet, starting at `now`. Every
    /// connection offers the local candidates in `cfg`.
    pub fn new(cfg: Config, now: Instant) -> Self {
        WebRtc {
            cfg,
            // Per connection rather than str0m's process default: a library
            // has no business installing one for its host.
            provider: Arc::new(str0m::crypto::from_feature_flags()),
            conns: HashMap::new(),
            next: 0,
            now,
            transmits: VecDeque::new(),
            events: VecDeque::new(),
        }
    }

    /// Add a local candidate to every connection made from now on, such as
    /// a server-reflexive address the driver learned after starting.
    pub fn add_local_candidate(&mut self, c: Candidate) {
        self.cfg.candidates.push(c);
    }

    fn build(&mut self, offerer: bool) -> ConnId {
        let mut rtc = Rtc::builder()
            .set_crypto_provider(self.provider.clone())
            .set_dtls_cert(make_cert())
            .set_sctp_max_buffered_amount(SCTP_SEND_BUFFER)
            .set_stats_interval(Some(STATS_INTERVAL))
            .build(self.now);
        for c in &self.cfg.candidates {
            rtc.add_local_candidate(c.clone());
        }
        self.next += 1;
        self.conns.insert(
            self.next,
            Conn {
                rtc,
                channel: None,
                pending: None,
                offerer,
                disconnected_at: None,
                remote_types: HashMap::new(),
                selected: None,
            },
        );
        self.next
    }

    /// A datagram one of the driver's sockets received. Returns whether a
    /// connection took it; one that none did is for nobody here.
    pub fn handle_datagram(
        &mut self,
        now: Instant,
        source: SocketAddr,
        destination: SocketAddr,
        contents: &[u8],
    ) -> bool {
        self.now = now;
        let Ok(contents) = contents.try_into() else {
            return false;
        };
        let input = Input::Receive(
            now,
            Receive {
                proto: Protocol::Udp,
                source,
                destination,
                contents,
            },
        );
        let Some((&id, conn)) = self.conns.iter_mut().find(|(_, c)| c.rtc.accepts(&input)) else {
            return false;
        };
        if conn.rtc.handle_input(input).is_err() {
            self.drop_conn(id);
            return true;
        }
        self.drain(id);
        true
    }

    /// Advance every connection's clock.
    pub fn handle_timeout(&mut self, now: Instant) {
        self.now = now;
        let ids: Vec<ConnId> = self.conns.keys().copied().collect();
        for id in ids {
            let Some(conn) = self.conns.get_mut(&id) else {
                continue;
            };
            if conn
                .disconnected_at
                .is_some_and(|t| now >= t + DISCONNECTED_GRACE)
                || conn.rtc.handle_input(Input::Timeout(now)).is_err()
            {
                self.drop_conn(id);
                continue;
            }
            self.drain(id);
        }
    }

    /// The earliest moment any connection needs [`WebRtc::handle_timeout`].
    pub fn poll_timeout(&mut self) -> Option<Instant> {
        let ids: Vec<ConnId> = self.conns.keys().copied().collect();
        let mut earliest = None::<Instant>;
        for id in ids {
            if let Some(t) = self.drain(id) {
                earliest = Some(earliest.map_or(t, |e| e.min(t)));
            }
        }
        for c in self.conns.values() {
            if let Some(t) = c.disconnected_at {
                let t = t + DISCONNECTED_GRACE;
                earliest = Some(earliest.map_or(t, |e| e.min(t)));
            }
        }
        earliest
    }

    /// Run one connection's output until it asks for a timeout, which is
    /// returned. Events and datagrams go to the queues.
    fn drain(&mut self, id: ConnId) -> Option<Instant> {
        loop {
            let conn = self.conns.get_mut(&id)?;
            if !conn.rtc.is_alive() {
                self.drop_conn(id);
                return None;
            }
            let out = match conn.rtc.poll_output() {
                Ok(o) => o,
                Err(_) => {
                    self.drop_conn(id);
                    return None;
                }
            };
            match out {
                Output::Timeout(t) => return Some(t),
                Output::Transmit(t) => self.transmits.push_back(Datagram {
                    source: t.source,
                    destination: t.destination,
                    contents: t.contents.to_vec(),
                }),
                Output::Event(e) => match e {
                    Event::ChannelOpen(cid, _) => {
                        if conn.channel.is_none() {
                            conn.channel = Some(cid);
                            if let Some(mut ch) = conn.rtc.channel(cid) {
                                ch.set_buffered_amount_low_threshold(BUFFERED_LOW);
                            }
                            self.events.push_back(PeerEvent::Open(id));
                        }
                    }
                    Event::ChannelData(d) if Some(d.id) == conn.channel => {
                        self.events.push_back(PeerEvent::Data(id, d.data));
                    }
                    Event::ChannelBufferedAmountLow(cid) if Some(cid) == conn.channel => {
                        self.events.push_back(PeerEvent::BufferedLow(id));
                    }
                    Event::ChannelClose(cid) if Some(cid) == conn.channel => {
                        self.drop_conn(id);
                        return None;
                    }
                    Event::PeerStats(st) => {
                        if let Some(p) = st.selected_candidate_pair {
                            conn.selected = Some((p.local.addr, p.remote.addr));
                        }
                    }
                    Event::IceConnectionStateChange(s) => match s {
                        IceConnectionState::Disconnected => {
                            conn.disconnected_at.get_or_insert(self.now);
                        }
                        IceConnectionState::Checking
                        | IceConnectionState::Connected
                        | IceConnectionState::Completed => conn.disconnected_at = None,
                        _ => {}
                    },
                    _ => {}
                },
            }
        }
    }

    fn drop_conn(&mut self, id: ConnId) {
        if let Some(mut c) = self.conns.remove(&id) {
            c.rtc.disconnect();
            self.events.push_back(PeerEvent::Closed(id));
        }
    }

    /// Queue one binary message on the connection's channel. `Ok(false)` if
    /// the channel is not open yet; an error closes the connection.
    pub fn send(&mut self, id: ConnId, data: &[u8]) -> Result<bool, Closed> {
        let conn = self.conns.get_mut(&id).ok_or(Closed)?;
        let Some(cid) = conn.channel else {
            return Ok(false);
        };
        let Some(mut ch) = conn.rtc.channel(cid) else {
            return Ok(false);
        };
        match ch.write(true, data) {
            Ok(written) => {
                self.drain(id);
                Ok(written)
            }
            Err(_) => {
                self.drop_conn(id);
                Err(Closed)
            }
        }
    }

    /// Bytes queued on the channel and not yet acknowledged.
    pub fn buffered_amount(&mut self, id: ConnId) -> usize {
        let Some(conn) = self.conns.get_mut(&id) else {
            return 0;
        };
        let Some(cid) = conn.channel else { return 0 };
        conn.rtc
            .channel(cid)
            .map_or(0, |mut ch| ch.buffered_amount())
    }

    /// The pair the connection is using, once str0m has reported one. A
    /// local address none of ours matches is taken as a host one (a socket's
    /// own); a remote one nobody signalled is peer-reflexive by definition.
    pub fn selected_pair(&self, id: ConnId) -> Option<SelectedPair> {
        let conn = self.conns.get(&id)?;
        let (local, remote) = conn.selected?;
        let local_type = self
            .cfg
            .candidates
            .iter()
            .find(|c| c.addr() == local)
            .map_or(CandidateType::Host, |c| c.kind().into());
        let remote_type = conn
            .remote_types
            .get(&remote)
            .copied()
            .unwrap_or(CandidateType::Prflx);
        Some(SelectedPair {
            local,
            local_type,
            remote,
            remote_type,
        })
    }

    /// Whether the data channel of `id` is open.
    pub fn is_open(&self, id: ConnId) -> bool {
        self.conns.get(&id).is_some_and(|c| c.channel.is_some())
    }

    /// The next datagram to send, if any.
    pub fn poll_transmit(&mut self) -> Option<Datagram> {
        self.transmits.pop_front()
    }

    /// The next event, if any.
    pub fn poll_event(&mut self) -> Option<PeerEvent> {
        self.events.pop_front()
    }
}

/// A connection that is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Closed;

impl Connector for WebRtc {
    fn offer(&mut self) -> Option<(ConnId, String)> {
        let id = self.build(true);
        let conn = self.conns.get_mut(&id)?;
        let mut api = conn.rtc.sdp_api();
        api.add_channel(CHANNEL_LABEL.into());
        let Some((offer, pending)) = api.apply() else {
            self.drop_conn(id);
            return None;
        };
        conn.pending = Some(pending);
        Some((id, offer.to_sdp_string()))
    }

    fn answer(&mut self, offer: &str) -> Option<(ConnId, String)> {
        let parsed = SdpOffer::from_sdp_string(offer).ok()?;
        let id = self.build(false);
        let conn = self.conns.get_mut(&id)?;
        sdp_candidates(offer, &mut conn.remote_types);
        let offer = parsed;
        match conn.rtc.sdp_api().accept_offer(offer) {
            Ok(answer) => {
                let sdp = answer.to_sdp_string();
                self.drain(id);
                Some((id, sdp))
            }
            Err(_) => {
                self.drop_conn(id);
                None
            }
        }
    }

    fn accept_answer(&mut self, id: ConnId, answer: &str) -> bool {
        let Some(conn) = self.conns.get_mut(&id) else {
            return false;
        };
        sdp_candidates(answer, &mut conn.remote_types);
        let (Some(pending), Ok(answer)) = (conn.pending.take(), SdpAnswer::from_sdp_string(answer))
        else {
            return false;
        };
        let ok = conn.offerer && conn.rtc.sdp_api().accept_answer(pending, answer).is_ok();
        if ok {
            self.drain(id);
        } else {
            self.drop_conn(id);
        }
        ok
    }

    fn add_candidate(&mut self, id: ConnId, candidate: &str) {
        let Some(conn) = self.conns.get_mut(&id) else {
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate) else {
            return;
        };
        let Some(line) = v.get("candidate").and_then(|c| c.as_str()) else {
            return;
        };
        // An empty candidate is the end-of-candidates marker; mDNS names
        // (Chromium hides host addresses behind them) do not resolve here,
        // and the peer-reflexive address the first check reveals stands in.
        if let Ok(c) = Candidate::from_sdp_string(line.trim_start_matches("a=")) {
            conn.remote_types.insert(c.addr(), c.kind().into());
            conn.rtc.add_remote_candidate(c);
        }
    }

    fn close(&mut self, id: ConnId) {
        if let Some(mut c) = self.conns.remove(&id) {
            c.rtc.disconnect();
        }
    }
}

/// A self-signed P-256 certificate for DTLS, in pure Rust. A self-issued
/// **leaf**: a root profile's key usage is keyCertSign and cRLSign only, and
/// OpenSSL (node-datachannel) refuses that for ECDHE-ECDSA as `bad ecc cert`.
/// A random serial, for the reason dimpl's own generator gives: Firefox
/// rejects a second certificate with the same issuer and serial.
pub fn make_cert() -> DtlsCert {
    use p256::ecdsa::{DerSignature, SigningKey};
    use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use rand_core::{OsRng, RngCore};
    use std::str::FromStr;
    use x509_cert::builder::{Builder, CertificateBuilder, Profile};
    use x509_cert::der::Encode;
    use x509_cert::name::Name;
    use x509_cert::serial_number::SerialNumber;
    use x509_cert::spki::SubjectPublicKeyInfoOwned;
    use x509_cert::time::Validity;

    let key = SigningKey::random(&mut OsRng);
    let spki_der = key
        .verifying_key()
        .to_public_key_der()
        .expect("a P-256 key encodes");
    let spki = SubjectPublicKeyInfoOwned::try_from(spki_der.as_bytes()).expect("and decodes");
    let mut serial = [0u8; 16];
    OsRng.fill_bytes(&mut serial);
    serial[0] &= 0x7f;
    let name = Name::from_str("CN=tryst").expect("a fixed name parses");
    let builder = CertificateBuilder::new(
        Profile::Leaf {
            issuer: name.clone(),
            enable_key_agreement: false,
            enable_key_encipherment: false,
        },
        SerialNumber::new(&serial).expect("16 bytes is a valid serial"),
        Validity::from_now(Duration::from_secs(30 * 86_400)).expect("now plus 30 days"),
        name,
        spki,
        &key,
    )
    .expect("a fixed profile builds");
    let cert = builder.build::<DerSignature>().expect("a fresh key signs");
    DtlsCert {
        certificate: cert.to_der().expect("a built certificate encodes"),
        private_key: key
            .to_pkcs8_der()
            .expect("a P-256 key encodes")
            .as_bytes()
            .to_vec(),
    }
}
