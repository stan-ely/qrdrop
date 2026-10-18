//! One side of a timed transfer, for measuring a path between two machines
//! or two network namespaces: the harness under "The QUIC path, against
//! SCTP" in app/CAPABILITIES.md runs one of these on each end of a veth pair
//! with netem on it.
//!
//! ```text
//! bench code                                      # prints a fresh code
//! bench host  --code C --bind IP --relay-at IP:PORT --size BYTES
//! bench guest --code C --bind IP --relay ws://IP:PORT
//! bench serve --relay-at IP:PORT --stun-at IP:PORT   # relay and STUN, for peers behind NATs
//! ```
//!
//! The host serves the stand-in relay itself, so a namespace with no route
//! to the internet still pairs, unless it is given `--relay ws://…` -- as
//! both peers are when each sits behind its own NAT and `bench serve` runs
//! between them, with `--stun IP:PORT` so each learns its mapped address.
//! The host sends; the guest receives and prints one
//! JSON line, `{"mbps":…, "secs":…, "bytes":…}`, timed from its Accept to the
//! verified digest. The bytes come from memory and go nowhere, so a disk is
//! never what is measured. The local-network path is off: it is a WebSocket
//! over TCP, and what this compares is the paths that cross the internet.
//! `--quic` on both sides offers the QUIC path (built with `--features
//! quic`), bound to the same address; the guest's line then says which path
//! carried the file.

#[path = "../../tryst/tests/standin/mod.rs"]
mod standin;

use std::io;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use qrdrop_protocol::{Role, Secret};
use qrdrop_session::{
    Network, OpenConfig, QuicConfig, SessionEvent, SessionOptions, Sink, Source, open_room,
};
use tryst::signal::Strategy;

struct Pattern {
    size: u64,
    at: u64,
}

impl Source for Pattern {
    fn name(&self) -> &str {
        "bench.bin"
    }
    fn size(&self) -> u64 {
        self.size
    }
    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        for b in buf.iter_mut() {
            *b = (self.at % 251) as u8;
            self.at += 1;
        }
        Ok(())
    }
}

struct Discard;

impl Sink for Discard {
    fn write(&mut self, _: &[u8]) -> io::Result<()> {
        Ok(())
    }
    fn close(self: Box<Self>) -> io::Result<String> {
        Ok("nowhere".into())
    }
    fn abort(self: Box<Self>) {}
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn need(args: &[String], name: &str) -> String {
    arg(args, name).unwrap_or_else(|| panic!("{name} is required"))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("");
    if mode == "code" {
        println!("{}", Secret::generate().code());
        return;
    }
    if mode == "serve" {
        let relay = standin::start_on(&need(&args, "--relay-at")).await;
        let stun = tokio::net::UdpSocket::bind(need(&args, "--stun-at"))
            .await
            .expect("a STUN address");
        println!(
            "{}",
            serde_json::json!({ "relay": format!("ws://{relay}") })
        );
        stun_server(stun).await;
        return;
    }
    let role = match mode {
        "host" => Role::Host,
        "guest" => Role::Guest,
        _ => panic!("bench code | host | guest"),
    };
    let secret = Secret::decode(&need(&args, "--code")).expect("a qrdrop code");
    let bind: IpAddr = need(&args, "--bind").parse().expect("an address");
    let relay = match arg(&args, "--relay") {
        Some(url) => url,
        None => format!(
            "ws://{}",
            standin::start_on(&need(&args, "--relay-at")).await
        ),
    };
    let stun: Vec<String> = arg(&args, "--stun").into_iter().collect();

    let mut cfg = OpenConfig::new(secret, role);
    cfg.networks = vec![Network {
        strategy: Strategy::Nostr,
        relays: vec![relay],
    }];
    cfg.stun = stun.clone();
    cfg.turn = vec![];
    cfg.bind = Some(bind);
    cfg.timeout = Duration::from_secs(60);
    // To stderr, which a harness reads only when a run fails: where pairing
    // stopped ("Waiting for the other device") is most of what a failure
    // behind two NATs has to say.
    cfg.on_status = Some(std::sync::Arc::new(|t: &str| eprintln!("status: {t}")));
    let paired = open_room(cfg).await.expect("paired");
    let opts = SessionOptions {
        lan: None,
        quic: args.iter().any(|a| a == "--quic").then_some(QuicConfig {
            bind: Some(bind),
            stun,
        }),
    };
    let (session, mut events) = paired.confirm(role, opts).await;

    if role == Role::Host {
        let size: u64 = need(&args, "--size").parse().expect("a size");
        session.send_file(Box::new(Pattern { size, at: 0 }));
        while let Some(e) = events.next().await {
            match e {
                SessionEvent::Sent { .. } => break,
                SessionEvent::Failed(f) => panic!("{f}"),
                _ => {}
            }
        }
        // Long enough for the guest's leave to arrive first, so neither side
        // reports the other's exit as a failure.
        tokio::time::sleep(Duration::from_millis(500)).await;
    } else {
        let mut started = None;
        let mut path = "webrtc";
        while let Some(e) = events.next().await {
            match e {
                SessionEvent::Quic => path = "quic",
                SessionEvent::Offer(_) => {
                    started = Some(Instant::now());
                    session.accept(Box::new(Discard));
                }
                SessionEvent::Received { size, .. } => {
                    let secs = started.expect("an offer first").elapsed().as_secs_f64();
                    println!(
                        "{}",
                        serde_json::json!({
                            "mbps": (size as f64 / 1e6 / secs * 100.0).round() / 100.0,
                            "secs": (secs * 1000.0).round() / 1000.0,
                            "bytes": size,
                            "path": path,
                        })
                    );
                    break;
                }
                SessionEvent::Failed(f) => panic!("{f}"),
                _ => {}
            }
        }
    }
    session.close().await;
}

/// Enough of RFC 8489 to answer a Binding request: the same transaction ID
/// and an XOR-MAPPED-ADDRESS of the IPv4 address it came from.
async fn stun_server(sock: tokio::net::UdpSocket) {
    const COOKIE: u32 = 0x2112_A442;
    let mut buf = [0u8; 1500];
    loop {
        let Ok((n, from)) = sock.recv_from(&mut buf).await else {
            continue;
        };
        let std::net::SocketAddr::V4(from) = from else {
            continue;
        };
        if n < 20 || buf[0..2] != [0x00, 0x01] || buf[4..8] != COOKIE.to_be_bytes() {
            continue;
        }
        let mut out = Vec::with_capacity(32);
        out.extend_from_slice(&[0x01, 0x01, 0x00, 0x0c]);
        out.extend_from_slice(&buf[4..20]);
        out.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
        out.extend_from_slice(&(from.port() ^ (COOKIE >> 16) as u16).to_be_bytes());
        out.extend_from_slice(&(u32::from(*from.ip()) ^ COOKIE).to_be_bytes());
        let _ = sock.send_to(&out, from).await;
    }
}
