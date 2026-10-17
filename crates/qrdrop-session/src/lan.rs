//! The local-network fast path: `src/transport/lan.js`, with the listener of
//! `src/node/lan-server.js` and `app/src-tauri/src/lan.rs`.
//!
//! Only the sender's frames move, and only from the receiver's Accept on:
//! that is the one moment every frame already sent over WebRTC is one the
//! receiver has provably handled, so nothing on the new channel can overtake
//! anything on the old (lan.js, "WHY ACCEPT IS THE ONE MOMENT TO MOVE"). The
//! frames that move are the same sealed frames into the same session, so the
//! socket adds speed, not trust: the token keeps the socket for our peer, and
//! the AEAD keeps the frames ours.
//!
//! The negotiation itself -- who says hello when, who listens -- is the
//! session driver's (`session.rs`), because it is ordered against the control
//! stream. This module is the parts that are not: the listener rule, the
//! offer check, and the two ends of the socket.

use std::net::Ipv4Addr;
use std::time::Duration;

use qrdrop_protocol::{LanListen, Role};

/// How long a sender that has seen the peer's hello waits at Accept for the
/// link, as `LINK_WAIT_MS`.
pub const LINK_WAIT: Duration = Duration::from_secs(2);
/// Per address, for the connect and again for the token exchange after it.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(2);
/// How long the listener gives a connection to present the token.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// The listener's one-byte answer to a good token. Frames are never one byte.
pub const ACK: u8 = 0x06;
pub const TOKEN_BYTES: usize = 16;
/// The most addresses an offer is dialled at; more are dropped, as by
/// `parseOffer`.
pub const MAX_ADDRS: usize = 8;
/// A little over the largest sealed frame accepted inbound. Anything bigger
/// is a peer not speaking this protocol, and it is closed rather than
/// buffered.
pub const MAX_MESSAGE: usize = 64 * 1024;

/// Which side listens, from the two hellos: a quiet side in preference to
/// one that would prompt, the receiver when both are quiet, and nobody when
/// neither is. Both sides compute it from the same pair, so they agree
/// without a further message. `Host` is the sender.
pub fn choose_listener(sender: LanListen, receiver: LanListen) -> Option<Role> {
    if receiver == LanListen::Quiet {
        Some(Role::Guest)
    } else if sender == LanListen::Quiet {
        Some(Role::Host)
    } else {
        None
    }
}

/// Whether listening here is quiet, as `nodeLanPlatform` decides it: Linux
/// and Android have no per-application prompt for an inbound connection;
/// Windows Defender Firewall and macOS's application firewall ask the
/// person, so there it is `prompt` and nothing listens. A build without
/// `lan-listen` cannot listen at all and says `none` -- the protocol says
/// what a build lacks, and never guesses.
pub fn default_listen() -> LanListen {
    if !cfg!(feature = "lan-listen") {
        LanListen::None
    } else if cfg!(any(target_os = "linux", target_os = "android")) {
        LanListen::Quiet
    } else {
        LanListen::Prompt
    }
}

/// A peer's offer, checked before anything dials it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub addrs: Vec<Ipv4Addr>,
    pub port: u16,
    pub token: [u8; TOKEN_BYTES],
}

/// `parseOffer`. The peer is authenticated, but it is also a different
/// build, possibly a buggy or hostile one, and this is where its words turn
/// into outbound connections: dotted IPv4 on a private range, not loopback,
/// so an offer can aim this side neither at a host on the internet nor at a
/// service on this machine.
pub fn parse_offer(addrs: &[String], port: u64, token: &str) -> Option<Offer> {
    let port = u16::try_from(port).ok().filter(|p| *p != 0)?;
    let token = parse_token(token)?;
    let addrs: Vec<Ipv4Addr> = addrs
        .iter()
        .take(MAX_ADDRS)
        .filter(|a| dotted(a))
        .filter_map(|a| a.parse::<Ipv4Addr>().ok())
        .filter(|ip| !ip.is_loopback() && crate::path::is_private((*ip).into()))
        .collect();
    (!addrs.is_empty()).then_some(Offer { addrs, port, token })
}

/// `^\d{1,3}(\.\d{1,3}){3}$`, which `Ipv4Addr`'s parser is stricter than in
/// one way (no leading zeros) and the JS is not; checked first so the two
/// refuse the same strings.
fn dotted(a: &str) -> bool {
    let parts: Vec<&str> = a.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// 32 lowercase hex characters, as `^[0-9a-f]{32}$`.
pub fn parse_token(hex: &str) -> Option<[u8; TOKEN_BYTES]> {
    if hex.len() != TOKEN_BYTES * 2 || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let mut out = [0u8; TOKEN_BYTES];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

pub fn token_hex(token: &[u8; TOKEN_BYTES]) -> String {
    token.iter().map(|b| format!("{b:02x}")).collect()
}

/// No early exit, so the time a comparison takes says nothing about how
/// much of a guessed token was right.
pub fn same_token(candidate: &[u8], token: &[u8; TOKEN_BYTES]) -> bool {
    candidate.len() == TOKEN_BYTES
        && candidate
            .iter()
            .zip(token)
            .fold(0u8, |d, (a, b)| d | (a ^ b))
            == 0
}

#[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
pub(crate) use socket::*;

#[cfg(any(feature = "lan-dial", feature = "lan-listen"))]
mod socket {
    use std::pin::Pin;

    use futures_util::{Sink, SinkExt, Stream, StreamExt};
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
    use tokio_tungstenite::tungstenite::{Error, Message};

    use super::*;

    pub(crate) type WsTx = Pin<Box<dyn Sink<Message, Error = Error> + Send>>;
    pub(crate) type WsRx = Pin<Box<dyn Stream<Item = Result<Message, Error>> + Send>>;

    /// One authenticated link: one sealed frame per binary message.
    pub(crate) struct LanSocket {
        pub tx: WsTx,
        pub rx: WsRx,
    }

    pub(crate) fn ws_config() -> WebSocketConfig {
        WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE))
    }

    pub(crate) fn split<S>(ws: S) -> LanSocket
    where
        S: Sink<Message, Error = Error> + Stream<Item = Result<Message, Error>> + Send + 'static,
    {
        let (tx, rx) = ws.split();
        LanSocket {
            tx: Box::pin(tx),
            rx: Box::pin(rx),
        }
    }

    /// The first binary message, skipping pings and text; `None` if the
    /// socket ends first.
    async fn first_binary(rx: &mut WsRx) -> Option<Vec<u8>> {
        while let Some(m) = rx.next().await {
            match m.ok()? {
                Message::Binary(b) => return Some(b.to_vec()),
                Message::Close(_) => return None,
                _ => {}
            }
        }
        None
    }

    /// The dialling side: every address at once, the first to connect and
    /// acknowledge the token wins, and the rest are closed. `None` means
    /// staying on WebRTC, which is where the session already is: two devices
    /// that cannot reach each other directly is ordinary, not an error.
    #[cfg(feature = "lan-dial")]
    pub(crate) async fn dial(offer: &Offer) -> Option<LanSocket> {
        use futures_util::stream::FuturesUnordered;

        let mut attempts: FuturesUnordered<_> = offer
            .addrs
            .iter()
            .map(|a| dial_one(format!("ws://{a}:{}/", offer.port), offer.token))
            .collect();
        while let Some(r) = attempts.next().await {
            if r.is_some() {
                // Dropping the rest closes any that also connected; the
                // listener takes one connection and refuses the others anyway.
                return r;
            }
        }
        None
    }

    #[cfg(feature = "lan-dial")]
    async fn dial_one(url: String, token: [u8; TOKEN_BYTES]) -> Option<LanSocket> {
        let (ws, _) = tokio::time::timeout(
            DIAL_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(url, Some(ws_config()), true),
        )
        .await
        .ok()?
        .ok()?;
        let mut s = split(ws);
        s.tx.send(Message::Binary(token.to_vec().into()))
            .await
            .ok()?;
        let ack = tokio::time::timeout(DIAL_TIMEOUT, first_binary(&mut s.rx))
            .await
            .ok()??;
        (ack == [ACK]).then_some(s)
    }

    /// A listener waiting for its one connection.
    #[cfg(feature = "lan-listen")]
    pub(crate) struct Listening {
        pub addrs: Vec<String>,
        pub port: u16,
        pub listener: tokio::net::TcpListener,
    }

    /// Bind every interface on a free port. The offer names this machine's
    /// private IPv4 addresses, the default route's first.
    #[cfg(feature = "lan-listen")]
    pub(crate) async fn listen() -> std::io::Result<Listening> {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        let port = listener.local_addr()?.port();
        Ok(Listening {
            addrs: offered_addresses(),
            port,
            listener,
        })
    }

    /// Connections one at a time until one presents the token within
    /// [`HANDSHAKE_TIMEOUT`]; that one is answered [`ACK`] and returned, and
    /// the listener is dropped with it. A stranger who reaches the port is
    /// closed. Even one who somehow presented the token could only inject
    /// frames, and those fail their tag.
    #[cfg(feature = "lan-listen")]
    pub(crate) async fn accept(l: Listening, token: [u8; TOKEN_BYTES]) -> Option<LanSocket> {
        loop {
            let (tcp, _) = l.listener.accept().await.ok()?;
            let _ = tcp.set_nodelay(true);
            let attempt = async {
                let ws = tokio_tungstenite::accept_async_with_config(tcp, Some(ws_config()))
                    .await
                    .ok()?;
                let mut s = split(ws);
                let first = first_binary(&mut s.rx).await?;
                if !same_token(&first, &token) {
                    return None;
                }
                s.tx.send(Message::Binary(vec![ACK].into())).await.ok()?;
                Some(s)
            };
            if let Ok(Some(s)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, attempt).await {
                return Some(s);
            }
        }
    }

    /// The default route's address first -- the likeliest to work -- then
    /// every other interface's, private only, as `parseOffer` on the other
    /// end demands. Every interface and not only the default route's,
    /// because on a phone running a VPN the default route is the tunnel.
    #[cfg(feature = "lan-listen")]
    fn offered_addresses() -> Vec<String> {
        let primary = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .and_then(|s| {
                s.connect((Ipv4Addr::new(192, 0, 2, 1), 9))
                    .and_then(|_| s.local_addr())
            })
            .ok()
            .and_then(|a| match a.ip() {
                std::net::IpAddr::V4(ip) => Some(ip),
                std::net::IpAddr::V6(_) => None,
            });
        let all = if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|i| match i.ip() {
                std::net::IpAddr::V4(ip) => Some(ip),
                std::net::IpAddr::V6(_) => None,
            });
        offer_list(primary, all)
    }

    #[cfg(feature = "lan-listen")]
    pub(crate) fn offer_list(
        primary: Option<Ipv4Addr>,
        all: impl Iterator<Item = Ipv4Addr>,
    ) -> Vec<String> {
        let mut out: Vec<Ipv4Addr> = vec![];
        for ip in primary.into_iter().chain(all) {
            // 169.254 is an interface that never got an address from anybody.
            if ip.is_private() && !out.contains(&ip) {
                out.push(ip);
            }
        }
        out.truncate(MAX_ADDRS);
        out.into_iter().map(|ip| ip.to_string()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quiet_side_listens_and_the_receiver_first() {
        use LanListen::*;
        assert_eq!(choose_listener(Quiet, Quiet), Some(Role::Guest));
        assert_eq!(choose_listener(Prompt, Quiet), Some(Role::Guest));
        assert_eq!(choose_listener(Quiet, Prompt), Some(Role::Host));
        assert_eq!(choose_listener(Quiet, None), Some(Role::Host));
        assert_eq!(choose_listener(Prompt, Prompt), Option::None);
        assert_eq!(choose_listener(None, None), Option::None);
    }

    #[test]
    fn an_offer_aims_only_at_private_lan_addresses() {
        let t = "00112233445566778899aabbccddeeff";
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let o = parse_offer(
            &a(&["192.168.1.5", "8.8.8.8", "127.0.0.1", "10.0.0.2"]),
            5000,
            t,
        )
        .unwrap();
        assert_eq!(
            o.addrs,
            [
                "192.168.1.5".parse::<Ipv4Addr>().unwrap(),
                "10.0.0.2".parse().unwrap()
            ]
        );
        assert_eq!((o.port, o.token[15]), (5000, 0xff));
        assert_eq!(parse_offer(&a(&["8.8.8.8"]), 5000, t), None);
        assert_eq!(parse_offer(&a(&[]), 5000, t), None);
        assert_eq!(parse_offer(&a(&["192.168.1.5"]), 0, t), None);
        assert_eq!(parse_offer(&a(&["192.168.1.5"]), 65536, t), None);
        assert_eq!(
            parse_offer(&a(&["192.168.1.5"]), 5000, &t.to_uppercase()),
            None
        );
        assert_eq!(parse_offer(&a(&["192.168.1.5"]), 5000, &t[1..]), None);
        assert_eq!(
            parse_offer(
                &a(&["192.168.001.5", "::ffff:192.168.1.5", "fe80::1"]),
                5000,
                t
            ),
            None
        );
        // Only the first eight are looked at, so a ninth good one is never dialled.
        let mut many = vec!["8.8.8.8"; 8];
        many.push("192.168.1.9");
        assert_eq!(parse_offer(&a(&many), 5000, t), None);
    }

    #[test]
    fn tokens_round_trip_and_compare() {
        let t = [7u8; TOKEN_BYTES];
        assert_eq!(parse_token(&token_hex(&t)), Some(t));
        assert!(same_token(&t, &t));
        assert!(!same_token(&t[..15], &t));
        assert!(!same_token(&[8u8; TOKEN_BYTES], &t));
    }

    #[cfg(feature = "lan-listen")]
    #[test]
    fn the_offer_list_puts_the_default_route_first_and_keeps_private_only() {
        let ip = |s: &str| s.parse::<Ipv4Addr>().unwrap();
        let all = [
            ip("10.8.0.2"),
            ip("192.168.1.7"),
            ip("100.64.1.1"),
            ip("127.0.0.1"),
            ip("169.254.3.3"),
        ];
        assert_eq!(
            offer_list(Some(ip("192.168.1.7")), all.into_iter()),
            ["192.168.1.7", "10.8.0.2"]
        );
    }
}
