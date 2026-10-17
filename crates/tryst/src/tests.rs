//! The room and the signaller, against the two recordings of real Trystero
//! traffic (`trystero-recording.json` through a stand-in relay and tracker,
//! `trystero-recording-live.json` through the public ones) and against each
//! other.

// `&lo.self_topic().to_owned()` is how a test passes a signaller its own topic
// while borrowing it mutably; clippy reads the copy as unnecessary.
#![allow(clippy::unnecessary_to_owned)]

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::crypto::{SignalCipher, Topics, nostr_kind};
use crate::room::{CloseReason, Event, HANDSHAKE_TIMEOUT, Room, RoomConfig, WRONG_PASSWORD};
use crate::signal::{
    ANSWERING_TTL, ConnId, Connector, OFFER_POST_ANSWER_TTL, OFFER_TTL, Output, Signaller,
    Strategy, TrackerOffer,
};
use crate::vectors::unhex;
use crate::wire::{Frame, Payload, decode_chunk, unwrap_frame};

fn recordings() -> [Value; 2] {
    [
        serde_json::from_str(include_str!(
            "../../../test/vectors/trystero-recording.json"
        ))
        .unwrap(),
        serde_json::from_str(include_str!(
            "../../../test/vectors/trystero-recording-live.json"
        ))
        .unwrap(),
    ]
}

thread_local! {
    static CHALLENGE: RefCell<String> = const { RefCell::new(String::new()) };
}

fn recorded_challenge() -> String {
    CHALLENGE.with(|c| c.borrow().clone())
}

/// A channel message's action name and whole bytes, where the recording kept
/// them (it keeps only the head of anything over 256 bytes).
fn channel_bytes(m: &Value) -> Option<Vec<u8>> {
    m.get("hex").map(|h| unhex(h.as_str().unwrap()))
}

fn action_of(bytes: &[u8]) -> Option<String> {
    match unwrap_frame(bytes)? {
        Frame::Room { chunk, .. } => Some(decode_chunk(chunk)?.action),
        Frame::Presence { .. } => None,
    }
}

/// Replays each side of every recorded run through a Rust room in that
/// side's place: what it receives goes in, and what it sends on Trystero's
/// own actions must come out byte for byte, in the same order.
#[test]
fn room_replays_both_sides_of_every_recording() {
    for rec in recordings() {
        let password = rec["password"].as_str().unwrap();
        let topic = rec["topic"].as_str().unwrap();
        for run in rec["runs"].as_array().unwrap() {
            let peers = &run["peers"];
            for (me, them) in [("host", "guest"), ("guest", "host")] {
                let self_id = peers[me]["self_id"].as_str().unwrap();
                let other = peers[them]["self_id"].as_str().unwrap();
                let why = format!("{} {} as {me}", rec["relays"], run["strategy"]);
                let ours: Vec<&Value> = run["channel"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["peer"] == me)
                    .collect();

                // If this side is the initiator, its challenge is the one in
                // the recording, so its peer's recorded response is right.
                if self_id < other {
                    let first = ours
                        .iter()
                        .filter(|m| m["dir"] == "out")
                        .filter_map(|m| channel_bytes(m))
                        .find(|b| action_of(b).as_deref() == Some("@_hsdata"))
                        .unwrap();
                    let Some(Frame::Room { chunk, .. }) = unwrap_frame(&first) else {
                        panic!()
                    };
                    let body: Value =
                        serde_json::from_slice(decode_chunk(chunk).unwrap().payload).unwrap();
                    CHALLENGE.with(|c| *c.borrow_mut() = body["c"].as_str().unwrap().to_owned());
                }

                let now = Instant::now();
                let mut room = Room::new(RoomConfig {
                    app_id: rec["app_id"].as_str().unwrap().into(),
                    room_id: topic.into(),
                    password: password.into(),
                    self_id: self_id.into(),
                })
                .with_challenge(recorded_challenge);
                room.add_peer(other, now);

                let mut sent = vec![];
                let mut events = vec![];
                let mut want = vec![];
                for m in &ours {
                    let bytes = channel_bytes(m);
                    let action = bytes.as_deref().and_then(action_of);
                    if m["dir"] == "out" {
                        match action.as_deref() {
                            Some("@_leave") => room.leave(),
                            Some(a) if a.starts_with("@_") => {}
                            _ => continue,
                        }
                        want.push(bytes.unwrap());
                    } else if let Some(b) = bytes {
                        room.handle_data(other, &b);
                    }
                    while let Some(t) = room.poll_transmit() {
                        assert_eq!(t.peer, other);
                        sent.push(t.data);
                    }
                    while let Some(e) = room.poll_event() {
                        events.push(e);
                    }
                }
                assert_eq!(sent, want, "{why}");

                // Joined once, then the peer's ECDH key as a string, then a
                // leave from one side or the other.
                assert_eq!(
                    events.first(),
                    Some(&Event::Joined(other.to_owned())),
                    "{why}"
                );
                assert!(
                    events.iter().any(|e| matches!(e, Event::Message { message, .. }
                        if message.action == "ecdh" && matches!(&message.payload, Payload::Text(k) if k.starts_with('B')))),
                    "{why}: {events:?}"
                );
                assert!(
                    matches!(
                        events.last(),
                        Some(Event::Closed {
                            joined: true,
                            reason: CloseReason::Left | CloseReason::SelfLeft,
                            ..
                        })
                    ),
                    "{why}: {events:?}"
                );
            }
        }
    }
}

/// Every offer, answer and candidate in both recordings opens under the
/// recording's password, and the topics and info hashes the Trystero
/// clients used are the ones `Topics` derives.
#[test]
fn recordings_decrypt_and_name_the_derived_topics() {
    for rec in recordings() {
        let app = rec["app_id"].as_str().unwrap();
        let room = rec["topic"].as_str().unwrap();
        let topics = Topics::new(app, room);
        let cipher = SignalCipher::new(rec["password"].as_str().unwrap(), app, room);
        let mut opened = 0;
        for run in rec["runs"].as_array().unwrap() {
            let ids: Vec<&str> = ["host", "guest"]
                .iter()
                .map(|p| run["peers"][p]["self_id"].as_str().unwrap())
                .collect();
            for m in run["relay"].as_array().unwrap() {
                let Some(data) = m.get("data").and_then(Value::as_str) else {
                    continue;
                };
                let msg: Value = serde_json::from_str(data).unwrap();
                let me = run["peers"][m["peer"].as_str().unwrap()]["self_id"]
                    .as_str()
                    .unwrap();
                let mut sealed = vec![];
                if run["strategy"] == "nostr" {
                    match msg[0].as_str().unwrap() {
                        "REQ" if m["dir"] == "out" => {
                            let filter = &msg[2];
                            let want: BTreeSet<String> =
                                [topics.root().to_owned(), topics.peer_topic(me)].into();
                            let got: BTreeSet<String> = filter["#x"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|t| t.as_str().unwrap().into())
                                .collect();
                            assert_eq!(got, want);
                            let kinds: BTreeSet<u64> = filter["kinds"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|k| k.as_u64().unwrap())
                                .collect();
                            assert_eq!(kinds, want.iter().map(|t| nostr_kind(t) as u64).collect());
                        }
                        "EVENT" => {
                            let ev = if m["dir"] == "out" { &msg[1] } else { &msg[2] };
                            let topic = ev["tags"][0][1].as_str().unwrap();
                            assert_eq!(ev["kind"].as_u64().unwrap() as u32, nostr_kind(topic));
                            assert!(
                                topic == topics.root()
                                    || ids.iter().any(|id| topics.peer_topic(id) == topic)
                            );
                            let content: Value =
                                serde_json::from_str(ev["content"].as_str().unwrap()).unwrap();
                            for k in ["offer", "answer", "candidate"] {
                                if let Some(s) = content[k].as_str() {
                                    sealed.push((k, s.to_owned()));
                                }
                            }
                        }
                        _ => {}
                    }
                } else {
                    if let Some(h) = msg["info_hash"].as_str() {
                        assert_eq!(h, topics.info_hash());
                    }
                    for o in msg["offers"].as_array().into_iter().flatten() {
                        assert_eq!(o["offer_id"].as_str().unwrap().len(), 20);
                        sealed.push(("offer", o["offer"]["sdp"].as_str().unwrap().to_owned()));
                    }
                    for k in ["offer", "answer"] {
                        if let Some(s) = msg[k]["sdp"].as_str() {
                            sealed.push((k, s.to_owned()));
                        }
                    }
                }
                for (kind, s) in sealed {
                    let plain = cipher
                        .decrypt(&s)
                        .unwrap_or_else(|| panic!("{kind} did not open"));
                    if kind == "candidate" {
                        let c: Value = serde_json::from_str(&plain).unwrap();
                        assert!(c["candidate"].is_string());
                    } else {
                        assert!(plain.starts_with("v=0\r\n"), "{kind}");
                    }
                    opened += 1;
                }
            }
        }
        assert!(opened > 4, "{opened}");
    }
}

/// A connector that makes no connections, only records what was asked of it.
#[derive(Default)]
struct Fake {
    next: ConnId,
    offers: Vec<ConnId>,
    answers: Vec<(ConnId, String)>,
    accepted: Vec<(ConnId, String)>,
    candidates: Vec<(ConnId, String)>,
    closed: Vec<ConnId>,
}

impl Connector for Fake {
    fn offer(&mut self) -> Option<(ConnId, String)> {
        self.next += 1;
        self.offers.push(self.next);
        Some((self.next, format!("v=0\r\nfake offer {}\r\n", self.next)))
    }
    fn answer(&mut self, offer: &str) -> Option<(ConnId, String)> {
        self.next += 1;
        self.answers.push((self.next, offer.to_owned()));
        Some((self.next, format!("v=0\r\nfake answer {}\r\n", self.next)))
    }
    fn accept_answer(&mut self, conn: ConnId, answer: &str) -> bool {
        self.accepted.push((conn, answer.to_owned()));
        true
    }
    fn add_candidate(&mut self, conn: ConnId, candidate: &str) {
        self.candidates.push((conn, candidate.to_owned()));
    }
    fn close(&mut self, conn: ConnId) {
        self.closed.push(conn);
    }
}

fn outputs(s: &mut Signaller) -> Vec<Output> {
    std::iter::from_fn(|| s.poll_output()).collect()
}

fn keys(content: &str) -> BTreeSet<String> {
    let v: Value = serde_json::from_str(content).unwrap();
    v.as_object().unwrap().keys().cloned().collect()
}

/// Each side of each recorded Nostr run, fed what its relay delivered: a
/// Rust signaller in its place publishes the same kinds of message to the
/// same topics, and does what the recorded side did with each signal.
#[test]
fn nostr_signaller_replays_the_recorded_runs() {
    for rec in recordings() {
        let app = rec["app_id"].as_str().unwrap();
        let room = rec["topic"].as_str().unwrap();
        let password = rec["password"].as_str().unwrap();
        for run in rec["runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["strategy"] == "nostr")
        {
            for (me, them) in [("host", "guest"), ("guest", "host")] {
                let self_id = run["peers"][me]["self_id"].as_str().unwrap();
                let other = run["peers"][them]["self_id"].as_str().unwrap();
                let why = format!("{} as {me}", rec["relays"]);
                let mut s = Signaller::new(Strategy::Nostr, app, room, password, self_id);
                let mut c = Fake::default();
                let mut recorded = BTreeSet::new();
                let mut produced = BTreeSet::new();
                let urls: Vec<&str> = run["relay"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|m| m["url"].as_str())
                    .collect();
                for m in run["relay"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["peer"] == me)
                {
                    let msg: Value = serde_json::from_str(m["data"].as_str().unwrap()).unwrap();
                    if msg[0] != "EVENT" {
                        continue;
                    }
                    let relay = urls.iter().position(|u| *u == m["url"]).unwrap();
                    let ev = if m["dir"] == "out" { &msg[1] } else { &msg[2] };
                    let topic = ev["tags"][0][1].as_str().unwrap();
                    let content = ev["content"].as_str().unwrap();
                    if m["dir"] == "out" {
                        recorded.insert((topic.to_owned(), keys(content)));
                        continue;
                    }
                    s.handle_topic(relay, topic, content, Instant::now(), &mut c);
                    for o in outputs(&mut s) {
                        if let Output::Publish { topic, content, .. } = o {
                            assert_eq!(
                                serde_json::from_str::<Value>(&content).unwrap()["peerId"],
                                self_id
                            );
                            produced.insert((topic, keys(&content)));
                        }
                    }
                }
                // The announce to the root is the client's, not the
                // signaller's; everything else it publishes the recorded
                // side published too. Candidates are the one thing it never
                // sends, because its SDP carries them.
                assert!(!produced.is_empty(), "{why}");
                for p in &produced {
                    assert!(
                        recorded.contains(p),
                        "{why}: produced {p:?}, recorded {recorded:?}"
                    );
                }
                let their_topic = Topics::new(app, room).peer_topic(other);
                let offer_keys: BTreeSet<String> =
                    ["peerId", "offerId", "offer"].map(String::from).into();
                let answer_keys: BTreeSet<String> =
                    ["peerId", "answer", "offerId"].map(String::from).into();
                if self_id < other {
                    assert!(produced.contains(&(their_topic, offer_keys)), "{why}");
                    assert!(c.answers.is_empty(), "{why}: the lower ID never answers");
                } else {
                    assert!(produced.contains(&(their_topic, answer_keys)), "{why}");
                    assert_eq!(c.answers.len(), 1, "{why}");
                    assert!(c.answers[0].1.starts_with("v=0\r\n"), "{why}");
                    // The recorded offerer trickled candidates; each reached
                    // the answering connection, decrypted.
                    assert!(
                        c.candidates.iter().all(|(conn, _)| *conn == c.answers[0].0),
                        "{why}"
                    );
                }
            }
        }
    }
}

/// The torrent runs: the higher ID answers the lower one's pooled offer
/// through the tracker, and the lower ID ignores the higher one's.
#[test]
fn torrent_signaller_replays_the_recorded_runs() {
    for rec in recordings() {
        let app = rec["app_id"].as_str().unwrap();
        let room = rec["topic"].as_str().unwrap();
        let password = rec["password"].as_str().unwrap();
        for run in rec["runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["strategy"] == "torrent")
        {
            for (me, them) in [("host", "guest"), ("guest", "host")] {
                let self_id = run["peers"][me]["self_id"].as_str().unwrap();
                let other = run["peers"][them]["self_id"].as_str().unwrap();
                let mut s = Signaller::new(Strategy::Torrent, app, room, password, self_id);
                let mut c = Fake::default();
                let mut answered = vec![];
                for m in run["relay"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["peer"] == me && m["dir"] == "in")
                {
                    let msg: Value = serde_json::from_str(m["data"].as_str().unwrap()).unwrap();
                    if let (Some(offer), Some(id)) =
                        (msg["offer"]["sdp"].as_str(), msg["offer_id"].as_str())
                    {
                        s.tracker_offer(
                            TrackerOffer {
                                relay: 0,
                                peer: msg["peer_id"].as_str().unwrap(),
                                offer,
                                offer_id: id,
                                has_outgoing: true,
                            },
                            Instant::now(),
                            &mut c,
                        );
                        for o in outputs(&mut s) {
                            if let Output::TrackerAnswer {
                                to_peer,
                                offer_id,
                                sdp,
                                ..
                            } = o
                            {
                                assert!(
                                    SignalCipher::new(password, app, room)
                                        .decrypt(&sdp)
                                        .is_some()
                                );
                                answered.push((to_peer, offer_id == id));
                            }
                        }
                    }
                }
                if self_id > other {
                    assert_eq!(
                        answered,
                        vec![(other.to_owned(), true)],
                        "{} as {me}",
                        rec["relays"]
                    );
                } else {
                    assert!(answered.is_empty(), "{} as {me}", rec["relays"]);
                }
            }
        }
    }
}

fn room(self_id: &str, password: &str) -> Room {
    Room::new(RoomConfig {
        app_id: "qrdrop".into(),
        room_id: "room".into(),
        password: password.into(),
        self_id: self_id.into(),
    })
}

/// Shuttles every transmit between two rooms until both are quiet.
fn pump(a: &mut Room, b: &mut Room) -> (Vec<Event>, Vec<Event>) {
    let (mut ea, mut eb) = (vec![], vec![]);
    loop {
        let mut moved = false;
        while let Some(t) = a.poll_transmit() {
            b.handle_data(a.self_id().to_owned().as_str(), &t.data);
            moved = true;
        }
        while let Some(t) = b.poll_transmit() {
            a.handle_data(b.self_id().to_owned().as_str(), &t.data);
            moved = true;
        }
        ea.extend(std::iter::from_fn(|| a.poll_event()));
        eb.extend(std::iter::from_fn(|| b.poll_event()));
        if !moved {
            return (ea, eb);
        }
    }
}

#[test]
fn two_rooms_join_and_exchange_every_payload_kind() {
    let now = Instant::now();
    let (mut a, mut b) = (room("aaaa", "pw"), room("bbbb", "pw"));
    a.add_peer("bbbb", now);
    b.add_peer("aaaa", now);
    let (ea, eb) = pump(&mut a, &mut b);
    assert_eq!(ea, vec![Event::Joined("bbbb".into())]);
    assert_eq!(eb, vec![Event::Joined("aaaa".into())]);

    let big: Vec<u8> = (0..100_000u32).map(|i| i as u8).collect();
    let sent = [
        Payload::Text("hello".into()),
        Payload::Json(json!({"z": 1, "a": [true, null]})),
        Payload::Binary(big),
        Payload::Binary(vec![]),
    ];
    for p in &sent {
        assert_eq!(a.send("frame", p, None, Some("bbbb")), Ok(1));
    }
    let (_, eb) = pump(&mut a, &mut b);
    let got: Vec<Payload> = eb
        .into_iter()
        .map(|e| match e {
            Event::Message { peer, message } => {
                assert_eq!(peer, "aaaa");
                message.payload
            }
            e => panic!("{e:?}"),
        })
        .collect();
    assert_eq!(got, sent);

    // Trystero's namespace is not the caller's to write into.
    assert!(
        a.send("@_leave", &Payload::Text(String::new()), None, None)
            .is_err()
    );
    a.leave();
    let (ea, eb) = pump(&mut a, &mut b);
    assert_eq!(
        ea,
        vec![Event::Closed {
            peer: "bbbb".into(),
            joined: true,
            reason: CloseReason::SelfLeft
        }]
    );
    assert_eq!(
        eb,
        vec![Event::Closed {
            peer: "aaaa".into(),
            joined: true,
            reason: CloseReason::Left
        }]
    );
}

#[test]
fn a_wrong_password_never_joins_and_says_why() {
    let now = Instant::now();
    let (mut a, mut b) = (room("aaaa", "pw"), room("bbbb", "other"));
    a.add_peer("bbbb", now);
    b.add_peer("aaaa", now);
    let (ea, eb) = pump(&mut a, &mut b);
    let reason = CloseReason::Handshake(format!("handshake failed: {WRONG_PASSWORD}"));
    assert_eq!(
        ea,
        vec![Event::Closed {
            peer: "bbbb".into(),
            joined: false,
            reason
        }]
    );
    // The responder passed its own check -- it answered a challenge -- and
    // waits for a ready that never comes, until the timeout.
    assert!(eb.is_empty());
    b.handle_timeout(now + HANDSHAKE_TIMEOUT);
    assert!(matches!(
        b.poll_event(),
        Some(Event::Closed {
            joined: false,
            reason: CloseReason::Handshake(_),
            ..
        })
    ));
}

#[test]
fn a_pending_peer_is_heard_only_on_the_handshake_actions() {
    let now = Instant::now();
    let (mut a, mut b) = (room("aaaa", "pw"), room("bbbb", "pw"));
    a.add_peer("bbbb", now);
    b.add_peer("aaaa", now);
    // Before any handshake traffic moves, b's application message to a
    // pending a is dropped by a, as Trystero drops an early `ecdh`.
    let token = Topics::new("qrdrop", "room").room_token().to_owned();
    let chunk =
        crate::wire::encode_action("ecdh", 0, &Payload::Text("early".into()), None).unwrap();
    a.handle_data("bbbb", &crate::wire::wrap_room(&token, &chunk[0]));
    // And so is anything for another room, or from a stranger.
    a.handle_data("bbbb", &crate::wire::wrap_room(&"0".repeat(64), &chunk[0]));
    let (ea, _) = pump(&mut a, &mut b);
    assert_eq!(ea, vec![Event::Joined("bbbb".into())]);
    a.handle_data("cccc", &crate::wire::wrap_room(&token, &chunk[0]));
    assert_eq!(a.poll_event(), None);
    // After the join, the same message is heard.
    a.handle_data("bbbb", &crate::wire::wrap_room(&token, &chunk[0]));
    assert!(matches!(a.poll_event(), Some(Event::Message { .. })));
}

#[test]
fn no_password_still_exchanges_ready() {
    let now = Instant::now();
    let (mut a, mut b) = (room("aaaa", ""), room("bbbb", ""));
    a.add_peer("bbbb", now);
    b.add_peer("aaaa", now);
    let (ea, eb) = pump(&mut a, &mut b);
    assert_eq!((ea.len(), eb.len()), (1, 1));
    assert_eq!(a.poll_timeout(), None);
}

/// Two Nostr signallers over one perfect relay, each with its own fake
/// connector: the announce reaches the higher ID, which nudges, the lower ID
/// offers, the higher one answers, and the answer is applied.
#[test]
fn two_nostr_signallers_agree_who_offers() {
    let now = Instant::now();
    let mut lo = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "AAAA");
    let mut hi = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "zzzz");
    let (mut clo, mut chi) = (Fake::default(), Fake::default());
    let root = lo.topics().root().to_owned();

    // hi hears lo's announce first: it is higher, so it nudges and waits.
    hi.handle_topic(0, &root, &lo.announce(), now, &mut chi);
    let nudge = outputs(&mut hi);
    assert!(matches!(&nudge[..], [Output::Publish { topic, .. }] if topic == lo.self_topic()));
    assert!(chi.offers.is_empty());

    // lo hears the nudge (on its own topic) and offers.
    let Output::Publish { content, .. } = &nudge[0] else {
        panic!()
    };
    lo.handle_topic(0, &lo.self_topic().to_owned(), content, now, &mut clo);
    let offer = outputs(&mut lo);
    let [
        Output::Publish {
            topic,
            content: offer,
            ..
        },
    ] = &offer[..]
    else {
        panic!("{offer:?}")
    };
    assert_eq!(topic, hi.self_topic());
    let offer_id = serde_json::from_str::<Value>(offer).unwrap()["offerId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(offer_id.len(), 12);

    // A repeat of the announce within the resend window sends nothing new.
    lo.handle_topic(0, &root, &hi.announce(), now, &mut clo);
    assert!(outputs(&mut lo).is_empty());
    assert_eq!(clo.offers.len(), 1);

    // hi answers, naming the offer.
    hi.handle_topic(0, &hi.self_topic().to_owned(), offer, now, &mut chi);
    let answer = outputs(&mut hi);
    let [
        Output::Publish {
            content: answer, ..
        },
    ] = &answer[..]
    else {
        panic!("{answer:?}")
    };
    assert_eq!(chi.answers, vec![(1, "v=0\r\nfake offer 1\r\n".into())]);
    assert_eq!(
        serde_json::from_str::<Value>(answer).unwrap()["offerId"],
        offer_id.as_str()
    );

    // A stale answer is ignored; the real one is applied once.
    let stale = answer.replace(&offer_id, "XXXXXXXXXXXX");
    lo.handle_topic(0, &lo.self_topic().to_owned(), &stale, now, &mut clo);
    assert!(clo.accepted.is_empty());
    lo.handle_topic(0, &lo.self_topic().to_owned(), answer, now, &mut clo);
    lo.handle_topic(0, &lo.self_topic().to_owned(), answer, now, &mut clo);
    assert_eq!(clo.accepted, vec![(1, "v=0\r\nfake answer 1\r\n".into())]);

    // Both channels open: each side hands its connection to the room, and
    // nothing more from the other is acted on.
    lo.connected(1, &mut clo);
    hi.connected(1, &mut chi);
    assert_eq!(
        outputs(&mut lo),
        vec![Output::Connected {
            peer: "zzzz".into(),
            conn: 1
        }]
    );
    assert_eq!(
        outputs(&mut hi),
        vec![Output::Connected {
            peer: "AAAA".into(),
            conn: 1
        }]
    );
    lo.handle_topic(0, &root, &hi.announce(), now, &mut clo);
    assert!(outputs(&mut lo).is_empty());
    // A drop asks for a fresh announce, and the next announce offers again.
    lo.disconnected(1);
    assert_eq!(outputs(&mut lo), vec![Output::Reannounce]);
    lo.handle_topic(0, &root, &hi.announce(), now, &mut clo);
    assert_eq!(clo.offers.len(), 2);
}

#[test]
fn glare_the_higher_offer_is_ignored_and_the_lower_one_wins() {
    let now = Instant::now();
    let mut lo = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "AAAA");
    let mut hi = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "zzzz");
    let (mut clo, mut chi) = (Fake::default(), Fake::default());
    let cipher = SignalCipher::new("pw", "qrdrop", "room");
    // lo has an offer out to hi.
    lo.handle_topic(
        0,
        &lo.topics().root().to_owned(),
        &hi.announce(),
        now,
        &mut clo,
    );
    assert_eq!(clo.offers.len(), 1);
    outputs(&mut lo);
    // An offer from hi crosses it: lo, the lower ID, ignores it.
    let theirs = json!({"peerId": "zzzz", "offerId": "hhhhhhhhhhhh", "offer": cipher.encrypt("v=0\r\nhi\r\n")}).to_string();
    lo.handle_topic(0, &lo.self_topic().to_owned(), &theirs, now, &mut clo);
    assert!(outputs(&mut lo).is_empty() && clo.answers.is_empty());

    // hi with an offer out to lo (it would not make one, but a tracker's
    // pooled offers are exactly this) answers lo's offer and drops its own.
    let offer = cipher.encrypt("v=0\r\nlo\r\n");
    let o = TrackerOffer {
        relay: 0,
        peer: "AAAA",
        offer: &offer,
        offer_id: "offer-from-lo-000000",
        has_outgoing: true,
    };
    hi.tracker_offer(o, now, &mut chi);
    assert_eq!(chi.answers.len(), 1);
    assert!(
        matches!(&outputs(&mut hi)[..], [Output::TrackerAnswer { to_peer, offer_id, .. }]
        if to_peer == "AAAA" && offer_id == "offer-from-lo-000000")
    );
}

#[test]
fn a_wrong_password_is_reported_and_answers_nothing() {
    let now = Instant::now();
    let mut s = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "zzzz");
    let mut c = Fake::default();
    let bad = SignalCipher::new("other", "qrdrop", "room");
    let offer = json!({"peerId": "AAAA", "offerId": "o", "offer": bad.encrypt("v=0")}).to_string();
    s.handle_topic(0, &s.self_topic().to_owned(), &offer, now, &mut c);
    assert_eq!(
        outputs(&mut s),
        vec![Output::WrongPassword {
            peer: "AAAA".into()
        }]
    );
    assert!(c.answers.is_empty());
    // Malformed signal fields drop the whole message, as Trystero's do.
    for m in [
        json!({"peerId": "AAAA", "offer": ""}),
        json!({"peerId": "AAAA", "offer": 7}),
        json!({"offer": bad.encrypt("v=0")}),
        json!({"peerId": "zzzz"}),
    ] {
        s.handle_topic(0, &s.self_topic().to_owned(), &m.to_string(), now, &mut c);
    }
    s.handle_topic(
        0,
        "some other topic",
        &json!({"peerId": "AAAA"}).to_string(),
        now,
        &mut c,
    );
    assert!(outputs(&mut s).is_empty());
}

#[test]
fn candidates_before_their_offer_are_held_for_it() {
    let now = Instant::now();
    let mut s = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "zzzz");
    let mut c = Fake::default();
    let cipher = SignalCipher::new("pw", "qrdrop", "room");
    let me = s.self_topic().to_owned();
    let cand = r#"{"candidate":"candidate:1 1 UDP 1 127.0.0.1 9 typ host","sdpMid":"0","sdpMLineIndex":0}"#;
    let trickle =
        json!({"peerId": "AAAA", "offerId": "oooooooooooo", "candidate": cipher.encrypt(cand)})
            .to_string();
    s.handle_topic(0, &me, &trickle, now, &mut c);
    assert!(c.candidates.is_empty());
    let offer =
        json!({"peerId": "AAAA", "offerId": "oooooooooooo", "offer": cipher.encrypt("v=0")})
            .to_string();
    s.handle_topic(0, &me, &offer, now, &mut c);
    assert_eq!(c.candidates, vec![(c.answers[0].0, cand.to_owned())]);
    // Later ones go straight to it.
    s.handle_topic(0, &me, &trickle, now, &mut c);
    assert_eq!(c.candidates.len(), 2);
}

#[test]
fn offers_and_answers_expire_and_close_their_connections() {
    let now = Instant::now();
    let mut s = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "AAAA");
    let mut c = Fake::default();
    let root = s.topics().root().to_owned();
    s.handle_topic(
        0,
        &root,
        &json!({"peerId": "zzzz"}).to_string(),
        now,
        &mut c,
    );
    assert_eq!(s.poll_timeout(), Some(now + OFFER_TTL));
    s.handle_timeout(now + OFFER_TTL - Duration::from_millis(1), &mut c);
    assert!(c.closed.is_empty());
    s.handle_timeout(now + OFFER_TTL, &mut c);
    assert_eq!(c.closed, vec![1]);
    assert_eq!(s.poll_timeout(), None);
    outputs(&mut s);

    // An answered offer gets the shorter post-answer window from the answer.
    s.handle_topic(
        0,
        &root,
        &json!({"peerId": "zzzz"}).to_string(),
        now,
        &mut c,
    );
    let offer: Value = outputs(&mut s)
        .into_iter()
        .find_map(|o| match o {
            Output::Publish { content, .. } if content.contains("offerId") => {
                serde_json::from_str(&content).ok()
            }
            _ => None,
        })
        .unwrap();
    let cipher = SignalCipher::new("pw", "qrdrop", "room");
    let answer =
        json!({"peerId": "zzzz", "offerId": offer["offerId"], "answer": cipher.encrypt("v=0")})
            .to_string();
    let later = now + Duration::from_secs(1);
    s.handle_topic(0, &s.self_topic().to_owned(), &answer, later, &mut c);
    assert_eq!(s.poll_timeout(), Some(later + OFFER_POST_ANSWER_TTL));

    // An answer we sent, never connected, is closed after its window.
    let mut hi = Signaller::new(Strategy::Nostr, "qrdrop", "room", "pw", "zzzz");
    let mut ch = Fake::default();
    let offer =
        json!({"peerId": "AAAA", "offerId": "o", "offer": cipher.encrypt("v=0")}).to_string();
    hi.handle_topic(0, &hi.self_topic().to_owned(), &offer, now, &mut ch);
    hi.handle_timeout(now + ANSWERING_TTL, &mut ch);
    assert_eq!(ch.closed, vec![ch.answers[0].0]);
}

#[test]
fn a_second_connection_to_a_connected_peer_is_closed() {
    let mut s = Signaller::new(Strategy::Torrent, "qrdrop", "room", "pw", "AAAA");
    let mut c = Fake::default();
    let cipher = SignalCipher::new("pw", "qrdrop", "room");
    let (one, _) = s.pooled_offer(&mut c).unwrap();
    let (two, _) = s.pooled_offer(&mut c).unwrap();
    s.tracker_answer("zzzz", one, &cipher.encrypt("v=0 a"), &mut c);
    s.tracker_answer("zzzz", two, &cipher.encrypt("v=0 b"), &mut c);
    s.connected(one, &mut c);
    s.connected(two, &mut c);
    assert_eq!(
        outputs(&mut s),
        vec![Output::Connected {
            peer: "zzzz".into(),
            conn: one
        }]
    );
    assert_eq!(c.closed, vec![two]);
    // An unanswered pooled offer is the tracker client's to reclaim.
    let (three, _) = s.pooled_offer(&mut c).unwrap();
    s.reclaim(three, &mut c);
    s.reclaim(one, &mut c); // bound to a peer: not reclaimable
    assert_eq!(c.closed, vec![two, three]);
}
