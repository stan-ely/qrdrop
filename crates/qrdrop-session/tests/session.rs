//! The session over real rooms: tryst on loopback, through the stand-in
//! relay and tracker the tryst tests use, with real UDP and real str0m. What
//! these port is the behaviour of `test/room.test.mjs` and `lan.test.mjs`.

#[path = "../../tryst/tests/standin/mod.rs"]
mod standin;

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::time::Duration;

use qrdrop_protocol::{Keypair, LanListen, NetworkPath, Role, Secret};
use qrdrop_session::io::{FileSink, FileSource};
use qrdrop_session::pair::{KEY_ACTION, PICK_ACTION};
use qrdrop_session::{
    LanConfig, Network, OpenConfig, OpenError, Paired, SessionEvent, SessionEvents, SessionHandle,
    SessionOptions, open_room,
};
use tokio::time::timeout;
use tryst::join::{JoinConfig, RoomEvent, join};
use tryst::signal::Strategy;
use tryst::wire::Payload;

const WAIT: Duration = Duration::from_secs(30);

/// One network, Nostr, for every test that is about something other than
/// pairing. Racing both here put the two sides on different networks about
/// one pairing in 275 (measured over 25 runs of this file under WSL): the
/// stand-in serves both from one socket, so they finish within a few
/// milliseconds of each other, and each side keeps whichever finished first
/// for it. That is a real bug in `open_room`, not in these tests
/// (docs/notes/pairing-race.md), and it failed whichever test it landed in --
/// a SAS that disagreed, or a transfer into a room the other side had left.
/// The race itself is exercised by `config_race` and the tests that use it.
fn config(secret: &Secret, role: Role, url: &str) -> OpenConfig {
    config_over(secret, role, url, &[Strategy::Nostr])
}

/// Both networks, as the CLI and the app join them.
fn config_race(secret: &Secret, role: Role, url: &str) -> OpenConfig {
    config_over(secret, role, url, &[Strategy::Nostr, Strategy::Torrent])
}

fn config_over(secret: &Secret, role: Role, url: &str, over: &[Strategy]) -> OpenConfig {
    let mut c = OpenConfig::new(Secret::from_bytes(*secret.as_bytes()), role);
    c.networks = over
        .iter()
        .map(|&strategy| Network {
            strategy,
            relays: vec![url.into()],
        })
        .collect();
    c.stun = vec![];
    c.turn = vec![];
    c.bind = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
    c
}

async fn pair_up(url: &str) -> (Paired, Paired, Secret) {
    pair_with(url, config).await
}

async fn pair_with(
    url: &str,
    config: fn(&Secret, Role, &str) -> OpenConfig,
) -> (Paired, Paired, Secret) {
    let secret = Secret::generate();
    let (h, g) = tokio::join!(
        open_room(config(&secret, Role::Host, url)),
        open_room(config(&secret, Role::Guest, url))
    );
    (h.unwrap(), g.unwrap(), secret)
}

async fn until(
    ev: &mut SessionEvents,
    mut want: impl FnMut(&SessionEvent) -> bool,
) -> SessionEvent {
    timeout(WAIT, async {
        loop {
            let e = ev.next().await.expect("the session ended");
            if let SessionEvent::Failed(f) = &e
                && !want(&e)
            {
                panic!("failed: {f}");
            }
            if want(&e) {
                return e;
            }
        }
    })
    .await
    .expect("timed out")
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("qrdrop-session-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Send `len` bytes host to guest and check they arrive whole. Returns the
/// two event streams for anything else a test wants to look at.
async fn transfer(
    name: &str,
    len: usize,
    (h, mut he): (SessionHandle, SessionEvents),
    (g, mut ge): (SessionHandle, SessionEvents),
) -> (Vec<SessionEvent>, Vec<SessionEvent>) {
    let dir = scratch(name);
    let src = dir.join("src.bin");
    let data: Vec<u8> = (0..len).map(|i| (i * 7 % 256) as u8).collect();
    std::fs::write(&src, &data).unwrap();
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();

    h.send_file(Box::new(FileSource::open(&src).unwrap()));
    let mut guest_seen = vec![];
    let offer = until(&mut ge, |e| {
        guest_seen.push(e.clone());
        matches!(e, SessionEvent::Offer(_))
    })
    .await;
    let SessionEvent::Offer(m) = offer else {
        unreachable!()
    };
    g.accept(Box::new(FileSink::create(&out, &m.name).unwrap()));
    let mut host_seen = vec![];
    let sent = until(&mut he, |e| {
        host_seen.push(e.clone());
        matches!(e, SessionEvent::Sent { .. })
    })
    .await;
    let received = until(&mut ge, |e| {
        guest_seen.push(e.clone());
        matches!(e, SessionEvent::Received { .. })
    })
    .await;
    let (
        SessionEvent::Sent { digest: a },
        SessionEvent::Received {
            digest: b,
            location,
            ..
        },
    ) = (sent, received)
    else {
        unreachable!()
    };
    assert_eq!(a, b);
    assert_eq!(std::fs::read(&location).unwrap(), data);
    g.close().await;
    h.close().await;
    let _ = std::fs::remove_dir_all(&dir);
    (host_seen, guest_seen)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_sessions_pair_over_the_race_and_move_a_file() {
    let url = format!("ws://{}", standin::start().await);
    // Still exposed to the race below, at about one run in 275, because it
    // is the one test of pairing the way a real device pairs.
    let (h, g, _) = pair_with(&url, config_race).await;
    assert_eq!(h.sas(), g.sas());
    let hs = h.confirm(Role::Host, SessionOptions::default()).await;
    let gs = g.confirm(Role::Guest, SessionOptions::default()).await;
    // Loopback, host candidates both ends: the bytes stay local.
    assert_eq!(hs.0.path().await, NetworkPath::Local);
    let (host_seen, _) = transfer("race", 300_000, hs, gs).await;
    assert!(
        host_seen.iter().any(|e| matches!(
            e,
            SessionEvent::Path {
                combined: NetworkPath::Local,
                ..
            }
        )),
        "{host_seen:?}"
    );
}

/// The CLI shape that broke between two CLIs: one side confirms at once and
/// starts sending (a path verdict, then a hello: control 0 and 1), while the
/// other is still reading its SAS. Those frames are held, not dropped, and
/// handed over in order at the confirm.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn frames_sent_while_the_other_side_reads_its_sas_are_held() {
    let url = format!("ws://{}", standin::start().await);
    let (h, g, _) = pair_up(&url).await;
    let lan = SessionOptions {
        lan: Some(LanConfig {
            listen: LanListen::Prompt,
        }),
        quic: None,
    };
    let hs = h.confirm(Role::Host, lan).await;
    hs.0.path().await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let gs = g.confirm(Role::Guest, SessionOptions::default()).await;
    transfer("early", 50_000, hs, gs).await;
}

/// A third device holding the code joins the room and sends frames at
/// everyone. A runt from the paired peer is fatal, so if a stranger's ever
/// reached the session this transfer would fail.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stranger_in_the_room_never_reaches_the_session() {
    let url = format!("ws://{}", standin::start().await);
    let secret = Secret::generate();
    let (h, g) = tokio::join!(
        open_room(config(&secret, Role::Host, &url)),
        open_room(config(&secret, Role::Guest, &url))
    );
    let (h, g) = (h.unwrap(), g.unwrap());
    let mut jc = JoinConfig::new(
        Strategy::Nostr,
        "qrdrop",
        &secret.topic(),
        &secret.password(),
        &[&url],
    );
    jc.bind = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let mut stranger = join(jc).await.unwrap();
    let hs = h.confirm(Role::Host, SessionOptions::default()).await;
    let gs = g.confirm(Role::Guest, SessionOptions::default()).await;
    let pest = tokio::spawn(async move {
        loop {
            match stranger.next_event().await {
                Some(RoomEvent::Joined(_)) => {
                    let _ = stranger
                        .send("frame", Payload::Binary(vec![1; 14]), None, None)
                        .await;
                }
                Some(_) => {}
                None => return,
            }
        }
    });
    tokio::time::sleep(Duration::from_millis(1500)).await;
    transfer("stranger", 50_000, hs, gs).await;
    pest.abort();
}

/// One ECDH keypair per join, never cached: pairing twice over one secret
/// gives two sessions that do not share keys. The SAS is derived from the
/// session keys, so two that differ show it (but for one chance in 2^24).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_pairings_over_one_secret_share_no_keys() {
    let url = format!("ws://{}", standin::start().await);
    let (h1, g1, secret) = pair_up(&url).await;
    let first = *h1.sas();
    h1.reject().await;
    g1.reject().await;
    let (h2, g2) = tokio::join!(
        open_room(config(&secret, Role::Host, &url)),
        open_room(config(&secret, Role::Guest, &url))
    );
    let (h2, g2) = (h2.unwrap(), g2.unwrap());
    assert_eq!(h2.sas(), g2.sas());
    assert_ne!(h2.sas(), &first);
}

/// The pairing network race (docs/notes/pairing-race.md): each side of
/// `open_room` keeps whichever network finished first for it, with a keypair
/// of its own per network, so two sides that keep different ones show
/// different SASes and talk into different rooms. It needs the two networks
/// to finish within a few milliseconds, which load provides and an idle
/// machine does not: 1000 pairings one after another never showed it on
/// Windows, while the whole file in parallel did. So this pairs many at
/// once, and is ignored until the fix lands. `cargo test -p qrdrop-session
/// --all-features --test session -- --ignored` runs it.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "fails until the pairing network race is fixed: docs/notes/pairing-race.md"]
async fn both_sides_of_a_raced_pairing_keep_the_same_network() {
    let url = format!("ws://{}", standin::start().await);
    for round in 0..20 {
        let pairings: Vec<_> = (0..24)
            .map(|_| {
                let url = url.clone();
                tokio::spawn(async move {
                    let (h, g, _) = pair_with(&url, config_race).await;
                    let kept = ((h.strategy(), *h.sas()), (g.strategy(), *g.sas()));
                    h.reject().await;
                    g.reject().await;
                    kept
                })
            })
            .collect();
        for (i, p) in pairings.into_iter().enumerate() {
            let (host, guest) = p.await.unwrap();
            assert_eq!(
                host, guest,
                "round {round}, pairing {i}: host and guest kept"
            );
        }
    }
}

/// The host's half of the fix for the race above: once it has kept a network
/// it sends a pick there, and only there, carrying a value the guest derives
/// from its own session. The guest here is a bare tryst room doing the key
/// exchange by hand, because a `Paired` drops every action but frames.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_host_says_which_network_it_kept() {
    let url = format!("ws://{}", standin::start().await);
    let secret = Secret::generate();
    let host = open_room(config(&secret, Role::Host, &url));
    let guest = async {
        let mut jc = JoinConfig::new(
            Strategy::Nostr,
            "qrdrop",
            &secret.topic(),
            &secret.password(),
            &[&url],
        );
        jc.bind = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let mut room = join(jc).await.unwrap();
        let mut keypair = Some(Keypair::generate());
        let public = keypair.as_ref().unwrap().public_key_b64url();
        let mut pairing = None;
        timeout(WAIT, async {
            loop {
                match room.next_event().await.expect("the room closed") {
                    RoomEvent::Joined(peer) => {
                        let _ = room
                            .send(KEY_ACTION, Payload::Text(public.clone()), None, Some(&peer))
                            .await;
                    }
                    RoomEvent::Message { message, .. } if message.action == KEY_ACTION => {
                        let (Some(kp), Payload::Text(theirs)) = (keypair.take(), message.payload)
                        else {
                            continue;
                        };
                        pairing = Some(kp.establish_b64url(&theirs, &secret, Role::Guest).unwrap());
                    }
                    RoomEvent::Message { message, .. } if message.action == PICK_ACTION => {
                        let Payload::Text(pick) = message.payload else {
                            panic!("a pick that is not text");
                        };
                        let ours = pairing.as_ref().expect("a pick before the key exchange");
                        return (pick, ours.pick(), *ours.sas(), room);
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("no pick arrived")
    };
    let (h, (pick, ours, sas, room)) = tokio::join!(host, guest);
    let h = h.unwrap();
    assert_eq!(pick, ours);
    assert_eq!(h.sas(), &sas);
    h.reject().await;
    room.leave().await;
}

#[tokio::test]
async fn nobody_arriving_is_a_timeout_that_says_so() {
    let url = format!("ws://{}", standin::start().await);
    let mut c = config(&Secret::generate(), Role::Host, &url);
    c.timeout = Duration::from_millis(800);
    let e = open_room(c).await.unwrap_err();
    assert!(matches!(e, OpenError::Timeout), "{e:?}");
    assert_eq!(e.to_string(), "Timed out waiting for the other device");
}

/// This machine's private IPv4 address, if it has one: the LAN path offers
/// only private addresses and refuses loopback, as the JS does, so it is
/// tested over the real interface or not at all.
#[cfg(all(feature = "lan-listen", feature = "lan-dial"))]
fn private_address() -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    s.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if ip.is_private() => Some(ip),
        _ => None,
    }
}

#[cfg(all(feature = "lan-listen", feature = "lan-dial"))]
async fn over_lan(sender: LanListen, receiver: LanListen, name: &str) {
    if private_address().is_none() {
        eprintln!("skipped: no private IPv4 address on this machine");
        return;
    }
    let url = format!("ws://{}", standin::start().await);
    let (h, g, _) = pair_up(&url).await;
    let hs = h
        .confirm(
            Role::Host,
            SessionOptions {
                lan: Some(LanConfig { listen: sender }),
                quic: None,
            },
        )
        .await;
    let gs = g
        .confirm(
            Role::Guest,
            SessionOptions {
                lan: Some(LanConfig { listen: receiver }),
                quic: None,
            },
        )
        .await;
    let (host_seen, guest_seen) = transfer(name, 2 * 1024 * 1024, hs, gs).await;
    assert!(
        host_seen.contains(&SessionEvent::Lan),
        "the sender never switched: {host_seen:?}"
    );
    assert!(
        guest_seen.contains(&SessionEvent::Lan),
        "no frame arrived over the link"
    );
}

#[cfg(all(feature = "lan-listen", feature = "lan-dial"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_file_crosses_the_lan_when_the_receiver_listens() {
    over_lan(LanListen::Prompt, LanListen::Quiet, "lan-receiver").await;
}

#[cfg(all(feature = "lan-listen", feature = "lan-dial"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_file_crosses_the_lan_when_the_sender_listens() {
    over_lan(LanListen::Quiet, LanListen::Prompt, "lan-sender").await;
}

/// Neither side can listen quietly: no listener, no prompt, and the file
/// goes over WebRTC with nothing said about the LAN.
#[cfg(all(feature = "lan-listen", feature = "lan-dial"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_nobody_quiet_the_file_stays_on_webrtc() {
    let url = format!("ws://{}", standin::start().await);
    let (h, g, _) = pair_up(&url).await;
    let prompt = SessionOptions {
        lan: Some(LanConfig {
            listen: LanListen::Prompt,
        }),
        quic: None,
    };
    let hs = h.confirm(Role::Host, prompt.clone()).await;
    let gs = g.confirm(Role::Guest, prompt).await;
    let (host_seen, guest_seen) = transfer("lan-none", 100_000, hs, gs).await;
    assert!(!host_seen.contains(&SessionEvent::Lan) && !guest_seen.contains(&SessionEvent::Lan));
}

/// Two sessions with every default -- qrdrop's public relays and trackers,
/// its STUN and TURN servers, the default route's interface -- pairing and
/// moving a file. Ignored, as the e2e suites are kept out of `npm test`: it
/// needs the goodwill of public infrastructure. `cargo test -- --ignored`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn live_two_sessions_pair_over_the_public_networks() {
    let secret = Secret::generate();
    let (h, g) = tokio::join!(
        open_room(OpenConfig::new(
            Secret::from_bytes(*secret.as_bytes()),
            Role::Host
        )),
        open_room(OpenConfig::new(
            Secret::from_bytes(*secret.as_bytes()),
            Role::Guest
        ))
    );
    let (h, g) = (h.unwrap(), g.unwrap());
    eprintln!("paired over {:?}", h.strategy());
    let hs = h.confirm(Role::Host, SessionOptions::default()).await;
    let gs = g.confirm(Role::Guest, SessionOptions::default()).await;
    eprintln!("path: {:?}", hs.0.path().await);
    let started = std::time::Instant::now();
    transfer("live", 8 * 1024 * 1024, hs, gs).await;
    eprintln!("8 MiB in {:?}", started.elapsed());
}

#[cfg(feature = "quic")]
fn quic_options() -> SessionOptions {
    SessionOptions {
        lan: None,
        quic: Some(qrdrop_session::QuicConfig {
            bind: Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            stun: vec![],
        }),
    }
}

/// Two Rust peers with the QUIC path: the sender's frames move to it at
/// Accept, both ends say so, and the file arrives whole over it -- 8 MiB, so
/// it is the stream and not WebRTC that carries nearly all of it.
#[cfg(feature = "quic")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_rust_peers_move_the_file_over_quic() {
    let url = format!("ws://{}", standin::start().await);
    let (h, g, _) = pair_up(&url).await;
    let hs = h.confirm(Role::Host, quic_options()).await;
    let gs = g.confirm(Role::Guest, quic_options()).await;
    let (host_seen, guest_seen) = transfer("quic", 8 * 1024 * 1024, hs, gs).await;
    assert!(
        host_seen.contains(&SessionEvent::Quic),
        "the sender never switched: {host_seen:?}"
    );
    assert!(
        guest_seen.contains(&SessionEvent::Quic),
        "nothing arrived over QUIC: {guest_seen:?}"
    );
}

/// Both direct paths up: LAN carries the file and QUIC carries nothing. A
/// phone sender measured LAN well ahead of QUIC on one network (session.rs,
/// `at_accept`). The QUIC endpoint idling beside it must not fail the
/// transfer as it closes, either.
#[cfg(all(feature = "quic", feature = "lan-listen", feature = "lan-dial"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_both_direct_paths_up_the_file_takes_the_lan() {
    if private_address().is_none() {
        eprintln!("skipped: no private IPv4 address on this machine");
        return;
    }
    let url = format!("ws://{}", standin::start().await);
    let (h, g, _) = pair_up(&url).await;
    let both = |listen| SessionOptions {
        lan: Some(LanConfig { listen }),
        ..quic_options()
    };
    let hs = h.confirm(Role::Host, both(LanListen::Prompt)).await;
    let gs = g.confirm(Role::Guest, both(LanListen::Quiet)).await;
    let (host_seen, guest_seen) = transfer("lan-and-quic", 8 * 1024 * 1024, hs, gs).await;
    assert!(
        host_seen.contains(&SessionEvent::Lan) && !host_seen.contains(&SessionEvent::Quic),
        "{host_seen:?}"
    );
    assert!(
        guest_seen.contains(&SessionEvent::Lan) && !guest_seen.contains(&SessionEvent::Quic),
        "{guest_seen:?}"
    );
}

/// A sender with the path and a receiver without it -- a JS peer, or a
/// build without the feature -- never hears a `quic-hello` back, and goes on
/// at Accept over WebRTC without waiting out quic::LINK_WAIT.
#[cfg(feature = "quic")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_receiver_without_quic_costs_the_sender_no_wait() {
    let url = format!("ws://{}", standin::start().await);
    let (h, g, _) = pair_up(&url).await;
    let hs = h.confirm(Role::Host, quic_options()).await;
    let gs = g.confirm(Role::Guest, SessionOptions::default()).await;
    let started = std::time::Instant::now();
    let (host_seen, guest_seen) = transfer("quic-none", 50_000, hs, gs).await;
    assert!(
        started.elapsed() < qrdrop_session::quic::LINK_WAIT,
        "took {:?}",
        started.elapsed()
    );
    assert!(!host_seen.contains(&SessionEvent::Quic), "{host_seen:?}");
    assert!(!guest_seen.contains(&SessionEvent::Quic), "{guest_seen:?}");
}
