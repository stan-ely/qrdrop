//! The runtime end to end on loopback: real WebSockets to a stand-in relay,
//! real UDP, real str0m, two Rust peers. The JS-facing half of the same
//! check is e2e/tryst.e2e.mjs.

mod standin;

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::timeout;
use tryst::join::{JoinConfig, JoinError, RoomEvent, RoomHandle, join};
use tryst::relay::{Backoff, Relay, RelayEvent};
use tryst::signal::Strategy;
use tryst::webrtc::CandidateType;
use tryst::wire::Payload;

const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const WAIT: Duration = Duration::from_secs(20);

fn config(strategy: Strategy, url: &str, id: &str, password: &str) -> JoinConfig {
    let mut c = JoinConfig::new(strategy, "qrdrop", "the-room", password, &[url]);
    c.bind = Some(LOCAL);
    c.self_id = Some(id.into());
    c
}

async fn until(room: &mut RoomHandle, mut want: impl FnMut(&RoomEvent) -> bool) -> RoomEvent {
    timeout(WAIT, async {
        loop {
            let e = room.next_event().await.expect("the room ended");
            if want(&e) {
                return e;
            }
        }
    })
    .await
    .expect("timed out")
}

async fn pair(strategy: Strategy) {
    let addr = standin::start().await;
    let url = format!("ws://{addr}");
    // Fixed IDs, so which side offers is known: the lower one.
    let lo_id = "0000000000000000000a";
    let hi_id = "zzzzzzzzzzzzzzzzzzzz";
    let mut lo = join(config(strategy, &url, lo_id, "pw")).await.unwrap();
    let mut hi = join(config(strategy, &url, hi_id, "pw")).await.unwrap();
    assert_eq!(
        until(&mut lo, |e| matches!(e, RoomEvent::Joined(_))).await,
        RoomEvent::Joined(hi_id.into())
    );
    assert_eq!(
        until(&mut hi, |e| matches!(e, RoomEvent::Joined(_))).await,
        RoomEvent::Joined(lo_id.into())
    );

    // Both on loopback with no STUN: host to host, once str0m has said so.
    let pair = timeout(WAIT, async {
        loop {
            if let Some(p) = lo.selected_pair(hi_id).await {
                return p;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("no selected pair");
    assert_eq!(
        (pair.local_type, pair.remote_type),
        (CandidateType::Host, CandidateType::Host)
    );
    assert!(
        pair.local.ip().is_loopback() && pair.remote.ip().is_loopback(),
        "{pair:?}"
    );

    assert_eq!(
        lo.send("ecdh", Payload::Text("key".into()), None, None)
            .await,
        Ok(1)
    );
    let RoomEvent::Message { peer, message } =
        until(&mut hi, |e| matches!(e, RoomEvent::Message { .. })).await
    else {
        unreachable!()
    };
    assert_eq!((peer.as_str(), message.action.as_str()), (lo_id, "ecdh"));
    assert_eq!(message.payload, Payload::Text("key".into()));

    // Eight MiB the other way, one frame-sized message at a time, as qrdrop
    // sends a file: each send waits for room under the high-water mark.
    let frame: Vec<u8> = (0..16_348u32).map(|i| (i % 251) as u8).collect();
    let count = 8 * 1024 * 1024 / frame.len();
    let sender = async {
        for _ in 0..count {
            assert_eq!(
                hi.send("frame", Payload::Binary(frame.clone()), None, Some(lo_id))
                    .await,
                Ok(1)
            );
        }
    };
    let receiver = async {
        let mut got = 0;
        while got < count {
            if let RoomEvent::Message { message, .. } =
                until(&mut lo, |e| matches!(e, RoomEvent::Message { .. })).await
            {
                assert_eq!(message.payload, Payload::Binary(frame.clone()));
                got += 1;
            }
        }
    };
    tokio::join!(sender, receiver);

    hi.leave().await;
    assert_eq!(
        until(&mut lo, |e| matches!(e, RoomEvent::Left(_))).await,
        RoomEvent::Left(hi_id.into())
    );
    lo.leave().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_rust_peers_pair_over_a_nostr_relay() {
    pair(Strategy::Nostr).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_rust_peers_pair_over_a_tracker() {
    pair(Strategy::Torrent).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_password_is_reported_and_never_joins() {
    let addr = standin::start().await;
    let url = format!("ws://{addr}");
    let mut lo = join(config(Strategy::Nostr, &url, "0000000000000000000a", "pw"))
        .await
        .unwrap();
    let mut hi = join(config(
        Strategy::Nostr,
        &url,
        "zzzzzzzzzzzzzzzzzzzz",
        "other",
    ))
    .await
    .unwrap();
    let e = until(&mut hi, |e| {
        matches!(e, RoomEvent::WrongPassword(_) | RoomEvent::Joined(_))
    })
    .await;
    assert_eq!(e, RoomEvent::WrongPassword("0000000000000000000a".into()));
    let joined = timeout(
        Duration::from_secs(2),
        until(&mut lo, |e| matches!(e, RoomEvent::Joined(_))),
    )
    .await;
    assert!(joined.is_err(), "{joined:?}");
}

#[tokio::test]
async fn no_relay_is_an_error_that_says_so() {
    // A port nothing listens on: every dial fails at once.
    let dead = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let mut c = config(
        Strategy::Nostr,
        &format!("ws://{dead}"),
        "0000000000000000000a",
        "pw",
    );
    c.join_timeout = Duration::from_millis(500);
    let e = join(c).await.unwrap_err();
    assert!(matches!(e, JoinError::NoRelay));
    assert_eq!(e.to_string(), "no signalling server reachable");
}

/// Trystero gives a relay five retries and then never dials it again; a
/// relay here that fails twelve times in a row is still dialled, and the
/// room joins on the thirteenth.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_relay_that_keeps_dropping_is_never_given_up() {
    let addr = standin::start_with(|n| n < 12).await;
    let mut c = config(
        Strategy::Nostr,
        &format!("ws://{addr}"),
        "0000000000000000000a",
        "pw",
    );
    c.backoff = Backoff {
        first: Duration::from_millis(5),
        max: Duration::from_millis(20),
    };
    c.join_timeout = Duration::from_secs(10);
    let room = join(c).await.unwrap();
    room.leave().await;
}

/// After a drop, a relay waits out its backoff -- unless the app says it is
/// back, which redials now.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_redials_at_once() {
    let addr = standin::start_with(|n| n == 0).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let slow = Backoff {
        first: Duration::from_secs(60),
        max: Duration::from_secs(60),
    };
    let relay = Relay::open(0, &format!("ws://{addr}"), slow, tx);
    assert_eq!(
        timeout(WAIT, rx.recv()).await.unwrap(),
        Some(RelayEvent::Up(0))
    );
    assert_eq!(
        timeout(WAIT, rx.recv()).await.unwrap(),
        Some(RelayEvent::Down(0))
    );
    // A minute's backoff ahead; nothing comes in half a second.
    assert!(
        timeout(Duration::from_millis(500), rx.recv())
            .await
            .is_err()
    );
    relay.resume();
    assert_eq!(
        timeout(Duration::from_secs(2), rx.recv()).await.unwrap(),
        Some(RelayEvent::Up(0))
    );
}

/// The lower ID ignores a tracker offer while it holds offers of its own,
/// and a tracker forwards offers only to peers already in the swarm. So a
/// lower peer whose warmup announces are over before the higher one joins
/// must announce again when the higher one's offer arrives, or the two wait
/// out the tracker's interval -- 120 s here, as on the public trackers --
/// and the join times out. Found live against tracker.openwebtorrent.com.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tracker_peer_that_joined_first_still_pairs_as_the_lower_id() {
    let addr = standin::start().await;
    let url = format!("ws://{addr}");
    let lo_id = "0000000000000000000a";
    let hi_id = "zzzzzzzzzzzzzzzzzzzz";
    let mut lo = join(config(Strategy::Torrent, &url, lo_id, "pw"))
        .await
        .unwrap();
    // Past the 233 + 533 + 1333 ms warmup.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mut hi = join(config(Strategy::Torrent, &url, hi_id, "pw"))
        .await
        .unwrap();
    let quick = Duration::from_secs(10);
    let e = timeout(quick, until(&mut lo, |e| matches!(e, RoomEvent::Joined(_))))
        .await
        .expect("lo never joined");
    assert_eq!(e, RoomEvent::Joined(hi_id.into()));
    let e = timeout(quick, until(&mut hi, |e| matches!(e, RoomEvent::Joined(_))))
        .await
        .expect("hi never joined");
    assert_eq!(e, RoomEvent::Joined(lo_id.into()));
}

#[path = "standin/turn.rs"]
mod turn_standin;

/// Both peers relay-only, as `iceTransportPolicy: 'relay'`: neither offers
/// an address of its own, so the only way the two meet is through TURN.
/// The connection settles on the relayed candidate, a message crosses, and
/// the stand-in counts what it carried.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_relay_only_peers_pair_through_turn() {
    use tryst::join::TurnServer;
    let addr = standin::start().await;
    let url = format!("ws://{addr}");
    let (turn, relayed) = turn_standin::start().await;
    let server = TurnServer {
        url: format!("turn:{turn}?transport=udp"),
        username: turn_standin::USERNAME.into(),
        credential: turn_standin::PASSWORD.into(),
    };
    let (lo_id, hi_id) = ("0000000000000000000a", "zzzzzzzzzzzzzzzzzzzz");
    let relay_only = |id| {
        let mut c = config(Strategy::Nostr, &url, id, "pw");
        c.turn = vec![server.clone()];
        c.relay_only = true;
        c
    };
    let mut lo = join(relay_only(lo_id)).await.unwrap();
    let mut hi = join(relay_only(hi_id)).await.unwrap();
    assert_eq!(
        until(&mut lo, |e| matches!(e, RoomEvent::Joined(_))).await,
        RoomEvent::Joined(hi_id.into())
    );
    until(&mut hi, |e| matches!(e, RoomEvent::Joined(_))).await;
    let pair = timeout(WAIT, async {
        loop {
            if let Some(p) = lo.selected_pair(hi_id).await {
                return p;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("no selected pair");
    assert_eq!(pair.local_type, CandidateType::Relay, "{pair:?}");
    assert_eq!(
        lo.send("msg", Payload::Text("via turn".into()), None, Some(hi_id))
            .await,
        Ok(1)
    );
    let RoomEvent::Message { message, .. } =
        until(&mut hi, |e| matches!(e, RoomEvent::Message { .. })).await
    else {
        unreachable!()
    };
    assert_eq!(message.payload, Payload::Text("via turn".into()));
    assert!(relayed.load(std::sync::atomic::Ordering::Relaxed) > 0);
    lo.leave().await;
    hi.leave().await;
}
