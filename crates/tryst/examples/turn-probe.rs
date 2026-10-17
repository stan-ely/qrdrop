//! Allocate on the public Open Relay TURN server and print what it says.
//!
//! Run by hand, not from a test: it needs the network and a server whose
//! static credentials the Open Relay Project may withdraw at any time.
//!
//! ```text
//! cargo run -p tryst --example turn-probe --features turn
//! ```

use std::net::{ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

use tryst::turn::{TurnClient, TurnEvent};

fn main() -> std::io::Result<()> {
    let host = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "openrelay.metered.ca:80".into());
    let server = host
        .to_socket_addrs()?
        .find(|a| a.is_ipv4())
        .expect("no IPv4 address for the server");
    println!("server {host} -> {server}");

    let sock = UdpSocket::bind("0.0.0.0:0")?;
    let mut turn = TurnClient::new(
        server,
        "openrelayproject",
        "openrelayproject",
        Instant::now(),
    );
    let mut buf = [0u8; 2048];
    loop {
        while let Some((to, data)) = turn.poll_transmit() {
            sock.send_to(&data, to)?;
        }
        // Either event ends the probe, so the first one is the answer.
        match turn.poll_event() {
            Some(TurnEvent::Allocated(addr)) => {
                println!("allocated: relayed address {addr}");
                return Ok(());
            }
            Some(TurnEvent::Failed(why)) => {
                println!("failed: {why}");
                return Ok(());
            }
            None => {}
        }
        let wait = turn
            .poll_timeout()
            .map_or(Duration::from_millis(100), |t| {
                t.saturating_duration_since(Instant::now())
            })
            .max(Duration::from_millis(1));
        sock.set_read_timeout(Some(wait))?;
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                if turn.is_from_server(from) {
                    turn.handle_input(from, &buf[..n], Instant::now());
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(e),
        }
        turn.handle_timeout(Instant::now());
    }
}
