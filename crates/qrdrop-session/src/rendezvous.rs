//! Pairing with no route to the relays: the code's own device listens at the
//! address in its QR, and the scanner dials it (docs/notes/offline-pairing.md).
//!
//! The four messages and why each is there are `qrdrop_protocol`'s
//! `rendezvous.rs` (and `src/core/rendezvous.js` before it). This is the
//! socket half: who accepts what, for how long, and which connection wins.
//! What comes out is an ordinary [`Paired`] over a socket carrier, so the SAS,
//! the confirm and the session after it are the room path's own.
//!
//! **The listener answers nothing keyed before the code is proved.** It sends
//! a nonce to whoever connects, and generates its keypair only once a dial
//! has verified, so a stranger on the network costs one handshake slot for
//! [`HANDSHAKE_TIMEOUT`] and no key at all. [`MAX_HANDSHAKES`] run at once,
//! for the reason `lan.rs` gives: one at a time let a stranger who found the
//! port hold it longer than the peer's dial would wait.
//!
//! **The dialler races only the hello, and keys one connection.** Every
//! address in the locator is tried at once, and the first to send a nonce is
//! the one the handshake runs on; the rest are dropped. Keying every
//! connection that answered looks more robust and is the pairing race again
//! (docs/notes/pairing-race.md): a listener reachable at two addresses could
//! finish on one while this side kept the other, each with its own keypair,
//! and the two screens would show SASes that disagree with no attacker
//! anywhere -- spending the secret's one roll on nothing.
//!
//! **Nothing here falls back.** A dial that fails returns `None` before any
//! SAS exists, and the caller may then try the relays. A listener's
//! half-finished handshake is dropped and the listener keeps waiting. Once a
//! `Paired` exists, its SAS is the secret's one roll, whatever happens next.

#[cfg(feature = "lan-dial")]
use std::net::SocketAddr;
#[cfg(feature = "lan-listen")]
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use futures_util::SinkExt;
use futures_util::stream::{FuturesUnordered, StreamExt};
use qrdrop_protocol::{Keypair, Locator, Nonce, Pairing, Role, Secret};
use tokio_tungstenite::tungstenite::Message;

use crate::lan::{LanSocket, first_binary, split, ws_config};
use crate::pair::Paired;

/// How long a dial may take, from the first connect to the listener's keyed
/// answer. Short, because a scanner with a route to the relays waits this
/// long before trying them: two devices that cannot reach each other
/// directly is ordinary, and costing every such pairing more than a few
/// seconds would make the locator a penalty.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(3);
/// How long the listener gives one connection to finish all four messages.
pub const HANDSHAKE_TIMEOUT: Duration = crate::lan::HANDSHAKE_TIMEOUT;
/// Handshakes the listener runs at once; past it a connection is closed
/// unread.
#[cfg(feature = "lan-listen")]
pub const MAX_HANDSHAKES: usize = 32;
/// The most addresses a locator carries, as its encoding allows.
#[cfg(feature = "lan-listen")]
const LOCATOR_ADDRESSES: usize = 4;

/// One finished handshake, before the hold takes the socket.
pub(crate) struct Met {
    pub pairing: Pairing,
    pub socket: LanSocket,
    pub peer: String,
}

async fn send(s: &mut LanSocket, bytes: &[u8]) -> Option<()> {
    s.tx.send(Message::Binary(bytes.to_vec().into())).await.ok()
}

/// A listener for an offline pairing, bound before the code is shown so its
/// address can go in the QR.
#[cfg(feature = "lan-listen")]
pub struct OfflineListener {
    listener: tokio::net::TcpListener,
    locator: Option<Locator>,
}

#[cfg(feature = "lan-listen")]
impl std::fmt::Debug for OfflineListener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OfflineListener")
            .field("locator", &self.locator)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "lan-listen")]
impl OfflineListener {
    /// Bind every interface on a free port. Whether listening here raises a
    /// firewall prompt is the caller's question ([`crate::lan::default_listen`]):
    /// this binds when asked.
    pub async fn bind() -> std::io::Result<OfflineListener> {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        let port = listener.local_addr()?.port();
        let addresses: Vec<Ipv4Addr> = crate::lan::offered_addresses()
            .iter()
            .filter_map(|a| a.parse().ok())
            .take(LOCATOR_ADDRESSES)
            .collect();
        let locator = (!addresses.is_empty()).then_some(Locator { port, addresses });
        Ok(OfflineListener { listener, locator })
    }

    /// Bound to one address, for tests on loopback, which no real locator
    /// may carry.
    #[cfg(test)]
    pub(crate) async fn bind_on(ip: Ipv4Addr) -> OfflineListener {
        let listener = tokio::net::TcpListener::bind((ip, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        OfflineListener {
            listener,
            locator: Some(Locator {
                port,
                addresses: vec![ip],
            }),
        }
    }

    /// Where this listener can be reached, for the QR. `None` when this
    /// machine has no private IPv4 address, and then the code goes out bare.
    pub fn locator(&self) -> Option<&Locator> {
        self.locator.as_ref()
    }

    /// Wait for a peer that proves `secret`, and pair with it as the host.
    /// Runs until one does; the caller bounds it, and dropping the future
    /// stops listening. `None` only if the socket itself fails.
    pub async fn accept(self, secret: &Secret) -> Option<Paired> {
        self.accept_met(secret).await.map(Paired::local)
    }

    pub(crate) async fn accept_met(self, secret: &Secret) -> Option<Met> {
        let mut pending = FuturesUnordered::new();
        loop {
            tokio::select! {
                r = self.listener.accept() => {
                    let (tcp, from) = r.ok()?;
                    if pending.len() < MAX_HANDSHAKES {
                        pending.push(tokio::time::timeout(
                            HANDSHAKE_TIMEOUT,
                            answer(tcp, from.ip(), secret),
                        ));
                    }
                }
                Some(r) = pending.next(), if !pending.is_empty() => {
                    if let Ok(Some(met)) = r {
                        // Dropping `pending` and the listener closes every other
                        // handshake and the port with them.
                        return Some(met);
                    }
                }
            }
        }
    }
}

/// The listener's side of one connection.
#[cfg(feature = "lan-listen")]
async fn answer(tcp: tokio::net::TcpStream, from: IpAddr, secret: &Secret) -> Option<Met> {
    let _ = tcp.set_nodelay(true);
    let ws = tokio_tungstenite::accept_async_with_config(tcp, Some(ws_config()))
        .await
        .ok()?;
    let mut s = split(ws);
    let key = secret.rendezvous_key();
    let nonce = qrdrop_protocol::nonce();
    send(&mut s, &nonce).await?;
    let dial = key.open_dial(&nonce, &first_binary(&mut s.rx).await?)?;
    // Only now, with the code proved: a stranger never costs a keypair.
    let keypair = Keypair::generate();
    let listen = *keypair.public_key();
    send(&mut s, &key.seal_listen(&nonce, &dial, &listen)).await?;
    let ok = first_binary(&mut s.rx).await?;
    if !key.open_ok(&nonce, &dial, &listen, &ok) {
        return None;
    }
    let pairing = keypair.establish(&dial, secret, Role::Host).ok()?;
    Some(Met {
        pairing,
        socket: s,
        peer: from.to_string(),
    })
}

/// Dial the locator's addresses and pair as the guest, within
/// [`DIAL_TIMEOUT`]. Only private, non-loopback addresses are dialled, as
/// `lan.rs`'s `parse_offer` holds an offer to: a QR is untrusted input, and
/// must not aim this side at a host on the internet or a service on this
/// machine. `None` means try the relays.
#[cfg(feature = "lan-dial")]
pub async fn dial(locator: &Locator, secret: &Secret) -> Option<Paired> {
    let addrs = locator
        .addresses
        .iter()
        .filter(|ip| !ip.is_loopback() && crate::path::is_private((**ip).into()))
        .map(|ip| SocketAddr::from((*ip, locator.port)))
        .collect();
    dial_met(addrs, secret).await.map(Paired::local)
}

#[cfg(feature = "lan-dial")]
pub(crate) async fn dial_met(addrs: Vec<SocketAddr>, secret: &Secret) -> Option<Met> {
    let key = secret.rendezvous_key();
    let keyed = tokio::time::timeout(DIAL_TIMEOUT, async {
        let mut hellos: FuturesUnordered<_> = addrs.into_iter().map(hello).collect();
        let (mut s, nonce, peer) = loop {
            if let Some(won) = hellos.next().await? {
                break won;
            }
        };
        // The rest are dropped here, before anything keyed is sent on them.
        drop(hellos);
        let keypair = Keypair::generate();
        let dial = *keypair.public_key();
        send(&mut s, &key.seal_dial(&nonce, &dial)).await?;
        let listen = key.open_listen(&nonce, &dial, &first_binary(&mut s.rx).await?)?;
        Some((s, nonce, peer, keypair, dial, listen))
    })
    .await
    .ok()??;
    let (mut s, nonce, peer, keypair, dial, listen) = keyed;
    // Outside the timeout, so it cannot cut the ok half-sent: a listener that
    // read a whole ok has latched, and this side must then not be off trying
    // the relays as if it had not.
    tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        send(&mut s, &key.seal_ok(&nonce, &dial, &listen)),
    )
    .await
    .ok()??;
    let pairing = keypair.establish(&listen, secret, Role::Guest).ok()?;
    Some(Met {
        pairing,
        socket: s,
        peer,
    })
}

/// Connect, and wait for the listener's nonce.
#[cfg(feature = "lan-dial")]
async fn hello(addr: SocketAddr) -> Option<(LanSocket, Nonce, String)> {
    let (ws, _) = tokio_tungstenite::connect_async_with_config(
        format!("ws://{addr}/"),
        Some(ws_config()),
        true,
    )
    .await
    .ok()?;
    let mut s = split(ws);
    let nonce: Nonce = first_binary(&mut s.rx).await?.try_into().ok()?;
    Some((s, nonce, addr.ip().to_string()))
}

#[cfg(all(test, feature = "lan-listen", feature = "lan-dial"))]
mod tests {
    use std::net::{Ipv4Addr, SocketAddr};

    use futures_util::{SinkExt, StreamExt};
    use qrdrop_protocol::Secret;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;

    fn addr_of(l: &OfflineListener) -> SocketAddr {
        let loc = l.locator().unwrap();
        SocketAddr::from((loc.addresses[0], loc.port))
    }

    #[tokio::test]
    async fn a_dialler_holding_the_code_pairs_and_both_show_one_sas() {
        let secret = Secret::generate();
        let l = OfflineListener::bind_on(Ipv4Addr::LOCALHOST).await;
        let at = addr_of(&l);
        let s2 = secret.clone();
        let host = tokio::spawn(async move { l.accept_met(&s2).await });
        let guest = dial_met(vec![at], &secret).await.expect("the dial pairs");
        let host = host.await.unwrap().expect("the listener pairs");
        assert_eq!(host.pairing.sas(), guest.pairing.sas());
    }

    #[tokio::test]
    async fn a_dialler_with_another_code_is_refused_and_the_listener_keeps_waiting() {
        let secret = Secret::generate();
        let l = OfflineListener::bind_on(Ipv4Addr::LOCALHOST).await;
        let at = addr_of(&l);
        let s2 = secret.clone();
        let host = tokio::spawn(async move { l.accept_met(&s2).await });
        assert!(dial_met(vec![at], &Secret::generate()).await.is_none());
        assert!(!host.is_finished(), "a stranger ended the wait");
        let guest = dial_met(vec![at], &secret)
            .await
            .expect("the real peer still gets in");
        let host = host.await.unwrap().unwrap();
        assert_eq!(host.pairing.sas(), guest.pairing.sas());
    }

    /// A stranger who connects and says nothing holds one slot, not the port.
    #[tokio::test]
    async fn a_silent_stranger_does_not_keep_the_peer_out() {
        let secret = Secret::generate();
        let l = OfflineListener::bind_on(Ipv4Addr::LOCALHOST).await;
        let at = addr_of(&l);
        let s2 = secret.clone();
        let host = tokio::spawn(async move { l.accept_met(&s2).await });
        let (_stranger, _) = tokio_tungstenite::connect_async(format!("ws://{at}/"))
            .await
            .unwrap();
        assert!(dial_met(vec![at], &secret).await.is_some());
        assert!(host.await.unwrap().is_some());
    }

    /// The half-finished handshake the note designs against: the dial and
    /// the listen go through, and the ok never arrives. The listener must not
    /// have paired -- it shows no SAS -- and must take the next dial.
    #[tokio::test]
    async fn a_handshake_cut_before_the_ok_never_pairs_the_listener() {
        let secret = Secret::generate();
        let l = OfflineListener::bind_on(Ipv4Addr::LOCALHOST).await;
        let at = addr_of(&l);
        let s2 = secret.clone();
        let host = tokio::spawn(async move { l.accept_met(&s2).await });

        let key = secret.rendezvous_key();
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{at}/"))
            .await
            .unwrap();
        let nonce: Nonce = ws
            .next()
            .await
            .unwrap()
            .unwrap()
            .into_data()
            .to_vec()
            .try_into()
            .unwrap();
        let dial = *Keypair::generate().public_key();
        ws.send(Message::Binary(
            key.seal_dial(&nonce, &dial).to_vec().into(),
        ))
        .await
        .unwrap();
        let listen = ws.next().await.unwrap().unwrap().into_data();
        assert!(key.open_listen(&nonce, &dial, &listen).is_some());
        drop(ws);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!host.is_finished(), "the listener paired without an ok");

        assert!(dial_met(vec![at], &secret).await.is_some());
        assert!(host.await.unwrap().is_some());
    }

    /// Something at the address that is not a listener holding the code --
    /// answering the hello and then anything at all -- gives a dial that
    /// fails, and so a fallback, never a pairing.
    #[tokio::test]
    async fn an_impostor_listener_is_refused() {
        let secret = Secret::generate();
        let impostor = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let at = impostor.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = impostor.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            ws.send(Message::Binary(vec![0; 16].into())).await.unwrap();
            let heard = ws.next().await.unwrap().unwrap().into_data();
            // Echo its own key back as though it were the listener's.
            ws.send(Message::Binary(heard)).await.unwrap();
            let _ = ws.next().await;
        });
        assert!(dial_met(vec![at], &secret).await.is_none());
    }

    #[tokio::test]
    async fn nothing_listening_is_a_quick_none() {
        let free = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let at = free.local_addr().unwrap();
        drop(free);
        let started = std::time::Instant::now();
        assert!(dial_met(vec![at], &Secret::generate()).await.is_none());
        assert!(started.elapsed() <= DIAL_TIMEOUT + Duration::from_millis(500));
    }

    #[tokio::test]
    async fn a_locator_aimed_at_this_machine_or_the_internet_is_not_dialled() {
        let loopback = Locator {
            port: 9,
            addresses: vec![Ipv4Addr::LOCALHOST, Ipv4Addr::new(8, 8, 8, 8)],
        };
        let started = std::time::Instant::now();
        assert!(dial(&loopback, &Secret::generate()).await.is_none());
        // Nothing was dialled at all, so nothing was waited for.
        assert!(started.elapsed() < Duration::from_millis(200));
    }
}
