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
use crate::webrtc::{Config as RtcConfig, PeerEvent, WebRtc};
use crate::wire::{Message, Payload};

/// The bytes a peer's connection may hold queued before [`RoomHandle::send`]
/// waits: qrdrop's transport high-water mark.
pub const HIGH_WATER: usize = 4 * 1024 * 1024;
/// How long [`join`] waits for its first relay before giving up.
pub const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the server-reflexive address is waited for before the room is
/// announced without it.
pub const STUN_TIMEOUT: Duration = Duration::from_millis(1_500);
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

#[derive(Clone, Debug)]
pub struct JoinConfig {
    pub strategy: Strategy,
    pub app_id: String,
    pub room_id: String,
    pub password: String,
    /// `wss://` (or `ws://`) relay URLs: Nostr relays or WebTorrent trackers.
    pub relays: Vec<String>,
    /// STUN servers as `host:port` (a `stun:` prefix is accepted).
    pub stun: Vec<String>,
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
            bind: None,
            self_id: None,
            join_timeout: JOIN_TIMEOUT,
            backoff: Backoff::default(),
        }
    }
}

#[derive(Debug)]
pub enum JoinError {
    /// No relay came up within the join timeout. Names the cause, which is
    /// not the peer: nobody could have been found.
    NoRelay,
    /// This build has no client for the strategy.
    StrategyNotBuilt(Strategy),
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

#[derive(Clone, Debug, PartialEq)]
pub enum RoomEvent {
    /// Trystero's `onPeerJoin`: the handshake passed both ways.
    Joined(String),
    /// Trystero's `onPeerLeave`, for a peer that had joined.
    Left(String),
    Message {
        peer: String,
        message: Message,
    },
    /// A peer's signal did not open under our password.
    WrongPassword(String),
    /// How many relays are up, out of how many are still in use.
    Relays {
        up: usize,
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
    Leave(oneshot::Sender<()>),
}

/// A joined room. Dropping it leaves the room without waiting.
#[derive(Debug)]
pub struct RoomHandle {
    self_id: String,
    tx: mpsc::UnboundedSender<Cmd>,
    rx: mpsc::UnboundedReceiver<RoomEvent>,
}

impl RoomHandle {
    pub fn self_id(&self) -> &str {
        &self.self_id
    }

    /// The next thing that happened, or `None` once the room is gone.
    pub async fn next_event(&mut self) -> Option<RoomEvent> {
        self.rx.recv().await
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

    /// Leave: `@_leave` to every peer, [`LEAVE_LINGER`] for it to go, then
    /// close. Never fails, as Trystero's `leave()` never rejects.
    pub async fn leave(self) {
        let (ack, done) = oneshot::channel();
        if self.tx.send(Cmd::Leave(ack)).is_ok() {
            let _ = done.await;
        }
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

async fn reflexive(socket: &UdpSocket, servers: &[String]) -> Vec<SocketAddr> {
    let mut asks = vec![];
    for s in servers {
        let host = s.trim_start_matches("stun:");
        let Ok(addrs) = tokio::net::lookup_host(host).await else {
            continue;
        };
        // One address per server, of the socket's own family.
        let v4 = socket.local_addr().is_ok_and(|l| l.is_ipv4());
        if let Some(a) = addrs.into_iter().find(|a| a.is_ipv4() == v4) {
            let (tid, req) = crate::stun::request();
            if socket.send_to(&req, a).await.is_ok() {
                asks.push(tid);
            }
        }
    }
    let mut found = vec![];
    let deadline = tokio::time::Instant::now() + STUN_TIMEOUT;
    let mut buf = [0u8; 1500];
    while !asks.is_empty() {
        let Ok(Ok((n, _))) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await
        else {
            break;
        };
        if let Some(i) = asks
            .iter()
            .position(|t| crate::stun::mapped_address(&buf[..n], t).is_some())
        {
            let addr = crate::stun::mapped_address(&buf[..n], &asks[i]).expect("matched above");
            asks.swap_remove(i);
            if !found.contains(&addr) {
                found.push(addr);
            }
        }
    }
    found
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
    let local = socket.local_addr().map_err(JoinError::Socket)?;
    let mut rtc_cfg = RtcConfig::host(&[local]);
    for addr in reflexive(&socket, &cfg.stun).await {
        if addr != local
            && let Ok(c) = str0m::Candidate::server_reflexive(addr, local, "udp")
        {
            rtc_cfg.candidates.push(c);
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
        Ok(Ok(())) => Ok(RoomHandle { self_id, tx, rx }),
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
                    st.rtc.handle_datagram(Instant::now(), from, st.local, &buf[..n]);
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
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(far)
        .max(now)
    }

    fn on_timeout(&mut self, now: Instant) {
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
                // UDP: a datagram the socket cannot take now is a lost one,
                // which SCTP and ICE already expect.
                let _ = self.socket.try_send_to(&d.contents, d.destination);
            }
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
