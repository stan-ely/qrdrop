//! Two whole peers in one process: signaller, str0m connection and room on
//! each side, datagrams moved between them in memory on a simulated clock.
//! Nothing is mocked below the signalling relay, so this is ICE, DTLS, SCTP
//! and DCEP for real, and Trystero's handshake on top of them.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use crate::room::{Event, Room, RoomConfig};
use crate::signal::{ConnId, Output, Signaller, Strategy};
use crate::webrtc::{Config, PeerEvent, WebRtc};
use crate::wire::Payload;

struct Side {
    addr: SocketAddr,
    signaller: Signaller,
    rtc: WebRtc,
    room: Room,
    peer_of: HashMap<ConnId, String>,
    conn_of: HashMap<String, ConnId>,
    events: Vec<Event>,
}

impl Side {
    fn new(id: &str, port: u16, now: Instant) -> Side {
        let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        Side {
            addr,
            signaller: Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", id),
            rtc: WebRtc::new(Config::host(&[addr]), now),
            room: Room::new(RoomConfig {
                app_id: "qrdrop".into(),
                room_id: "room".into(),
                password: "pw".into(),
                self_id: id.into(),
            }),
            peer_of: HashMap::new(),
            conn_of: HashMap::new(),
            events: vec![],
        }
    }

    /// Route everything between the layers; returns what to publish.
    fn step(&mut self, now: Instant) -> Vec<(String, String)> {
        let mut publish = vec![];
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
                            self.room.remove_peer(&p);
                        }
                    }
                }
            }
            while let Some(o) = self.signaller.poll_output() {
                busy = true;
                match o {
                    Output::Publish { topic, content, .. } => publish.push((topic, content)),
                    Output::Connected { peer, conn } => {
                        self.peer_of.insert(conn, peer.clone());
                        self.conn_of.insert(peer.clone(), conn);
                        self.room.add_peer(&peer, now);
                    }
                    o => panic!("{o:?}"),
                }
            }
            while let Some(t) = self.room.poll_transmit() {
                busy = true;
                let conn = self.conn_of[&t.peer];
                assert_eq!(self.rtc.send(conn, &t.data), Ok(true));
            }
            while let Some(e) = self.room.poll_event() {
                busy = true;
                self.events.push(e);
            }
            if !busy {
                return publish;
            }
        }
    }
}

/// Deliver a published message to whichever side subscribes to its topic.
fn relay(publish: Vec<(String, String)>, sides: &mut [&mut Side; 2], now: Instant) {
    for (topic, content) in publish {
        for s in sides.iter_mut() {
            if topic == s.signaller.self_topic() || topic == s.signaller.topics().root() {
                s.signaller
                    .handle_topic(0, &topic, &content, now, &mut s.rtc);
            }
        }
    }
}

fn run(a: &mut Side, b: &mut Side, now: &mut Instant, until: impl Fn(&Side, &Side) -> bool) {
    for _ in 0..200_000 {
        if until(a, b) {
            return;
        }
        let pa = a.step(*now);
        let pb = b.step(*now);
        relay(pa, &mut [a, b], *now);
        relay(pb, &mut [a, b], *now);
        let mut moved = false;
        for (from, to) in [(0, 1), (1, 0)] {
            let (src, dst) = if from == 0 {
                (&mut *a, &mut *b)
            } else {
                (&mut *b, &mut *a)
            };
            while let Some(d) = src.rtc.poll_transmit() {
                moved = true;
                if d.destination == dst.addr {
                    dst.rtc
                        .handle_datagram(*now, d.source, d.destination, &d.contents);
                }
            }
            let _ = to;
        }
        if !moved {
            *now += Duration::from_millis(5);
            a.rtc.handle_timeout(*now);
            b.rtc.handle_timeout(*now);
            a.room.handle_timeout(*now);
            b.room.handle_timeout(*now);
        }
    }
    panic!("never got there");
}

#[test]
fn two_rust_peers_signal_connect_handshake_and_move_a_frame() {
    let mut now = Instant::now();
    let mut a = Side::new("AAAAAAAAAAAAAAAAAAAA", 10_001, now);
    let mut b = Side::new("zzzzzzzzzzzzzzzzzzzz", 10_002, now);

    // b announces on the root; a, the lower ID, offers.
    let announce = b.signaller.announce();
    let root = a.signaller.topics().root().to_owned();
    a.signaller
        .handle_topic(0, &root, &announce, now, &mut a.rtc);

    run(&mut a, &mut b, &mut now, |a, b| {
        !a.events.is_empty() && !b.events.is_empty()
    });
    assert_eq!(a.events, vec![Event::Joined(b.room.self_id().to_owned())]);
    assert_eq!(b.events, vec![Event::Joined(a.room.self_id().to_owned())]);

    // A full-size frame message: 16348 bytes of payload in one chunk, the
    // 16451-byte channel message the recordings show.
    let frame: Vec<u8> = (0..16_348u32).map(|i| (i % 251) as u8).collect();
    let big: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
    for p in [
        Payload::Binary(frame.clone()),
        Payload::Text("ecdh-key".into()),
        Payload::Binary(big.clone()),
    ] {
        a.room.send("frame", &p, None, None).unwrap();
    }
    run(&mut a, &mut b, &mut now, |_, b| b.events.len() == 4);
    let got: Vec<&Payload> = b.events[1..]
        .iter()
        .map(|e| match e {
            Event::Message { message, .. } => &message.payload,
            e => panic!("{e:?}"),
        })
        .collect();
    assert_eq!(
        got,
        vec![
            &Payload::Binary(frame),
            &Payload::Text("ecdh-key".into()),
            &Payload::Binary(big)
        ]
    );

    // A leaves: B hears the leave over the channel before anything closes.
    a.room.leave();
    run(&mut a, &mut b, &mut now, |_, b| b.events.len() == 5);
    assert!(matches!(
        &b.events[4],
        Event::Closed {
            joined: true,
            reason: crate::room::CloseReason::Left,
            ..
        }
    ));
}
