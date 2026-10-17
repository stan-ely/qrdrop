//! The transfer state machines between two real sessions. Ports
//! test/transfer, control-stream, control-order and backpressure: what each JS
//! test asserted, here, wherever the property survives the move to sans-IO.
//! Where it became structural, the test says so and checks the structure.

use std::time::{Duration, Instant};

use super::*;
use crate::code::Secret;
use crate::frame::{CHUNK_SIZE, Expect, FrameKey, Header, TYPE_CHUNK, TYPE_CONTROL, open, seal};
use crate::pairing::{Keypair, Role};

fn pair() -> (Session, Session) {
    let secret = Secret::generate();
    let (h, g) = (Keypair::generate(), Keypair::generate());
    let (hp, gp) = (*h.public_key(), *g.public_key());
    let host = h.establish(&gp, &secret, Role::Host).unwrap().confirm();
    let guest = g.establish(&hp, &secret, Role::Guest).unwrap().confirm();
    (host, guest)
}

fn bytes(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 7 + i / 251) as u8).collect()
}

fn offer(name: &str, size: usize) -> FileOffer {
    FileOffer {
        name: name.into(),
        size: size as u64,
        mime: String::new(),
    }
}

/// How a side's driver answers an offer.
#[derive(Clone)]
enum Answer {
    Accept,
    Decline,
    SinkFails(String),
    /// The person has not decided; the dialog is up.
    Hold,
}

/// One device: a session and a driver as simple as the JS tests' fakes. The
/// sink is a Vec; the source is a Vec; the person answers as told.
struct Side {
    s: Session,
    file: Vec<u8>,
    sink: Vec<u8>,
    log: Vec<Event>,
    answer: Answer,
    /// Report writes at once. Off is a sink that has stalled.
    auto_write: bool,
    /// Chunks per step: the transport's high-water mark, roughly.
    burst: usize,
}

impl Side {
    fn new(s: Session) -> Self {
        Side {
            s,
            file: vec![],
            sink: vec![],
            log: vec![],
            answer: Answer::Accept,
            auto_write: true,
            burst: usize::MAX,
        }
    }

    fn step(&mut self, now: Instant) -> bool {
        let mut did = false;
        while let Some(e) = self.s.poll_event() {
            did = true;
            self.log.push(e.clone());
            match e {
                Event::Offer(_) => match self.answer.clone() {
                    Answer::Accept => self.s.accept().unwrap(),
                    Answer::Decline => self.s.decline().unwrap(),
                    Answer::SinkFails(why) => self.s.accept_failed(&why),
                    Answer::Hold => {}
                },
                Event::Write(b) => {
                    self.sink.extend_from_slice(&b);
                    if self.auto_write {
                        self.s.write_done(b.len() as u64);
                    }
                }
                Event::Complete { .. } => self.s.file_closed(now).unwrap(),
                Event::SendAccepted { .. } => self.s.start_chunks(now).unwrap(),
                _ => {}
            }
        }
        for _ in 0..self.burst {
            let Some(want) = self.s.chunk_wanted() else {
                break;
            };
            let at = want.offset as usize;
            let data = self.file[at..at + want.len].to_vec();
            self.s.send_chunk(&data).unwrap();
            did = true;
        }
        did
    }

    fn failures(&self) -> Vec<&Error> {
        self.log
            .iter()
            .filter_map(|e| {
                if let Event::Failed(e) = e {
                    Some(e)
                } else {
                    None
                }
            })
            .collect()
    }

    fn has(&self, f: impl Fn(&Event) -> bool) -> bool {
        self.log.iter().any(f)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dir {
    HostToGuest,
    GuestToHost,
}

/// Runs both sides and the wire between them until nothing moves. `wire` sees
/// every frame and returns what actually arrives in its place.
fn run(
    a: &mut Side,
    b: &mut Side,
    now: Instant,
    mut wire: impl FnMut(Dir, Vec<u8>) -> Vec<Vec<u8>>,
) {
    loop {
        let mut moved = a.step(now);
        while let Some(f) = a.s.poll_transmit() {
            moved = true;
            for f in wire(Dir::HostToGuest, f) {
                b.s.handle_frame(&f, now);
            }
        }
        moved |= b.step(now);
        while let Some(f) = b.s.poll_transmit() {
            moved = true;
            for f in wire(Dir::GuestToHost, f) {
                a.s.handle_frame(&f, now);
            }
        }
        if !moved {
            return;
        }
    }
}

fn clean(_: Dir, f: Vec<u8>) -> Vec<Vec<u8>> {
    vec![f]
}

/// The host sends `file` to the guest.
fn transfer(file: Vec<u8>, name: &str) -> (Side, Side) {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer(name, file.len())).unwrap();
    host.file = file;
    run(&mut host, &mut guest, Instant::now(), clean);
    (host, guest)
}

fn sealed_by(peer: &Session, header: Header, plaintext: &[u8]) -> Vec<u8> {
    seal(&peer.send, &header, plaintext)
}

fn chunk_header(index: u64, last: bool) -> Header {
    Header {
        kind: TYPE_CHUNK,
        file_seq: 0,
        index,
        last,
    }
}

// --- test/transfer ---

#[test]
fn a_small_file_arrives_byte_identical() {
    let file = bytes(1000);
    let (host, guest) = transfer(file.clone(), "a.bin");
    assert_eq!(guest.sink, file);
    assert!(host.has(|e| matches!(e, Event::Sent { .. })));
    let digest = |s: &Side| {
        s.log.iter().find_map(|e| match e {
            Event::Sent { digest, .. } | Event::Received { digest, .. } => Some(digest.clone()),
            _ => None,
        })
    };
    assert_eq!(digest(&host), digest(&guest));
    assert!(host.failures().is_empty() && guest.failures().is_empty());
}

#[test]
fn files_spanning_exact_and_partial_chunk_boundaries_arrive_intact() {
    for size in [
        0,
        1,
        CHUNK_SIZE - 1,
        CHUNK_SIZE,
        CHUNK_SIZE + 1,
        3 * CHUNK_SIZE + 5,
    ] {
        let file = bytes(size);
        let (_, guest) = transfer(file.clone(), "b.bin");
        assert_eq!(guest.sink, file, "size {size}");
        assert!(
            guest.has(|e| matches!(e, Event::Received { size: s, .. } if *s == size as u64)),
            "size {size}"
        );
    }
}

#[test]
fn declining_means_no_file_bytes_are_ever_sent() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    guest.answer = Answer::Decline;
    host.s.send_file(offer("no.bin", 50_000)).unwrap();
    host.file = bytes(50_000);
    let mut chunks = 0;
    run(&mut host, &mut guest, Instant::now(), |d, f| {
        if d == Dir::HostToGuest && f[0] == TYPE_CHUNK {
            chunks += 1;
        }
        vec![f]
    });
    assert_eq!(chunks, 0);
    assert!(host.has(|e| matches!(e, Event::SendDeclined { seq: 0 })));
    assert!(host.failures().is_empty());
    // And the session is free for another file.
    assert_eq!(host.s.send_file(offer("next.bin", 1)), Ok(1));
}

#[test]
fn progress_is_monotonic_and_reaches_the_full_size() {
    let size = 5 * CHUNK_SIZE + 17;
    let (host, guest) = transfer(bytes(size), "p.bin");
    let sent: Vec<u64> = host
        .log
        .iter()
        .filter_map(|e| match e {
            Event::SendProgress { sent, .. } => Some(*sent),
            _ => None,
        })
        .collect();
    let got: Vec<u64> = guest
        .log
        .iter()
        .filter_map(|e| match e {
            Event::ReceiveProgress { received, .. } => Some(*received),
            _ => None,
        })
        .collect();
    for v in [&sent, &got] {
        assert!(v.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(v.last(), Some(&(size as u64)));
        assert_eq!(v.len(), 6);
    }
}

#[test]
fn the_manifest_survives_the_trip_intact() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    guest.answer = Answer::Hold;
    let o = FileOffer {
        name: "résumé 📄.pdf".into(),
        size: 50,
        mime: "application/pdf".into(),
    };
    host.s.send_file(o).unwrap();
    run(&mut host, &mut guest, Instant::now(), clean);
    let want = Manifest {
        seq: 0,
        name: "résumé 📄.pdf".into(),
        size: 50,
        mime: "application/pdf".into(),
        chunks: 1,
    };
    assert_eq!(guest.log, vec![Event::Offer(want)]);
}

#[test]
fn a_missing_mime_goes_out_as_octet_stream() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    guest.answer = Answer::Hold;
    host.s.send_file(offer("x", 1)).unwrap();
    run(&mut host, &mut guest, Instant::now(), clean);
    assert!(guest.has(|e| matches!(e, Event::Offer(m) if m.mime == DEFAULT_MIME)));
}

#[test]
fn a_corrupted_chunk_is_dropped_and_the_file_is_abandoned_at_complete() {
    // The flipped byte is ciphertext, so the frame fails its tag and is
    // dropped, not treated as a fault. The missing chunk cannot hide: it
    // resurfaces as a count mismatch when the sender claims completion.
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("c.bin", 100)).unwrap();
    host.file = bytes(100);
    run(&mut host, &mut guest, Instant::now(), |d, mut f| {
        if d == Dir::HostToGuest && f[0] == TYPE_CHUNK {
            f[20] ^= 0xff;
        }
        vec![f]
    });
    assert_eq!(guest.s.dropped(), 1);
    assert_eq!(guest.failures(), vec![&Error::ChunkCountMismatch]);
    assert!(guest.has(|e| *e == Event::AbortSink));
    assert!(!guest.has(|e| matches!(e, Event::Complete { .. } | Event::Received { .. })));
    // And the sender heard why rather than waiting on a done.
    assert_eq!(
        host.failures(),
        vec![&Error::PeerCouldNotComplete("Chunk count mismatch".into())]
    );
}

#[test]
fn a_foreign_frame_injected_mid_transfer_does_not_kill_it() {
    // The field report: "Out-of-order frame: expected 0, got 13877" on a file
    // of 64 chunks at most, refused on its cleartext header.
    let foreign = FrameKey::new(&[9; 32]);
    let stray = seal(&foreign, &chunk_header(13877, false), &bytes(64));
    let file = bytes(3 * CHUNK_SIZE);
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("wanted.bin", file.len())).unwrap();
    host.file = file.clone();
    run(&mut host, &mut guest, Instant::now(), |d, f| {
        if d == Dir::HostToGuest {
            vec![stray.clone(), f]
        } else {
            vec![f]
        }
    });
    assert!(guest.failures().is_empty() && host.failures().is_empty());
    assert_eq!(guest.sink, file);
    assert!(guest.s.dropped() >= 4);
}

#[test]
fn a_foreign_chunk_with_no_accepted_file_is_dropped_and_sends_nothing_back() {
    let (_, mut guest) = pair();
    let foreign = FrameKey::new(&[9; 32]);
    for index in 13877..13887 {
        guest.handle_frame(
            &seal(&foreign, &chunk_header(index, false), &bytes(64)),
            Instant::now(),
        );
    }
    assert_eq!(guest.dropped(), 10);
    assert_eq!(guest.poll_event(), None);
    assert_eq!(guest.poll_transmit(), None);
}

#[test]
fn our_own_peer_contradicting_itself_is_fatal_and_the_peer_is_told() {
    let (host, mut guest) = pair();
    guest.handle_frame(
        &sealed_by(&host, chunk_header(7, false), &bytes(64)),
        Instant::now(),
    );
    assert_eq!(guest.dropped(), 0, "an authenticated frame is never a drop");
    assert_eq!(
        guest.poll_event(),
        Some(Event::Failed(Error::ChunkWithoutFile))
    );
    let told = guest.poll_transmit().expect("an error frame");
    let opened = open(&host.recv, &told, Some(Expect::control(0))).unwrap();
    assert_eq!(
        Control::parse(&opened.plaintext),
        Ok(Control::Error {
            seq: 0,
            message: "Chunk arrived with no accepted file".into()
        })
    );
}

#[test]
fn a_replayed_chunk_is_out_of_order_and_fatal() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("r.bin", 2 * CHUNK_SIZE)).unwrap();
    host.file = bytes(2 * CHUNK_SIZE);
    run(&mut host, &mut guest, Instant::now(), |d, f| {
        if d == Dir::HostToGuest && f[0] == TYPE_CHUNK && f[12] == 0 {
            vec![f.clone(), f]
        } else {
            vec![f]
        }
    });
    assert_eq!(
        guest.failures(),
        vec![&Error::Frame(FrameError::Index {
            expected: 1,
            got: 0
        })]
    );
    assert!(guest.has(|e| *e == Event::AbortSink));
}

#[test]
fn a_sink_that_cannot_be_opened_fails_with_its_own_reason_not_as_a_dismissal() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    guest.answer = Answer::SinkFails("Saving failed: os error 2".into());
    host.s.send_file(offer("s.bin", 10)).unwrap();
    run(&mut host, &mut guest, Instant::now(), clean);
    assert_eq!(
        guest.failures(),
        vec![&Error::Sink("Saving failed: os error 2".into())]
    );
    assert!(!host.has(|e| matches!(e, Event::SendDeclined { .. })));
    assert_eq!(
        host.failures(),
        vec![&Error::PeerRefused("Saving failed: os error 2".into())]
    );
}

#[test]
fn after_the_first_failure_nothing_else_is_reported() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("f.bin", 4 * CHUNK_SIZE)).unwrap();
    host.file = bytes(4 * CHUNK_SIZE);
    // Every chunk sent twice: the first duplicate is fatal, and the many
    // authentic, out-of-order frames behind it must not each report again.
    run(&mut host, &mut guest, Instant::now(), |d, f| {
        if d == Dir::HostToGuest && f[0] == TYPE_CHUNK {
            vec![f.clone(), f]
        } else {
            vec![f]
        }
    });
    assert_eq!(guest.failures().len(), 1);
    let errors_sent = guest
        .log
        .iter()
        .filter(|e| matches!(e, Event::Failed(_)))
        .count();
    assert_eq!(errors_sent, 1);
    assert_eq!(host.failures().len(), 1);
}

#[test]
fn cancelling_a_receive_aborts_the_sink_and_nothing_after_it_is_reported() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("x.bin", 10 * CHUNK_SIZE)).unwrap();
    host.file = bytes(10 * CHUNK_SIZE);
    host.burst = 2;
    let now = Instant::now();
    // Run until the guest is a few chunks in, then cancel.
    for _ in 0..3 {
        host.step(now);
        while let Some(f) = host.s.poll_transmit() {
            guest.s.handle_frame(&f, now);
        }
        guest.step(now);
        while let Some(f) = guest.s.poll_transmit() {
            host.s.handle_frame(&f, now);
        }
    }
    assert!(guest.s.busy());
    let before = guest.log.len();
    guest.s.cancel();
    assert_eq!(guest.s.poll_event(), Some(Event::AbortSink));
    assert_eq!(
        guest.s.poll_transmit(),
        None,
        "a cancel tells the peer nothing; the room closing does"
    );
    run(&mut host, &mut guest, now, clean);
    assert_eq!(guest.log.len(), before, "nothing at all after the cancel");
    assert!(guest.sink.len() < 10 * CHUNK_SIZE);
    assert!(guest.s.ended());
    guest.s.cancel(); // idempotent
    assert_eq!(guest.s.poll_event(), None);
}

#[test]
fn a_save_dialog_still_open_when_the_receive_ends_does_not_revive_it() {
    for end in ["cancel", "peer left"] {
        let (h, g) = pair();
        let (mut host, mut guest) = (Side::new(h), Side::new(g));
        guest.answer = Answer::Hold;
        host.s.send_file(offer("d.bin", 10)).unwrap();
        run(&mut host, &mut guest, Instant::now(), clean);
        match end {
            "cancel" => guest.s.cancel(),
            _ => guest.s.peer_left(),
        }
        // The dialog returns now, with a sink open: it must be released.
        assert_eq!(guest.s.accept(), Err(UsageError::Ended), "{end}");
        assert_eq!(guest.s.poll_transmit(), None, "{end}");
    }
}

#[test]
fn a_sender_whose_receiver_leaves_mid_file_fails_there_instead_of_hanging() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("m.bin", 10 * CHUNK_SIZE)).unwrap();
    host.file = bytes(10 * CHUNK_SIZE);
    host.burst = 1;
    let now = Instant::now();
    for _ in 0..4 {
        host.step(now);
        while let Some(f) = host.s.poll_transmit() {
            guest.s.handle_frame(&f, now);
        }
        guest.step(now);
        while let Some(f) = guest.s.poll_transmit() {
            host.s.handle_frame(&f, now);
        }
    }
    assert!(host.s.chunk_wanted().is_some());
    host.s.peer_left();
    assert_eq!(
        host.s.chunk_wanted(),
        None,
        "nothing more is sealed into an empty room"
    );
    host.step(now);
    assert_eq!(host.failures(), vec![&Error::PeerDisconnected]);
    assert_eq!(
        Error::PeerDisconnected.to_string(),
        crate::PEER_DISCONNECTED
    );
}

#[test]
fn a_receiver_that_leaves_right_after_its_done_does_not_fail_a_finished_send() {
    // The interop flake: the leave arrived behind the done, and the JS
    // handled it while the done was still decrypting. Here a frame is
    // finished with when handle_frame returns, so the order holds.
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("l.bin", 3 * CHUNK_SIZE)).unwrap();
    host.file = bytes(3 * CHUNK_SIZE);
    run(&mut host, &mut guest, Instant::now(), clean);
    host.s.peer_left();
    host.step(Instant::now());
    assert!(host.has(|e| matches!(e, Event::Sent { .. })));
    assert!(host.failures().is_empty());
}

#[test]
fn a_receiver_that_declines_and_leaves_is_reported_as_declining() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    guest.answer = Answer::Decline;
    host.s.send_file(offer("n.bin", 10)).unwrap();
    run(&mut host, &mut guest, Instant::now(), clean);
    host.s.peer_left();
    host.step(Instant::now());
    assert!(host.has(|e| matches!(e, Event::SendDeclined { .. })));
    assert!(host.failures().is_empty());
}

#[test]
fn a_second_offer_while_one_is_open_is_fatal() {
    let (mut host, mut guest) = pair();
    let m = |seq| {
        Control::Manifest(Manifest {
            seq,
            name: "x".into(),
            size: 1,
            mime: DEFAULT_MIME.into(),
            chunks: 1,
        })
    };
    host.send_control(m(0));
    host.send_control(m(1));
    while let Some(f) = host.poll_transmit() {
        guest.handle_frame(&f, Instant::now());
    }
    assert!(matches!(guest.poll_event(), Some(Event::Offer(_))));
    assert_eq!(
        guest.poll_event(),
        Some(Event::Failed(Error::OfferWhileBusy))
    );
}

#[test]
fn excess_data_and_a_misplaced_last_flag_are_fatal() {
    for (size, chunks, last_at, want) in [
        (10, 1, 0, Error::ExcessData),
        (CHUNK_SIZE as u64 * 2, 2, 0, Error::LastAtWrongChunk),
    ] {
        let (mut host, mut guest) = pair();
        host.send_control(Control::Manifest(Manifest {
            seq: 0,
            name: "x".into(),
            size,
            mime: DEFAULT_MIME.into(),
            chunks,
        }));
        guest.handle_frame(&host.poll_transmit().unwrap(), Instant::now());
        guest.poll_event();
        guest.accept().unwrap();
        let data = if want == Error::ExcessData {
            bytes(11)
        } else {
            bytes(CHUNK_SIZE)
        };
        guest.handle_frame(
            &sealed_by(&host, chunk_header(0, last_at == 0), &data),
            Instant::now(),
        );
        assert_eq!(guest.failure(), Some(&want));
        assert!(!std::iter::from_fn(|| guest.poll_event()).any(|e| matches!(e, Event::Write(_))));
    }
}

#[test]
fn a_digest_that_does_not_match_is_fatal() {
    let (mut host, mut guest) = pair();
    host.send_control(Control::Manifest(Manifest {
        seq: 0,
        name: "x".into(),
        size: 3,
        mime: DEFAULT_MIME.into(),
        chunks: 1,
    }));
    guest.handle_frame(&host.poll_transmit().unwrap(), Instant::now());
    guest.accept().unwrap();
    guest.handle_frame(
        &sealed_by(&host, chunk_header(0, true), b"abc"),
        Instant::now(),
    );
    host.send_control(Control::Complete {
        seq: 0,
        chunks: 1,
        digest: "00".repeat(32),
    });
    guest.handle_frame(&host.poll_transmit().unwrap(), Instant::now());
    assert_eq!(guest.failure(), Some(&Error::DigestMismatch));
    assert!(std::iter::from_fn(|| guest.poll_event()).any(|e| e == Event::AbortSink));
}

#[test]
fn an_unknown_control_type_is_ignored_and_consumes_its_index() {
    // A peer one version ahead. If this were fatal, or did not advance the
    // index, every frame after it would fail: the protocol could never grow.
    let (mut host, mut guest) = pair();
    let unknown = Header {
        kind: TYPE_CONTROL,
        file_seq: crate::frame::CONTROL_SEQ,
        index: 0,
        last: false,
    };
    guest.handle_frame(
        &seal(&host.send, &unknown, br#"{"t":"quic-offer","x":1}"#),
        Instant::now(),
    );
    host.control_out = 1;
    host.send_path(NetworkPath::Local).unwrap();
    guest.handle_frame(&host.poll_transmit().unwrap(), Instant::now());
    assert_eq!(
        guest.poll_event(),
        Some(Event::PeerPath(NetworkPath::Local))
    );
    assert!(guest.failure().is_none());
}

#[test]
fn a_second_file_waits_for_the_first() {
    // Seqs are the session's to assign (see the decline test for the next
    // one being 1), because a seq is the nonce prefix of a whole file.
    let (mut host, _) = pair();
    assert_eq!(host.send_file(offer("a", 1)), Ok(0));
    assert_eq!(host.send_file(offer("b", 1)), Err(UsageError::Busy));
}

#[test]
fn frames_that_arrive_while_the_sink_closes_wait_for_it() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("w.bin", 5)).unwrap();
    host.file = bytes(5);
    let now = Instant::now();
    // Deliver everything to the guest without letting its driver run.
    host.step(now);
    while let Some(f) = host.s.poll_transmit() {
        guest.s.handle_frame(&f, now);
    }
    guest.step(now); // accepts
    while let Some(f) = guest.s.poll_transmit() {
        host.s.handle_frame(&f, now);
    }
    host.step(now); // chunk and complete
    while let Some(f) = host.s.poll_transmit() {
        guest.s.handle_frame(&f, now);
    }
    host.s.send_path(NetworkPath::Direct).unwrap();
    let path = host.s.poll_transmit().unwrap();
    // Drain events by hand up to Complete, holding the close.
    let mut saw_complete = false;
    while let Some(e) = guest.s.poll_event() {
        saw_complete |= matches!(e, Event::Complete { .. });
    }
    assert!(saw_complete);
    guest.s.handle_frame(&path, now);
    assert_eq!(guest.s.poll_event(), None, "held behind the close");
    guest.s.file_closed(now).unwrap();
    assert!(matches!(guest.s.poll_event(), Some(Event::Received { .. })));
    assert_eq!(
        guest.s.poll_event(),
        Some(Event::PeerPath(NetworkPath::Direct))
    );
}

// --- test/control-stream ---

#[test]
fn a_failure_the_peer_sent_before_the_manifest_still_answers_it() {
    let (mut host, mut guest) = pair();
    guest.send_control(Control::error(0, "early"));
    host.handle_frame(&guest.poll_transmit().unwrap(), Instant::now());
    assert_eq!(host.poll_event(), None, "nothing is waiting yet");
    host.send_file(offer("x", 1)).unwrap();
    assert_eq!(
        host.poll_event(),
        Some(Event::Failed(Error::PeerRefused("early".into())))
    );
}

#[test]
fn an_error_matches_whatever_seq_it_names() {
    let (mut host, mut guest) = pair();
    host.send_file(offer("x", 1)).unwrap();
    guest.send_control(Control::error(41, "no idea which file"));
    host.handle_frame(&guest.poll_transmit().unwrap(), Instant::now());
    assert_eq!(
        host.poll_event(),
        Some(Event::Failed(Error::PeerRefused(
            "no idea which file".into()
        )))
    );
}

#[test]
fn a_reply_for_another_file_does_not_answer_this_one() {
    let (mut host, mut guest) = pair();
    host.send_file(offer("x", 1)).unwrap();
    guest.send_control(Control::Accept { seq: 5 });
    host.handle_frame(&guest.poll_transmit().unwrap(), Instant::now());
    assert_eq!(host.poll_event(), None);
    assert_eq!(host.chunk_wanted(), None);
}

#[test]
fn the_first_failure_is_the_one_reported() {
    let (mut host, _) = pair();
    host.send_file(offer("x", 1)).unwrap();
    host.peer_left();
    host.handle_timeout(Instant::now() + Duration::from_secs(1000));
    host.abort("later");
    assert_eq!(
        host.poll_event(),
        Some(Event::Failed(Error::PeerDisconnected))
    );
    assert_eq!(host.poll_event(), None);
    assert_eq!(host.failure(), Some(&Error::PeerDisconnected));
}

#[test]
fn a_paused_sender_whose_receiver_leaves_blames_the_leave_not_the_pause() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("p.bin", 2 * CHUNK_SIZE)).unwrap();
    host.file = bytes(2 * CHUNK_SIZE);
    host.burst = 0;
    let now = Instant::now();
    run(&mut host, &mut guest, now, clean);
    guest.s.send_control(Control::Pause);
    host.s.handle_frame(&guest.s.poll_transmit().unwrap(), now);
    assert_eq!(host.s.poll_timeout(), Some(now + PAUSE_TIMEOUT));
    host.s.peer_left();
    host.s.handle_timeout(now + PAUSE_TIMEOUT);
    host.step(now);
    assert_eq!(host.failures(), vec![&Error::PeerDisconnected]);
}

#[test]
fn resume_releases_a_paused_sender_and_a_pause_that_never_ends_times_out() {
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("p.bin", 2 * CHUNK_SIZE)).unwrap();
    host.file = bytes(2 * CHUNK_SIZE);
    host.burst = 0;
    let now = Instant::now();
    run(&mut host, &mut guest, now, clean);
    assert!(host.s.chunk_wanted().is_some());

    guest.s.send_control(Control::Pause);
    host.s.handle_frame(&guest.s.poll_transmit().unwrap(), now);
    assert_eq!(host.s.chunk_wanted(), None);
    host.s
        .handle_timeout(now + PAUSE_TIMEOUT - Duration::from_millis(1));
    assert!(host.s.failure().is_none());

    guest.s.send_control(Control::Resume);
    host.s.handle_frame(&guest.s.poll_transmit().unwrap(), now);
    assert!(host.s.chunk_wanted().is_some());
    assert_eq!(host.s.poll_timeout(), None);

    guest.s.send_control(Control::Pause);
    host.s.handle_frame(&guest.s.poll_transmit().unwrap(), now);
    host.s.handle_timeout(now + PAUSE_TIMEOUT);
    assert_eq!(host.s.failure(), Some(&Error::PauseTimeout));
    assert_eq!(
        Error::PauseTimeout.to_string(),
        "Peer paused the transfer and never resumed"
    );
}

// --- test/control-order ---

#[test]
fn control_frames_leave_in_index_order_with_chunks_between_them() {
    // The JS needed a queue keyed on one nextControlIndex per direction;
    // here every frame goes through one FIFO as it is sealed. Check the
    // CLI's shape -- verdict, hello and manifest back to back -- and the
    // receiver's, a verdict beside its Accept.
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_path(NetworkPath::Direct).unwrap();
    host.s.send_lan_hello(LanListen::Quiet).unwrap();
    host.s.send_file(offer("o.bin", 3 * CHUNK_SIZE)).unwrap();
    host.file = bytes(3 * CHUNK_SIZE);
    guest.s.send_path(NetworkPath::Direct).unwrap();
    let mut seen: Vec<(Dir, u8, u64)> = vec![];
    run(&mut host, &mut guest, Instant::now(), |d, f| {
        let h = Header::decode(f[..14].try_into().unwrap());
        seen.push((d, h.kind, h.index));
        vec![f]
    });
    assert!(host.failures().is_empty() && guest.failures().is_empty());
    for dir in [Dir::HostToGuest, Dir::GuestToHost] {
        let controls: Vec<u64> = seen
            .iter()
            .filter(|(d, k, _)| *d == dir && *k == TYPE_CONTROL)
            .map(|s| s.2)
            .collect();
        assert_eq!(
            controls,
            (0..controls.len() as u64).collect::<Vec<_>>(),
            "{dir:?}"
        );
    }
    // complete is after the last chunk.
    let host_out: Vec<u8> = seen
        .iter()
        .filter(|s| s.0 == Dir::HostToGuest)
        .map(|s| s.1)
        .collect();
    assert_eq!(host_out, vec![0, 0, 0, 1, 1, 1, 0]);
}

// --- test/backpressure ---

#[test]
fn a_slow_sink_makes_the_sender_pause_and_the_backlog_stays_bounded() {
    let size = 6 * 1024 * 1024;
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("big.bin", size)).unwrap();
    host.file = bytes(size);
    host.burst = 8;
    guest.auto_write = false;
    let now = Instant::now();
    let mut pauses = 0;
    let mut peak = 0;
    run(&mut host, &mut guest, now, |d, f| {
        if d == Dir::GuestToHost && f[0] == TYPE_CONTROL {
            pauses += 1;
        }
        vec![f]
    });
    peak = peak.max(guest.s.pending());
    // Stalled: the sender stopped once the pause reached it, a burst over.
    assert!(guest.s.pending() >= PAUSE_AT);
    assert!(peak < PAUSE_AT + 9 * CHUNK_SIZE as u64, "peak {peak}");
    assert_eq!(host.s.chunk_wanted(), None);
    assert_eq!(host.s.poll_timeout(), Some(now + PAUSE_TIMEOUT));
    assert!(pauses >= 2, "accept, then pause");

    // The sink catches up in pieces; the backlog never exceeds the bound.
    loop {
        let backlog = guest.s.pending();
        if backlog == 0 && guest.has(|e| matches!(e, Event::Received { .. })) {
            break;
        }
        guest.s.write_done(backlog.min(512 * 1024));
        run(&mut host, &mut guest, now, clean);
        peak = peak.max(guest.s.pending());
        assert!(host.failures().is_empty() && guest.failures().is_empty());
    }
    assert!(peak < PAUSE_AT + 9 * CHUNK_SIZE as u64, "peak {peak}");
    assert_eq!(guest.sink, host.file);
    assert!(host.has(|e| matches!(e, Event::Sent { .. })));
}

#[test]
fn a_sender_that_ignores_pause_still_completes_unbounded() {
    // An old JS sender drops 'pause' as an unknown type and keeps going.
    // Stood in for by never delivering the pause (guest index 1, after its
    // accept), and nothing after it, since an undelivered index would make
    // the next guest frame out of order at the host. The receiver stays
    // correct with an unbounded backlog, and pauses exactly once: the
    // hysteresis holds the edge rather than re-sending on every frame.
    let size = 5 * 1024 * 1024;
    let (h, g) = pair();
    let (mut host, mut guest) = (Side::new(h), Side::new(g));
    host.s.send_file(offer("old.bin", size)).unwrap();
    host.file = bytes(size);
    guest.auto_write = false;
    let now = Instant::now();
    let mut swallowed = 0;
    run(&mut host, &mut guest, now, |d, f| {
        if d == Dir::GuestToHost {
            let h = Header::decode(f[..14].try_into().unwrap());
            if h.index >= 1 {
                swallowed += 1;
                return vec![];
            }
        }
        vec![f]
    });
    assert_eq!(swallowed, 2, "the pause, then the done");
    assert_eq!(
        guest.s.pending(),
        size as u64,
        "every chunk arrived, unbounded"
    );
    assert!(guest.has(|e| matches!(e, Event::Complete { .. })));
}
