//! A TURN client over UDP (RFC 8656), sans-IO: bytes in, bytes out, and the
//! only clock is the `Instant` each call is handed.
//!
//! str0m gathers no relayed candidates and has no TURN client, so a peer
//! behind a NAT that will not hole-punch (symmetric, or a UDP-hostile
//! network) has nothing to fall back on. This is the missing half. The runtime
//! owns the one UDP socket and uses it for str0m and for this; the wiring is
//! three rules:
//!
//! - Allocate with [`TurnClient::new`], drain [`TurnClient::poll_transmit`]
//!   onto the socket, and when [`TurnEvent::Allocated`] arrives hand the
//!   relayed address to str0m as a local candidate.
//! - A str0m transmit whose source is the relayed address goes through
//!   [`TurnClient::send_to`], and the datagram that comes back is sent to the
//!   TURN server. Anything else str0m sends goes out directly.
//! - A datagram from the TURN server goes to [`TurnClient::handle_input`]; if
//!   it yields `(peer, payload)`, that is a datagram *to* str0m with the
//!   relayed address as its destination and `peer` as its source.
//!
//! It is the same shape as `stun.rs` and for the same reason: a few hundred
//! lines of codec in place of a crate, since the subset used is small and a
//! TURN crate would bring its own sockets and its own runtime.
//!
//! What it speaks: UDP only, IPv4 and IPv6 peers, the long-term credential
//! mechanism with MD5 and HMAC-SHA1 (the only ones coturn-style servers,
//! including Open Relay, offer by default), Allocate, Refresh,
//! CreatePermission, ChannelBind, Send and Data indications and ChannelData.
//! What it does not: TCP or TLS to the server, `MESSAGE-INTEGRITY-SHA256` and
//! password algorithms (RFC 8489), FINGERPRINT (never required on UDP, and
//! TURN servers do not demand it), alternate-server redirects, DONT-FRAGMENT,
//! and SASLprep of the username and password. ASCII credentials are their
//! own SASLprep; a caller with others must prepare them first.
//!
//! What is deliberately *not* here is a policy about candidates. Permissions
//! are by IP, so the caller says which peer IPs it has learned
//! ([`TurnClient::create_permission`]); [`TurnClient::send_to`] also asks for
//! one, so a forgotten call costs one round trip and not a black hole.

use std::collections::{BTreeMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use rand_core::{OsRng, RngCore};
use sha1::Sha1;

const MAGIC: u32 = 0x2112_A442;
const HEADER: usize = 20;
/// A STUN transaction ID.
type Tid = [u8; 12];

// Methods (RFC 8656 section 17).
const ALLOCATE: u16 = 0x0003;
const REFRESH: u16 = 0x0004;
const SEND: u16 = 0x0006;
const DATA_METHOD: u16 = 0x0007;
const CREATE_PERMISSION: u16 = 0x0008;
const CHANNEL_BIND: u16 = 0x0009;

// Classes, already shifted into place in the message type.
const REQUEST: u16 = 0x0000;
const INDICATION: u16 = 0x0010;
const SUCCESS: u16 = 0x0100;
const ERROR: u16 = 0x0110;

// Attributes.
const USERNAME: u16 = 0x0006;
const MESSAGE_INTEGRITY: u16 = 0x0008;
const ERROR_CODE: u16 = 0x0009;
const CHANNEL_NUMBER: u16 = 0x000C;
const LIFETIME: u16 = 0x000D;
const XOR_PEER_ADDRESS: u16 = 0x0012;
const DATA: u16 = 0x0013;
const REALM: u16 = 0x0014;
const NONCE: u16 = 0x0015;
const XOR_RELAYED_ADDRESS: u16 = 0x0016;
const REQUESTED_TRANSPORT: u16 = 0x0019;

/// IANA protocol number for UDP, the only transport asked for.
const TRANSPORT_UDP: u8 = 17;

/// The first retransmission interval (RFC 8489 section 6.2.1).
const RTO: Duration = Duration::from_millis(500);
/// Sends of one request before giving up: the original and six repeats.
const MAX_SENDS: u32 = 7;
/// After the last send, wait `Rm * RTO` (Rm = 16) for a late answer.
const FINAL_WAIT: Duration = Duration::from_millis(500 * 16);
/// How many times one request may be re-sent with a fresh nonce (401 on the
/// first Allocate, 438 later) before the server is deemed to be looping.
const MAX_AUTH_RETRIES: u8 = 3;

/// What a server grants when the response carries no LIFETIME.
const DEFAULT_LIFETIME: u32 = 600;
/// A permission lasts 300 s; refreshing at 240 s leaves a lost request room
/// for two retransmissions' worth of slack before it lapses.
const PERMISSION_REFRESH: Duration = Duration::from_secs(240);
/// A channel binding lasts 600 s. Refreshed well before, and not at the
/// allocation's cadence, because it is its own timer on the server.
const CHANNEL_REFRESH: Duration = Duration::from_secs(480);
/// Channel numbers a client may bind (RFC 8656 section 12).
const CHANNEL_FIRST: u16 = 0x4000;
const CHANNEL_LAST: u16 = 0x7FFE;

/// What the allocation became, for the caller to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEvent {
    /// The server granted this relayed transport address. Offer it to the
    /// peer connection as a local candidate.
    Allocated(SocketAddr),
    /// The allocation is gone or was never made: a refusal, bad credentials,
    /// no answer, or a refresh the server rejected. The client is inert from
    /// here; build a new one to try again.
    Failed(String),
}

/// A TURN client's state for one allocation on one server.
pub struct TurnClient {
    server: SocketAddr,
    username: String,
    password: String,
    /// `None` until the first 401 teaches us the realm and a nonce.
    auth: Option<Auth>,
    pending: Vec<Pending>,
    transmits: VecDeque<Vec<u8>>,
    events: VecDeque<TurnEvent>,
    allocation: Option<Allocation>,
    permissions: BTreeMap<IpAddr, Permission>,
    channels: BTreeMap<SocketAddr, Channel>,
    by_number: BTreeMap<u16, SocketAddr>,
    next_channel: u16,
    failed: bool,
}

/// What the long-term credential mechanism needs on every request.
struct Auth {
    realm: Vec<u8>,
    nonce: Vec<u8>,
    /// `MD5(username ":" realm ":" password)`.
    key: [u8; 16],
}

struct Allocation {
    relayed: SocketAddr,
    /// `None` while a Refresh is in flight.
    refresh_at: Option<Instant>,
}

enum Permission {
    /// Asked for (or waiting for the allocation); not yet confirmed.
    Requested,
    /// Confirmed. `None` while a refresh is in flight, and the permission is
    /// still good then, so sends carry on.
    Granted { refresh_at: Option<Instant> },
}

struct Channel {
    number: u16,
    state: ChannelState,
}

enum ChannelState {
    Binding,
    Bound {
        refresh_at: Option<Instant>,
    },
    /// The server refused or never answered. Kept, rather than removed, so
    /// that the next packet to this peer does not ask again: an error that is
    /// persistent (403) would otherwise cost a request per packet. Sends fall
    /// back to indications, which need no binding.
    Unusable,
}

#[derive(Clone)]
enum Kind {
    Allocate,
    Refresh,
    Permission(IpAddr),
    ChannelBind(SocketAddr, u16),
}

/// A request awaiting its answer, with what is needed to repeat it.
struct Pending {
    tid: Tid,
    kind: Kind,
    wire: Vec<u8>,
    /// Whether `wire` carried credentials. A 401 to a request that did is a
    /// refusal of those credentials, not a request to send them.
    authed: bool,
    auth_retries: u8,
    sends: u32,
    /// The wait after the *next* send.
    rto: Duration,
    deadline: Instant,
}

impl Pending {
    /// Record a send at `now` and set when to give up on it.
    fn sent(&mut self, now: Instant) {
        self.sends += 1;
        let wait = if self.sends >= MAX_SENDS {
            FINAL_WAIT
        } else {
            self.rto
        };
        self.deadline = now + wait;
        self.rto *= 2;
    }
}

impl TurnClient {
    /// Start an allocation on `server`. The first Allocate request is queued
    /// at once; drain [`poll_transmit`](Self::poll_transmit).
    pub fn new(server: SocketAddr, username: &str, password: &str, now: Instant) -> Self {
        let mut c = TurnClient {
            server,
            username: username.to_owned(),
            password: password.to_owned(),
            auth: None,
            pending: Vec::new(),
            transmits: VecDeque::new(),
            events: VecDeque::new(),
            allocation: None,
            permissions: BTreeMap::new(),
            channels: BTreeMap::new(),
            by_number: BTreeMap::new(),
            next_channel: CHANNEL_FIRST,
            failed: false,
        };
        c.issue(Kind::Allocate, 0, now);
        c
    }

    /// Whether `from` is the TURN server. The caller checks this before
    /// [`handle_input`](Self::handle_input), since the same socket also
    /// carries str0m's traffic, and a datagram from the server is never
    /// anything but ours.
    pub fn is_from_server(&self, from: SocketAddr) -> bool {
        from == self.server
    }

    /// Where every datagram this client produces goes.
    pub fn server(&self) -> SocketAddr {
        self.server
    }

    /// The relayed transport address, once allocated and until it is lost.
    pub fn relayed_address(&self) -> Option<SocketAddr> {
        self.allocation.as_ref().map(|a| a.relayed)
    }

    /// The next thing that happened to the allocation.
    pub fn poll_event(&mut self) -> Option<TurnEvent> {
        self.events.pop_front()
    }

    /// The next datagram for the TURN server, and the server's address.
    pub fn poll_transmit(&mut self) -> Option<(SocketAddr, Vec<u8>)> {
        self.transmits.pop_front().map(|d| (self.server, d))
    }

    /// When [`handle_timeout`](Self::handle_timeout) next has work: a
    /// retransmission, or a refresh coming due. `None` once failed.
    pub fn poll_timeout(&self) -> Option<Instant> {
        if self.failed {
            return None;
        }
        let pending = self.pending.iter().map(|p| p.deadline);
        let alloc = self.allocation.iter().filter_map(|a| a.refresh_at);
        let perms = self.permissions.values().filter_map(|p| match p {
            Permission::Granted { refresh_at } => *refresh_at,
            Permission::Requested => None,
        });
        let chans = self.channels.values().filter_map(|c| match c.state {
            ChannelState::Bound { refresh_at } => refresh_at,
            _ => None,
        });
        pending.chain(alloc).chain(perms).chain(chans).min()
    }

    /// Run whatever is due at `now`: repeat unanswered requests, give up on
    /// ones repeated enough, and send the refreshes whose time has come.
    pub fn handle_timeout(&mut self, now: Instant) {
        if self.failed {
            return;
        }
        let mut keep = Vec::new();
        let mut dead = Vec::new();
        for mut p in std::mem::take(&mut self.pending) {
            if p.deadline > now {
                keep.push(p);
            } else if p.sends >= MAX_SENDS {
                dead.push(p.kind);
            } else {
                self.transmits.push_back(p.wire.clone());
                p.sent(now);
                keep.push(p);
            }
        }
        self.pending = keep;
        for kind in dead {
            self.fail(kind, "no answer from the server");
        }
        if self.failed {
            return;
        }

        if let Some(a) = &mut self.allocation
            && a.refresh_at.is_some_and(|t| t <= now)
        {
            a.refresh_at = None;
            self.issue(Kind::Refresh, 0, now);
        }
        let due: Vec<IpAddr> = self
            .permissions
            .iter()
            .filter(|(_, p)| matches!(p, Permission::Granted { refresh_at: Some(t) } if *t <= now))
            .map(|(ip, _)| *ip)
            .collect();
        for ip in due {
            self.permissions
                .insert(ip, Permission::Granted { refresh_at: None });
            self.issue(Kind::Permission(ip), 0, now);
        }
        let due: Vec<(SocketAddr, u16)> = self
            .channels
            .iter()
            .filter(
                |(_, c)| matches!(c.state, ChannelState::Bound { refresh_at: Some(t) } if t <= now),
            )
            .map(|(peer, c)| (*peer, c.number))
            .collect();
        for (peer, n) in due {
            if let Some(c) = self.channels.get_mut(&peer) {
                c.state = ChannelState::Bound { refresh_at: None };
            }
            self.issue(Kind::ChannelBind(peer, n), 0, now);
        }
    }

    /// Ask the server to accept traffic from `peer`'s address. Permissions
    /// are by IP and port-less, last five minutes, and are kept alive here
    /// for as long as the client lives. Call it when a remote candidate's
    /// address is learned, *before* ICE checks go out from the relayed
    /// address: a check that reaches the server first is dropped, and the
    /// peer's answer to it is too if no permission exists yet.
    ///
    /// Idempotent. Before the allocation exists the request waits for it.
    pub fn create_permission(&mut self, peer: IpAddr, now: Instant) {
        if self.failed || self.permissions.contains_key(&peer) {
            return;
        }
        self.permissions.insert(peer, Permission::Requested);
        if self.allocation.is_some() {
            self.issue(Kind::Permission(peer), 0, now);
        }
    }

    /// Wrap `data` for `peer` and return the datagram to send to the server.
    ///
    /// It is a ChannelData frame (4 bytes of overhead) once a channel to
    /// `peer` is bound, and a Send indication (36) until then; the first send
    /// to a peer starts the bind, queued on [`poll_transmit`](Self::poll_transmit).
    /// `None` before the allocation exists, after it is lost, or for a
    /// payload too large for either framing: a dropped datagram, which ICE
    /// and DTLS are built to survive. The first datagram to a new peer can
    /// also be lost at the server, whose permission for it is still in
    /// flight.
    pub fn send_to(&mut self, peer: SocketAddr, data: &[u8], now: Instant) -> Option<Vec<u8>> {
        if self.failed || self.allocation.is_none() || data.len() > 60_000 {
            return None;
        }
        self.create_permission(peer.ip(), now);
        match self.channels.get(&peer) {
            Some(Channel {
                number,
                state: ChannelState::Bound { .. },
            }) => {
                let mut f = Vec::with_capacity(4 + data.len());
                f.extend_from_slice(&number.to_be_bytes());
                f.extend_from_slice(&(data.len() as u16).to_be_bytes());
                f.extend_from_slice(data);
                return Some(f);
            }
            Some(_) => {}
            None if self.next_channel <= CHANNEL_LAST => {
                let n = self.next_channel;
                self.next_channel += 1;
                self.channels.insert(
                    peer,
                    Channel {
                        number: n,
                        state: ChannelState::Binding,
                    },
                );
                self.by_number.insert(n, peer);
                self.issue(Kind::ChannelBind(peer, n), 0, now);
            }
            None => {}
        }
        let tid = new_tid();
        let mut b = Builder::new(SEND | INDICATION, &tid);
        b.attr(XOR_PEER_ADDRESS, &xor_address(peer, &tid));
        b.attr(DATA, data);
        Some(b.finish())
    }

    /// Consume a datagram from the TURN server: a response to one of our
    /// requests (acted on, nothing returned), or relayed data from a peer
    /// (a Data indication or ChannelData), returned as `(peer, payload)`.
    ///
    /// It looks only at the first byte and the framing: a datagram from any
    /// other source, or one that is not TURN, returns `None` and changes
    /// nothing. The caller is expected to check
    /// [`is_from_server`](Self::is_from_server) first, so that a datagram
    /// that is str0m's is never even offered here.
    pub fn handle_input(
        &mut self,
        from: SocketAddr,
        data: &[u8],
        now: Instant,
    ) -> Option<(SocketAddr, Vec<u8>)> {
        if from != self.server || self.failed {
            return None;
        }
        match *data.first()? {
            0x40..=0x7F => {
                let n = u16::from_be_bytes([data[0], *data.get(1)?]);
                let len = u16::from_be_bytes([*data.get(2)?, *data.get(3)?]) as usize;
                let payload = data.get(4..4 + len)?;
                Some((*self.by_number.get(&n)?, payload.to_vec()))
            }
            0x00..=0x3F => {
                let msg = parse(data)?;
                match msg.typ & 0x0110 {
                    INDICATION if msg.typ == DATA_METHOD | INDICATION => {
                        let peer = parse_xor_address(msg.attr(XOR_PEER_ADDRESS)?, &msg.tid)?;
                        Some((peer, msg.attr(DATA)?.to_vec()))
                    }
                    SUCCESS | ERROR => {
                        self.on_response(&msg, now);
                        None
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// Build, queue and track a request. The wire bytes are kept so that a
    /// retransmission is byte-identical, as RFC 8489 requires.
    fn issue(&mut self, kind: Kind, auth_retries: u8, now: Instant) {
        let tid = new_tid();
        let (wire, authed) = self.build(&kind, &tid);
        self.transmits.push_back(wire.clone());
        let mut p = Pending {
            tid,
            kind,
            wire,
            authed,
            auth_retries,
            sends: 0,
            rto: RTO,
            deadline: now,
        };
        p.sent(now);
        self.pending.push(p);
    }

    /// A request, with credentials once we have a realm and nonce.
    fn build(&self, kind: &Kind, tid: &Tid) -> (Vec<u8>, bool) {
        let mut b = Builder::new(REQUEST | method_of(kind), tid);
        match kind {
            Kind::Allocate => b.attr(REQUESTED_TRANSPORT, &[TRANSPORT_UDP, 0, 0, 0]),
            Kind::Refresh => {}
            Kind::Permission(ip) => {
                b.attr(XOR_PEER_ADDRESS, &xor_address(SocketAddr::new(*ip, 0), tid));
            }
            Kind::ChannelBind(peer, n) => {
                let [hi, lo] = n.to_be_bytes();
                b.attr(CHANNEL_NUMBER, &[hi, lo, 0, 0]);
                b.attr(XOR_PEER_ADDRESS, &xor_address(*peer, tid));
            }
        }
        match &self.auth {
            Some(a) => {
                b.attr(USERNAME, self.username.as_bytes());
                b.attr(REALM, &a.realm);
                b.attr(NONCE, &a.nonce);
                (b.finish_with_integrity(&a.key), true)
            }
            None => (b.finish(), false),
        }
    }

    fn on_response(&mut self, msg: &Message<'_>, now: Instant) {
        let Some(idx) = self.pending.iter().position(|p| p.tid == msg.tid) else {
            return;
        };
        // A response to a request that carried credentials proves, by its
        // integrity, that it is the server's and not a guess at a
        // transaction ID. The 401 that starts the exchange has none to
        // check, and a success without one is refused only where it would
        // have to have one. An error is left to its code: a wrong-nonce 438
        // is signed with the *new* nonce's key at best.
        if msg.typ & 0x0110 == SUCCESS
            && self.pending[idx].authed
            && let Some(a) = &self.auth
            && msg.verify_integrity(&a.key) != Some(true)
        {
            return;
        }
        let p = self.pending.remove(idx);

        if msg.typ & 0x0110 == ERROR {
            let (code, reason) = msg.error().unwrap_or((0, String::new()));
            let stale = code == 438;
            let challenge = code == 401 && !p.authed;
            if (stale || challenge)
                && p.auth_retries < MAX_AUTH_RETRIES
                && let Some(nonce) = msg.attr(NONCE)
            {
                // A 438 may omit the realm; the old one stands then.
                let realm = match (msg.attr(REALM), &self.auth) {
                    (Some(r), _) => r.to_vec(),
                    (None, Some(a)) if !challenge => a.realm.clone(),
                    _ => Vec::new(),
                };
                if !realm.is_empty() {
                    self.set_auth(realm, nonce.to_vec());
                    self.issue(p.kind, p.auth_retries + 1, now);
                    return;
                }
            }
            self.fail(p.kind, &format!("{code} {reason}"));
            return;
        }

        match p.kind {
            Kind::Allocate => {
                let relayed = msg
                    .attr(XOR_RELAYED_ADDRESS)
                    .and_then(|v| parse_xor_address(v, &msg.tid));
                let Some(relayed) = relayed else {
                    self.fail(Kind::Allocate, "success without a relayed address");
                    return;
                };
                self.allocation = Some(Allocation {
                    relayed,
                    refresh_at: Some(now + refresh_delay(msg.lifetime())),
                });
                self.events.push_back(TurnEvent::Allocated(relayed));
                // Permissions asked for during the allocation wait for it.
                let waiting: Vec<IpAddr> = self
                    .permissions
                    .iter()
                    .filter(|(_, p)| matches!(p, Permission::Requested))
                    .map(|(ip, _)| *ip)
                    .collect();
                for ip in waiting {
                    self.issue(Kind::Permission(ip), 0, now);
                }
            }
            Kind::Refresh => {
                if let Some(a) = &mut self.allocation {
                    a.refresh_at = Some(now + refresh_delay(msg.lifetime()));
                }
            }
            Kind::Permission(ip) => {
                self.permissions.insert(
                    ip,
                    Permission::Granted {
                        refresh_at: Some(now + PERMISSION_REFRESH),
                    },
                );
            }
            Kind::ChannelBind(peer, _) => {
                if let Some(c) = self.channels.get_mut(&peer) {
                    c.state = ChannelState::Bound {
                        refresh_at: Some(now + CHANNEL_REFRESH),
                    };
                }
            }
        }
    }

    fn set_auth(&mut self, realm: Vec<u8>, nonce: Vec<u8>) {
        // RFC 8489 section 9.2.2: MD5 of "username:realm:password".
        let mut h = Md5::new();
        h.update(self.username.as_bytes());
        h.update(b":");
        h.update(&realm);
        h.update(b":");
        h.update(self.password.as_bytes());
        self.auth = Some(Auth {
            realm,
            nonce,
            key: h.finalize().into(),
        });
    }

    /// A request that cannot succeed. Losing the allocation ends the client;
    /// losing a permission or a channel costs only that one.
    fn fail(&mut self, kind: Kind, why: &str) {
        match kind {
            Kind::Allocate | Kind::Refresh => {
                self.failed = true;
                self.allocation = None;
                self.pending.clear();
                let what = if matches!(kind, Kind::Allocate) {
                    "allocate"
                } else {
                    "refresh"
                };
                self.events
                    .push_back(TurnEvent::Failed(format!("{what}: {why}")));
            }
            Kind::Permission(ip) => {
                self.permissions.remove(&ip);
            }
            Kind::ChannelBind(peer, _) => {
                if let Some(c) = self.channels.get_mut(&peer) {
                    c.state = ChannelState::Unusable;
                }
            }
        }
    }
}

fn method_of(kind: &Kind) -> u16 {
    match kind {
        Kind::Allocate => ALLOCATE,
        Kind::Refresh => REFRESH,
        Kind::Permission(_) => CREATE_PERMISSION,
        Kind::ChannelBind(..) => CHANNEL_BIND,
    }
}

/// How long to wait before refreshing an allocation granted `lifetime`
/// seconds: a minute before it lapses, but never sooner than the half-way
/// mark, so that a short lifetime is not refreshed in a tight loop.
fn refresh_delay(lifetime: u32) -> Duration {
    Duration::from_secs(u64::from(lifetime.saturating_sub(60).max(lifetime / 2)))
}

fn new_tid() -> Tid {
    let mut t = [0u8; 12];
    OsRng.fill_bytes(&mut t);
    t
}

/// A message under construction. The length field is kept current after each
/// attribute, because MESSAGE-INTEGRITY is computed over a header whose
/// length already counts the attribute it is about to become.
struct Builder {
    buf: Vec<u8>,
}

impl Builder {
    fn new(typ: u16, tid: &Tid) -> Self {
        let mut buf = Vec::with_capacity(128);
        buf.extend_from_slice(&typ.to_be_bytes());
        buf.extend_from_slice(&[0, 0]);
        buf.extend_from_slice(&MAGIC.to_be_bytes());
        buf.extend_from_slice(tid);
        Builder { buf }
    }

    fn attr(&mut self, kind: u16, value: &[u8]) {
        self.buf.extend_from_slice(&kind.to_be_bytes());
        self.buf
            .extend_from_slice(&(value.len() as u16).to_be_bytes());
        self.buf.extend_from_slice(value);
        // Attributes are padded to four bytes; the length field excludes the
        // padding of the last one only by convention, and counts it here.
        self.buf.resize(self.buf.len().div_ceil(4) * 4, 0);
        let len = (self.buf.len() - HEADER) as u16;
        self.buf[2..4].copy_from_slice(&len.to_be_bytes());
    }

    fn finish(self) -> Vec<u8> {
        self.buf
    }

    fn finish_with_integrity(mut self, key: &[u8]) -> Vec<u8> {
        let mac = integrity(&self.buf, key);
        self.attr(MESSAGE_INTEGRITY, &mac);
        self.buf
    }
}

/// HMAC-SHA1 over `prefix` (a whole message up to, not including, its
/// MESSAGE-INTEGRITY attribute), with the length field rewritten to count
/// that attribute's 24 bytes (RFC 8489 section 14.5). The caller's header
/// may say anything about length; it is the *covered* bytes that are signed.
fn integrity(prefix: &[u8], key: &[u8]) -> [u8; 20] {
    let mut buf = prefix.to_vec();
    let len = (buf.len() - HEADER + 24) as u16;
    buf[2..4].copy_from_slice(&len.to_be_bytes());
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(&buf);
    mac.finalize().into_bytes().into()
}

/// The 16 bytes an IPv6 address is XORed with: the cookie, then the
/// transaction ID.
fn v6_mask(tid: &Tid) -> [u8; 16] {
    let mut m = [0u8; 16];
    m[..4].copy_from_slice(&MAGIC.to_be_bytes());
    m[4..].copy_from_slice(tid);
    m
}

/// The value of an XOR-PEER-ADDRESS, XOR-RELAYED-ADDRESS or the like.
fn xor_address(addr: SocketAddr, tid: &Tid) -> Vec<u8> {
    let mut v = vec![0, 0];
    v.extend_from_slice(&(addr.port() ^ (MAGIC >> 16) as u16).to_be_bytes());
    match addr.ip() {
        IpAddr::V4(ip) => {
            v[1] = 1;
            v.extend_from_slice(&(u32::from(ip) ^ MAGIC).to_be_bytes());
        }
        IpAddr::V6(ip) => {
            v[1] = 2;
            let mask = v6_mask(tid);
            v.extend(ip.octets().iter().zip(mask).map(|(a, m)| a ^ m));
        }
    }
    v
}

fn parse_xor_address(v: &[u8], tid: &Tid) -> Option<SocketAddr> {
    let port = u16::from_be_bytes([*v.get(2)?, *v.get(3)?]) ^ (MAGIC >> 16) as u16;
    let ip = match v.get(1)? {
        1 => {
            let b: [u8; 4] = v.get(4..8)?.try_into().ok()?;
            IpAddr::V4(Ipv4Addr::from(u32::from_be_bytes(b) ^ MAGIC))
        }
        2 => {
            let b = v.get(4..20)?;
            let mask = v6_mask(tid);
            let mut a = [0u8; 16];
            for (i, o) in a.iter_mut().enumerate() {
                *o = b[i] ^ mask[i];
            }
            IpAddr::V6(Ipv6Addr::from(a))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

struct Attr<'a> {
    kind: u16,
    /// Where the attribute's header starts in the message.
    offset: usize,
    value: &'a [u8],
}

struct Message<'a> {
    typ: u16,
    tid: Tid,
    raw: &'a [u8],
    attrs: Vec<Attr<'a>>,
}

/// A STUN message, or `None` for anything that is not one: wrong cookie,
/// a length that does not fit, an attribute that runs off the end.
fn parse(msg: &[u8]) -> Option<Message<'_>> {
    if msg.len() < HEADER
        || msg[0] & 0xC0 != 0
        || u32::from_be_bytes([msg[4], msg[5], msg[6], msg[7]]) != MAGIC
    {
        return None;
    }
    let len = u16::from_be_bytes([msg[2], msg[3]]) as usize;
    if !len.is_multiple_of(4) {
        return None;
    }
    let body = msg.get(HEADER..HEADER + len)?;
    let mut attrs = Vec::new();
    let mut i = 0;
    while i + 4 <= body.len() {
        let kind = u16::from_be_bytes([body[i], body[i + 1]]);
        let alen = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        let value = body.get(i + 4..i + 4 + alen)?;
        attrs.push(Attr {
            kind,
            offset: HEADER + i,
            value,
        });
        i += 4 + alen.div_ceil(4) * 4;
    }
    Some(Message {
        typ: u16::from_be_bytes([msg[0], msg[1]]),
        tid: msg[8..20].try_into().ok()?,
        raw: msg,
        attrs,
    })
}

impl Message<'_> {
    fn attr(&self, kind: u16) -> Option<&[u8]> {
        self.attrs.iter().find(|a| a.kind == kind).map(|a| a.value)
    }

    /// Whether the MESSAGE-INTEGRITY is right under `key`; `None` if the
    /// message has none.
    fn verify_integrity(&self, key: &[u8]) -> Option<bool> {
        let a = self.attrs.iter().find(|a| a.kind == MESSAGE_INTEGRITY)?;
        Some(a.value == integrity(&self.raw[..a.offset], key))
    }

    fn error(&self) -> Option<(u16, String)> {
        let v = self.attr(ERROR_CODE)?;
        let code = u16::from(*v.get(2)? & 7) * 100 + u16::from(*v.get(3)?);
        Some((code, String::from_utf8_lossy(v.get(4..)?).into_owned()))
    }

    fn lifetime(&self) -> u32 {
        self.attr(LIFETIME)
            .and_then(|v| <[u8; 4]>::try_from(v).ok())
            .map_or(DEFAULT_LIFETIME, u32::from_be_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectors::unhex;

    const SERVER: &str = "198.51.100.1:3478";

    fn server() -> SocketAddr {
        SERVER.parse().unwrap()
    }

    fn key_for(user: &str, realm: &str, pass: &str) -> [u8; 16] {
        Md5::digest(format!("{user}:{realm}:{pass}")).into()
    }

    /// What a server sends back for `req`.
    fn respond(req: &[u8], typ: u16, attrs: &[(u16, Vec<u8>)], key: Option<&[u8; 16]>) -> Vec<u8> {
        let tid: Tid = req[8..20].try_into().unwrap();
        let mut b = Builder::new(typ, &tid);
        for (k, v) in attrs {
            b.attr(*k, v);
        }
        match key {
            Some(k) => b.finish_with_integrity(k),
            None => b.finish(),
        }
    }

    fn error_attr(code: u16, reason: &str) -> (u16, Vec<u8>) {
        let mut v = vec![0, 0, (code / 100) as u8, (code % 100) as u8];
        v.extend_from_slice(reason.as_bytes());
        (ERROR_CODE, v)
    }

    fn drain(c: &mut TurnClient) -> Vec<Vec<u8>> {
        std::iter::from_fn(|| c.poll_transmit())
            .map(|(to, d)| {
                assert_eq!(to, server());
                d
            })
            .collect()
    }

    /// One queued datagram, parsed.
    fn one(c: &mut TurnClient) -> Vec<u8> {
        let mut v = drain(c);
        assert_eq!(v.len(), 1, "expected exactly one datagram");
        v.remove(0)
    }

    /// A client through a 401 and an authenticated success, relayed address
    /// 203.0.113.7:49152 and the lifetime given.
    fn allocated(t0: Instant, lifetime: u32) -> (TurnClient, [u8; 16]) {
        let mut c = TurnClient::new(server(), "user", "pass", t0);
        let first = one(&mut c);
        let challenge = respond(
            &first,
            ALLOCATE | ERROR,
            &[
                error_attr(401, "Unauthorized"),
                (REALM, b"example.org".to_vec()),
                (NONCE, b"nonce-1".to_vec()),
            ],
            None,
        );
        assert!(c.handle_input(server(), &challenge, t0).is_none());
        let second = one(&mut c);
        let key = key_for("user", "example.org", "pass");
        let tid: Tid = second[8..20].try_into().unwrap();
        let ok = respond(
            &second,
            ALLOCATE | SUCCESS,
            &[
                (
                    XOR_RELAYED_ADDRESS,
                    xor_address("203.0.113.7:49152".parse().unwrap(), &tid),
                ),
                (LIFETIME, lifetime.to_be_bytes().to_vec()),
            ],
            Some(&key),
        );
        c.handle_input(server(), &ok, t0);
        (c, key)
    }

    #[test]
    fn rfc_5769_long_term_credential_integrity_matches_byte_for_byte() {
        // RFC 5769 section 2.4. The USERNAME on the wire is the SASLprep'd
        // form of the sample's, so the key can be made from it directly.
        let msg = unhex(concat!(
            "000100602112a44278ad3433c6ad72c029da412e",
            "00060012e3839ee38388e383aae38383e382afe382b90000",
            "0015001c662f2f3439396b39353464364f4c33346f4c39465354767936347341",
            "0014000b6578616d706c652e6f726700",
            "00080014f67024656dd64a3e02b8e0712e85c9a28ca89666"
        ));
        let m = parse(&msg).unwrap();
        let username = String::from_utf8(m.attr(USERNAME).unwrap().to_vec()).unwrap();
        assert_eq!(username.chars().count(), 6);
        assert_eq!(m.attr(REALM).unwrap(), b"example.org");
        assert_eq!(m.attr(NONCE).unwrap(), b"f//499k954d6OL34oL9FSTvy64sA");

        let key = key_for(&username, "example.org", "TheMatrIX");
        let mi = m
            .attrs
            .iter()
            .find(|a| a.kind == MESSAGE_INTEGRITY)
            .unwrap();
        let want = unhex("f67024656dd64a3e02b8e0712e85c9a28ca89666");
        assert_eq!(integrity(&msg[..mi.offset], &key).to_vec(), want);

        // The same message, rebuilt by the Builder, is the vector's bytes.
        let tid: Tid = msg[8..20].try_into().unwrap();
        let mut b = Builder::new(0x0001, &tid);
        b.attr(USERNAME, username.as_bytes());
        b.attr(NONCE, m.attr(NONCE).unwrap());
        b.attr(REALM, b"example.org");
        let built = b.finish_with_integrity(&key);
        assert_eq!(&built[..mi.offset], &msg[..mi.offset]);
        assert_eq!(&built[mi.offset + 4..], &want[..]);
    }

    #[test]
    fn the_first_allocate_is_unauthenticated_and_the_second_carries_credentials() {
        let t0 = Instant::now();
        let mut c = TurnClient::new(server(), "user", "pass", t0);
        let first = one(&mut c);
        // Header, then REQUESTED-TRANSPORT = UDP and nothing else.
        assert_eq!(&first[..2], &[0x00, 0x03]);
        assert_eq!(&first[2..4], &[0x00, 0x08]);
        assert_eq!(&first[4..8], &MAGIC.to_be_bytes());
        assert_eq!(&first[20..], &[0x00, 0x19, 0x00, 0x04, 17, 0, 0, 0]);

        let challenge = respond(
            &first,
            ALLOCATE | ERROR,
            &[
                error_attr(401, "Unauthorized"),
                (REALM, b"example.org".to_vec()),
                (NONCE, b"abc".to_vec()),
            ],
            None,
        );
        assert!(c.handle_input(server(), &challenge, t0).is_none());
        let second = one(&mut c);
        assert_ne!(first[8..20], second[8..20], "a retry is a new transaction");
        let m = parse(&second).unwrap();
        assert_eq!(m.typ, ALLOCATE | REQUEST);
        assert_eq!(m.attr(USERNAME).unwrap(), b"user");
        assert_eq!(m.attr(REALM).unwrap(), b"example.org");
        assert_eq!(m.attr(NONCE).unwrap(), b"abc");
        assert_eq!(m.attr(REQUESTED_TRANSPORT).unwrap(), &[17, 0, 0, 0]);
        assert_eq!(
            m.verify_integrity(&key_for("user", "example.org", "pass")),
            Some(true)
        );
        assert_eq!(c.relayed_address(), None);
        assert_eq!(c.poll_event(), None);
    }

    #[test]
    fn a_success_yields_the_relayed_address_and_one_event() {
        let t0 = Instant::now();
        let (mut c, _) = allocated(t0, 600);
        let want: SocketAddr = "203.0.113.7:49152".parse().unwrap();
        assert_eq!(c.relayed_address(), Some(want));
        assert_eq!(c.poll_event(), Some(TurnEvent::Allocated(want)));
        assert_eq!(c.poll_event(), None);
        // Refresh a minute before the lifetime lapses.
        assert_eq!(c.poll_timeout(), Some(t0 + Duration::from_secs(540)));
    }

    #[test]
    fn a_forged_success_without_valid_integrity_is_ignored() {
        let t0 = Instant::now();
        let mut c = TurnClient::new(server(), "user", "pass", t0);
        let first = one(&mut c);
        let challenge = respond(
            &first,
            ALLOCATE | ERROR,
            &[
                error_attr(401, "x"),
                (REALM, b"r".to_vec()),
                (NONCE, b"n".to_vec()),
            ],
            None,
        );
        c.handle_input(server(), &challenge, t0);
        let second = one(&mut c);
        let tid: Tid = second[8..20].try_into().unwrap();
        let attrs = [(
            XOR_RELAYED_ADDRESS,
            xor_address("203.0.113.7:1".parse().unwrap(), &tid),
        )];
        let unsigned = respond(&second, ALLOCATE | SUCCESS, &attrs, None);
        let wrong = respond(&second, ALLOCATE | SUCCESS, &attrs, Some(&[7; 16]));
        c.handle_input(server(), &unsigned, t0);
        c.handle_input(server(), &wrong, t0);
        assert_eq!(c.relayed_address(), None);
        assert_eq!(c.poll_event(), None);
    }

    #[test]
    fn permissions_and_the_allocation_are_refreshed_on_their_timers() {
        let t0 = Instant::now();
        let (mut c, key) = allocated(t0, 600);
        let peer: IpAddr = "198.51.100.9".parse().unwrap();
        c.create_permission(peer, t0);
        c.create_permission(peer, t0); // idempotent
        let req = one(&mut c);
        let m = parse(&req).unwrap();
        assert_eq!(m.typ, CREATE_PERMISSION | REQUEST);
        let tid = m.tid;
        assert_eq!(
            parse_xor_address(m.attr(XOR_PEER_ADDRESS).unwrap(), &tid),
            Some(SocketAddr::new(peer, 0))
        );
        assert_eq!(m.verify_integrity(&key), Some(true));
        let ok = respond(&req, CREATE_PERMISSION | SUCCESS, &[], Some(&key));
        c.handle_input(server(), &ok, t0);

        // The permission comes due at 240 s, the allocation at 540 s.
        let t240 = t0 + Duration::from_secs(240);
        assert_eq!(c.poll_timeout(), Some(t240));
        c.handle_timeout(t240 - Duration::from_millis(1));
        assert!(drain(&mut c).is_empty());
        c.handle_timeout(t240);
        let req = one(&mut c);
        assert_eq!(parse(&req).unwrap().typ, CREATE_PERMISSION | REQUEST);
        let ok = respond(&req, CREATE_PERMISSION | SUCCESS, &[], Some(&key));
        c.handle_input(server(), &ok, t240);
        assert_eq!(c.poll_timeout(), Some(t240 + Duration::from_secs(240)));

        let t480 = t240 + Duration::from_secs(240);
        c.handle_timeout(t480);
        let req = one(&mut c);
        assert_eq!(parse(&req).unwrap().typ, CREATE_PERMISSION | REQUEST);
        let ok = respond(&req, CREATE_PERMISSION | SUCCESS, &[], Some(&key));
        c.handle_input(server(), &ok, t480);

        let t540 = t0 + Duration::from_secs(540);
        assert_eq!(c.poll_timeout(), Some(t540));
        c.handle_timeout(t540);
        let req = one(&mut c);
        let m = parse(&req).unwrap();
        assert_eq!(m.typ, REFRESH | REQUEST);
        assert_eq!(m.verify_integrity(&key), Some(true));
        let ok = respond(
            &req,
            REFRESH | SUCCESS,
            &[(LIFETIME, 600u32.to_be_bytes().to_vec())],
            Some(&key),
        );
        c.handle_input(server(), &ok, t540);
        // The next one due is the permission, refreshed at 480 s: 720 s.
        assert_eq!(c.poll_timeout(), Some(t0 + Duration::from_secs(720)));
    }

    #[test]
    fn a_permission_asked_for_before_the_allocation_waits_for_it() {
        let t0 = Instant::now();
        let mut c = TurnClient::new(server(), "user", "pass", t0);
        let peer: IpAddr = "198.51.100.9".parse().unwrap();
        c.create_permission(peer, t0);
        assert_eq!(drain(&mut c).len(), 1, "only the Allocate");
        assert_eq!(c.send_to("198.51.100.9:5".parse().unwrap(), b"x", t0), None);
    }

    #[test]
    fn a_stale_nonce_is_retried_with_the_new_one() {
        let t0 = Instant::now();
        let (mut c, key) = allocated(t0, 600);
        let t = t0 + Duration::from_secs(540);
        c.handle_timeout(t);
        let req = one(&mut c);
        let stale = respond(
            &req,
            REFRESH | ERROR,
            &[
                error_attr(438, "Stale Nonce"),
                (REALM, b"example.org".to_vec()),
                (NONCE, b"nonce-2".to_vec()),
            ],
            None,
        );
        c.handle_input(server(), &stale, t);
        let retry = one(&mut c);
        let m = parse(&retry).unwrap();
        assert_eq!(m.typ, REFRESH | REQUEST);
        assert_eq!(m.attr(NONCE).unwrap(), b"nonce-2");
        assert_eq!(m.verify_integrity(&key), Some(true));
        assert!(c.relayed_address().is_some());
    }

    #[test]
    fn refused_credentials_fail_the_allocation_instead_of_looping() {
        let t0 = Instant::now();
        let mut c = TurnClient::new(server(), "user", "wrong", t0);
        let first = one(&mut c);
        let challenge = respond(
            &first,
            ALLOCATE | ERROR,
            &[
                error_attr(401, "Unauthorized"),
                (REALM, b"r".to_vec()),
                (NONCE, b"n".to_vec()),
            ],
            None,
        );
        c.handle_input(server(), &challenge, t0);
        let second = one(&mut c);
        let again = respond(
            &second,
            ALLOCATE | ERROR,
            &[
                error_attr(401, "Unauthorized"),
                (REALM, b"r".to_vec()),
                (NONCE, b"n".to_vec()),
            ],
            None,
        );
        c.handle_input(server(), &again, t0);
        assert!(drain(&mut c).is_empty());
        assert_eq!(
            c.poll_event(),
            Some(TurnEvent::Failed("allocate: 401 Unauthorized".into()))
        );
        assert_eq!(c.poll_timeout(), None);
        assert_eq!(c.send_to("1.2.3.4:5".parse().unwrap(), b"x", t0), None);
    }

    #[test]
    fn relayed_data_unwraps_and_outbound_data_wraps_then_moves_to_a_channel() {
        let t0 = Instant::now();
        let (mut c, key) = allocated(t0, 600);
        let peer: SocketAddr = "198.51.100.9:40000".parse().unwrap();

        // Inbound Data indication.
        let tid = [9u8; 12];
        let mut b = Builder::new(DATA_METHOD | INDICATION, &tid);
        b.attr(XOR_PEER_ADDRESS, &xor_address(peer, &tid));
        b.attr(DATA, b"hello");
        let ind = b.finish();
        assert_eq!(
            c.handle_input(server(), &ind, t0),
            Some((peer, b"hello".to_vec()))
        );
        // The same datagram from anywhere else is not ours.
        assert_eq!(c.handle_input(peer, &ind, t0), None);
        assert!(!c.is_from_server(peer) && c.is_from_server(server()));
        // Garbage in both framings.
        assert_eq!(c.handle_input(server(), &[], t0), None);
        assert_eq!(c.handle_input(server(), &[0x80, 1, 2, 3], t0), None);
        assert_eq!(c.handle_input(server(), &ind[..30], t0), None);
        assert_eq!(c.handle_input(server(), &[0x40, 0x00, 0, 5, 1], t0), None);

        // First send: an indication, and a permission and a bind queued.
        let wrapped = c.send_to(peer, b"first", t0).unwrap();
        let m = parse(&wrapped).unwrap();
        assert_eq!(m.typ, SEND | INDICATION);
        assert_eq!(
            parse_xor_address(m.attr(XOR_PEER_ADDRESS).unwrap(), &m.tid),
            Some(peer)
        );
        assert_eq!(m.attr(DATA).unwrap(), b"first");
        let queued = drain(&mut c);
        assert_eq!(queued.len(), 2);
        let bind = queued
            .iter()
            .map(|q| parse(q).unwrap())
            .find(|m| m.typ == CHANNEL_BIND | REQUEST)
            .unwrap();
        assert_eq!(bind.attr(CHANNEL_NUMBER).unwrap(), &[0x40, 0x00, 0, 0]);
        assert_eq!(bind.verify_integrity(&key), Some(true));

        // Until the bind is confirmed, sends are still indications.
        let again = c.send_to(peer, b"second", t0).unwrap();
        assert_eq!(parse(&again).unwrap().typ, SEND | INDICATION);
        assert!(drain(&mut c).is_empty(), "one bind per peer");

        let bind_raw = queued
            .iter()
            .find(|q| parse(q).unwrap().typ == CHANNEL_BIND | REQUEST)
            .unwrap();
        let ok = respond(bind_raw, CHANNEL_BIND | SUCCESS, &[], Some(&key));
        c.handle_input(server(), &ok, t0);
        let framed = c.send_to(peer, b"third", t0).unwrap();
        assert_eq!(framed, [&[0x40, 0x00, 0, 5][..], b"third"].concat());

        // And ChannelData comes back out of the server the same way.
        let inbound = [&[0x40, 0x00, 0, 4][..], b"pong"].concat();
        assert_eq!(
            c.handle_input(server(), &inbound, t0),
            Some((peer, b"pong".to_vec()))
        );
        // A channel nobody bound is not a peer.
        assert_eq!(c.handle_input(server(), &[0x41, 0x00, 0, 0], t0), None);
    }

    #[test]
    fn ipv6_addresses_round_trip_through_the_xor_encoding() {
        let tid = [0xA5u8; 12];
        for s in ["[2001:db8::1]:3478", "192.0.2.1:32853", "[::1]:1"] {
            let a: SocketAddr = s.parse().unwrap();
            assert_eq!(parse_xor_address(&xor_address(a, &tid), &tid), Some(a));
        }
        // RFC 5769 section 2.3: the IPv6 mapped address in the sample.
        let v = unhex("0002a1470113a9faa5d3f179bc25f4b5bed2b9d9");
        assert_eq!(
            parse_xor_address(&v, &unhex("b7e7a701bc34d686fa87dfae").try_into().unwrap()),
            Some(
                "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
                    .parse()
                    .unwrap()
            )
        );
    }

    #[test]
    fn an_unanswered_request_is_repeated_on_the_rfc_schedule_then_fails() {
        let t0 = Instant::now();
        let mut c = TurnClient::new(server(), "user", "pass", t0);
        let first = one(&mut c);
        let mut now = t0;
        let mut waits = Vec::new();
        let mut sends = 1;
        loop {
            let due = c.poll_timeout().expect("a timer while pending");
            waits.push(due - now);
            now = due;
            c.handle_timeout(now);
            let out = drain(&mut c);
            if out.is_empty() {
                break;
            }
            assert_eq!(out, vec![first.clone()], "byte-identical repeats");
            sends += 1;
        }
        assert_eq!(sends, 7);
        let ms: Vec<u128> = waits.iter().map(|d| d.as_millis()).collect();
        assert_eq!(ms, [500, 1000, 2000, 4000, 8000, 16000, 8000]);
        assert_eq!(
            c.poll_event(),
            Some(TurnEvent::Failed(
                "allocate: no answer from the server".into()
            ))
        );
        assert_eq!(c.poll_timeout(), None);
        assert_eq!(c.relayed_address(), None);
    }
}
