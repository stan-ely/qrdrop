//! Joining a room for real: relays, a UDP socket, str0m and the sans-IO core
//! wired together on tokio. This is the one module that owns time and IO;
//! everything it decides, it asks the core.
//!
//! One room per [`join`], one strategy per room, as in Trystero. qrdrop races
//! two strategies by joining twice; that is the session's business, not
//! this crate's.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket as StdUdpSocket};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot};

use crate::crypto::gen_id;
use crate::relay::{Backoff, Relay, RelayEvent};
use crate::room::{self, Room, RoomConfig};
use crate::signal::{ConnId, Output, Signaller, Strategy, TrackerOffer};
use crate::turn::{TurnClient, TurnEvent};
use crate::webrtc::{Config as RtcConfig, PeerEvent, SelectedPair, WebRtc};
use crate::wire::{Message, Payload};

/// The bytes a peer's connection may hold queued before [`RoomHandle::send`]
/// waits: qrdrop's transport high-water mark.
pub const HIGH_WATER: usize = 4 * 1024 * 1024;
/// How long [`join`] waits for its first relay before giving up.
pub const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the server-reflexive address is waited for before the room is
/// announced without it.
pub const STUN_TIMEOUT: Duration = Duration::from_millis(1_500);
/// How long [`join`] waits for a relay-only room's TURN allocation, which
/// is the only candidate such a room has.
pub const TURN_TIMEOUT: Duration = Duration::from_secs(5);
/// Trystero's leave: the `@_leave` goes out, then 99 ms, then the close.
pub const LEAVE_LINGER: Duration = Duration::from_millis(99);

const WARMUP: [Duration; 3] = [
    Duration::from_millis(233),
    Duration::from_millis(533),
    Duration::from_millis(1_333),
];
const NOSTR_INTERVAL: Duration = Duration::from_secs(60);
const NOSTR_MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);
const TRACKER_DEFAULT_INTERVAL: Duration = Duration::from_secs(10);
const TRACKER_MAX_INTERVAL: Duration = Duration::from_secs(120);
const TRACKER_OFFERS: usize = 3;
const TRACKER_OFFER_RETENTION: Duration = Duration::from_secs(120);
const TRACKER_DEDUPE: Duration = Duration::from_secs(4);
/// The least time between two announces on one tracker when an offer we
/// had to ignore pulls the next one forward. See `on_tracker`.
const TRACKER_NUDGE_GAP: Duration = Duration::from_secs(2);

/// What [`join`] needs to find a room and connect to its peers.
#[derive(Clone, Debug)]
pub struct JoinConfig {
    /// Which signalling wire to use.
    pub strategy: Strategy,
    /// The Trystero `appId`.
    pub app_id: String,
    /// The room ID within that app.
    pub room_id: String,
    /// The room password, which keys the signal encryption and the handshake.
    pub password: String,
    /// `wss://` (or `ws://`) relay URLs: Nostr relays or WebTorrent trackers.
    pub relays: Vec<String>,
    /// STUN servers as `host:port` (a `stun:` prefix is accepted).
    pub stun: Vec<String>,
    /// TURN servers, UDP only.
    pub turn: Vec<TurnServer>,
    /// Offer only relayed candidates, as `iceTransportPolicy: 'relay'`: the
    /// peer never learns this side's own addresses, and nothing connects
    /// without a TURN allocation.
    pub relay_only: bool,
    /// The address to bind the UDP socket to. `None` picks the interface
    /// the default route leaves through.
    pub bind: Option<IpAddr>,
    /// Ours, 20 characters from `0-9A-Za-z`; generated when `None`.
    pub self_id: Option<String>,
    /// How long to wait for the first relay; [`JOIN_TIMEOUT`] by default.
    pub join_timeout: Duration,
    /// How each relay's redials are paced.
    pub backoff: Backoff,
}

impl JoinConfig {
    /// A config for one room with default timeouts, no STUN or TURN servers and
    /// a generated peer ID. `relays` are the Nostr relay or tracker URLs.
    pub fn new(
        strategy: Strategy,
        app_id: &str,
        room_id: &str,
        password: &str,
        relays: &[&str],
    ) -> Self {
        JoinConfig {
            strategy,
            app_id: app_id.into(),
            room_id: room_id.into(),
            password: password.into(),
            relays: relays.iter().map(|s| s.to_string()).collect(),
            stun: vec![],
            turn: vec![],
            relay_only: false,
            bind: None,
            self_id: None,
            join_timeout: JOIN_TIMEOUT,
            backoff: Backoff::default(),
        }
    }
}

/// One TURN server and its long-term credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnServer {
    /// `host:port`; a `turn:` prefix is accepted, and `?transport=udp`.
    pub url: String,
    /// The long-term credential's username.
    pub username: String,
    /// The long-term credential's password.
    pub credential: String,
}

/// Why [`join`] failed.
#[derive(Debug)]
pub enum JoinError {
    /// No relay came up within the join timeout. Names the cause, which is
    /// not the peer: nobody could have been found.
    NoRelay,
    /// This build has no client for the strategy.
    StrategyNotBuilt(Strategy),
    /// The UDP socket could not be opened.
    Socket(io::Error),
}

impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JoinError::NoRelay => f.write_str("no signalling server reachable"),
            JoinError::StrategyNotBuilt(s) => write!(f, "this build has no {s:?} client"),
            JoinError::Socket(e) => write!(f, "could not open a UDP socket: {e}"),
        }
    }
}

impl std::error::Error for JoinError {}

/// Something that happened in a joined room.
#[derive(Clone, Debug, PartialEq)]
pub enum RoomEvent {
    /// Trystero's `onPeerJoin`: the handshake passed both ways.
    Joined(String),
    /// Trystero's `onPeerLeave`, for a peer that had joined.
    Left(String),
    /// A message from a joined peer on an action the caller owns.
    Message {
        /// The sender.
        peer: String,
        /// What it sent.
        message: Message,
    },
    /// A peer's signal did not open under our password.
    WrongPassword(String),
    /// How many relays are up, out of how many are still in use.
    Relays {
        /// The number of relays currently connected.
        up: usize,
        /// The number of relays still in use, which excludes any that refused us.
        total: usize,
    },
}

/// A send that could not finish.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendError {
    /// The action name is empty, too long, or in Trystero's `@_` namespace.
    ActionName,
    /// The peer left, or its connection closed, before every chunk went out.
    Gone,
    /// The room has been left.
    Closed,
}

enum Cmd {
    Send {
        action: String,
        payload: Payload,
        meta: Option<Value>,
        to: Option<String>,
        done: oneshot::Sender<Result<usize, SendError>>,
    },
    Resume,
    Path {
        peer: String,
        done: oneshot::Sender<Option<SelectedPair>>,
    },
    Leave(oneshot::Sender<()>),
}

/// A joined room. Dropping it leaves the room without waiting.
#[derive(Debug)]
pub struct RoomHandle {
    sender: RoomSender,
    rx: mpsc::UnboundedReceiver<RoomEvent>,
}

/// The sending half of a [`RoomHandle`], for a task that sends while
/// another reads events. Cloning it is cheap; the room stays open until the
/// handle is dropped or left, whatever senders remain.
#[derive(Clone, Debug)]
pub struct RoomSender {
    self_id: String,
    tx: mpsc::UnboundedSender<Cmd>,
}

impl RoomHandle {
    /// This side's peer ID.
    pub fn self_id(&self) -> &str {
        &self.sender.self_id
    }

    /// The next thing that happened, or `None` once the room is gone.
    pub async fn next_event(&mut self) -> Option<RoomEvent> {
        self.rx.recv().await
    }

    /// A cloneable sending half of this room.
    pub fn sender(&self) -> RoomSender {
        self.sender.clone()
    }

    /// See [`RoomSender::send`].
    pub async fn send(
        &self,
        action: &str,
        payload: Payload,
        meta: Option<Value>,
        to: Option<&str>,
    ) -> Result<usize, SendError> {
        self.sender.send(action, payload, meta, to).await
    }

    /// See [`RoomSender::resume`].
    pub fn resume(&self) {
        self.sender.resume();
    }

    /// See [`RoomSender::selected_pair`].
    pub async fn selected_pair(&self, peer: &str) -> Option<SelectedPair> {
        self.sender.selected_pair(peer).await
    }

    /// Leave: `@_leave` to every peer, [`LEAVE_LINGER`] for it to go, then
    /// close. Never fails, as Trystero's `leave()` never rejects.
    pub async fn leave(self) {
        let (ack, done) = oneshot::channel();
        if self.sender.tx.send(Cmd::Leave(ack)).is_ok() {
            let _ = done.await;
        }
    }
}

impl RoomSender {
    /// This side's peer ID.
    pub fn self_id(&self) -> &str {
        &self.self_id
    }

    /// Send on `action` to one peer or every joined peer. Resolves once each
    /// chunk is on its connection, after waiting while a connection holds
    /// more than [`HIGH_WATER`] -- so awaiting each send is the backpressure.
    /// Returns how many peers it went to.
    pub async fn send(
        &self,
        action: &str,
        payload: Payload,
        meta: Option<Value>,
        to: Option<&str>,
    ) -> Result<usize, SendError> {
        let (done, wait) = oneshot::channel();
        let cmd = Cmd::Send {
            action: action.into(),
            payload,
            meta,
            to: to.map(str::to_owned),
            done,
        };
        self.tx.send(cmd).map_err(|_| SendError::Closed)?;
        wait.await.unwrap_or(Err(SendError::Closed))
    }

    /// The app is back in the foreground: redial every relay now.
    pub fn resume(&self) {
        let _ = self.tx.send(Cmd::Resume);
    }

    /// The candidate pair `peer`'s connection is using, once str0m has
    /// reported one (about a second after it connects). `None` before then,
    /// and for a peer that is not connected.
    pub async fn selected_pair(&self, peer: &str) -> Option<SelectedPair> {
        let (done, wait) = oneshot::channel();
        self.tx
            .send(Cmd::Path {
                peer: peer.into(),
                done,
            })
            .ok()?;
        wait.await.ok().flatten()
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The address the default route leaves from. A UDP connect sends nothing;
/// it only asks the OS which interface it would use.
fn default_ip() -> IpAddr {
    StdUdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").map(|_| s))
        .and_then(|s| s.local_addr())
        .map(|a| a.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

/// One address for `host:port`, of the socket's own family.
async fn resolve(socket: &UdpSocket, host: &str) -> Option<SocketAddr> {
    let v4 = socket.local_addr().is_ok_and(|l| l.is_ipv4());
    tokio::net::lookup_host(host)
        .await
        .ok()?
        .find(|a| a.is_ipv4() == v4)
}

/// The socket buffers every UDP socket here asks for. Measured in phase 9
/// (docs/notes/rust-session.md) between two sessions under netem: with the
/// platform defaults the sender's bursts overran the receiver's buffer and
/// SCTP lived in loss recovery, 7.9 MB/s at no delay and 1.1 at 100 ms; with
/// these, 23 and 8.3. Phase 1 had found the same and asked for it, and the
/// runtime was written without it. The OS may grant less (Linux caps it at
/// `net.core.rmem_max`, and doubles what it grants); a refusal is not an
/// error, only a slower socket.
pub const SOCKET_BUFFER: usize = 4 << 20;

/// Ask for [`SOCKET_BUFFER`] each way.
pub fn size_buffers(socket: &UdpSocket) {
    let r = socket2::SockRef::from(socket);
    let _ = r.set_recv_buffer_size(SOCKET_BUFFER);
    let _ = r.set_send_buffer_size(SOCKET_BUFFER);
}

/// This socket's address as every STUN server sees it, deduplicated, after
/// at most [`STUN_TIMEOUT`]. For a transport beside the room's -- the QUIC
/// path in qrdrop-session -- that has to learn its own mapping on its own
/// socket, since a NAT maps each socket apart.
pub async fn reflexive(socket: &UdpSocket, stun: &[String]) -> Vec<SocketAddr> {
    let mut asks = vec![];
    for s in stun {
        if let Some(a) = resolve(socket, s.trim_start_matches("stun:")).await {
            let (tid, req) = crate::stun::request();
            if socket.send_to(&req, a).await.is_ok() {
                asks.push(tid);
            }
        }
    }
    let mut found = vec![];
    let deadline = tokio::time::Instant::now() + STUN_TIMEOUT;
    let mut buf = [0u8; 2048];
    while !asks.is_empty() {
        match tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => {
                if let Some(i) = asks
                    .iter()
                    .position(|t| crate::stun::mapped_address(&buf[..n], t).is_some())
                {
                    let addr =
                        crate::stun::mapped_address(&buf[..n], &asks[i]).expect("matched above");
                    asks.swap_remove(i);
                    if !found.contains(&addr) {
                        found.push(addr);
                    }
                }
            }
            Ok(Err(_)) => {}
            Err(_) => break,
        }
    }
    found
}

/// Ask every STUN server for our mapped address and start an allocation on
/// every TURN server, on the room's own socket, and wait -- up to
/// [`STUN_TIMEOUT`], or [`TURN_TIMEOUT`] for a relay-only room, whose only
/// candidate is an allocation -- for the answers. An allocation still going
/// at the end goes on in the room's loop, and its relayed address reaches
/// every connection made after it lands.
async fn gather(
    socket: &UdpSocket,
    stun: &[String],
    turn: &[TurnServer],
    relay_only: bool,
) -> (Vec<SocketAddr>, Vec<TurnClient>) {
    let mut asks = vec![];
    if !relay_only {
        for s in stun {
            if let Some(a) = resolve(socket, s.trim_start_matches("stun:")).await {
                let (tid, req) = crate::stun::request();
                if socket.send_to(&req, a).await.is_ok() {
                    asks.push(tid);
                }
            }
        }
    }
    let mut turns = vec![];
    for t in turn {
        let host = t.url.trim_start_matches("turn:");
        let host = host.split('?').next().unwrap_or(host);
        if let Some(a) = resolve(socket, host).await {
            turns.push(TurnClient::new(
                a,
                &t.username,
                &t.credential,
                Instant::now(),
            ));
        }
    }
    // The events stay queued for the room's loop, which adds the candidates
    // of any allocation still landing; here only whether one is settled.
    let mut found = vec![];
    let wait = if relay_only {
        TURN_TIMEOUT
    } else {
        STUN_TIMEOUT
    };
    let deadline = tokio::time::Instant::now() + wait;
    let mut buf = [0u8; 2048];
    loop {
        for t in &mut turns {
            while let Some((to, d)) = t.poll_transmit() {
                let _ = socket.send_to(&d, to).await;
            }
        }
        let allocating = turns
            .iter()
            .any(|t| t.relayed_address().is_none() && t.poll_timeout().is_some());
        if asks.is_empty() && !allocating {
            break;
        }
        let next = turns
            .iter()
            .filter_map(TurnClient::poll_timeout)
            .map(tokio::time::Instant::from_std)
            .min()
            .map_or(deadline, |t| t.min(deadline));
        match tokio::time::timeout_at(next, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, from))) => {
                if let Some(t) = turns.iter_mut().find(|t| t.is_from_server(from)) {
                    t.handle_input(from, &buf[..n], Instant::now());
                } else if let Some(i) = asks
                    .iter()
                    .position(|t| crate::stun::mapped_address(&buf[..n], t).is_some())
                {
                    let addr =
                        crate::stun::mapped_address(&buf[..n], &asks[i]).expect("matched above");
                    asks.swap_remove(i);
                    if !found.contains(&addr) {
                        found.push(addr);
                    }
                }
            }
            // A reset from an ICMP unreachable, on Windows: keep waiting.
            Ok(Err(_)) => {}
            Err(_) if tokio::time::Instant::now() >= deadline => break,
            Err(_) => {
                for t in &mut turns {
                    t.handle_timeout(Instant::now());
                }
            }
        }
    }
    (found, turns)
}

/// Join a room. Resolves once a relay is up and the room has been
/// announced on it, or fails with [`JoinError::NoRelay`] if none comes up.
/// Must be called inside a tokio runtime.
pub async fn join(cfg: JoinConfig) -> Result<RoomHandle, JoinError> {
    match cfg.strategy {
        #[cfg(not(feature = "nostr"))]
        Strategy::Nostr => return Err(JoinError::StrategyNotBuilt(Strategy::Nostr)),
        #[cfg(not(feature = "torrent"))]
        Strategy::Torrent => return Err(JoinError::StrategyNotBuilt(Strategy::Torrent)),
        #[allow(unreachable_patterns)]
        _ => {}
    }
    let ip = cfg.bind.unwrap_or_else(default_ip);
    let socket = UdpSocket::bind(SocketAddr::new(ip, 0))
        .await
        .map_err(JoinError::Socket)?;
    size_buffers(&socket);
    let local = socket.local_addr().map_err(JoinError::Socket)?;
    let mut rtc_cfg = if cfg.relay_only {
        RtcConfig { candidates: vec![] }
    } else {
        RtcConfig::host(&[local])
    };
    let (mapped, mut turns) = gather(&socket, &cfg.stun, &cfg.turn, cfg.relay_only).await;
    for addr in mapped {
        if addr != local
            && let Ok(c) = str0m::Candidate::server_reflexive(addr, local, "udp")
        {
            rtc_cfg.candidates.push(c);
        }
    }
    // Allocations that landed in time are in every connection from the
    // first; their events are spent here so the loop does not add them twice.
    for t in &mut turns {
        while let Some(e) = t.poll_event() {
            if let TurnEvent::Allocated(addr) = e
                && let Ok(c) = str0m::Candidate::relayed(addr, local, "udp")
            {
                rtc_cfg.candidates.push(c);
            }
        }
    }

    let self_id = cfg.self_id.clone().unwrap_or_else(|| gen_id(20));
    let (relay_tx, relay_rx) = mpsc::unbounded_channel();
    let relays: Vec<Relay> = cfg
        .relays
        .iter()
        .enumerate()
        .map(|(i, u)| Relay::open(i, u, cfg.backoff, relay_tx.clone()))
        .collect();
    let (tx, cmds) = mpsc::unbounded_channel();
    let (events, rx) = mpsc::unbounded_channel();
    let (ready_tx, ready) = oneshot::channel();
    let now = Instant::now();
    let n = relays.len();
    let state = State {
        signaller: Signaller::new(
            cfg.strategy,
            &cfg.app_id,
            &cfg.room_id,
            &cfg.password,
            &self_id,
        ),
        room: Room::new(RoomConfig {
            app_id: cfg.app_id.clone(),
            room_id: cfg.room_id.clone(),
            password: cfg.password.clone(),
            self_id: self_id.clone(),
        }),
        rtc: WebRtc::new(rtc_cfg, now),
        socket: Arc::new(socket),
        local,
        turns,
        strategy: cfg.strategy,
        #[cfg(feature = "nostr")]
        keys: crate::nostr::Keys::generate(),
        relays,
        up: vec![false; n],
        retired: vec![false; n],
        announce: vec![None; n],
        announced: vec![None; n],
        interval: vec![
            if cfg.strategy == Strategy::Nostr {
                NOSTR_INTERVAL
            } else {
                TRACKER_DEFAULT_INTERVAL
            };
            n
        ],
        backoff: vec![(Duration::ZERO, now); n],
        outstanding: vec![],
        seen: HashMap::new(),
        conn_of: HashMap::new(),
        peer_of: HashMap::new(),
        queues: HashMap::new(),
        events,
        ready: Some(ready_tx),
        leaving: None,
        self_id: self_id.clone(),
    };
    tokio::spawn(run(state, cmds, relay_rx));
    match tokio::time::timeout(cfg.join_timeout, ready).await {
        Ok(Ok(())) => Ok(RoomHandle {
            sender: RoomSender { self_id, tx },
            rx,
        }),
        // Dropping `tx` ends the task, which drops the relays.
        _ => Err(JoinError::NoRelay),
    }
}

struct Outstanding {
    id: String,
    conn: ConnId,
    cipher: String,
    made: Instant,
}

struct Queued {
    data: Vec<u8>,
    waiter: Option<Arc<Waiter>>,
}

type Done = oneshot::Sender<Result<usize, SendError>>;

/// One `send`, finished when every chunk to every target is out.
struct Waiter {
    left: std::sync::Mutex<(usize, Option<Done>)>,
    targets: usize,
}

impl Waiter {
    fn chunk_out(&self) {
        let mut l = self.left.lock().expect("never poisoned");
        l.0 = l.0.saturating_sub(1);
        if l.0 == 0
            && let Some(done) = l.1.take()
        {
            let _ = done.send(Ok(self.targets));
        }
    }

    fn fail(&self, e: SendError) {
        if let Some(done) = self.left.lock().expect("never poisoned").1.take() {
            let _ = done.send(Err(e));
        }
    }
}

struct State {
    signaller: Signaller,
    room: Room,
    rtc: WebRtc,
    socket: Arc<UdpSocket>,
    local: SocketAddr,
    /// One per TURN server, allocated or still allocating.
    turns: Vec<TurnClient>,
    strategy: Strategy,
    #[cfg(feature = "nostr")]
    keys: crate::nostr::Keys,
    relays: Vec<Relay>,
    up: Vec<bool>,
    retired: Vec<bool>,
    /// Per relay: when to announce next, and how many announces so far.
    announce: Vec<Option<(Instant, usize)>>,
    interval: Vec<Duration>,
    /// Per tracker: when we last announced on it.
    announced: Vec<Option<Instant>>,
    /// Per Nostr relay: the rate-limit delay and when it ends.
    backoff: Vec<(Duration, Instant)>,
    outstanding: Vec<Outstanding>,
    seen: HashMap<String, Instant>,
    conn_of: HashMap<String, ConnId>,
    peer_of: HashMap<ConnId, String>,
    queues: HashMap<String, VecDeque<Queued>>,
    events: mpsc::UnboundedSender<RoomEvent>,
    ready: Option<oneshot::Sender<()>>,
    leaving: Option<(Instant, oneshot::Sender<()>)>,
    self_id: String,
}

async fn run(
    mut st: State,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
    mut relays: mpsc::UnboundedReceiver<RelayEvent>,
) {
    let socket = st.socket.clone();
    let mut buf = vec![0u8; 2048];
    loop {
        let now = Instant::now();
        st.pump(now);
        if let Some((at, _)) = &st.leaving
            && now >= *at
        {
            break;
        }
        let deadline = st.deadline(now);
        tokio::select! {
            r = socket.recv_from(&mut buf) => {
                // Windows reports an ICMP port-unreachable as a reset on the
                // next receive: a dead candidate pair, not a dead socket.
                if let Ok((n, from)) = r {
                    st.on_datagram(from, &buf[..n], Instant::now());
                }
            }
            Some(ev) = relays.recv() => st.on_relay(ev, Instant::now()),
            c = cmds.recv() => match c {
                Some(c) => st.on_cmd(c, Instant::now()),
                // The handle is gone: leave without waiting for anyone.
                None if st.leaving.is_none() => {
                    st.start_leave(Instant::now(), oneshot::channel().0);
                }
                None => {}
            },
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => st.on_timeout(Instant::now()),
        }
    }
    let conns: Vec<ConnId> = st.peer_of.keys().copied().collect();
    for c in conns {
        crate::signal::Connector::close(&mut st.rtc, c);
    }
    st.pump(Instant::now());
    if let Some((_, ack)) = st.leaving.take() {
        let _ = ack.send(());
    }
}

impl State {
    fn emit(&self, e: RoomEvent) {
        let _ = self.events.send(e);
    }

    fn relay_status(&self) {
        let total = self.retired.iter().filter(|r| !**r).count();
        let up = self
            .up
            .iter()
            .zip(&self.retired)
            .filter(|(u, r)| **u && !**r)
            .count();
        self.emit(RoomEvent::Relays { up, total });
    }

    fn deadline(&mut self, now: Instant) -> Instant {
        let far = now + Duration::from_secs(3600);
        [
            self.rtc.poll_timeout(),
            self.room.poll_timeout(),
            self.signaller.poll_timeout(),
            self.announce.iter().flatten().map(|(t, _)| *t).min(),
            self.leaving.as_ref().map(|(t, _)| *t),
            self.turns.iter().filter_map(TurnClient::poll_timeout).min(),
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(far)
        .max(now)
    }

    /// A datagram on the room's socket: from a TURN server, unwrapped and
    /// handed to str0m as arriving at the relayed address; anything else,
    /// straight to str0m.
    fn on_datagram(&mut self, from: SocketAddr, data: &[u8], now: Instant) {
        if let Some(t) = self.turns.iter_mut().find(|t| t.is_from_server(from)) {
            let relayed = t.relayed_address();
            if let Some((peer, payload)) = t.handle_input(from, data, now)
                && let Some(relayed) = relayed
            {
                self.rtc.handle_datagram(now, peer, relayed, &payload);
            }
            return;
        }
        self.rtc.handle_datagram(now, from, self.local, data);
    }

    /// What the TURN clients queued, onto the socket, and any allocation
    /// that landed, into str0m for the connections made from now on.
    fn flush_turn(&mut self) -> bool {
        let mut busy = false;
        for t in &mut self.turns {
            while let Some(e) = t.poll_event() {
                busy = true;
                if let TurnEvent::Allocated(addr) = e
                    && let Ok(c) = str0m::Candidate::relayed(addr, self.local, "udp")
                {
                    self.rtc.add_local_candidate(c);
                }
            }
            while let Some((to, d)) = t.poll_transmit() {
                busy = true;
                let _ = self.socket.try_send_to(&d, to);
            }
        }
        busy
    }

    fn on_timeout(&mut self, now: Instant) {
        for t in &mut self.turns {
            t.handle_timeout(now);
        }
        self.rtc.handle_timeout(now);
        self.room.handle_timeout(now);
        self.signaller.handle_timeout(now, &mut self.rtc);
        for i in 0..self.announce.len() {
            if let Some((at, n)) = self.announce[i]
                && at <= now
            {
                self.announce_on(i, n, now);
            }
        }
    }

    fn on_cmd(&mut self, c: Cmd, now: Instant) {
        match c {
            Cmd::Send {
                action,
                payload,
                meta,
                to,
                done,
            } => {
                if self.leaving.is_some() {
                    let _ = done.send(Err(SendError::Closed));
                    return;
                }
                match self
                    .room
                    .send(&action, &payload, meta.as_ref(), to.as_deref())
                {
                    Err(_) => {
                        let _ = done.send(Err(SendError::ActionName));
                    }
                    Ok(0) => {
                        let _ = done.send(Ok(0));
                    }
                    Ok(targets) => {
                        // The room queued its chunks as transmits; tag them
                        // with this send's waiter as they move to the queues.
                        let mut chunks = vec![];
                        while let Some(t) = self.room.poll_transmit() {
                            chunks.push(t);
                        }
                        let waiter = Arc::new(Waiter {
                            left: std::sync::Mutex::new((chunks.len(), Some(done))),
                            targets,
                        });
                        for t in chunks {
                            self.queues.entry(t.peer).or_default().push_back(Queued {
                                data: t.data,
                                waiter: Some(waiter.clone()),
                            });
                        }
                    }
                }
            }
            Cmd::Resume => {
                for (i, r) in self.relays.iter().enumerate() {
                    if !self.retired[i] {
                        r.resume();
                    }
                }
                self.reannounce(now);
            }
            Cmd::Path { peer, done } => {
                let pair = self
                    .conn_of
                    .get(&peer)
                    .and_then(|c| self.rtc.selected_pair(*c));
                let _ = done.send(pair);
            }
            Cmd::Leave(ack) => self.start_leave(now, ack),
        }
    }

    fn start_leave(&mut self, now: Instant, ack: oneshot::Sender<()>) {
        if self.leaving.is_some() {
            let _ = ack.send(());
            return;
        }
        self.room.leave();
        self.signaller.leave(&mut self.rtc);
        for o in self.outstanding.drain(..) {
            crate::signal::Connector::close(&mut self.rtc, o.conn);
        }
        self.announce.iter_mut().for_each(|a| *a = None);
        self.leaving = Some((now + LEAVE_LINGER, ack));
    }

    fn reannounce(&mut self, now: Instant) {
        for i in 0..self.announce.len() {
            if self.up[i] && !self.retired[i] {
                self.announce[i] = Some((now, 0));
            }
        }
    }

    fn on_relay(&mut self, ev: RelayEvent, now: Instant) {
        match ev {
            RelayEvent::Up(i) => {
                if self.retired[i] || self.leaving.is_some() {
                    return;
                }
                self.up[i] = true;
                #[cfg(feature = "nostr")]
                if self.strategy == Strategy::Nostr {
                    let root = self.signaller.topics().root().to_owned();
                    let (_, req) =
                        crate::nostr::subscribe(&[&root, self.signaller.self_topic()], now_secs());
                    self.relays[i].send(req);
                }
                self.announce[i] = Some((now, 0));
                self.relay_status();
            }
            RelayEvent::Down(i) => {
                self.up[i] = false;
                self.announce[i] = None;
                self.relay_status();
            }
            RelayEvent::Text(i, text) => match self.strategy {
                Strategy::Nostr => self.on_nostr(i, &text, now),
                Strategy::Torrent => self.on_tracker(i, &text, now),
            },
        }
    }

    #[cfg(not(feature = "nostr"))]
    fn on_nostr(&mut self, _: usize, _: &str, _: Instant) {}

    #[cfg(feature = "nostr")]
    fn on_nostr(&mut self, i: usize, text: &str, now: Instant) {
        use crate::nostr::RelayMsg;
        let Some(msg) = RelayMsg::parse(text) else {
            return;
        };
        if msg.is_refusal() {
            self.retired[i] = true;
            self.up[i] = false;
            self.announce[i] = None;
            self.relays[i].retire();
            self.relay_status();
            return;
        }
        if msg.is_rate_limited() {
            let d = &mut self.backoff[i];
            d.0 = if d.0.is_zero() {
                NOSTR_INTERVAL
            } else {
                (d.0 * 2).max(NOSTR_INTERVAL)
            }
            .min(NOSTR_MAX_BACKOFF);
            d.1 = now + d.0;
            return;
        }
        match msg {
            RelayMsg::Ok { accepted: true, .. } => self.backoff[i].0 = Duration::ZERO,
            RelayMsg::Event { topic, content } => {
                self.signaller
                    .handle_topic(i, &topic, &content, now, &mut self.rtc)
            }
            _ => {}
        }
    }

    fn on_tracker(&mut self, i: usize, text: &str, now: Instant) {
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(text) else {
            return;
        };
        if m.contains_key("failure reason") {
            return;
        }
        if m.get("info_hash").and_then(Value::as_str)
            != Some(self.signaller.topics().info_hash().as_str())
        {
            return;
        }
        if let Some(secs) = m.get("interval").and_then(Value::as_f64) {
            self.interval[i] =
                Duration::from_secs_f64(secs).clamp(TRACKER_DEFAULT_INTERVAL, TRACKER_MAX_INTERVAL);
        }
        let s = |k: &str| m.get(k).and_then(Value::as_str);
        let (Some(peer), Some(offer_id)) = (s("peer_id"), s("offer_id")) else {
            return;
        };
        if peer == self.self_id {
            return;
        }
        let offer = m
            .get("offer")
            .and_then(|o| o.get("sdp"))
            .and_then(Value::as_str);
        let answer = m
            .get("answer")
            .and_then(|o| o.get("sdp"))
            .and_then(Value::as_str);
        let kind = if offer.is_some() { "offer" } else { "answer" };
        let key = format!("{kind}:{offer_id}:{peer}");
        if self
            .seen
            .get(&key)
            .is_some_and(|t| now.duration_since(*t) < TRACKER_DEDUPE)
        {
            return;
        }
        self.seen
            .retain(|_, t| now.duration_since(*t) < TRACKER_DEDUPE * 6);
        self.seen.insert(key, now);
        if let Some(offer) = offer {
            let has_outgoing = !self.outstanding.is_empty();
            // The glare rule has the lower ID ignore an offer while it holds
            // offers of its own, trusting the other side to take one of
            // those instead. But a tracker forwards an announce's offers
            // only to peers already in the swarm, so the peer that joined
            // second never sees offers announced before it arrived, and
            // would see ours only at our next announce -- up to the
            // tracker's 120 s interval away, measured on
            // tracker.openwebtorrent.com, against a 15 s join timeout. Its
            // offer is proof it is now in the swarm, so announce again soon,
            // and our offers reach it. Rate limited, because it sends an
            // offer every few seconds until one of them is answered.
            if has_outgoing && self.self_id.as_str() < peer {
                let at = self.announced[i].map_or(now, |t| (t + TRACKER_NUDGE_GAP).max(now));
                if let Some((next, n)) = self.announce[i]
                    && at < next
                {
                    self.announce[i] = Some((at, n));
                }
            }
            let o = TrackerOffer {
                relay: i,
                peer,
                offer,
                offer_id,
                has_outgoing,
            };
            self.signaller.tracker_offer(o, now, &mut self.rtc);
        } else if let Some(answer) = answer
            && let Some(k) = self.outstanding.iter().position(|o| o.id == offer_id)
        {
            let o = self.outstanding.swap_remove(k);
            self.signaller
                .tracker_answer(peer, o.conn, answer, &mut self.rtc);
        }
    }

    fn announce_on(&mut self, i: usize, n: usize, now: Instant) {
        if !self.up[i] || self.retired[i] {
            self.announce[i] = None;
            return;
        }
        let mut interval = self.interval[i];
        match self.strategy {
            Strategy::Nostr => {
                #[cfg(feature = "nostr")]
                {
                    let (delay, until) = self.backoff[i];
                    if now < until {
                        self.announce[i] = Some((until.max(now + NOSTR_INTERVAL.min(delay)), n));
                        return;
                    }
                    let root = self.signaller.topics().root().to_owned();
                    self.relays[i].send(self.keys.event(
                        &root,
                        &self.signaller.announce(),
                        now_secs(),
                    ));
                }
            }
            Strategy::Torrent => {
                self.outstanding.retain(|o| {
                    let keep = now.duration_since(o.made) < TRACKER_OFFER_RETENTION;
                    if !keep {
                        crate::signal::Connector::close(&mut self.rtc, o.conn);
                    }
                    keep
                });
                while self.outstanding.len() < TRACKER_OFFERS {
                    let Some((conn, cipher)) = self.signaller.pooled_offer(&mut self.rtc) else {
                        break;
                    };
                    self.outstanding.push(Outstanding {
                        id: gen_id(20),
                        conn,
                        cipher,
                        made: now,
                    });
                }
                let offers: Vec<Value> = self
                    .outstanding
                    .iter()
                    .map(|o| json!({"offer_id": o.id, "offer": {"type": "offer", "sdp": o.cipher}}))
                    .collect();
                let msg = json!({
                    "action": "announce",
                    "info_hash": self.signaller.topics().info_hash(),
                    "peer_id": self.self_id,
                    "numwant": TRACKER_OFFERS,
                    "offers": offers,
                });
                self.relays[i].send(msg.to_string());
                self.announced[i] = Some(now);
                interval = self.interval[i];
            }
        }
        let next = WARMUP.get(n).map_or(interval, |w| (*w).min(interval));
        self.announce[i] = Some((now + next, n + 1));
    }

    /// Move everything between the layers until nothing moves.
    fn pump(&mut self, now: Instant) {
        loop {
            let mut busy = false;
            while let Some(e) = self.rtc.poll_event() {
                busy = true;
                match e {
                    PeerEvent::Open(conn) => self.signaller.connected(conn, &mut self.rtc),
                    PeerEvent::Data(conn, data) => {
                        if let Some(p) = self.peer_of.get(&conn) {
                            self.room.handle_data(p, &data);
                        }
                    }
                    PeerEvent::BufferedLow(_) => {}
                    PeerEvent::Closed(conn) => {
                        self.signaller.disconnected(conn);
                        if let Some(p) = self.peer_of.remove(&conn) {
                            self.conn_of.remove(&p);
                            self.drop_queue(&p);
                            self.room.remove_peer(&p);
                        }
                    }
                }
            }
            while let Some(o) = self.signaller.poll_output() {
                busy = true;
                match o {
                    #[cfg(feature = "nostr")]
                    Output::Publish {
                        relay,
                        topic,
                        content,
                    } => {
                        if let Some(r) = self.relays.get(relay) {
                            r.send(self.keys.event(&topic, &content, now_secs()));
                        }
                    }
                    #[cfg(not(feature = "nostr"))]
                    Output::Publish { .. } => {}
                    Output::TrackerAnswer {
                        relay,
                        to_peer,
                        offer_id,
                        sdp,
                    } => {
                        if let Some(r) = self.relays.get(relay) {
                            r.send(
                                json!({
                                    "action": "announce",
                                    "info_hash": self.signaller.topics().info_hash(),
                                    "peer_id": self.self_id,
                                    "answer": {"type": "answer", "sdp": sdp},
                                    "offer_id": offer_id,
                                    "to_peer_id": to_peer,
                                })
                                .to_string(),
                            );
                        }
                    }
                    Output::WrongPassword { peer } => self.emit(RoomEvent::WrongPassword(peer)),
                    Output::Connected { peer, conn } => {
                        self.peer_of.insert(conn, peer.clone());
                        self.conn_of.insert(peer.clone(), conn);
                        self.room.add_peer(&peer, now);
                    }
                    Output::Reannounce => self.reannounce(now),
                }
            }
            while let Some(t) = self.room.poll_transmit() {
                busy = true;
                self.queues.entry(t.peer).or_default().push_back(Queued {
                    data: t.data,
                    waiter: None,
                });
            }
            while let Some(e) = self.room.poll_event() {
                busy = true;
                match e {
                    room::Event::Joined(p) => self.emit(RoomEvent::Joined(p)),
                    room::Event::Message { peer, message } => {
                        self.emit(RoomEvent::Message { peer, message })
                    }
                    room::Event::Closed { peer, joined, .. } => {
                        if joined {
                            self.emit(RoomEvent::Left(peer.clone()));
                        }
                        // A leave's own @_leave is still queued: flush it
                        // before the connection goes, at the linger's end.
                        if self.leaving.is_none() {
                            self.drop_queue(&peer);
                            if let Some(conn) = self.conn_of.remove(&peer) {
                                self.peer_of.remove(&conn);
                                crate::signal::Connector::close(&mut self.rtc, conn);
                                self.signaller.disconnected(conn);
                            }
                        }
                    }
                }
            }
            busy |= self.flush();
            while let Some(d) = self.rtc.poll_transmit() {
                busy = true;
                // From the relayed address: through its TURN server, which
                // `send_to` wraps it for.
                if let Some(t) = self
                    .turns
                    .iter_mut()
                    .find(|t| t.relayed_address() == Some(d.source))
                {
                    if let Some(wrapped) = t.send_to(d.destination, &d.contents, now) {
                        let _ = self.socket.try_send_to(&wrapped, t.server());
                    }
                    continue;
                }
                // UDP: a datagram the socket cannot take now is a lost one,
                // which SCTP and ICE already expect.
                let _ = self.socket.try_send_to(&d.contents, d.destination);
            }
            busy |= self.flush_turn();
            // Joined, for the caller, once one relay has carried an announce.
            if self.ready.is_some() && self.announce.iter().flatten().any(|(_, n)| *n > 0) {
                let _ = self.ready.take().map(|r| r.send(()));
            }
            if !busy {
                return;
            }
        }
    }

    /// Hand queued chunks to their connections while each is under the
    /// high-water mark. Returns whether anything moved.
    fn flush(&mut self) -> bool {
        let mut moved = false;
        let peers: Vec<String> = self.queues.keys().cloned().collect();
        for p in peers {
            let Some(&conn) = self.conn_of.get(&p) else {
                continue;
            };
            loop {
                if self.rtc.buffered_amount(conn) >= HIGH_WATER {
                    break;
                }
                let Some(q) = self.queues.get_mut(&p).and_then(VecDeque::pop_front) else {
                    break;
                };
                match self.rtc.send(conn, &q.data) {
                    Ok(true) => {
                        moved = true;
                        if let Some(w) = q.waiter {
                            w.chunk_out();
                        }
                    }
                    Ok(false) => {
                        self.queues.entry(p.clone()).or_default().push_front(q);
                        break;
                    }
                    Err(_) => {
                        if let Some(w) = q.waiter {
                            w.fail(SendError::Gone);
                        }
                        self.drop_queue(&p);
                        break;
                    }
                }
            }
        }
        moved
    }

    fn drop_queue(&mut self, peer: &str) {
        for q in self.queues.remove(peer).into_iter().flatten() {
            if let Some(w) = q.waiter {
                w.fail(SendError::Gone);
            }
        }
    }
}
