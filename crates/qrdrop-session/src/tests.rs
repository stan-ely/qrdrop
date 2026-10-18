//! The run loop on an in-memory link, as `test/helpers/fake-network.mjs`
//! runs the JS: two confirmed sessions whose frames go straight into each
//! other's inbound channel, in order, with no room in between. What these
//! port is the behaviour of `test/transfer.test.mjs` and
//! `backpressure.test.mjs`; the room itself is tests/session.rs's.

use std::io;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use qrdrop_protocol::{CHUNK_SIZE, Keypair, NetworkPath, PAUSE_AT, Role, Secret};
use tokio::time::timeout;

use crate::io::{Sink, Source};
use crate::session::{
    Ctl, Inbox, Link, LinkIn, MEMORY_WINDOW, OUT_HIGH, READ_AHEAD, Route, SessionEvent,
    SessionEvents, SessionHandle, SessionOptions, inbox, start,
};

const WAIT: Duration = Duration::from_secs(20);

type Side = (SessionHandle, SessionEvents);

/// Two sessions on one secret, joined in memory. Each side's inbound sender
/// is returned too, so a test can put a frame or a leave in the other's way.
fn pair() -> (Side, Side, Inbox, Inbox) {
    let secret = Secret::generate();
    let (a, b) = (Keypair::generate(), Keypair::generate());
    let (ap, bp) = (a.public_key().to_vec(), b.public_key().to_vec());
    let host = a.establish(&bp, &secret, Role::Host).unwrap();
    let guest = b.establish(&ap, &secret, Role::Guest).unwrap();
    assert_eq!(host.sas(), guest.sas());
    let (a_tx, a_rx) = inbox();
    let (b_tx, b_rx) = inbox();
    let link = |to: &Inbox, own: Inbox, rx| Link {
        route: Route::Memory(to.clone()),
        ctl: Ctl::Memory(to.clone()),
        link_tx: own,
        link_rx: rx,
    };
    let opts = SessionOptions::default();
    let h = start(
        host.confirm(),
        Role::Host,
        opts.clone(),
        link(&b_tx, a_tx.clone(), a_rx),
    );
    let g = start(
        guest.confirm(),
        Role::Guest,
        opts,
        link(&a_tx, b_tx.clone(), b_rx),
    );
    (h, g, a_tx, b_tx)
}

struct Bytes {
    name: String,
    data: Vec<u8>,
    at: usize,
    /// Bytes read so far, for a test that measures a backlog as it forms.
    read: Arc<AtomicU64>,
}

impl Source for Bytes {
    fn name(&self) -> &str {
        &self.name
    }
    fn size(&self) -> u64 {
        self.data.len() as u64
    }
    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        let end = self.at + buf.len();
        let src = self
            .data
            .get(self.at..end)
            .ok_or(io::ErrorKind::UnexpectedEof)?;
        buf.copy_from_slice(src);
        self.at = end;
        self.read.fetch_add(buf.len() as u64, Ordering::Relaxed);
        Ok(())
    }
}

fn source(len: usize) -> Box<Bytes> {
    Box::new(Bytes {
        name: "report.bin".into(),
        data: (0..len).map(|i| (i % 251) as u8).collect(),
        at: 0,
        read: Arc::default(),
    })
}

/// What a test sink saw: its bytes, and whether it was closed or aborted.
#[derive(Default)]
struct Seen {
    data: Mutex<Vec<u8>>,
    closed: AtomicUsize,
    aborted: AtomicUsize,
}

struct Recording {
    seen: Arc<Seen>,
    delay: Duration,
    written: Arc<AtomicU64>,
    /// When set, the source's read count: each write records how far the
    /// reads are ahead of the writes, on this thread and at this moment, so
    /// neither figure is a stale copy of the other.
    ahead: Option<(Arc<AtomicU64>, Arc<AtomicU64>)>,
}

impl Sink for Recording {
    fn write(&mut self, data: &[u8]) -> io::Result<()> {
        if let Some((read, worst)) = &self.ahead {
            let behind = read.load(Ordering::Relaxed) - self.written.load(Ordering::Relaxed);
            worst.fetch_max(behind, Ordering::Relaxed);
        }
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        self.seen.data.lock().unwrap().extend_from_slice(data);
        self.written.fetch_add(data.len() as u64, Ordering::Relaxed);
        Ok(())
    }
    fn close(self: Box<Self>) -> io::Result<String> {
        self.seen.closed.fetch_add(1, Ordering::Relaxed);
        Ok("memory".into())
    }
    fn abort(self: Box<Self>) {
        self.seen.aborted.fetch_add(1, Ordering::Relaxed);
    }
}

fn sink(delay: Duration) -> (Box<Recording>, Arc<Seen>, Arc<AtomicU64>) {
    let seen = Arc::new(Seen::default());
    let written = Arc::new(AtomicU64::new(0));
    (
        Box::new(Recording {
            seen: seen.clone(),
            delay,
            written: written.clone(),
            ahead: None,
        }),
        seen,
        written,
    )
}

async fn until(
    ev: &mut SessionEvents,
    mut want: impl FnMut(&SessionEvent) -> bool,
) -> SessionEvent {
    timeout(WAIT, async {
        loop {
            let e = ev.next().await.expect("the session ended");
            if want(&e) {
                return e;
            }
        }
    })
    .await
    .expect("timed out")
}

#[tokio::test]
async fn a_file_crosses_whole_and_both_ends_agree_on_its_digest() {
    let ((h, mut he), (g, mut ge), ..) = pair();
    let len = 3 * 16_318 + 77;
    h.send_file(source(len));
    let SessionEvent::Offer(m) = until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await
    else {
        unreachable!()
    };
    assert_eq!(
        (m.name.as_str(), m.size, m.chunks),
        ("report.bin", len as u64, 4)
    );
    let (s, seen, _) = sink(Duration::ZERO);
    g.accept(s);
    let SessionEvent::Sent { digest: sent } =
        until(&mut he, |e| matches!(e, SessionEvent::Sent { .. })).await
    else {
        unreachable!()
    };
    let SessionEvent::Received {
        digest,
        size,
        name,
        location,
    } = until(&mut ge, |e| matches!(e, SessionEvent::Received { .. })).await
    else {
        unreachable!()
    };
    assert_eq!(
        (digest, size, name.as_str(), location.as_str()),
        (sent, len as u64, "report.bin", "memory")
    );
    assert_eq!(*seen.data.lock().unwrap(), source(len).data);
    assert_eq!(seen.closed.load(Ordering::Relaxed), 1);
    h.close().await;
    g.close().await;
}

#[tokio::test]
async fn an_empty_file_is_one_empty_chunk() {
    let ((h, mut he), (g, mut ge), ..) = pair();
    h.send_file(source(0));
    until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await;
    let (s, seen, _) = sink(Duration::ZERO);
    g.accept(s);
    until(&mut he, |e| matches!(e, SessionEvent::Sent { .. })).await;
    until(&mut ge, |e| {
        matches!(e, SessionEvent::Received { size: 0, .. })
    })
    .await;
    assert_eq!(seen.closed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_decline_reaches_the_sender_and_nothing_is_written() {
    let ((h, mut he), (g, mut ge), ..) = pair();
    h.send_file(source(1000));
    until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await;
    g.decline();
    until(&mut he, |e| matches!(e, SessionEvent::Declined)).await;
}

/// No path in memory: both sides say unknown, and say it rather than guess.
#[tokio::test]
async fn with_no_pair_to_read_the_path_is_unknown() {
    let ((h, mut he), ..) = pair();
    assert_eq!(h.path().await, NetworkPath::Unknown);
    let e = until(&mut he, |e| matches!(e, SessionEvent::Path { .. })).await;
    assert!(
        matches!(
            e,
            SessionEvent::Path {
                combined: NetworkPath::Unknown,
                ..
            }
        ),
        "{e:?}"
    );
}

/// The leave lands right behind the `done`, in one breath. The JS reported
/// this finished transfer as a disconnect for months (CLAUDE.md, "Known-flaky
/// and known-broken"); here the two are one channel and handled in order.
#[tokio::test]
async fn a_leave_right_behind_the_done_is_not_a_disconnect() {
    let ((h, mut he), (g, mut ge), a_in, _) = pair();
    h.send_file(source(40_000));
    until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await;
    let (s, _, _) = sink(Duration::ZERO);
    g.accept(s);
    until(&mut ge, |e| matches!(e, SessionEvent::Received { .. })).await;
    // The receiver leaving the moment it has the file, as the CLI does. The
    // Left goes straight to the peer and the done through the writer, so
    // what orders them is `shut` waiting for the writer to flush; without
    // that, only scheduling did. (Measured: removing the flush does not fail
    // this, even over a hundred rounds on four threads -- the window is two
    // channel hops wide -- so the order is kept by construction, not by a
    // test that can see it go.)
    g.close().await;
    let _ = a_in;
    let e = until(&mut he, |e| {
        matches!(e, SessionEvent::Sent { .. } | SessionEvent::Failed(_))
    })
    .await;
    assert!(matches!(e, SessionEvent::Sent { .. }), "{e:?}");
}

#[tokio::test]
async fn a_sender_leaving_mid_file_fails_the_receive_and_deletes_the_partial() {
    let ((h, _he), (g, mut ge), ..) = pair();
    // Large enough that it cannot all arrive before the leave: the memory
    // link is as fast as memory, and flow control holds it to about 4 MiB.
    h.send_file(source(32 * 1024 * 1024));
    until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await;
    let (s, seen, _) = sink(Duration::from_millis(1));
    g.accept(s);
    until(&mut ge, |e| {
        matches!(e, SessionEvent::ReceiveProgress { .. })
    })
    .await;
    h.close().await;
    let e = until(&mut ge, |e| matches!(e, SessionEvent::Failed(_))).await;
    assert_eq!(
        e,
        SessionEvent::Failed(qrdrop_protocol::PEER_DISCONNECTED.into())
    );
    // The sink thread aborts on the next command it reads.
    timeout(WAIT, async {
        while seen.aborted.load(Ordering::Relaxed) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the partial file was not aborted");
    assert_eq!(seen.closed.load(Ordering::Relaxed), 0);
}

/// A frame from nowhere -- the wrong key, as a stranger's would be -- is
/// dropped and the transfer goes on.
#[tokio::test]
async fn a_frame_that_fails_its_tag_is_dropped_not_fatal() {
    let ((h, mut he), (g, mut ge), _, b_in) = pair();
    b_in.send(LinkIn::Frame(vec![0u8; 64])).unwrap();
    // Long enough to be a frame: a runt is a different failure, and from the
    // paired peer a fatal one, as in the JS.
    b_in.send(LinkIn::Frame(vec![1u8; 100])).unwrap();
    h.send_file(source(20_000));
    until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await;
    let (s, _, _) = sink(Duration::ZERO);
    g.accept(s);
    until(&mut he, |e| matches!(e, SessionEvent::Sent { .. })).await;
    until(&mut ge, |e| matches!(e, SessionEvent::Received { .. })).await;
}

/// The slow sink: 32 MiB into a sink that takes half a millisecond per
/// frame. Without flow control the receiver's backlog is most of the file;
/// with it, the sender pauses at 4 MiB written-but-unflushed.
///
/// The backlog is measured as the source's reads ahead of the sink's writes,
/// sampled in the sink as each write starts. It used to be a `SendProgress`
/// event's figure less the sink's count when the test read the event, which
/// pairs a stale number with a current one: when the test fell behind, the
/// sink had overtaken the event and the subtraction overflowed. The bound
/// is the pause plus everything that can sit between the source and the
/// sink when it lands -- the read-ahead, the writer's queue, the memory
/// link's window -- and a megabyte of slack for the pause's own trip.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_sink_holds_the_sender_back() {
    let ((h, mut he), (g, mut ge), ..) = pair();
    let len = 32 * 1024 * 1024;
    let src = source(len);
    let read = src.read.clone();
    h.send_file(src);
    until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await;
    let (mut s, _, _) = sink(Duration::from_micros(500));
    let worst = Arc::new(AtomicU64::new(0));
    s.ahead = Some((read, worst.clone()));
    g.accept(s);
    loop {
        let e = timeout(Duration::from_secs(60), he.next())
            .await
            .expect("stalled")
            .expect("ended");
        match e {
            SessionEvent::Sent { .. } => break,
            SessionEvent::Failed(f) => panic!("{f}"),
            _ => {}
        }
    }
    until(&mut ge, |e| matches!(e, SessionEvent::Received { .. })).await;
    let in_between = (READ_AHEAD * CHUNK_SIZE + OUT_HIGH) as u64 + MEMORY_WINDOW;
    let worst = worst.load(Ordering::Relaxed);
    assert!(
        worst < PAUSE_AT + in_between + 1024 * 1024,
        "backlog reached {worst}"
    );
}

/// Accept after the sender has gone: the sink is released, never written.
#[tokio::test]
async fn an_accept_after_the_session_ended_aborts_the_sink() {
    let ((h, _he), (g, mut ge), ..) = pair();
    h.send_file(source(1000));
    until(&mut ge, |e| matches!(e, SessionEvent::Offer(_))).await;
    h.close().await;
    until(&mut ge, |e| matches!(e, SessionEvent::Failed(_))).await;
    let (s, seen, _) = sink(Duration::ZERO);
    g.accept(s);
    timeout(WAIT, async {
        while seen.aborted.load(Ordering::Relaxed) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the sink was kept");
}
