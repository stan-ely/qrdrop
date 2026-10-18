//! The transfer state machines, sans-IO: one [`Session`] per paired peer,
//! carrying both directions at once.
//!
//! A port of `src/core/sender.js`, `receiver.js` and `control.js`. The JS
//! runs these as async code over a channel, a control stream and a queue of
//! promises; here they are one value that takes inputs and queues outputs,
//! and the driver (`qrdrop-session`, phase 5) owns every socket, file, clock
//! and person. Several of the JS's invariants were bugs before they were
//! rules, and some of them stop being things to get right and become things
//! that cannot happen:
//!
//! - **One control queue per direction.** The JS had to make take-index,
//!   seal and send one queued step, because WebCrypto finishing two seals out
//!   of order put an index on the wire behind a higher one. Here sealing is
//!   synchronous and every outbound frame goes through one FIFO,
//!   [`Session::poll_transmit`], so index order is send order by construction.
//! - **A leave fails the stream only after the frames before it.** The JS
//!   handed a frame to decryption un-awaited, so the leave behind it ran first
//!   and a finished send was reported as a disconnect. Here
//!   [`Session::handle_frame`] has finished with a frame when it returns, so a
//!   `done` delivered before [`Session::peer_left`] has already ended the send.
//! - **`fail()` is sticky, and the first error wins.** One `halted` flag, set
//!   once; everything after it is a no-op that reports nothing.
//!
//! The rest are rules this module still has to keep, and the tests name them:
//! authenticate, then trust (a frame that fails its tag is dropped and
//! counted, never fatal, with no threshold); unknown control types are ignored
//! and consume their index; Accept is the driver's call, made only after the
//! person chose and the sink is open; flow control pauses the peer at 4 MiB
//! of plaintext handed out but not yet written, and resumes it at 1 MiB.

use std::collections::VecDeque;
use std::fmt;
use std::time::{Duration, Instant};

use crate::control::{
    Control, DEFAULT_MIME, LanListen, Manifest, NetworkPath, open_control, seal_control,
};
use crate::digest::{Chain, equal_hex};
use crate::frame::{
    CHUNK_SIZE, CONTROL_SEQ, Expect, FrameError, FrameKey, HEADER_BYTES, Header, TYPE_CHUNK,
    TYPE_CONTROL, open, seal,
};

/// Above this many bytes handed out in [`Event::Write`] and not yet reported
/// by [`Session::write_done`], the peer is asked to pause. Without it a sink
/// slower than the channel lets the whole file accumulate in memory: the JS
/// measured a 1 GiB heap over a 1 GiB transfer before it had this.
pub const PAUSE_AT: u64 = 4 * 1024 * 1024;
/// ...and resumed once the backlog falls to this. The gap is hysteresis; one
/// threshold would pause and resume on every frame at the boundary.
pub const RESUME_AT: u64 = 1024 * 1024;
/// A peer that pauses and never resumes fails the send rather than parking it
/// forever. Generous, because a phone writing to slow storage can hold a
/// transfer for many seconds at a stretch.
pub const PAUSE_TIMEOUT: Duration = Duration::from_secs(120);

/// `max(1, ceil(size / CHUNK_SIZE))`: an empty file is one empty chunk.
pub fn chunk_count(size: u64) -> u64 {
    size.div_ceil(CHUNK_SIZE as u64).max(1)
}

/// What the sender knows about a file before reading any of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileOffer {
    pub name: String,
    pub size: u64,
    /// Empty means unknown, sent as `application/octet-stream`.
    pub mime: String,
}

/// The bytes the sender wants next: `len` bytes at `offset` of the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkRequest {
    pub file_seq: u32,
    pub index: u64,
    pub offset: u64,
    pub len: usize,
}

/// Something the driver has to act on or show, in the order it happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The peer offers a file. Show it to the person; on their Accept, open
    /// the sink and only then call [`Session::accept`]. Nothing is accepted
    /// for them, ever.
    Offer(Manifest),
    /// Plaintext for the open sink, in file order. Report it written with
    /// [`Session::write_done`]; that is what flow control counts.
    Write(Vec<u8>),
    ReceiveProgress {
        received: u64,
        total: u64,
        chunk: u64,
        chunks: u64,
    },
    /// Every byte has been handed out in `Write` and the digest matched.
    /// Finish the writes, close the sink, then call [`Session::file_closed`].
    Complete {
        seq: u32,
    },
    /// The `done` is queued: the file is the person's.
    Received {
        seq: u32,
        size: u64,
        digest: String,
    },
    /// Throw the partial file away. Comes before the [`Event::Failed`] that
    /// explains it, or alone after [`Session::cancel`].
    AbortSink,

    /// The peer accepted. Move the transport if it is going to move -- the
    /// LAN switch happens here and at no other moment, because every frame
    /// already sent is one the peer has provably handled -- then call
    /// [`Session::start_chunks`].
    SendAccepted {
        seq: u32,
    },
    SendDeclined {
        seq: u32,
    },
    SendProgress {
        sent: u64,
        total: u64,
        chunk: u64,
        chunks: u64,
    },
    Sent {
        seq: u32,
        digest: String,
    },

    /// The peer's own view of the route. Advisory; nothing waits for it.
    PeerPath(NetworkPath),
    PeerLanHello(LanListen),
    PeerLanOffer {
        addrs: Vec<String>,
        port: u64,
        token: String,
        answer: Option<String>,
    },
    PeerQuicHello,
    PeerQuicOffer {
        addrs: Vec<String>,
        fp: String,
    },

    /// The session is over. Reported once; nothing after it is.
    Failed(Error),
}

/// Why a session ended badly. The messages are the JS's, which both surfaces
/// show and e2e/interop.e2e.mjs matches on in places.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// An authentic frame that broke the protocol. Never
    /// [`FrameError::Unauthenticated`]: those are dropped, not failures.
    Frame(FrameError),
    Runt,
    Malformed(String),
    OfferWhileBusy,
    ChunkWithoutFile,
    ExcessData,
    LastAtWrongChunk,
    UnexpectedCompletion,
    ChunkCountMismatch,
    SizeMismatch,
    DigestMismatch,
    PeerRefused(String),
    PeerCouldNotComplete(String),
    PauseTimeout,
    PeerDisconnected,
    /// The sink could not be opened, in the driver's words. A failure, never
    /// a dismissal: a dismissed dialog is [`Session::decline`].
    Sink(String),
    /// The file did not yield the bytes its size promised.
    SourceChanged,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Frame(e) => e.fmt(f),
            Error::Runt => f.write_str("Runt frame"),
            Error::Malformed(m) => f.write_str(m),
            Error::OfferWhileBusy => {
                f.write_str("Peer offered a file while one was already in flight")
            }
            Error::ChunkWithoutFile => f.write_str("Chunk arrived with no accepted file"),
            Error::ExcessData => f.write_str("Peer sent more data than the manifest declared"),
            Error::LastAtWrongChunk => f.write_str("End-of-file flag arrived at the wrong chunk"),
            Error::UnexpectedCompletion => f.write_str("Unexpected completion"),
            Error::ChunkCountMismatch => f.write_str("Chunk count mismatch"),
            Error::SizeMismatch => f.write_str("Size mismatch"),
            Error::DigestMismatch => f.write_str("Digest mismatch"),
            Error::PeerRefused(m) => write!(f, "Peer refused the transfer: {m}"),
            Error::PeerCouldNotComplete(m) => {
                write!(f, "Peer could not complete the transfer: {m}")
            }
            Error::PauseTimeout => f.write_str("Peer paused the transfer and never resumed"),
            Error::PeerDisconnected => f.write_str(crate::PEER_DISCONNECTED),
            Error::Sink(m) => f.write_str(m),
            Error::SourceChanged => f.write_str("The file changed while it was being sent"),
        }
    }
}

impl std::error::Error for Error {}

/// A call the session's state does not allow. The driver's mistake or a race
/// it lost, never the peer's doing, and it changes nothing -- except
/// [`UsageError::WrongLength`], which is a file that changed under the sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsageError {
    /// The session has failed, been cancelled, or lost its peer. After
    /// [`Session::accept`], this is the answer that says to release the sink
    /// the driver just opened: the receive ended while the dialog was up.
    Ended,
    /// A file is already on its way out.
    Busy,
    NoOffer,
    NotAccepted,
    NotStreaming,
    NotClosing,
    /// [`Session::send_chunk`] was handed the wrong number of bytes. The
    /// session has failed with [`Error::SourceChanged`].
    WrongLength {
        expected: usize,
        got: usize,
    },
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UsageError::Ended => f.write_str("the session has ended"),
            UsageError::Busy => f.write_str("a file is already being sent"),
            UsageError::NoOffer => f.write_str("there is no offer to answer"),
            UsageError::NotAccepted => f.write_str("the peer has not accepted"),
            UsageError::NotStreaming => f.write_str("no chunk is wanted"),
            UsageError::NotClosing => f.write_str("no file is waiting to be closed"),
            UsageError::WrongLength { expected, got } => {
                write!(f, "expected {expected} bytes, got {got}")
            }
        }
    }
}

impl std::error::Error for UsageError {}

struct Outgoing {
    seq: u32,
    size: u64,
    chunks: u64,
    state: Out,
    digest: Chain,
    sent: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Out {
    AwaitingReply,
    Accepted,
    Streaming { next: u64 },
    AwaitingDone,
}

struct Active {
    manifest: Manifest,
    expected: u64,
    digest: Chain,
    received: u64,
}

enum Incoming {
    Idle,
    Offered(Manifest),
    Receiving(Active),
    /// Verified and waiting for the driver to close the sink. Frames that
    /// arrive meanwhile wait in `deferred`, as the JS's queue held them behind
    /// the awaited close.
    Closing {
        seq: u32,
        size: u64,
        digest: String,
    },
}

/// One paired session, both directions. Made by
/// [`Pairing::confirm`](crate::Pairing::confirm), and only there.
pub struct Session {
    send: FrameKey,
    recv: FrameKey,
    control_out: u64,
    control_in: u64,
    /// Assigned here and never by the caller: a fileSeq is the nonce prefix
    /// of every chunk in its file, and two files under one seq would reuse
    /// nonces under one key.
    next_file_seq: u32,

    outbox: VecDeque<Vec<u8>>,
    events: VecDeque<Event>,

    /// Replies to our sender, in arrival order, until a wait matches them.
    /// Buffered rather than dropped as the JS control stream buffers them: a
    /// peer's `error` sent before our manifest still answers it.
    replies: VecDeque<Control>,
    peer_paused: bool,
    pause_deadline: Option<Instant>,
    outgoing: Option<Outgoing>,

    incoming: Incoming,
    deferred: VecDeque<Vec<u8>>,
    pending: u64,
    queued: u64,
    told_paused: bool,

    halted: bool,
    failure: Option<Error>,
    dropped: u64,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("halted", &self.halted)
            .field("dropped", &self.dropped)
            .field("pending", &self.pending)
            .finish_non_exhaustive()
    }
}

impl Session {
    pub(crate) fn new(send: FrameKey, recv: FrameKey) -> Self {
        Session {
            send,
            recv,
            control_out: 0,
            control_in: 0,
            next_file_seq: 0,
            outbox: VecDeque::new(),
            events: VecDeque::new(),
            replies: VecDeque::new(),
            peer_paused: false,
            pause_deadline: None,
            outgoing: None,
            incoming: Incoming::Idle,
            deferred: VecDeque::new(),
            pending: 0,
            queued: 0,
            told_paused: false,
            halted: false,
            failure: None,
            dropped: 0,
        }
    }

    // --- outputs ---

    /// The next frame for the channel, in the order it must be sent.
    pub fn poll_transmit(&mut self) -> Option<Vec<u8>> {
        self.outbox.pop_front()
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// When [`Session::handle_timeout`] next has something to do.
    pub fn poll_timeout(&self) -> Option<Instant> {
        self.pause_deadline
    }

    // --- state ---

    /// Frames that failed their tag and were dropped. A healthy transfer sees
    /// zero, and a non-zero count beside one that completed is the evidence
    /// that something else is putting packets into the room.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Plaintext handed out in [`Event::Write`] and not yet written.
    pub fn pending(&self) -> u64 {
        self.pending
    }

    /// Frames the transport holds for this session and has not handed to
    /// [`Session::handle_frame`] yet, in bytes. Counted toward the pause with
    /// [`Session::pending`], because a queue in front of this session is a
    /// backlog too: receiver.js counts a frame at arrival, before it is
    /// decrypted, for exactly that reason. Counting only what has been
    /// opened lets a receiver whose decryption falls behind the channel hold
    /// an unbounded queue that the pause never hears about. Measured in the
    /// session's slow-sink test, where on a two-core runner the queue took
    /// the backlog to 8.4 MB against a 4 MiB pause.
    ///
    /// Set before each frame is handed in, and whenever the queue grows.
    pub fn set_queued(&mut self, bytes: u64) {
        self.queued = bytes;
        self.consider_pause();
    }

    /// Every chunk of the outgoing file is sealed and queued, and the
    /// receiver's `done` is all that is left to wait for.
    pub fn awaiting_done(&self) -> bool {
        self.outgoing
            .as_ref()
            .is_some_and(|o| o.state == Out::AwaitingDone)
    }

    /// A file is being received into an open sink.
    pub fn busy(&self) -> bool {
        matches!(
            self.incoming,
            Incoming::Receiving(_) | Incoming::Closing { .. }
        )
    }

    pub fn ended(&self) -> bool {
        self.halted
    }

    /// The first failure, which is the one reported.
    pub fn failure(&self) -> Option<&Error> {
        self.failure.as_ref()
    }

    // --- inputs from the transport ---

    /// Every inbound frame from the paired peer goes here, in channel order.
    /// The peer filter and the early-frame hold are the room's job, before it.
    pub fn handle_frame(&mut self, frame: &[u8], now: Instant) {
        if self.halted {
            return;
        }
        if matches!(self.incoming, Incoming::Closing { .. }) {
            self.deferred.push_back(frame.to_vec());
            return;
        }
        self.process(frame, now);
    }

    /// The peer left the room. Ends whatever was in flight as a disconnect,
    /// and ends the session either way.
    pub fn peer_left(&mut self) {
        if self.halted {
            return;
        }
        if self.outgoing.is_some() || !matches!(self.incoming, Incoming::Idle) {
            self.fail(Error::PeerDisconnected, false);
        } else {
            self.halted = true;
        }
    }

    pub fn handle_timeout(&mut self, now: Instant) {
        if self.pause_deadline.is_some_and(|d| now >= d) {
            self.fail(Error::PauseTimeout, false);
        }
    }

    // --- inputs from the person and the driver ---

    /// The person pressed Cancel. Aborts a file being received and tells the
    /// peer nothing: it learns from the room closing, which is what the driver
    /// does next. Idempotent.
    pub fn cancel(&mut self) {
        if self.halted {
            return;
        }
        self.halted = true;
        if self.busy() {
            self.events.push_back(Event::AbortSink);
        }
        self.incoming = Incoming::Idle;
        self.outgoing = None;
        self.pause_deadline = None;
    }

    /// Something local went wrong that the peer should hear about.
    pub fn abort(&mut self, reason: &str) {
        self.fail(Error::Sink(reason.to_owned()), true);
    }

    /// Tells the peer which route this side observed. Sealed like everything
    /// else: a forged `local` would suppress the warning that a transfer is
    /// about to cost someone money.
    pub fn send_path(&mut self, path: NetworkPath) -> Result<(), UsageError> {
        self.send_advisory(Control::Path { path })
    }

    /// The sender's first word on the LAN path, after its SAS confirm; the
    /// receiver's only in reply, ahead of its Accept.
    pub fn send_lan_hello(&mut self, listen: LanListen) -> Result<(), UsageError> {
        self.send_advisory(Control::LanHello { listen })
    }

    pub fn send_lan_offer(
        &mut self,
        addrs: Vec<String>,
        port: u16,
        token: String,
        answer: Option<String>,
    ) -> Result<(), UsageError> {
        self.send_advisory(Control::LanOffer {
            addrs,
            port: u64::from(port),
            token,
            answer,
        })
    }

    /// The QUIC path's hello, at `lan-hello`'s moments.
    pub fn send_quic_hello(&mut self) -> Result<(), UsageError> {
        self.send_advisory(Control::QuicHello)
    }

    pub fn send_quic_offer(&mut self, addrs: Vec<String>, fp: String) -> Result<(), UsageError> {
        self.send_advisory(Control::QuicOffer { addrs, fp })
    }

    fn send_advisory(&mut self, msg: Control) -> Result<(), UsageError> {
        if self.halted {
            return Err(UsageError::Ended);
        }
        self.send_control(msg);
        Ok(())
    }

    // --- receiving ---

    /// The person accepted and the sink is open. If this returns
    /// [`UsageError::Ended`], the receive ended while the sink was opening:
    /// release it rather than write into it.
    pub fn accept(&mut self) -> Result<(), UsageError> {
        if self.halted {
            return Err(UsageError::Ended);
        }
        let Incoming::Offered(manifest) = std::mem::replace(&mut self.incoming, Incoming::Idle)
        else {
            return Err(UsageError::NoOffer);
        };
        let seq = manifest.seq;
        self.incoming = Incoming::Receiving(Active {
            manifest,
            expected: 0,
            digest: Chain::new(),
            received: 0,
        });
        self.send_control(Control::Accept { seq });
        Ok(())
    }

    /// The person declined, or dismissed the save dialog.
    pub fn decline(&mut self) -> Result<(), UsageError> {
        if self.halted {
            return Err(UsageError::Ended);
        }
        let Incoming::Offered(manifest) = std::mem::replace(&mut self.incoming, Incoming::Idle)
        else {
            return Err(UsageError::NoOffer);
        };
        self.send_control(Control::Decline { seq: manifest.seq });
        Ok(())
    }

    /// The sink could not be opened. The peer hears why, and the session ends.
    pub fn accept_failed(&mut self, reason: &str) {
        self.fail(Error::Sink(reason.to_owned()), true);
    }

    /// `bytes` of [`Event::Write`] plaintext are through the sink.
    pub fn write_done(&mut self, bytes: u64) {
        self.pending = self.pending.saturating_sub(bytes);
        if !self.halted && self.told_paused && self.pending + self.queued <= RESUME_AT {
            self.told_paused = false;
            self.send_control(Control::Resume);
        }
    }

    /// The sink is closed after [`Event::Complete`]. Sends `done`.
    pub fn file_closed(&mut self, now: Instant) -> Result<(), UsageError> {
        if self.halted {
            return Err(UsageError::Ended);
        }
        let Incoming::Closing { seq, size, digest } =
            std::mem::replace(&mut self.incoming, Incoming::Idle)
        else {
            return Err(UsageError::NotClosing);
        };
        self.send_control(Control::Done { seq });
        self.events.push_back(Event::Received { seq, size, digest });
        while !self.halted && !matches!(self.incoming, Incoming::Closing { .. }) {
            let Some(frame) = self.deferred.pop_front() else {
                break;
            };
            self.process(&frame, now);
        }
        Ok(())
    }

    // --- sending ---

    /// Sends a file's manifest. Call only once the person has confirmed the
    /// SAS -- which a [`Session`] existing already proves -- and after the
    /// relay size cap, which is the driver's. Returns the file's seq.
    pub fn send_file(&mut self, offer: FileOffer) -> Result<u32, UsageError> {
        if self.halted {
            return Err(UsageError::Ended);
        }
        if self.outgoing.is_some() {
            return Err(UsageError::Busy);
        }
        let seq = self.next_file_seq;
        assert!(seq != CONTROL_SEQ, "file sequence numbers exhausted");
        self.next_file_seq += 1;
        let chunks = chunk_count(offer.size);
        let mime = if offer.mime.is_empty() {
            DEFAULT_MIME.to_owned()
        } else {
            offer.mime
        };
        self.send_control(Control::Manifest(Manifest {
            seq,
            name: offer.name,
            size: offer.size,
            mime,
            chunks,
        }));
        self.outgoing = Some(Outgoing {
            seq,
            size: offer.size,
            chunks,
            state: Out::AwaitingReply,
            digest: Chain::new(),
            sent: 0,
        });
        self.advance_outgoing();
        Ok(seq)
    }

    /// After [`Event::SendAccepted`], once the driver has done what it does
    /// at Accept. Chunks are wanted from here.
    pub fn start_chunks(&mut self, now: Instant) -> Result<(), UsageError> {
        if self.halted {
            return Err(UsageError::Ended);
        }
        match &mut self.outgoing {
            Some(out) if out.state == Out::Accepted => out.state = Out::Streaming { next: 0 },
            _ => return Err(UsageError::NotAccepted),
        }
        self.arm_pause(now);
        Ok(())
    }

    /// The chunk the sender wants next, or `None` while there is none: before
    /// [`Session::start_chunks`], after the last, and while the peer has asked
    /// us to pause. The driver also holds off while its own channel is over its
    /// high-water mark; that buffer is the transport's, not ours.
    pub fn chunk_wanted(&self) -> Option<ChunkRequest> {
        if self.halted || self.peer_paused {
            return None;
        }
        self.streaming_request()
    }

    /// The bytes [`Session::chunk_wanted`] asked for. Seals and queues the
    /// chunk, and after the last one queues `complete`.
    pub fn send_chunk(&mut self, data: &[u8]) -> Result<(), UsageError> {
        if self.halted {
            return Err(UsageError::Ended);
        }
        let Some(want) = self.streaming_request() else {
            return Err(UsageError::NotStreaming);
        };
        if data.len() != want.len {
            self.fail(Error::SourceChanged, false);
            return Err(UsageError::WrongLength {
                expected: want.len,
                got: data.len(),
            });
        }
        let out = self
            .outgoing
            .as_mut()
            .expect("streaming implies an outgoing file");
        let last = want.index + 1 == out.chunks;
        out.digest.update(data);
        out.sent += data.len() as u64;
        let header = Header {
            kind: TYPE_CHUNK,
            file_seq: out.seq,
            index: want.index,
            last,
        };
        self.outbox.push_back(seal(&self.send, &header, data));
        self.events.push_back(Event::SendProgress {
            sent: out.sent,
            total: out.size,
            chunk: want.index + 1,
            chunks: out.chunks,
        });
        if !last {
            out.state = Out::Streaming {
                next: want.index + 1,
            };
            return Ok(());
        }
        out.state = Out::AwaitingDone;
        let complete = Control::Complete {
            seq: out.seq,
            chunks: out.chunks,
            digest: out.digest.hex(),
        };
        self.pause_deadline = None;
        self.send_control(complete);
        self.advance_outgoing();
        Ok(())
    }

    /// [`Session::chunk_wanted`] without the pause: a chunk the driver read
    /// before a pause arrived may still go out.
    fn streaming_request(&self) -> Option<ChunkRequest> {
        let out = self.outgoing.as_ref()?;
        let Out::Streaming { next } = out.state else {
            return None;
        };
        let offset = next * CHUNK_SIZE as u64;
        let len = (out.size - offset).min(CHUNK_SIZE as u64) as usize;
        Some(ChunkRequest {
            file_seq: out.seq,
            index: next,
            offset,
            len,
        })
    }

    // --- internals ---

    fn send_control(&mut self, msg: Control) {
        let frame = seal_control(&self.send, self.control_out, &msg);
        self.control_out += 1;
        self.outbox.push_back(frame);
    }

    fn process(&mut self, frame: &[u8], now: Instant) {
        match self.process_frame(frame, now) {
            Ok(()) => {}
            // Not from the peer we paired with: the header is the AAD, so
            // nobody without the key makes one that opens. Dropping is the
            // only defensible answer, and deliberately with no "give up after
            // N" -- that threshold is a denial of service in two lines. A
            // dropped frame that mattered resurfaces anyway, as a count, size
            // or digest mismatch at `complete`, or as a reply that never comes.
            Err(Error::Frame(FrameError::Unauthenticated)) => self.dropped += 1,
            Err(e) => self.fail(e, true),
        }
    }

    fn process_frame(&mut self, frame: &[u8], now: Instant) -> Result<(), Error> {
        if frame.len() < HEADER_BYTES {
            return Err(Error::Runt);
        }
        if frame[0] != TYPE_CONTROL {
            return self.handle_chunk(frame);
        }
        let opened = open_control(&self.recv, frame, self.control_in).map_err(Error::Frame)?;
        let msg = Control::parse(&opened.plaintext).map_err(|m| Error::Malformed(m.0))?;
        self.control_in += 1;

        match msg {
            // Advisory: each describes the connection, answers no request, and
            // never reaches the reply queue, where a wait would hold it.
            Control::Path { path } => self.events.push_back(Event::PeerPath(path)),
            Control::Pause => {
                self.peer_paused = true;
                self.arm_pause(now);
            }
            Control::Resume => {
                self.peer_paused = false;
                self.pause_deadline = None;
            }
            Control::LanHello { listen } => self.events.push_back(Event::PeerLanHello(listen)),
            Control::LanOffer {
                addrs,
                port,
                token,
                answer,
            } => {
                self.events.push_back(Event::PeerLanOffer {
                    addrs,
                    port,
                    token,
                    answer,
                });
            }
            Control::QuicHello => self.events.push_back(Event::PeerQuicHello),
            Control::QuicOffer { addrs, fp } => {
                self.events.push_back(Event::PeerQuicOffer { addrs, fp });
            }
            reply @ (Control::Accept { .. }
            | Control::Decline { .. }
            | Control::Done { .. }
            | Control::Error { .. }) => {
                self.replies.push_back(reply);
                self.advance_outgoing();
            }
            Control::Manifest(manifest) => self.handle_manifest(manifest)?,
            Control::Complete {
                seq,
                chunks,
                digest,
            } => self.handle_complete(seq, chunks, digest)?,
            Control::Unknown => {}
        }
        Ok(())
    }

    fn arm_pause(&mut self, now: Instant) {
        let streaming =
            matches!(&self.outgoing, Some(o) if matches!(o.state, Out::Streaming { .. }));
        if self.peer_paused && streaming && self.pause_deadline.is_none() {
            self.pause_deadline = Some(now + PAUSE_TIMEOUT);
        }
    }

    /// Matches buffered replies against what the sender is waiting for, as
    /// the JS control stream's `next()` does: by type and seq, except that
    /// `error` matches any seq, because a failing peer may not know which file
    /// it was failing.
    fn advance_outgoing(&mut self) {
        let Some(out) = &self.outgoing else { return };
        let (seq, state) = (out.seq, out.state);
        let wants = |m: &Control| match (state, m) {
            (_, Control::Error { .. }) => matches!(state, Out::AwaitingReply | Out::AwaitingDone),
            (Out::AwaitingReply, Control::Accept { .. } | Control::Decline { .. }) => {
                m.seq() == Some(seq)
            }
            (Out::AwaitingDone, Control::Done { .. }) => m.seq() == Some(seq),
            _ => false,
        };
        let Some(at) = self.replies.iter().position(wants) else {
            return;
        };
        let reply = self.replies.remove(at).expect("position is in range");
        match reply {
            Control::Accept { .. } => {
                self.outgoing.as_mut().expect("checked above").state = Out::Accepted;
                self.events.push_back(Event::SendAccepted { seq });
            }
            Control::Decline { .. } => {
                self.outgoing = None;
                self.events.push_back(Event::SendDeclined { seq });
            }
            Control::Done { .. } => {
                let out = self.outgoing.take().expect("checked above");
                self.events.push_back(Event::Sent {
                    seq,
                    digest: out.digest.hex(),
                });
            }
            Control::Error { message, .. } if state == Out::AwaitingReply => {
                self.fail(Error::PeerRefused(message), false);
            }
            Control::Error { message, .. } => {
                self.fail(Error::PeerCouldNotComplete(message), false)
            }
            _ => unreachable!("only replies are buffered"),
        }
    }

    fn handle_manifest(&mut self, manifest: Manifest) -> Result<(), Error> {
        // Stricter than the JS, which checks only for an accepted file: a
        // second manifest before the first is answered is something no
        // sender does, since every one waits for its reply.
        if !matches!(self.incoming, Incoming::Idle) {
            return Err(Error::OfferWhileBusy);
        }
        self.incoming = Incoming::Offered(manifest.clone());
        self.events.push_back(Event::Offer(manifest));
        Ok(())
    }

    fn handle_chunk(&mut self, frame: &[u8]) -> Result<(), Error> {
        let Incoming::Receiving(active) = &mut self.incoming else {
            // Opened with no expectation only to ask whether this is our
            // peer. A stranger's fails the tag and is dropped; our peer
            // sending chunks for a file we never accepted is a real violation.
            open(&self.recv, frame, None).map_err(Error::Frame)?;
            return Err(Error::ChunkWithoutFile);
        };
        let opened = open(
            &self.recv,
            frame,
            Some(Expect::chunk(active.manifest.seq, active.expected)),
        )
        .map_err(Error::Frame)?;
        let len = opened.plaintext.len() as u64;
        // Checked before the bytes are handed out, where the JS writes them
        // first and throws after: the failure is the same, and the excess
        // never reaches the file.
        if active.received + len > active.manifest.size {
            return Err(Error::ExcessData);
        }
        active.digest.update(&opened.plaintext);
        active.expected += 1;
        active.received += len;
        if opened.header.last && active.expected != active.manifest.chunks {
            return Err(Error::LastAtWrongChunk);
        }
        let progress = Event::ReceiveProgress {
            received: active.received,
            total: active.manifest.size,
            chunk: active.expected,
            chunks: active.manifest.chunks,
        };
        self.pending += len;
        self.events.push_back(Event::Write(opened.plaintext));
        self.events.push_back(progress);
        self.consider_pause();
        Ok(())
    }

    /// Asks the peer to pause once the backlog -- written-but-unflushed and
    /// queued-but-unopened together -- reaches [`PAUSE_AT`], while a file is
    /// coming in. Once per pause: [`Session::write_done`] resumes.
    fn consider_pause(&mut self) {
        if self.halted || self.told_paused || !matches!(self.incoming, Incoming::Receiving(_)) {
            return;
        }
        if self.pending + self.queued >= PAUSE_AT {
            self.told_paused = true;
            self.send_control(Control::Pause);
        }
    }

    fn handle_complete(&mut self, seq: u32, chunks: u64, digest: String) -> Result<(), Error> {
        let Incoming::Receiving(active) = &self.incoming else {
            return Err(Error::UnexpectedCompletion);
        };
        if active.manifest.seq != seq {
            return Err(Error::UnexpectedCompletion);
        }
        // Three independent ways a short or altered file is caught.
        if active.expected != chunks {
            return Err(Error::ChunkCountMismatch);
        }
        if active.received != active.manifest.size {
            return Err(Error::SizeMismatch);
        }
        if !equal_hex(&active.digest.hex(), &digest) {
            return Err(Error::DigestMismatch);
        }
        let size = active.received;
        self.incoming = Incoming::Closing { seq, size, digest };
        self.events.push_back(Event::Complete { seq });
        Ok(())
    }

    /// The first failure ends the session; later ones say nothing, because
    /// what follows a real failure is usually its echo. `notify` tells the
    /// peer first, so a sender is not left waiting on a `done` from a receiver
    /// that has already torn down -- a silent receiver looks exactly like a
    /// slow one.
    fn fail(&mut self, error: Error, notify: bool) {
        if self.halted {
            return;
        }
        self.halted = true;
        let seq = match &self.incoming {
            Incoming::Offered(m) => Some(m.seq),
            Incoming::Receiving(a) => Some(a.manifest.seq),
            Incoming::Closing { seq, .. } => Some(*seq),
            Incoming::Idle => None,
        };
        if self.busy() {
            self.events.push_back(Event::AbortSink);
        }
        self.incoming = Incoming::Idle;
        self.outgoing = None;
        self.pause_deadline = None;
        if notify {
            self.send_control(Control::error(seq.unwrap_or(0), &error.to_string()));
        }
        self.failure = Some(error.clone());
        self.events.push_back(Event::Failed(error));
    }
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
