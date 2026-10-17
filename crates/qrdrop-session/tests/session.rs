//! The session over real rooms: tryst on loopback, through the stand-in
//! relay and tracker the tryst tests use, with real UDP and real str0m. What
//! these port is the behaviour of `test/room.test.mjs` and `lan.test.mjs`.

#[path = "../../tryst/tests/standin/mod.rs"]
mod standin;

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::time::Duration;

use qrdrop_protocol::{LanListen, NetworkPath, Role, Secret};
use qrdrop_session::io::{FileSink, FileSource};
use qrdrop_session::{
    LanConfig, Network, OpenConfig, OpenError, Paired, SessionEvent, SessionEvents, SessionHandle,
    SessionOptions, open_room,
};
use tokio::time::timeout;
use tryst::join::{JoinConfig, RoomEvent, join};
use tryst::signal::Strategy;
use tryst::wire::Payload;

const WAIT: Duration = Duration::from_secs(30);

fn config(secret: &Secret, role: Role, url: &str) -> OpenConfig {
    let mut c = OpenConfig::new(Secret::from_bytes(*secret.as_bytes()), role);
    c.networks = vec![
        Network {
            strategy: Strategy::Nostr,
            relays: vec![url.into()],
        },
        Network {
            strategy: Strategy::Torrent,
            relays: vec![url.into()],
        },
    ];
    c.stun = vec![];
    c.turn = vec![];
    c.bind = Some(IpAddr::V4(Ipv4Addr::LOCALHOST));
    c
}

async fn pair_up(url: &str) -> (Paired, Paired, Secret) {
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
    let (h, g, _) = pair_up(&url).await;
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
            },
        )
        .await;
    let gs = g
        .confirm(
            Role::Guest,
            SessionOptions {
                lan: Some(LanConfig { listen: receiver }),
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
    };
    let hs = h.confirm(Role::Host, prompt).await;
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
