//! The QUIC path between two Rust peers: phase 9 of
//! docs/notes/rust-session.md, and kept because it measured several times
//! faster than SCTP over a round trip (app/CAPABILITIES.md, "The QUIC path,
//! against SCTP").
//!
//! It is the local-network path's shape on another transport, and every
//! timing rule of that path holds here for the same reasons (lan.rs, and
//! lan.js's "WHY ACCEPT IS THE ONE MOMENT TO MOVE"):
//!
//! - **It is negotiated after the SAS, on the authenticated control stream.**
//!   The sender's `quic-hello` follows its confirm; a receiver's is only ever
//!   a reply, queued inside its handling of the sender's, so it is ahead of
//!   the Accept and the sender knows at Accept whether the peer has the path
//!   without a timeout. Each side then sends one `quic-offer`: its candidate
//!   addresses and its certificate's fingerprint. Not in the Trystero signal,
//!   which is sealed only with the code's password, so anyone holding the
//!   code could read the addresses and race the real peer to them; the
//!   control stream is keyed by the ECDH and reaches nobody unverified.
//! - **Only the sender's frames move, and only at the receiver's Accept.**
//!   The receiver never switches; its replies stay on WebRTC.
//! - **It adds speed, not trust.** The frames are the same sealed frames into
//!   the same session. TLS pins each end to the fingerprint the other sent,
//!   which keeps the connection for our peer, and the AEAD keeps the frames
//!   ours.
//!
//! The receiver is the QUIC server and the sender the client, and both send
//! first, which is what gets through two NATs: the client's Initial packets
//! open its own mapping towards the server's candidates, and the server's
//! punches -- datagrams too short to be QUIC, which the client's endpoint
//! drops -- open the server's towards the client's. Whichever lands second
//! gets through. No relay: a pair that cannot punch stays on WebRTC, TURN
//! included, which is where the session already is.
//!
//! A JS peer never sees any of this but the sender's one `quic-hello`, which
//! it ignores as a type it does not know, and never sends one, so a Rust
//! sender talking to it settles at Accept as if the path did not exist.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

/// The QUIC stream closed while it was carrying the file. LAN_CLOSED's
/// sentence, for this path.
pub const QUIC_CLOSED: &str = "The direct connection to the other device closed.";

/// How long a sender whose peer has the path waits at Accept for the
/// connection. Longer than LAN's 2 s, because a hole punch can need the
/// client's second Initial: the first may reach the server's NAT before the
/// server's punch has opened it.
pub const LINK_WAIT: Duration = Duration::from_secs(3);
/// How long the client tries each candidate, and the server waits for it.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// The most candidates an offer carries or is dialled at.
pub const MAX_ADDRS: usize = 8;
pub const FINGERPRINT_BYTES: usize = 32;
/// The application protocol both ends name, so a stray QUIC client of some
/// other protocol fails the handshake rather than speaking to this one.
pub const ALPN: &[u8] = b"qrdrop/1";
/// A frame's length prefix on the stream is four bytes, big-endian, and a
/// frame is never more than this: a little over the largest sealed frame
/// accepted inbound, as lan.rs's `MAX_MESSAGE`.
pub const MAX_FRAME: usize = 64 * 1024;
/// The connection's and the stream's flow-control windows. A window is
/// what one round trip can carry: 16 MiB per 100 ms is 168 MB/s, past what
/// a phone's AEAD does. SCTP's equivalent under str0m is 1 MiB, which is
/// exactly what held the WebRTC path to 8.5 MB/s at 100 ms.
pub const WINDOW: u32 = 16 * 1024 * 1024;
/// The congestion window a connection opens with. quinn's default is ten
/// packets, about 14 KB, and from there slow start overshoots, loses a burst
/// and spends the rest of a short file regrowing. A phone sending 64 MiB over
/// Wi-Fi averaged 15.0 MB/s at 1 MiB against 12.7 at the default, over five
/// alternated rounds. That is a fifth of its gap to LAN and no more
/// (docs/notes/rust-session.md, the fourth device session). On a slow
/// uplink between networks it costs little: quinn paces the window across
/// the RTT, and slow start would have reached 1 MiB about six round trips in
/// and overshot the same link anyway. What it skips is those round trips.
/// BBR was tried in its place: no faster, and it lost 10-15% of what it sent.
pub const INITIAL_WINDOW: u64 = 1024 * 1024;
/// How far the reader runs ahead of the session: frames read off the stream
/// and not yet handled. Past it the reader stops reading, quinn stops
/// granting credit, and the sender stalls on its window -- the transport's
/// own backpressure, under the session's pause, the way SCTP's receive
/// window sits under it on WebRTC.
pub const READ_AHEAD: u64 = 4 * 1024 * 1024;
/// A keep-alive well inside the idle timeout, so a connection made at the
/// SAS survives a person taking their time over Accept.
pub const KEEP_ALIVE: Duration = Duration::from_secs(5);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// The server's punches: how many, how far apart.
pub const PUNCHES: u32 = 20;
pub const PUNCH_EVERY: Duration = Duration::from_millis(200);

/// What a session needs to take part: where to bind, and whom to ask for
/// this socket's address as the internet sees it. The room's STUN servers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuicConfig {
    /// `None` binds every interface and offers each one's address.
    pub bind: Option<IpAddr>,
    /// `host:port`, as [`crate::OpenConfig::stun`].
    pub stun: Vec<String>,
}

/// A peer's offer, checked before anything is sent towards it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub addrs: Vec<SocketAddr>,
    pub fp: [u8; FINGERPRINT_BYTES],
}

/// The peer is authenticated, but it is also a different build, possibly a
/// buggy or hostile one, and this is where its words turn into packets: IPv4
/// (the socket is), a real port, and no address that is not one host's --
/// unspecified, broadcast, multicast. Loopback only when this side is bound
/// to loopback itself, which is a test or a bench and never a deployment, so
/// an offer cannot aim this side at a service on its own machine. Unlike the
/// LAN path, public addresses are the point.
pub fn parse_offer(addrs: &[String], fp: &str, loopback: bool) -> Option<Offer> {
    let fp = parse_fingerprint(fp)?;
    let mut out = vec![];
    for a in addrs.iter().take(MAX_ADDRS) {
        let Ok(sa) = a.parse::<SocketAddr>() else {
            continue;
        };
        let IpAddr::V4(ip) = sa.ip() else { continue };
        if sa.port() == 0
            || ip.is_unspecified()
            || ip.is_broadcast()
            || ip.is_multicast()
            || (ip.is_loopback() && !loopback)
            || out.contains(&sa)
        {
            continue;
        }
        out.push(sa);
    }
    (!out.is_empty()).then_some(Offer { addrs: out, fp })
}

/// 64 lowercase hex characters.
pub fn parse_fingerprint(hex: &str) -> Option<[u8; FINGERPRINT_BYTES]> {
    if hex.len() != FINGERPRINT_BYTES * 2
        || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let mut out = [0u8; FINGERPRINT_BYTES];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

pub fn fingerprint_hex(fp: &[u8; FINGERPRINT_BYTES]) -> String {
    fp.iter().map(|b| format!("{b:02x}")).collect()
}

/// The host candidates: the default route's address first, as the LAN
/// offer orders them, then every other interface's that is neither loopback
/// nor link-local. Private and public alike -- a host with a public address
/// needs no punch at all.
#[cfg_attr(not(feature = "quic"), allow(dead_code))]
pub(crate) fn host_candidates(
    primary: Option<Ipv4Addr>,
    all: impl Iterator<Item = Ipv4Addr>,
) -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = vec![];
    for ip in primary.into_iter().chain(all) {
        if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

#[cfg(feature = "quic")]
pub(crate) use endpoint::*;

#[cfg(feature = "quic")]
mod endpoint {
    use std::io;
    use std::sync::Arc;

    use futures_util::StreamExt;
    use futures_util::stream::FuturesUnordered;
    use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
    use quinn::{
        ClientConfig, Connection, Endpoint, EndpointConfig, RecvStream, SendStream, ServerConfig,
        TokioRuntime, TransportConfig, VarInt,
    };
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
    use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
    use rustls::{DigitallySignedStruct, DistinguishedName, SignatureScheme};
    use sha2::{Digest, Sha256};

    use super::*;

    /// A bound socket, its candidates, and the certificate this side will
    /// present -- everything an offer says, ready before it is sent.
    pub(crate) struct Prepared {
        socket: std::net::UdpSocket,
        pub addrs: Vec<SocketAddr>,
        cert: Vec<u8>,
        key: Vec<u8>,
        pub fp: [u8; FINGERPRINT_BYTES],
    }

    /// Bind, learn the reflexive address, make the certificate. A fresh
    /// certificate per session, like the DTLS one, and for the same reason
    /// the ECDH keypair is fresh: nothing links two sessions.
    pub(crate) async fn prepare(cfg: &QuicConfig) -> io::Result<Prepared> {
        let ip = cfg.bind.unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        let socket = tokio::net::UdpSocket::bind(SocketAddr::new(ip, 0)).await?;
        tryst::join::size_buffers(&socket);
        let port = socket.local_addr()?.port();
        let mut addrs: Vec<SocketAddr> = match cfg.bind {
            Some(ip) if !ip.is_unspecified() => vec![SocketAddr::new(ip, port)],
            _ => host_candidates(primary_v4(), interfaces_v4())
                .into_iter()
                .map(|ip| SocketAddr::new(IpAddr::V4(ip), port))
                .collect(),
        };
        for a in tryst::join::reflexive(&socket, &cfg.stun).await {
            if !addrs.contains(&a) {
                addrs.push(a);
            }
        }
        addrs.truncate(MAX_ADDRS);
        let cert = tryst::webrtc::make_cert();
        let fp: [u8; FINGERPRINT_BYTES] = Sha256::digest(&cert.certificate).into();
        Ok(Prepared {
            socket: socket.into_std()?,
            addrs,
            cert: cert.certificate,
            key: cert.private_key,
            fp,
        })
    }

    fn primary_v4() -> Option<Ipv4Addr> {
        std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .and_then(|s| {
                s.connect((Ipv4Addr::new(192, 0, 2, 1), 9))
                    .and_then(|_| s.local_addr())
            })
            .ok()
            .and_then(|a| match a.ip() {
                IpAddr::V4(ip) => Some(ip),
                IpAddr::V6(_) => None,
            })
    }

    fn interfaces_v4() -> impl Iterator<Item = Ipv4Addr> {
        if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|i| match i.ip() {
                IpAddr::V4(ip) => Some(ip),
                IpAddr::V6(_) => None,
            })
    }

    /// The sender's end: its connection, and the one stream the frames go
    /// on.
    pub(crate) struct Outbound {
        pub endpoint: Endpoint,
        pub conn: Connection,
        pub send: SendStream,
    }

    /// The receiver's end, connected; the stream arrives with the first
    /// frame, which is the sender's first after Accept.
    pub(crate) struct Inbound {
        pub endpoint: Endpoint,
        pub conn: Connection,
    }

    fn provider() -> Arc<CryptoProvider> {
        Arc::new(rustls::crypto::ring::default_provider())
    }

    fn transport() -> Arc<TransportConfig> {
        let mut t = TransportConfig::default();
        t.stream_receive_window(VarInt::from_u32(WINDOW));
        t.receive_window(VarInt::from_u32(WINDOW));
        t.send_window(u64::from(WINDOW));
        t.keep_alive_interval(Some(KEEP_ALIVE));
        t.max_idle_timeout(Some(
            IDLE_TIMEOUT
                .try_into()
                .expect("30 s is a valid idle timeout"),
        ));
        // A third of quinn's default, so a lost first Initial -- the usual
        // fate of the side that punches first -- is resent in about 300 ms
        // rather than a second.
        t.initial_rtt(Duration::from_millis(100));
        // The one stream is the sender's, unidirectional; nothing else is
        // ever opened, so nothing else is allowed.
        t.max_concurrent_bidi_streams(VarInt::from_u32(0));
        t.max_concurrent_uni_streams(VarInt::from_u32(1));
        // Cubic, as quinn's default, but opening at INITIAL_WINDOW rather than
        // about 14 KB.
        let mut cubic = quinn::congestion::CubicConfig::default();
        cubic.initial_window(INITIAL_WINDOW);
        t.congestion_controller_factory(Arc::new(cubic));
        Arc::new(t)
    }

    /// Accepts exactly one certificate: the one whose SHA-256 the peer sent
    /// over the authenticated control stream. The handshake signature is
    /// still checked against it -- a certificate is public, and only the
    /// signature proves the other end holds its key.
    #[derive(Debug)]
    struct Pinned {
        fp: [u8; FINGERPRINT_BYTES],
        algs: WebPkiSupportedAlgorithms,
    }

    impl Pinned {
        fn new(fp: [u8; FINGERPRINT_BYTES], provider: &CryptoProvider) -> Arc<Self> {
            Arc::new(Pinned {
                fp,
                algs: provider.signature_verification_algorithms,
            })
        }

        fn check(&self, cert: &CertificateDer<'_>) -> Result<(), rustls::Error> {
            let got: [u8; FINGERPRINT_BYTES] = Sha256::digest(cert.as_ref()).into();
            // No early exit: the time a comparison takes says nothing about
            // how much of a guess was right.
            let diff = got.iter().zip(&self.fp).fold(0u8, |d, (a, b)| d | (a ^ b));
            if diff == 0 {
                Ok(())
            } else {
                Err(rustls::Error::General(
                    "not the certificate the peer offered".into(),
                ))
            }
        }
    }

    impl ServerCertVerifier for Pinned {
        fn verify_server_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            _: &[CertificateDer<'_>],
            _: &ServerName<'_>,
            _: &[u8],
            _: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            self.check(end_entity)
                .map(|()| ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Err(rustls::Error::General("QUIC is TLS 1.3 only".into()))
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algs)
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.algs.supported_schemes()
        }
    }

    impl ClientCertVerifier for Pinned {
        fn root_hint_subjects(&self) -> &[DistinguishedName] {
            &[]
        }

        fn verify_client_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            _: &[CertificateDer<'_>],
            _: UnixTime,
        ) -> Result<ClientCertVerified, rustls::Error> {
            self.check(end_entity)
                .map(|()| ClientCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Err(rustls::Error::General("QUIC is TLS 1.3 only".into()))
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algs)
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.algs.supported_schemes()
        }
    }

    fn identity(p: &Prepared) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        (
            vec![CertificateDer::from(p.cert.clone())],
            PrivateKeyDer::Pkcs8(p.key.clone().into()),
        )
    }

    fn tls_error(e: rustls::Error) -> io::Error {
        io::Error::other(e)
    }

    /// The sender: dial every candidate at once; the first handshake to
    /// finish wins and the others are dropped. `None` is staying on WebRTC.
    pub(crate) async fn dial(p: Prepared, peer: Offer) -> Option<Outbound> {
        let endpoint = client(&p, &peer).ok()?;
        let mut attempts: FuturesUnordered<_> = peer
            .addrs
            .iter()
            .filter_map(|a| endpoint.connect(*a, "qrdrop").ok())
            .map(|c| tokio::time::timeout(CONNECT_TIMEOUT, c))
            .collect();
        while let Some(r) = attempts.next().await {
            if let Ok(Ok(conn)) = r {
                drop(attempts);
                let send = conn.open_uni().await.ok()?;
                return Some(Outbound {
                    endpoint,
                    conn,
                    send,
                });
            }
        }
        endpoint.close(VarInt::from_u32(0), b"");
        None
    }

    fn client(p: &Prepared, peer: &Offer) -> io::Result<Endpoint> {
        let provider = provider();
        let (chain, key) = identity(p);
        let mut tls = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(tls_error)?
            .dangerous()
            .with_custom_certificate_verifier(Pinned::new(peer.fp, &provider))
            .with_client_auth_cert(chain, key)
            .map_err(tls_error)?;
        tls.alpn_protocols = vec![ALPN.to_vec()];
        let mut config = ClientConfig::new(Arc::new(
            QuicClientConfig::try_from(tls).map_err(io::Error::other)?,
        ));
        config.transport_config(transport());
        let mut endpoint = Endpoint::new(
            EndpointConfig::default(),
            None,
            p.socket.try_clone()?,
            Arc::new(TokioRuntime),
        )?;
        endpoint.set_default_client_config(config);
        Ok(endpoint)
    }

    /// The receiver: listen, punch towards the sender's candidates until a
    /// connection lands or [`CONNECT_TIMEOUT`] passes, and take the first
    /// connection whose certificate is the sender's -- the TLS verifier
    /// refuses any other inside the handshake.
    pub(crate) async fn serve(p: Prepared, peer: Offer) -> Option<Inbound> {
        let punch = p.socket.try_clone().ok()?;
        let endpoint = server(&p, &peer).ok()?;
        let targets = peer.addrs.clone();
        // From a plain clone of the endpoint's socket, never registered with
        // the runtime: the endpoint has registered it already, and the punches
        // only send, so a second registration -- and the question of which of
        // two would see a readable socket -- is avoided rather than tested.
        // The socket is non-blocking; a send that would block is one punch
        // skipped, of twenty.
        let puncher = tokio::spawn(async move {
            for _ in 0..PUNCHES {
                for a in &targets {
                    let _ = punch.send_to(&[0], a);
                }
                tokio::time::sleep(PUNCH_EVERY).await;
            }
        });
        let accepted = tokio::time::timeout(CONNECT_TIMEOUT, async {
            while let Some(incoming) = endpoint.accept().await {
                if let Ok(conn) = incoming.await {
                    return Some(conn);
                }
            }
            None
        })
        .await;
        puncher.abort();
        match accepted {
            Ok(Some(conn)) => Some(Inbound { endpoint, conn }),
            _ => {
                endpoint.close(VarInt::from_u32(0), b"");
                None
            }
        }
    }

    fn server(p: &Prepared, peer: &Offer) -> io::Result<Endpoint> {
        let provider = provider();
        let (chain, key) = identity(p);
        let mut tls = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(tls_error)?
            .with_client_cert_verifier(Pinned::new(peer.fp, &provider))
            .with_single_cert(chain, key)
            .map_err(tls_error)?;
        tls.alpn_protocols = vec![ALPN.to_vec()];
        let mut config = ServerConfig::with_crypto(Arc::new(
            QuicServerConfig::try_from(tls).map_err(io::Error::other)?,
        ));
        config.transport_config(transport());
        // One peer, one connection: a second is somebody else.
        config.max_incoming(1);
        Endpoint::new(
            EndpointConfig::default(),
            Some(config),
            p.socket.try_clone()?,
            Arc::new(TokioRuntime),
        )
    }

    /// One frame onto the stream: its length, then its bytes.
    pub(crate) async fn write_frame(send: &mut SendStream, frame: &[u8]) -> io::Result<()> {
        let len = u32::try_from(frame.len()).map_err(io::Error::other)?;
        send.write_all(&len.to_be_bytes())
            .await
            .map_err(io::Error::other)?;
        send.write_all(frame).await.map_err(io::Error::other)
    }

    /// The next frame off the stream; `None` at its end or at any error,
    /// including a length no frame has.
    pub(crate) async fn read_frame(recv: &mut RecvStream) -> Option<Vec<u8>> {
        let mut len = [0u8; 4];
        recv.read_exact(&mut len).await.ok()?;
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > MAX_FRAME {
            return None;
        }
        let mut frame = vec![0u8; len];
        recv.read_exact(&mut frame).await.ok()?;
        Some(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[test]
    fn an_offer_keeps_real_ipv4_hosts_and_drops_the_rest() {
        let addrs: Vec<String> = [
            "203.0.113.7:4433",
            "192.168.1.20:4433",
            "0.0.0.0:4433",
            "255.255.255.255:4433",
            "224.0.0.1:4433",
            "127.0.0.1:4433",
            "[2001:db8::1]:4433",
            "192.168.1.21:0",
            "not an address",
            "203.0.113.7:4433",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let o = parse_offer(&addrs, FP, false).unwrap();
        assert_eq!(
            o.addrs,
            vec![
                "203.0.113.7:4433".parse().unwrap(),
                "192.168.1.20:4433".parse().unwrap()
            ]
        );
        assert_eq!(fingerprint_hex(&o.fp), FP);
    }

    #[test]
    fn loopback_only_when_this_side_is_on_loopback() {
        let addrs = vec!["127.0.0.1:4433".to_string()];
        assert_eq!(parse_offer(&addrs, FP, false), None);
        assert!(parse_offer(&addrs, FP, true).is_some());
    }

    #[test]
    fn an_offer_needs_a_fingerprint_and_an_address() {
        let addrs = vec!["203.0.113.7:4433".to_string()];
        assert_eq!(parse_offer(&addrs, &FP.to_uppercase(), false), None);
        assert_eq!(parse_offer(&addrs, &FP[..62], false), None);
        assert_eq!(parse_offer(&[], FP, false), None);
    }

    #[test]
    fn at_most_eight_candidates_are_read() {
        let addrs: Vec<String> = (1..=12).map(|i| format!("203.0.113.{i}:4433")).collect();
        assert_eq!(
            parse_offer(&addrs, FP, false).unwrap().addrs.len(),
            MAX_ADDRS
        );
    }

    #[test]
    fn host_candidates_put_the_default_route_first_and_skip_what_is_not_a_host() {
        let all = [
            Ipv4Addr::new(127, 0, 0, 1),
            Ipv4Addr::new(169, 254, 3, 4),
            Ipv4Addr::new(10, 0, 0, 5),
            Ipv4Addr::new(198, 51, 100, 9),
            Ipv4Addr::new(192, 168, 1, 20),
        ];
        assert_eq!(
            host_candidates(Some(Ipv4Addr::new(192, 168, 1, 20)), all.into_iter()),
            vec![
                Ipv4Addr::new(192, 168, 1, 20),
                Ipv4Addr::new(10, 0, 0, 5),
                Ipv4Addr::new(198, 51, 100, 9)
            ]
        );
    }
}
