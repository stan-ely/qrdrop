//! The run loop: one task per confirmed pairing, owning the protocol
//! [`Session`], the room's two halves, the LAN link, and the threads that
//! read the source and write the sink.
//!
//! The JS spreads this across `cli.js`'s `runSend` and `runReceive`,
//! `attachReceiver`, `createPathExchange` and `createLanLink`, as callbacks
//! over promises. Several of its invariants were races before they were
//! rules, and in one loop over one queue they hold by construction:
//!
//! - **A leave fails the session only after the frames before it.** The JS
//!   decrypted a frame un-awaited, so the leave behind it ran first and a
//!   finished send was reported as a disconnect; every handler had to wait on
//!   `receiver.settled()`. Here the room's frames and its leave arrive on one
//!   channel, in the order the room saw them, and the loop handles each to
//!   the end before taking the next.
//! - **One control queue per direction.** Every frame leaves through one
//!   FIFO to one writer task, so index order is send order.
//! - **The LAN switch is a marker in that FIFO**, queued at Accept: every
//!   frame before it goes over WebRTC and every frame after it over the
//!   socket, so a LAN frame cannot overtake a WebRTC one.
//!
//! What the person decides -- the SAS, Accept or Decline, and the relay size
//! cap -- is the caller's, through [`SessionHandle`]. Nothing here accepts
//! for them.

use std::fmt;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use qrdrop_protocol::{
    CHUNK_SIZE, Event, FileOffer, LAN_CLOSED, LanListen, Manifest, NetworkPath, Role, Session,
};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tryst::join::{RoomEvent, RoomHandle, RoomSender};
use tryst::wire::Payload;

use crate::io::{Sink, Source};
use crate::lan;
use crate::pair::{FRAME_ACTION, Paired};
use crate::path;
use crate::quic;

/// How long an exit waits for the leave message to go out before giving up
/// on it: bounded, so a room that hangs cannot stop Ctrl-C from exiting.
pub const LEAVE_TIMEOUT: Duration = Duration::from_secs(2);

/// How long this side's own path verdict is waited for, as `classifyPath`
/// polls: the selected pair is not reported the instant a connection opens.
pub const PATH_WAIT: Duration = Duration::from_secs(3);

/// How long a sender whose direct link closed after its last chunk waits for
/// the receiver's `done` before calling the transfer failed. The receiver
/// closes that link when it has the whole file, and the close comes by
/// another road than the `done` (TCP or QUIC against WebRTC), so it can
/// overtake it: measured from a phone sending 64 MiB to the CLI, which had
/// received every byte and checked the digest while the phone said the
/// connection closed. A link that died with frames still in it gets no
/// `done`, and this ends that wait with the error it always had.
pub const LINK_CLOSE_GRACE: Duration = Duration::from_secs(5);

/// Bytes queued for the writer and not yet handed to the transport. Chunks
/// are read only while the queue is under this; the transport's own buffer
/// (4 MiB in tryst) is behind it.
pub(crate) const OUT_HIGH: usize = 1024 * 1024;

/// Chunks the source thread reads ahead: about 2 MiB, so a read never
/// stalls the channel and memory stays at two blocks, the bound
/// `src/web/source.js` chose its read-ahead against.
pub(crate) const READ_AHEAD: usize = 128;

/// Leave `room`, waiting at most [`LEAVE_TIMEOUT`] for the leave to go.
pub(crate) async fn leave_bounded(room: RoomHandle) {
    let _ = tokio::time::timeout(LEAVE_TIMEOUT, room.leave()).await;
}

/// The local-network fast path's part in one session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LanConfig {
    /// Whether this side can listen without a firewall prompt.
    /// [`lan::default_listen`] is the platform's answer; a build without
    /// `lan-listen` is `None` whatever this says.
    pub listen: LanListen,
}

impl Default for LanConfig {
    fn default() -> Self {
        LanConfig {
            listen: lan::default_listen(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionOptions {
    /// `None` is `--no-lan`: no hello is sent and none is answered, so the
    /// peer reads this side as one without the path.
    pub lan: Option<LanConfig>,
    /// The QUIC path, between two Rust peers. `None`, or a build without the
    /// `quic` feature, never says `quic-hello` and never answers one.
    pub quic: Option<quic::QuicConfig>,
}

/// What the caller shows or acts on, in the order it happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionEvent {
    /// This side's verdict once it has one, and again whenever the peer's
    /// arrives. `combined` is what to show: the two sides see different
    /// evidence, and neither is wrong.
    Path {
        mine: NetworkPath,
        theirs: NetworkPath,
        combined: NetworkPath,
    },
    /// The peer offers a file. Show it; on the person's Accept, open the
    /// sink and pass it to [`SessionHandle::accept`].
    Offer(Manifest),
    ReceiveProgress {
        received: u64,
        total: u64,
    },
    /// The file is whole, verified and closed, and the peer has been told.
    Received {
        name: String,
        size: u64,
        digest: String,
        location: String,
    },
    SendAccepted,
    SendProgress {
        sent: u64,
        total: u64,
    },
    Sent {
        digest: String,
    },
    Declined,
    /// The sender's frames now cross the local network: on the sender when
    /// it switched, on the receiver at the first frame to arrive that way.
    Lan,
    /// The same, for the direct QUIC connection.
    Quic,
    /// The session is over. Reported once, and nothing follows it.
    Failed(String),
}

enum Cmd {
    SendFile(Box<dyn Source>),
    Accept(Box<dyn Sink>),
    Decline,
    Cancel,
    Close(oneshot::Sender<()>),
}

/// The controls of a running session. Cheap to clone, so an interrupt
/// handler can hold one while the main flow holds another.
#[derive(Clone)]
pub struct SessionHandle {
    cmds: mpsc::UnboundedSender<Cmd>,
    path: watch::Receiver<Option<NetworkPath>>,
}

impl fmt::Debug for SessionHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionHandle").finish_non_exhaustive()
    }
}

impl SessionHandle {
    /// Offer a file. The relay size cap is checked before this, by the
    /// caller, against [`SessionHandle::path`].
    pub fn send_file(&self, source: Box<dyn Source>) {
        let _ = self.cmds.send(Cmd::SendFile(source));
    }

    /// The person accepted, and `sink` is open. If the receive ended while
    /// it was opening, the sink is aborted rather than written.
    pub fn accept(&self, sink: Box<dyn Sink>) {
        let _ = self.cmds.send(Cmd::Accept(sink));
    }

    pub fn decline(&self) {
        let _ = self.cmds.send(Cmd::Decline);
    }

    /// The person cancelled. A file being received is deleted; the peer
    /// learns from the room closing, which is [`SessionHandle::close`].
    pub fn cancel(&self) {
        let _ = self.cmds.send(Cmd::Cancel);
    }

    /// This side's own path verdict, waiting for it if it is not in yet
    /// (at most [`PATH_WAIT`] after the session started).
    pub async fn path(&self) -> NetworkPath {
        let mut rx = self.path.clone();
        match rx.wait_for(Option::is_some).await {
            Ok(p) => p.unwrap_or(NetworkPath::Unknown),
            Err(_) => NetworkPath::Unknown,
        }
    }

    /// End the session: cancel anything in flight, close the LAN link, and
    /// leave the room, waiting for the leave to go out -- bounded at
    /// [`LEAVE_TIMEOUT`]. Every exit goes through here, Ctrl-C included, or
    /// the other device learns only when its connection times out.
    pub async fn close(&self) {
        let (ack, done) = oneshot::channel();
        if self.cmds.send(Cmd::Close(ack)).is_ok() {
            let _ = done.await;
        }
    }
}

/// The session's events. `None` once the session has closed.
#[derive(Debug)]
pub struct SessionEvents(mpsc::UnboundedReceiver<SessionEvent>);

impl SessionEvents {
    pub async fn next(&mut self) -> Option<SessionEvent> {
        self.0.recv().await
    }
}

impl Paired {
    /// The person confirmed the SAS. This is the only way to a session, and
    /// the frames the peer sent while the SAS was on screen are handled now,
    /// first, in order.
    pub async fn confirm(self, role: Role, opts: SessionOptions) -> (SessionHandle, SessionEvents) {
        let Paired {
            pairing,
            peer,
            hold,
            ..
        } = self;
        let (room, early) = hold.release().await;
        let session = pairing.confirm();
        let (link_tx, link_rx) = inbox();
        for f in early.frames {
            let _ = link_tx.send(LinkIn::Frame(f));
        }
        if early.left {
            let _ = link_tx.send(LinkIn::Left);
        }
        let sender = room.sender();
        let (leave_tx, leave_rx) = oneshot::channel();
        tokio::spawn(read_room(room, peer.clone(), link_tx.clone(), leave_rx));
        let link = Link {
            route: Route::Room {
                sender: sender.clone(),
                peer: peer.clone(),
            },
            ctl: Ctl::Room {
                leave: Some(leave_tx),
                sender,
                peer,
            },
            link_tx,
            link_rx,
        };
        start(session, role, opts, link)
    }
}

/// The paired peer's frames and its leave, onto the session's one inbound
/// channel. A stranger's frames are dropped here, never held: the send side
/// has always been targeted at the paired peer, and both halves or neither.
async fn read_room(
    mut room: RoomHandle,
    peer: String,
    link: Inbox,
    leave: oneshot::Receiver<oneshot::Sender<()>>,
) {
    tokio::pin!(leave);
    loop {
        tokio::select! {
            ack = &mut leave => {
                leave_bounded(room).await;
                if let Ok(ack) = ack {
                    let _ = ack.send(());
                }
                return;
            }
            e = room.next_event() => match e {
                None => {
                    let _ = link.send(LinkIn::Left);
                    return;
                }
                Some(RoomEvent::Left(p)) if p == peer => {
                    let _ = link.send(LinkIn::Left);
                }
                Some(RoomEvent::Message { peer: p, message }) if p == peer && message.action == FRAME_ACTION => {
                    // A frame that is not binary is a runt one layer down,
                    // which is a clean failure rather than garbage decrypted.
                    let bytes = match message.payload {
                        Payload::Binary(b) => b,
                        _ => vec![],
                    };
                    let _ = link.send(LinkIn::Frame(bytes));
                }
                Some(_) => {}
            },
        }
    }
}

/// Everything that arrives for the loop from the network, in arrival order.
#[cfg_attr(
    not(all(any(feature = "lan-dial", feature = "lan-listen"), feature = "quic")),
    allow(dead_code)
)]
pub(crate) enum LinkIn {
    Frame(Vec<u8>),
    Left,
    /// A frame over the LAN socket.
    Lan(Vec<u8>),
    /// The LAN socket closed, or a write to it failed.
    LanClosed,
    /// A frame over the QUIC stream.
    Quic(Vec<u8>),
    /// The QUIC stream ended, or a write to it failed.
    QuicClosed,
}

impl LinkIn {
    fn frame_len(&self) -> u64 {
        match self {
            LinkIn::Frame(f) | LinkIn::Lan(f) | LinkIn::Quic(f) => f.len() as u64,
            LinkIn::Left | LinkIn::LanClosed | LinkIn::QuicClosed => 0,
        }
    }
}

/// A session's inbound queue, and the frame bytes waiting in it.
///
/// The count is what the pause hears about a queue in front of the session
/// ([`Session::set_queued`]): receiver.js counts a frame at arrival, and a
/// frame waiting here has arrived. Every road in -- the room's reader, the
/// LAN socket's, the memory link -- goes through [`Inbox::send`], so none
/// can bypass it.
#[derive(Clone)]
pub(crate) struct Inbox {
    tx: mpsc::UnboundedSender<LinkIn>,
    queued: Arc<AtomicU64>,
    /// Told whenever a frame is taken, for [`Inbox::wait_for_room`].
    room: Arc<Notify>,
}

/// The memory link's receive window. A real channel has one -- SCTP's, under
/// str0m -- and a sender facing a receiver that has stopped reading stalls
/// on it. Without one the memory link was a channel of infinite speed, and a
/// receiver starved of CPU could fall any distance behind: on a two-core
/// runner the slow-sink test saw backlogs of 7.7 and 9.7 MB, past any bound
/// flow control can promise, which no deployed transport would allow.
pub(crate) const MEMORY_WINDOW: u64 = 1024 * 1024;

impl Inbox {
    pub(crate) fn send(&self, li: LinkIn) -> Result<(), mpsc::error::SendError<LinkIn>> {
        let n = li.frame_len();
        self.queued.fetch_add(n, Ordering::Relaxed);
        self.tx.send(li).inspect_err(|_| {
            self.queued.fetch_sub(n, Ordering::Relaxed);
        })
    }

    /// `li` is out of the queue: what is still in it.
    fn taken(&self, li: &LinkIn) -> u64 {
        let n = li.frame_len();
        let left = self.queued.fetch_sub(n, Ordering::Relaxed) - n;
        self.room.notify_waiters();
        left
    }

    /// Until fewer than `window` bytes of frames are waiting.
    async fn wait_for_room(&self, window: u64) {
        loop {
            let notified = self.room.notified();
            tokio::pin!(notified);
            // Registered before the check, so a take between the two is not
            // missed.
            notified.as_mut().enable();
            if self.queued.load(Ordering::Relaxed) < window {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) fn inbox() -> (Inbox, mpsc::UnboundedReceiver<LinkIn>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        Inbox {
            tx,
            queued: Arc::new(AtomicU64::new(0)),
            room: Arc::new(Notify::new()),
        },
        rx,
    )
}

/// Where the writer sends frames.
pub(crate) enum Route {
    Room {
        sender: RoomSender,
        peer: String,
    },
    /// The other session's inbound channel, for tests.
    #[allow(dead_code)]
    Memory(Inbox),
}

/// How the loop leaves, and asks for the selected pair.
pub(crate) enum Ctl {
    Room {
        leave: Option<oneshot::Sender<oneshot::Sender<()>>>,
        sender: RoomSender,
        peer: String,
    },
    #[allow(dead_code)]
    Memory(Inbox),
}

pub(crate) struct Link {
    pub route: Route,
    pub ctl: Ctl,
    pub link_tx: Inbox,
    pub link_rx: mpsc::UnboundedReceiver<LinkIn>,
}

enum Out {
    Frame(Vec<u8>),
    #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
    UseLan(lan::WsTx),
    #[cfg(feature = "quic")]
    UseQuic(quinn::SendStream),
    /// Answered once every frame queued ahead of it has been handed over --
    /// and, on the QUIC stream, acknowledged, since a connection closed with
    /// frames still in quinn's buffer drops them.
    Flushed(oneshot::Sender<()>),
}

/// The writer: every outbound frame in queue order, to whichever route is
/// current, each awaited -- which is the transport's backpressure.
async fn write(
    route: Route,
    mut rx: mpsc::UnboundedReceiver<Out>,
    queued: Arc<AtomicUsize>,
    drained: Arc<Notify>,
    link: Inbox,
) {
    #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
    let mut over_lan: Option<lan::WsTx> = None;
    #[cfg(feature = "quic")]
    let mut over_quic: Option<quinn::SendStream> = None;
    // Set when the LAN or QUIC link fails under the sender. Nothing after it goes
    // anywhere: sent over WebRTC instead, it would arrive behind a gap of
    // frames lost with the socket, and the receiver would rightly call that
    // out of order.
    #[cfg_attr(
        not(any(feature = "lan-dial", feature = "lan-listen", feature = "quic")),
        allow(unused_mut)
    )]
    let mut lost = false;
    while let Some(o) = rx.recv().await {
        match o {
            Out::Frame(f) => {
                let n = f.len();
                #[cfg(feature = "quic")]
                if let Some(tx) = over_quic.as_mut() {
                    if quic::write_frame(tx, &f).await.is_err() {
                        over_quic = None;
                        lost = true;
                        let _ = link.send(LinkIn::QuicClosed);
                    }
                    queued.fetch_sub(n, Ordering::Relaxed);
                    drained.notify_one();
                    continue;
                }
                #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
                if let Some(tx) = over_lan.as_mut() {
                    use futures_util::SinkExt;
                    use tokio_tungstenite::tungstenite::Message;
                    if tx.send(Message::Binary(f.into())).await.is_err() {
                        over_lan = None;
                        lost = true;
                        let _ = link.send(LinkIn::LanClosed);
                    }
                    queued.fetch_sub(n, Ordering::Relaxed);
                    drained.notify_one();
                    continue;
                }
                if !lost {
                    match &route {
                        // An error here is the peer gone; its leave says so.
                        Route::Room { sender, peer } => {
                            let _ = sender
                                .send(FRAME_ACTION, Payload::Binary(f), None, Some(peer))
                                .await;
                        }
                        Route::Memory(tx) => {
                            tx.wait_for_room(MEMORY_WINDOW).await;
                            let _ = tx.send(LinkIn::Frame(f));
                        }
                    }
                }
                queued.fetch_sub(n, Ordering::Relaxed);
                drained.notify_one();
            }
            #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
            Out::UseLan(tx) => over_lan = Some(tx),
            #[cfg(feature = "quic")]
            Out::UseQuic(tx) => over_quic = Some(tx),
            Out::Flushed(ack) => {
                #[cfg(feature = "quic")]
                if let Some(mut tx) = over_quic.take() {
                    // The caller bounds the wait; a peer gone mid-stream
                    // never acknowledges.
                    let _ = tx.finish();
                    let _ = tx.stopped().await;
                }
                let _ = ack.send(());
            }
        }
    }
    drop(link);
}

enum SinkCmd {
    Write(Vec<u8>),
    Close,
    Abort,
}

enum SinkReply {
    Written(u64),
    Failed(String),
    Closed(Result<String, String>),
}

/// The sink on a thread of its own, so a slow write stalls only itself.
/// Every reply comes back to the loop, which is what the session's flow
/// control counts.
fn spawn_sink(
    mut sink: Box<dyn Sink>,
    replies: mpsc::UnboundedSender<SinkReply>,
) -> std::sync::mpsc::Sender<SinkCmd> {
    let (tx, rx) = std::sync::mpsc::channel::<SinkCmd>();
    std::thread::spawn(move || {
        while let Ok(c) = rx.recv() {
            match c {
                SinkCmd::Write(d) => match sink.write(&d) {
                    Ok(()) => {
                        let _ = replies.send(SinkReply::Written(d.len() as u64));
                    }
                    Err(e) => {
                        let _ = replies.send(SinkReply::Failed(e.to_string()));
                        sink.abort();
                        return;
                    }
                },
                SinkCmd::Close => {
                    let _ =
                        replies.send(SinkReply::Closed(sink.close().map_err(|e| e.to_string())));
                    return;
                }
                SinkCmd::Abort => {
                    sink.abort();
                    return;
                }
            }
        }
        // The loop went away without closing: a partial file.
        sink.abort();
    });
    tx
}

/// The source on a thread of its own, reading chunks ahead in file order.
fn spawn_source(mut source: Box<dyn Source>) -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel(READ_AHEAD);
    let size = source.size();
    std::thread::spawn(move || {
        let mut offset = 0u64;
        loop {
            let len = (size - offset).min(CHUNK_SIZE as u64) as usize;
            let mut buf = vec![0u8; len];
            let r = source.read_exact(&mut buf).map(|()| buf);
            let failed = r.is_err();
            if tx.blocking_send(r).is_err() || failed {
                return;
            }
            offset += len as u64;
            if offset >= size {
                return;
            }
        }
    });
    rx
}

enum LanEvent {
    /// The listener is up (or failed to come up, with nothing to offer).
    Listening {
        addrs: Vec<String>,
        port: u16,
        token: String,
    },
    #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
    Linked(lan::LanSocket),
    NoLink,
}

#[cfg_attr(not(feature = "quic"), allow(dead_code))]
enum QuicEvent {
    #[cfg(feature = "quic")]
    Prepared(quic::Prepared),
    #[cfg(feature = "quic")]
    Out(quic::Outbound),
    #[cfg(feature = "quic")]
    In(quic::Inbound),
    NoLink,
}

#[cfg_attr(not(feature = "quic"), allow(dead_code))]
struct QuicState {
    config: quic::QuicConfig,
    /// The peer's `quic-hello`: it has the path.
    theirs: bool,
    offer_seen: bool,
    state: LinkState,
    #[cfg(feature = "quic")]
    prepared: Option<quic::Prepared>,
    peer: Option<quic::Offer>,
    #[cfg(feature = "quic")]
    send: Option<quinn::SendStream>,
    /// Kept to close at the end, and so the endpoint outlives the stream.
    #[cfg(feature = "quic")]
    conns: Vec<(quinn::Endpoint, quinn::Connection)>,
    carrying: bool,
    events: mpsc::UnboundedSender<QuicEvent>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

#[derive(PartialEq, Eq)]
enum LinkState {
    Undecided,
    Pending,
    Up,
    None,
}

struct LanState {
    mine: LanListen,
    theirs: Option<LanListen>,
    listener: Option<Role>,
    offer_seen: bool,
    state: LinkState,
    #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
    tx: Option<lan::WsTx>,
    carrying: bool,
    events: mpsc::UnboundedSender<LanEvent>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

struct Driver {
    session: Session,
    role: Role,
    events: mpsc::UnboundedSender<SessionEvent>,
    out: mpsc::UnboundedSender<Out>,
    queued: Arc<AtomicUsize>,
    drained: Arc<Notify>,
    ctl: Ctl,
    lan: Option<LanState>,
    quic: Option<QuicState>,
    /// The file offered and not yet accepted.
    offered: Option<Box<dyn Source>>,
    source: Option<mpsc::Receiver<io::Result<Vec<u8>>>>,
    sink: Option<std::sync::mpsc::Sender<SinkCmd>>,
    sink_replies: mpsc::UnboundedSender<SinkReply>,
    receiving: Option<Manifest>,
    /// Where the closed sink says the file is, until the session reports it
    /// received.
    pending_location: Option<String>,
    #[cfg_attr(
        not(any(feature = "lan-dial", feature = "lan-listen")),
        allow(dead_code)
    )]
    link_tx: Inbox,
    /// The sender waits here at Accept, for a link, until this.
    link_wait: Option<Instant>,
    /// A direct link closed after the last chunk: unless the `done` lands
    /// first, fail with this message at this time (LINK_CLOSE_GRACE).
    link_grace: Option<(Instant, &'static str)>,
    mine: Option<NetworkPath>,
    theirs: NetworkPath,
    path_tx: watch::Sender<Option<NetworkPath>>,
    failed: bool,
}

pub(crate) fn start(
    session: Session,
    role: Role,
    opts: SessionOptions,
    link: Link,
) -> (SessionHandle, SessionEvents) {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel();
    let (path_tx, path_rx) = watch::channel(None);
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let (sink_tx, sink_rx) = mpsc::unbounded_channel();
    let (lan_tx, lan_rx) = mpsc::unbounded_channel();
    let (quic_tx, quic_rx) = mpsc::unbounded_channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let drained = Arc::new(Notify::new());
    tokio::spawn(write(
        link.route,
        out_rx,
        queued.clone(),
        drained.clone(),
        link.link_tx.clone(),
    ));
    let lan = opts.lan.map(|c| LanState {
        mine: if cfg!(feature = "lan-listen") {
            c.listen
        } else {
            LanListen::None
        },
        theirs: None,
        listener: None,
        offer_seen: false,
        state: LinkState::Undecided,
        #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
        tx: None,
        carrying: false,
        events: lan_tx,
        tasks: vec![],
    });
    let quic = opts
        .quic
        .filter(|_| cfg!(feature = "quic"))
        .map(|config| QuicState {
            config,
            theirs: false,
            offer_seen: false,
            state: LinkState::Undecided,
            #[cfg(feature = "quic")]
            prepared: None,
            peer: None,
            #[cfg(feature = "quic")]
            send: None,
            #[cfg(feature = "quic")]
            conns: vec![],
            carrying: false,
            events: quic_tx,
            tasks: vec![],
        });
    let mut d = Driver {
        session,
        role,
        events: ev_tx,
        out: out_tx,
        queued,
        drained,
        ctl: link.ctl,
        lan,
        quic,
        offered: None,
        source: None,
        sink: None,
        sink_replies: sink_tx,
        receiving: None,
        pending_location: None,
        link_tx: link.link_tx.clone(),
        link_wait: None,
        link_grace: None,
        mine: None,
        theirs: NetworkPath::Unknown,
        path_tx,
        failed: false,
    };
    let path_rx_loop = d.classify();
    tokio::spawn(async move {
        d.begin();
        d.run(cmd_rx, link.link_rx, sink_rx, lan_rx, quic_rx, path_rx_loop)
            .await;
    });
    (
        SessionHandle {
            cmds: cmd_tx,
            path: path_rx,
        },
        SessionEvents(ev_rx),
    )
}

impl Driver {
    /// Poll for the selected pair for up to [`PATH_WAIT`], as `classifyPath`
    /// polls `getStats()`, and say `Unknown` rather than guess if none comes.
    fn classify(&self) -> oneshot::Receiver<NetworkPath> {
        let (tx, rx) = oneshot::channel();
        let query = match &self.ctl {
            Ctl::Room { sender, peer, .. } => Some((sender.clone(), peer.clone())),
            Ctl::Memory(_) => None,
        };
        tokio::spawn(async move {
            let verdict = async {
                let (sender, peer) = query?;
                let deadline = tokio::time::Instant::now() + PATH_WAIT;
                loop {
                    if let Some(p) = sender.selected_pair(&peer).await {
                        return Some(path::classify(&p));
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            };
            let _ = tx.send(verdict.await.unwrap_or(NetworkPath::Unknown));
        });
        rx
    }

    /// After the SAS: the sender's hello says whether this machine will
    /// listen, and goes to nobody unverified (lan.js, "WHEN IT IS SAID").
    fn begin(&mut self) {
        if self.role == Role::Host
            && let Some(l) = &self.lan
        {
            let _ = self.session.send_lan_hello(l.mine);
        }
        // The same moment and the same reason, for the QUIC path (quic.rs).
        if self.role == Role::Host && self.quic.is_some() {
            let _ = self.session.send_quic_hello();
            self.quic_prepare();
        }
        self.pump();
    }

    async fn run(
        &mut self,
        mut cmds: mpsc::UnboundedReceiver<Cmd>,
        mut link: mpsc::UnboundedReceiver<LinkIn>,
        mut sink: mpsc::UnboundedReceiver<SinkReply>,
        mut lan_events: mpsc::UnboundedReceiver<LanEvent>,
        mut quic_events: mpsc::UnboundedReceiver<QuicEvent>,
        mut path: oneshot::Receiver<NetworkPath>,
    ) {
        let mut path_done = false;
        loop {
            let wanting = self.source.is_some() && self.session.chunk_wanted().is_some();
            let room = self.queued.load(Ordering::Relaxed) < OUT_HIGH;
            let timer = [
                self.session.poll_timeout(),
                self.link_wait,
                self.link_grace.map(|(t, _)| t),
            ]
            .into_iter()
            .flatten()
            .min();
            let sleep = async {
                match timer {
                    Some(t) => tokio::time::sleep_until(t.into()).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                c = cmds.recv() => match c {
                    None => {
                        self.shut().await;
                        return;
                    }
                    Some(Cmd::Close(ack)) => {
                        self.shut().await;
                        let _ = ack.send(());
                        return;
                    }
                    Some(c) => self.on_cmd(c),
                },
                Some(li) = link.recv() => self.on_link(li),
                Some(r) = sink.recv() => self.on_sink(r),
                Some(e) = lan_events.recv() => self.on_lan(e),
                Some(e) = quic_events.recv() => self.on_quic(e),
                p = &mut path, if !path_done => {
                    path_done = true;
                    self.on_path(p.unwrap_or(NetworkPath::Unknown));
                }
                c = async { self.source.as_mut().expect("guarded").recv().await }, if wanting && room => {
                    self.on_chunk(c);
                }
                _ = self.drained.notified(), if wanting && !room => {}
                _ = sleep => {
                    let now = Instant::now();
                    self.session.handle_timeout(now);
                    if self.link_wait.is_some_and(|t| now >= t) {
                        self.proceed(true);
                    }
                    if let Some((t, why)) = self.link_grace
                        && now >= t
                    {
                        self.link_grace = None;
                        if self.source.is_some() {
                            self.session.abort(why);
                        }
                    }
                }
            }
            self.pump();
        }
    }

    fn emit(&mut self, e: SessionEvent) {
        if matches!(e, SessionEvent::Failed(_)) {
            if self.failed {
                return;
            }
            self.failed = true;
        }
        let _ = self.events.send(e);
    }

    fn on_cmd(&mut self, c: Cmd) {
        match c {
            Cmd::SendFile(src) => {
                let offer = FileOffer {
                    name: src.name().into(),
                    size: src.size(),
                    mime: src.mime().into(),
                };
                if self.session.send_file(offer).is_ok() {
                    self.offered = Some(src);
                }
            }
            Cmd::Accept(sink) => match self.session.accept() {
                Ok(()) => self.sink = Some(spawn_sink(sink, self.sink_replies.clone())),
                // The receive ended while the sink was opening: release it
                // rather than write into it.
                Err(_) => sink.abort(),
            },
            Cmd::Decline => {
                let _ = self.session.decline();
                self.receiving = None;
            }
            Cmd::Cancel => self.session.cancel(),
            Cmd::Close(_) => unreachable!("handled by the loop"),
        }
    }

    fn on_link(&mut self, li: LinkIn) {
        let now = Instant::now();
        let queued = self.link_tx.taken(&li);
        self.session.set_queued(queued);
        match li {
            LinkIn::Frame(f) => self.session.handle_frame(&f, now),
            LinkIn::Lan(f) => {
                if let Some(l) = &mut self.lan
                    && !l.carrying
                {
                    l.carrying = true;
                    self.emit(SessionEvent::Lan);
                }
                self.session.handle_frame(&f, now);
            }
            LinkIn::Quic(f) => {
                if let Some(q) = &mut self.quic
                    && !q.carrying
                {
                    q.carrying = true;
                    self.emit(SessionEvent::Quic);
                }
                self.session.handle_frame(&f, now);
            }
            LinkIn::QuicClosed => {
                let carried = self.quic.as_ref().is_some_and(|q| q.carrying);
                if let Some(q) = &mut self.quic {
                    q.state = LinkState::None;
                }
                // Only a stream that was carrying the file loses anything by
                // ending: frames went down it and WebRTC has not got them.
                if carried && (self.session.busy() || self.source.is_some()) {
                    self.link_closed(quic::QUIC_CLOSED);
                }
            }
            LinkIn::Left => self.session.peer_left(),
            LinkIn::LanClosed => {
                // A receiver counts a link that was up as carrying, since the
                // sender may have switched and lost frames in it before the
                // first one arrived. A sender knows: it set `carrying` when
                // it switched. Reading "up" as "carrying" there was right
                // while LAN was the only direct link, and wrong once QUIC
                // could win: the idle LAN socket closing at the end of a
                // QUIC transfer failed a file the receiver already had
                // (measured from a phone sending 64 MiB to the CLI). The
                // receiver's guess has the same hole from the other side:
                // once a frame has come over QUIC, the sender switched there
                // and not here, so this socket carried nothing. Measured on a
                // phone receiving over a hotspot, whose idle LAN socket closed
                // 24 MB into a QUIC transfer and failed it.
                let over_quic = self.quic.as_ref().is_some_and(|q| q.carrying);
                let carried = self.lan.as_ref().is_some_and(|l| {
                    l.carrying
                        || (self.role == Role::Guest && l.state == LinkState::Up && !over_quic)
                });
                if let Some(l) = &mut self.lan {
                    l.state = LinkState::None;
                }
                // The frames stopped arriving over the link while WebRTC
                // may still be up, so no leave is coming to end this.
                if carried && (self.session.busy() || self.source.is_some()) {
                    self.link_closed(LAN_CLOSED);
                }
            }
        }
    }

    /// A direct link closed under a transfer. A sender with every chunk
    /// already out waits LINK_CLOSE_GRACE for the `done` that is probably
    /// behind the close; anyone else has lost frames, and fails now.
    fn link_closed(&mut self, why: &'static str) {
        if self.source.is_some() && self.session.awaiting_done() {
            self.link_grace
                .get_or_insert((Instant::now() + LINK_CLOSE_GRACE, why));
        } else {
            self.session.abort(why);
        }
    }

    fn on_sink(&mut self, r: SinkReply) {
        match r {
            SinkReply::Written(n) => self.session.write_done(n),
            SinkReply::Failed(e) => {
                self.sink = None;
                self.session.abort(&e);
            }
            SinkReply::Closed(Ok(location)) => {
                self.sink = None;
                if self.session.file_closed(Instant::now()).is_ok() {
                    // Event::Received follows from the session; the location
                    // rides with the manifest until then.
                    self.pending_location = Some(location);
                }
            }
            SinkReply::Closed(Err(e)) => {
                self.sink = None;
                self.session.abort(&e);
            }
        }
    }

    fn on_path(&mut self, mine: NetworkPath) {
        self.mine = Some(mine);
        self.path_tx.send_replace(Some(mine));
        let _ = self.session.send_path(mine);
        self.emit_path();
    }

    /// Only once this side has its own verdict. The peer's can arrive first,
    /// and an event then would say `mine: Unknown` for a verdict that is
    /// merely not in yet -- indistinguishable from one that came back
    /// unknown, and the CLI announces the path exactly once, at the first.
    fn emit_path(&mut self) {
        let Some(mine) = self.mine else { return };
        let theirs = self.theirs;
        self.emit(SessionEvent::Path {
            mine,
            theirs,
            combined: path::combine(mine, theirs),
        });
    }

    fn on_chunk(&mut self, c: Option<io::Result<Vec<u8>>>) {
        match c {
            Some(Ok(data)) => {
                let _ = self.session.send_chunk(&data);
            }
            Some(Err(e)) => self.session.abort(&format!("Could not read the file: {e}")),
            // The reader stopped early: the file is shorter than it was.
            None => {
                let _ = self.session.send_chunk(&[]);
            }
        }
        if self.session.chunk_wanted().is_none() {
            // Done reading, or failed: the thread exits when this drops.
            if self.session.ended() || self.session.failure().is_some() {
                self.source = None;
            }
        }
    }

    fn start_chunks(&mut self) {
        if let Some(src) = self.offered.take() {
            self.source = Some(spawn_source(src));
            let _ = self.session.start_chunks(Instant::now());
        }
    }

    /// Everything the session queued: frames to the writer, events acted on.
    fn pump(&mut self) {
        while let Some(f) = self.session.poll_transmit() {
            self.queued.fetch_add(f.len(), Ordering::Relaxed);
            let _ = self.out.send(Out::Frame(f));
        }
        while let Some(e) = self.session.poll_event() {
            self.on_event(e);
            while let Some(f) = self.session.poll_transmit() {
                self.queued.fetch_add(f.len(), Ordering::Relaxed);
                let _ = self.out.send(Out::Frame(f));
            }
        }
    }

    fn on_event(&mut self, e: Event) {
        match e {
            Event::Offer(m) => {
                self.receiving = Some(m.clone());
                self.emit(SessionEvent::Offer(m));
            }
            Event::Write(data) => {
                if let Some(s) = &self.sink {
                    let _ = s.send(SinkCmd::Write(data));
                }
            }
            Event::ReceiveProgress {
                received, total, ..
            } => self.emit(SessionEvent::ReceiveProgress { received, total }),
            Event::Complete { .. } => {
                if let Some(s) = &self.sink {
                    let _ = s.send(SinkCmd::Close);
                }
            }
            Event::Received { size, digest, .. } => {
                let name = self.receiving.take().map(|m| m.name).unwrap_or_default();
                let location = self.pending_location.take().unwrap_or_default();
                self.emit(SessionEvent::Received {
                    name,
                    size,
                    digest,
                    location,
                });
            }
            Event::AbortSink => {
                if let Some(s) = self.sink.take() {
                    let _ = s.send(SinkCmd::Abort);
                }
            }
            Event::SendAccepted { .. } => {
                self.emit(SessionEvent::SendAccepted);
                self.at_accept();
            }
            Event::SendDeclined { .. } => {
                self.offered = None;
                self.emit(SessionEvent::Declined);
            }
            Event::SendProgress { sent, total, .. } => {
                self.emit(SessionEvent::SendProgress { sent, total })
            }
            Event::Sent { digest, .. } => {
                self.source = None;
                self.emit(SessionEvent::Sent { digest });
            }
            Event::PeerPath(p) => {
                self.theirs = p;
                self.emit_path();
            }
            Event::PeerLanHello(theirs) => self.on_lan_hello(theirs),
            Event::PeerLanOffer { addrs, port, token } => self.on_lan_offer(&addrs, port, &token),
            Event::PeerQuicHello => self.on_quic_hello(),
            Event::PeerQuicOffer { addrs, fp } => self.on_quic_offer(&addrs, &fp),
            Event::Failed(e) => {
                self.source = None;
                self.offered = None;
                self.emit(SessionEvent::Failed(e.to_string()));
            }
        }
    }

    /// The one moment the sender's frames may move (lan.js, "WHY ACCEPT IS
    /// THE ONE MOMENT TO MOVE"). No hello from the peer by now is a peer
    /// without the path, recognised without a timeout: a receiver queues its
    /// reply inside its handling of our hello, ahead of its Accept.
    ///
    /// With both paths on offer, QUIC wins: it crosses a LAN as well as
    /// anything else does, and a NAT besides.
    fn at_accept(&mut self) {
        let wait = [
            self.lan_pending().then_some(lan::LINK_WAIT),
            self.quic_pending().then_some(quic::LINK_WAIT),
        ]
        .into_iter()
        .flatten()
        .max();
        match wait {
            Some(w) if !self.quic_up() => self.link_wait = Some(Instant::now() + w),
            _ => self.proceed(true),
        }
    }

    /// The peer said hello on the LAN path, a listener was chosen, and the
    /// link has not settled either way.
    fn lan_pending(&self) -> bool {
        self.lan.as_ref().is_some_and(|l| {
            l.theirs.is_some()
                && l.listener.is_some()
                && matches!(l.state, LinkState::Pending | LinkState::Undecided)
        })
    }

    fn quic_pending(&self) -> bool {
        self.quic.as_ref().is_some_and(|q| {
            q.theirs && matches!(q.state, LinkState::Pending | LinkState::Undecided)
        })
    }

    fn quic_up(&self) -> bool {
        self.quic.as_ref().is_some_and(|q| q.state == LinkState::Up)
    }

    /// A sender parked at Accept goes on, over the best link that is up --
    /// unless one is still settling and `last` is false, when it waits on.
    fn proceed(&mut self, last: bool) {
        if self.quic_up() {
            self.switch_to_quic();
        } else if !last && (self.quic_pending() || self.lan_pending()) {
            return;
        } else if self.lan.as_ref().is_some_and(|l| l.state == LinkState::Up) {
            self.switch_to_lan();
        }
        self.link_wait = None;
        self.start_chunks();
    }

    fn switch_to_quic(&mut self) {
        #[cfg(feature = "quic")]
        if let Some(q) = &mut self.quic
            && let Some(tx) = q.send.take()
        {
            q.carrying = true;
            let _ = self.out.send(Out::UseQuic(tx));
            self.emit(SessionEvent::Quic);
        }
    }

    fn switch_to_lan(&mut self) {
        #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
        if let Some(l) = self.lan.as_mut()
            && let Some(tx) = l.tx.take()
        {
            l.carrying = true;
            let _ = self.out.send(Out::UseLan(tx));
            self.emit(SessionEvent::Lan);
        }
    }

    fn on_lan_hello(&mut self, theirs: LanListen) {
        let role = self.role;
        let Some(l) = &mut self.lan else { return };
        // One per session; a second would open a second listener.
        if l.theirs.is_some() {
            return;
        }
        l.theirs = Some(theirs);
        let mine = l.mine;
        if role == Role::Guest {
            // Queued now, inside the handling of the sender's hello, so it
            // leaves ahead of an Accept the person has not pressed yet.
            let _ = self.session.send_lan_hello(mine);
        }
        let Some(l) = &mut self.lan else { return };
        let (sender, receiver) = if role == Role::Host {
            (mine, theirs)
        } else {
            (theirs, mine)
        };
        l.listener = lan::choose_listener(sender, receiver);
        match l.listener {
            None => l.state = LinkState::None,
            Some(r) if r == role => {
                l.state = LinkState::Pending;
                self.listen();
            }
            Some(_) => l.state = LinkState::Pending,
        }
    }

    #[cfg(feature = "lan-listen")]
    fn listen(&mut self) {
        let Some(l) = &mut self.lan else { return };
        let events = l.events.clone();
        l.tasks.push(tokio::spawn(async move {
            let mut token = [0u8; lan::TOKEN_BYTES];
            rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut token);
            let token_hex = lan::token_hex(&token);
            match lan::listen().await {
                Ok(listening) => {
                    let _ = events.send(LanEvent::Listening {
                        addrs: listening.addrs.clone(),
                        port: listening.port,
                        token: token_hex,
                    });
                    if listening.addrs.is_empty() {
                        let _ = events.send(LanEvent::NoLink);
                        return;
                    }
                    match lan::accept(listening, token).await {
                        Some(s) => {
                            let _ = events.send(LanEvent::Linked(s));
                        }
                        None => {
                            let _ = events.send(LanEvent::NoLink);
                        }
                    }
                }
                // Sent even with nothing to offer, so the peer stops waiting
                // for one now rather than at the end of LINK_WAIT.
                Err(_) => {
                    let _ = events.send(LanEvent::Listening {
                        addrs: vec![],
                        port: 0,
                        token: token_hex,
                    });
                    let _ = events.send(LanEvent::NoLink);
                }
            }
        }));
    }

    #[cfg(not(feature = "lan-listen"))]
    fn listen(&mut self) {
        // Unreachable in practice: without the feature this side says `none`
        // and is never chosen. Should it be, it offers nothing.
        if let Some(l) = &self.lan {
            let _ = l.events.send(LanEvent::Listening {
                addrs: vec![],
                port: 0,
                token: "0".repeat(32),
            });
            let _ = l.events.send(LanEvent::NoLink);
        }
    }

    fn on_lan_offer(&mut self, addrs: &[String], port: u64, token: &str) {
        let role = self.role;
        let Some(l) = &mut self.lan else { return };
        if l.offer_seen || l.listener.is_none() || l.listener == Some(role) {
            return;
        }
        l.offer_seen = true;
        let Some(offer) = lan::parse_offer(addrs, port, token) else {
            l.state = LinkState::None;
            return self.link_settled();
        };
        #[cfg(feature = "lan-dial")]
        {
            let events = l.events.clone();
            l.tasks.push(tokio::spawn(async move {
                let _ = events.send(match lan::dial(&offer).await {
                    Some(s) => LanEvent::Linked(s),
                    None => LanEvent::NoLink,
                });
            }));
        }
        #[cfg(not(feature = "lan-dial"))]
        {
            let _ = offer;
            l.state = LinkState::None;
            self.link_settled();
        }
    }

    fn on_lan(&mut self, e: LanEvent) {
        #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
        let link = self.link_tx.clone();
        let Some(l) = &mut self.lan else { return };
        match e {
            LanEvent::Listening { addrs, port, token } => {
                let _ = self.session.send_lan_offer(addrs, port, token);
            }
            #[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
            LanEvent::Linked(socket) => {
                let lan::LanSocket { tx, mut rx } = socket;
                l.tx = Some(tx);
                l.state = LinkState::Up;
                l.tasks.push(tokio::spawn(async move {
                    use futures_util::StreamExt;
                    use tokio_tungstenite::tungstenite::Message;
                    while let Some(Ok(m)) = rx.next().await {
                        match m {
                            Message::Binary(b) => {
                                if link.send(LinkIn::Lan(b.to_vec())).is_err() {
                                    return;
                                }
                            }
                            Message::Close(_) => break,
                            // Text is not part of this protocol.
                            _ => {}
                        }
                    }
                    let _ = link.send(LinkIn::LanClosed);
                }));
                self.link_settled();
            }
            LanEvent::NoLink => {
                l.state = LinkState::None;
                self.link_settled();
            }
        }
    }

    /// A link settled: a sender parked at Accept may go on now.
    fn link_settled(&mut self) {
        if self.link_wait.is_some() {
            self.proceed(false);
        }
    }

    /// The peer has the QUIC path. A receiver answers at once, inside its
    /// handling of the sender's hello and so ahead of its Accept (quic.rs).
    fn on_quic_hello(&mut self) {
        let role = self.role;
        let Some(q) = &mut self.quic else { return };
        // One per session; a second would bind a second endpoint.
        if q.theirs {
            return;
        }
        q.theirs = true;
        if role == Role::Guest {
            let _ = self.session.send_quic_hello();
            self.quic_prepare();
        }
    }

    #[cfg(feature = "quic")]
    fn quic_prepare(&mut self) {
        let Some(q) = &mut self.quic else { return };
        q.state = LinkState::Pending;
        let events = q.events.clone();
        let config = q.config.clone();
        q.tasks.push(tokio::spawn(async move {
            let _ = events.send(match quic::prepare(&config).await {
                Ok(p) => QuicEvent::Prepared(p),
                Err(_) => QuicEvent::NoLink,
            });
        }));
    }

    #[cfg(not(feature = "quic"))]
    fn quic_prepare(&mut self) {
        // Unreachable: without the feature there is no QUIC state at all.
    }

    fn on_quic_offer(&mut self, addrs: &[String], fp: &str) {
        let Some(q) = &mut self.quic else { return };
        if q.offer_seen || !q.theirs {
            return;
        }
        q.offer_seen = true;
        let loopback = q.config.bind.is_some_and(|ip| ip.is_loopback());
        match quic::parse_offer(addrs, fp, loopback) {
            Some(o) => {
                q.peer = Some(o);
                self.quic_connect();
            }
            None => {
                q.state = LinkState::None;
                self.link_settled();
            }
        }
    }

    /// Both offers are in: the sender dials, the receiver serves.
    fn quic_connect(&mut self) {
        #[cfg(feature = "quic")]
        {
            let role = self.role;
            let Some(q) = &mut self.quic else { return };
            // Both or neither: the first to arrive waits for the second.
            if q.prepared.is_none() || q.peer.is_none() {
                return;
            }
            let (Some(p), Some(peer)) = (q.prepared.take(), q.peer.take()) else {
                unreachable!("both checked above");
            };
            let events = q.events.clone();
            q.tasks.push(tokio::spawn(async move {
                let e = if role == Role::Host {
                    quic::dial(p, peer).await.map(QuicEvent::Out)
                } else {
                    quic::serve(p, peer).await.map(QuicEvent::In)
                };
                let _ = events.send(e.unwrap_or(QuicEvent::NoLink));
            }));
        }
    }

    fn on_quic(&mut self, e: QuicEvent) {
        #[cfg(feature = "quic")]
        let link = self.link_tx.clone();
        let Some(q) = &mut self.quic else { return };
        match e {
            #[cfg(feature = "quic")]
            QuicEvent::Prepared(p) => {
                let addrs = p.addrs.iter().map(|a| a.to_string()).collect();
                let _ = self
                    .session
                    .send_quic_offer(addrs, quic::fingerprint_hex(&p.fp));
                q.prepared = Some(p);
                self.quic_connect();
            }
            #[cfg(feature = "quic")]
            QuicEvent::Out(o) => {
                q.send = Some(o.send);
                q.conns.push((o.endpoint, o.conn));
                q.state = LinkState::Up;
                self.link_settled();
            }
            #[cfg(feature = "quic")]
            QuicEvent::In(i) => {
                let conn = i.conn.clone();
                q.conns.push((i.endpoint, i.conn));
                q.state = LinkState::Up;
                q.tasks.push(tokio::spawn(async move {
                    if let Ok(mut rx) = conn.accept_uni().await {
                        while let Some(f) = quic::read_frame(&mut rx).await {
                            link.wait_for_room(quic::READ_AHEAD).await;
                            if link.send(LinkIn::Quic(f)).is_err() {
                                return;
                            }
                        }
                    }
                    let _ = link.send(LinkIn::QuicClosed);
                }));
            }
            QuicEvent::NoLink => {
                q.state = LinkState::None;
                self.link_settled();
            }
        }
    }

    async fn shut(&mut self) {
        self.session.cancel();
        self.pump();
        // The leave goes by another road than the frames -- the room task
        // for a room, straight to the peer's link for memory -- so it can
        // overtake the last of them. A receiver closing as soon as it has
        // its file did exactly that to its own `done`, and the sender called
        // a finished transfer a disconnect. So wait until the writer has
        // handed over everything queued before this, bounded, since a peer
        // already gone can leave the writer parked on backpressure.
        let (ack, flushed) = oneshot::channel();
        if self.out.send(Out::Flushed(ack)).is_ok() {
            let _ = tokio::time::timeout(LEAVE_TIMEOUT, flushed).await;
        }
        self.source = None;
        self.offered = None;
        if let Some(l) = self.lan.take() {
            for t in l.tasks {
                t.abort();
            }
        }
        if let Some(q) = self.quic.take() {
            for t in q.tasks {
                t.abort();
            }
            #[cfg(feature = "quic")]
            for (endpoint, conn) in q.conns {
                conn.close(quinn::VarInt::from_u32(0), b"");
                drop(endpoint);
            }
        }
        match &mut self.ctl {
            Ctl::Room { leave, .. } => {
                if let Some(tx) = leave.take() {
                    let (ack, done) = oneshot::channel();
                    if tx.send(ack).is_ok() {
                        let _ = done.await;
                    }
                }
            }
            Ctl::Memory(other) => {
                let _ = other.send(LinkIn::Left);
            }
        }
    }
}
