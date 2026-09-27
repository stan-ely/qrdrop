//! The app's listening end of the local-network fast path
//! (src/transport/lan.js), for the one thing a webview cannot do: accept a
//! connection.
//!
//! `lan_listen` binds two sockets: one on every interface, for the peer, and
//! one on 127.0.0.1, for this app's own page. Each takes the first WebSocket
//! whose first message is the session's token, and stops listening once it has
//! it. Then this task forwards whole messages between the two until either
//! side closes, and ACKs the page once both have arrived. Nothing here parses
//! a frame, sees a key or holds plaintext. The frames are sealed end to end,
//! the token is the only secret Rust is handed, and it authorises one
//! connection.
//!
//! WHY A RELAY AND NOT IPC. The page could hand Rust its frames through
//! `invoke`, and Rust could write them to a raw socket. On Android an invoke's
//! body travels as base64 inside JSON (src/sink.rs has that finding), and
//! nothing carries bytes from Rust back to a page at all, so the fast path would
//! give back its own speed to get there. The page's WebSocket to 127.0.0.1 is
//! plain TCP. Measured on the phone (app/CAPABILITIES.md, "The Rust relay, on
//! both ends"): forwarding through this shape cost nothing measurable against a
//! direct connection.
//!
//! WHY THE PAGE PRESENTS THE TOKEN TOO. The local port is reachable by every
//! process on this machine. A local process that got there first would sit
//! between the page and its peer: it could not read or forge a frame, but it
//! could swallow the transfer. Asking the page for the token costs nothing and
//! closes that.
//!
//! One transfer at a time, like `SinkState`, so one slot: a second
//! `lan_listen` aborts the first.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// The listener's answer to a good token. Mirrors `ACK` in src/transport/lan.js.
const ACK: u8 = 0x06;
const TOKEN_BYTES: usize = 16;

/// How long one connection gets to present its token before the next is
/// taken. A stranger who connects and says nothing costs this much, once.
const HANDSHAKE: Duration = Duration::from_secs(5);

/// Whether listening is quiet here. Mirrors node/lan.js for the CLI: Android
/// and Linux have no per-application prompt for an inbound connection. Windows
/// Defender Firewall asks on the first listen, and so does macOS's application
/// firewall for an app that, like this one, is unsigned. So on those two the
/// app says 'prompt', never listens, and dials out instead, which prompts
/// nobody.
const MODE: &str = if cfg!(any(target_os = "android", target_os = "linux")) {
    "quiet"
} else {
    "prompt"
};

#[derive(Default)]
pub struct LanState(Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listening {
    port: u16,
    local_port: u16,
    addrs: Vec<String>,
}

#[tauri::command]
pub fn lan_mode() -> &'static str {
    MODE
}

#[tauri::command]
pub async fn lan_listen(state: tauri::State<'_, LanState>, token: String) -> Result<Listening, String> {
    let token = parse_token(&token)?;
    let lan = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.map_err(|e| e.to_string())?;
    let local = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|e| e.to_string())?;
    let listening = Listening {
        port: lan.local_addr().map_err(|e| e.to_string())?.port(),
        local_port: local.local_addr().map_err(|e| e.to_string())?.port(),
        addrs: offered_addresses(),
    };
    let task = tauri::async_runtime::spawn(relay(lan, local, token));
    if let Some(previous) = state.0.lock().unwrap().replace(task) {
        previous.abort();
    }
    Ok(listening)
}

/// Stops a listener nobody reached. After both ends have arrived the page
/// ends the link by closing its own socket, which ends the relay task.
#[tauri::command]
pub fn lan_close(state: tauri::State<'_, LanState>) {
    if let Some(task) = state.0.lock().unwrap().take() {
        task.abort();
    }
}

fn parse_token(hex: &str) -> Result<[u8; TOKEN_BYTES], String> {
    if hex.len() != TOKEN_BYTES * 2 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("lan_listen: malformed token".into());
    }
    let mut token = [0u8; TOKEN_BYTES];
    for (i, byte) in token.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(token)
}

/// Most addresses one offer carries. Mirrors `MAX_ADDRS` in
/// src/transport/lan.js, which drops any past it, so a ninth would never be
/// dialled.
const MAX_ADDRS: usize = 8;

/// This machine's private IPv4 addresses, for the offer: the default route's
/// first, then every other interface's. The peer dials them all at once and
/// keeps whichever answers (`dial` in src/transport/lan.js), so an address
/// that leads nowhere costs one failed connect and nothing else.
///
/// Every interface and not only the default route's, because the default
/// route is exactly the wrong one on a phone running a VPN: it goes through
/// the tunnel, whose address is often private (10.x), so that address alone
/// was offered and the Wi-Fi one the peer could reach never was, and the
/// session stayed on WebRTC without a word. src/node/lan-server.js has always
/// offered every interface.
fn offered_addresses() -> Vec<String> {
    offer_list(default_route_address(), interface_addresses())
}

/// The filter, kept apart from the OS calls so a desktop host can test it.
/// Private only, as `parseOffer` on the other end demands. A mobile-data
/// address is CGNAT and not private, so a phone with no Wi-Fi offers nothing
/// and the session stays on WebRTC, which is the right answer for that phone.
fn offer_list(primary: Option<Ipv4Addr>, all: Vec<Ipv4Addr>) -> Vec<String> {
    let mut out: Vec<Ipv4Addr> = Vec::new();
    for ip in primary.into_iter().chain(all) {
        if ip.is_private() && !out.contains(&ip) {
            out.push(ip);
        }
    }
    out.truncate(MAX_ADDRS);
    out.into_iter().map(|ip| ip.to_string()).collect()
}

/// The address the routing table would use to reach the internet, the
/// likeliest to work and so first in the offer. A connected UDP socket sends
/// nothing: `connect` only asks the routing table, and 192.0.2.1 is
/// TEST-NET-1, reserved never to be routed anywhere real.
fn default_route_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

/// Every up interface's IPv4 address, through `getifaddrs`. libc is already
/// in the build through tokio, and bionic has had `getifaddrs` since API 24,
/// which is this app's minSdk. Unix only: the relay listens on Android and
/// Linux alone (`MODE`), so elsewhere the default route is all there is.
#[cfg(unix)]
fn interface_addresses() -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `head` with a list that is only read here and
    // then handed back to freeifaddrs exactly once. Each ifa_addr is checked
    // for null and for AF_INET before it is read as a sockaddr_in.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            return out;
        }
        let mut cursor = head;
        while let Some(ifa) = cursor.as_ref() {
            let up = ifa.ifa_flags & (libc::IFF_UP as libc::c_uint) != 0;
            if up
                && !ifa.ifa_addr.is_null()
                && (*ifa.ifa_addr).sa_family as libc::c_int == libc::AF_INET
            {
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                out.push(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)));
            }
            cursor = ifa.ifa_next;
        }
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(not(unix))]
fn interface_addresses() -> Vec<Ipv4Addr> {
    Vec::new()
}

/// No early exit, so how long a comparison takes says nothing about how much
/// of a guessed token was right. Mirrors `equalBytes` in lan.js.
fn same_token(candidate: &[u8], token: &[u8; TOKEN_BYTES]) -> bool {
    candidate.len() == TOKEN_BYTES && candidate.iter().zip(token).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

/// Takes connections one at a time until one presents the token, and returns
/// it. `ack` is for the LAN side, which is owed an answer at once; the page's
/// answer waits until its peer has arrived too.
async fn authenticated(
    listener: &TcpListener,
    token: &[u8; TOKEN_BYTES],
    ack: bool,
) -> Option<WebSocketStream<TcpStream>> {
    loop {
        let (tcp, _) = listener.accept().await.ok()?;
        let _ = tcp.set_nodelay(true);
        let attempt = async {
            let mut ws = tokio_tungstenite::accept_async(tcp).await.ok()?;
            match ws.next().await? {
                Ok(Message::Binary(bytes)) if same_token(&bytes, token) => {
                    if ack {
                        ws.send(Message::Binary(vec![ACK].into())).await.ok()?;
                    }
                    Some(ws)
                }
                _ => None,
            }
        };
        if let Ok(Some(ws)) = tokio::time::timeout(HANDSHAKE, attempt).await {
            return Some(ws);
        }
    }
}

async fn relay(lan: TcpListener, local: TcpListener, token: [u8; TOKEN_BYTES]) {
    let (page, peer) = tokio::join!(
        authenticated(&local, &token, false),
        authenticated(&lan, &token, true),
    );
    // Both listeners close here: one connection each, and no more.
    drop(lan);
    drop(local);
    let (Some(mut page), Some(peer)) = (page, peer) else { return };
    if page.send(Message::Binary(vec![ACK].into())).await.is_err() {
        return;
    }

    let (mut page_tx, mut page_rx) = page.split();
    let (mut peer_tx, mut peer_rx) = peer.split();
    // Whole messages, binary only, in order. A close from either side is
    // passed on as a close to the other, so each end's WebSocket sees the
    // link end the way it would have without this hop in the middle -- and
    // then the relay ends, rather than waiting for the other side to answer
    // that close. Everything the closing side sent before its close has been
    // forwarded by then, because a WebSocket delivers in order, and a peer
    // that has vanished would otherwise hold this task until TCP gave up on
    // it.
    let outbound = async {
        while let Some(Ok(message)) = page_rx.next().await {
            if message.is_close() {
                break;
            }
            if message.is_binary() && peer_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = peer_tx.close().await;
    };
    let inbound = async {
        while let Some(Ok(message)) = peer_rx.next().await {
            if message.is_close() {
                break;
            }
            if message.is_binary() && page_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = page_tx.close().await;
    };
    tokio::select! {
        _ = outbound => {}
        _ = inbound => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_parse_and_compare() {
        let token = parse_token("000102030405060708090a0b0c0d0e0f").unwrap();
        assert_eq!(token[15], 15);
        assert!(same_token(&token, &token));
        let mut other = token;
        other[3] ^= 1;
        assert!(!same_token(&other, &token));
        assert!(!same_token(&token[..15], &token));
        assert!(parse_token("short").is_err());
        assert!(parse_token("zz0102030405060708090a0b0c0d0e0f").is_err());
    }

    #[test]
    fn offers_every_private_address_default_route_first() {
        let ip = |s: &str| s.parse::<Ipv4Addr>().unwrap();
        // A phone on a VPN: the default route is the tunnel, and the Wi-Fi
        // address must still be offered.
        let interfaces = ["127.0.0.1", "10.8.0.2", "192.168.1.7", "100.72.1.9", "169.254.3.3"];
        let got = offer_list(Some(ip("10.8.0.2")), interfaces.iter().map(|s| ip(s)).collect());
        assert_eq!(got, vec!["10.8.0.2", "192.168.1.7"]);
        // Mobile data only: CGNAT is not private, so nothing is offered.
        assert!(offer_list(Some(ip("100.72.1.9")), vec![ip("100.72.1.9")]).is_empty());
        let many = (1..=20).map(|n| Ipv4Addr::new(10, 0, 0, n)).collect();
        assert_eq!(offer_list(None, many).len(), MAX_ADDRS);
        // Whatever this host has, the real call keeps to the same rules.
        assert!(offered_addresses().iter().all(|a| ip(a).is_private()));
    }

    /// The whole relay, over loopback: the page and the peer each present the
    /// token, a stranger who does not is skipped, and messages cross both
    /// ways in order.
    #[tokio::test]
    async fn relays_between_the_page_and_its_peer() {
        use tokio_tungstenite::connect_async;
        let token = [7u8; TOKEN_BYTES];
        let lan = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let local = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let lan_url = format!("ws://{}/", lan.local_addr().unwrap());
        let local_url = format!("ws://{}/", local.local_addr().unwrap());
        let task = tokio::spawn(relay(lan, local, token));

        let (mut stranger, _) = connect_async(&lan_url).await.unwrap();
        stranger.send(Message::Binary(vec![0u8; TOKEN_BYTES].into())).await.unwrap();

        let (mut peer, _) = connect_async(&lan_url).await.unwrap();
        peer.send(Message::Binary(token.to_vec().into())).await.unwrap();
        let (mut page, _) = connect_async(&local_url).await.unwrap();
        page.send(Message::Binary(token.to_vec().into())).await.unwrap();

        assert_eq!(peer.next().await.unwrap().unwrap(), Message::Binary(vec![ACK].into()));
        assert_eq!(page.next().await.unwrap().unwrap(), Message::Binary(vec![ACK].into()));

        for n in [14usize, 16414, 70000] {
            page.send(Message::Binary(vec![1u8; n].into())).await.unwrap();
            peer.send(Message::Binary(vec![2u8; n].into())).await.unwrap();
        }
        for n in [14usize, 16414, 70000] {
            assert_eq!(peer.next().await.unwrap().unwrap(), Message::Binary(vec![1u8; n].into()));
            assert_eq!(page.next().await.unwrap().unwrap(), Message::Binary(vec![2u8; n].into()));
        }

        page.close(None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
    }
}
