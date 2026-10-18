//! One side of a timed transfer, for measuring a path between two machines
//! or two network namespaces: the harness under "The QUIC path, against
//! SCTP" in app/CAPABILITIES.md runs one of these on each end of a veth pair
//! with netem on it.
//!
//! ```text
//! bench code                                      # prints a fresh code
//! bench host  --code C --bind IP --relay-at IP:PORT --size BYTES
//! bench guest --code C --bind IP --relay ws://IP:PORT
//! ```
//!
//! The host serves the stand-in relay itself, so a namespace with no route
//! to the internet still pairs, and sends; the guest receives and prints one
//! JSON line, `{"mbps":…, "secs":…, "bytes":…}`, timed from its Accept to the
//! verified digest. The bytes come from memory and go nowhere, so a disk is
//! never what is measured. The local-network path is off: it is a WebSocket
//! over TCP, and what this compares is the paths that cross the internet.

#[path = "../../tryst/tests/standin/mod.rs"]
mod standin;

use std::io;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use qrdrop_protocol::{Role, Secret};
use qrdrop_session::{Network, OpenConfig, SessionEvent, SessionOptions, Sink, Source, open_room};
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
    let role = match mode {
        "host" => Role::Host,
        "guest" => Role::Guest,
        _ => panic!("bench code | host | guest"),
    };
    let secret = Secret::decode(&need(&args, "--code")).expect("a qrdrop code");
    let bind: IpAddr = need(&args, "--bind").parse().expect("an address");
    let relay = match role {
        Role::Host => format!(
            "ws://{}",
            standin::start_on(&need(&args, "--relay-at")).await
        ),
        Role::Guest => need(&args, "--relay"),
    };

    let mut cfg = OpenConfig::new(secret, role);
    cfg.networks = vec![Network {
        strategy: Strategy::Nostr,
        relays: vec![relay],
    }];
    cfg.stun = vec![];
    cfg.turn = vec![];
    cfg.bind = Some(bind);
    cfg.timeout = Duration::from_secs(60);
    let paired = open_room(cfg).await.expect("paired");
    let (session, mut events) = paired.confirm(role, SessionOptions { lan: None }).await;

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
        while let Some(e) = events.next().await {
            match e {
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
