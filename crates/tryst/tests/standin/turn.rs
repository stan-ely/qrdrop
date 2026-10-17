//! A stand-in TURN server on loopback: the subset of RFC 8656 that
//! `tryst::turn` speaks, with the long-term credential checked for real, so
//! the runtime's relayed path can be tested with no public server -- and
//! there is none to test against: the Open Relay hostname qrdrop ships
//! resolved to 192.0.2.1 when this was written (docs/notes/rust-session.md,
//! phase 5).
//!
//! One relay socket per allocation. Permissions are enforced, because a
//! client that forgot to create one should see its packets dropped here as
//! a real server drops them.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use sha1::Sha1;
use tokio::net::UdpSocket;

pub const USERNAME: &str = "standin";
pub const PASSWORD: &str = "standin-pass";
const REALM: &str = "standin.test";
const NONCE: &str = "standin-nonce";
const MAGIC: u32 = 0x2112_A442;

const ALLOCATE: u16 = 0x0003;
const REFRESH: u16 = 0x0004;
const SEND: u16 = 0x0006;
const DATA_IND: u16 = 0x0007;
const CREATE_PERMISSION: u16 = 0x0008;
const CHANNEL_BIND: u16 = 0x0009;
const INDICATION: u16 = 0x0010;
const SUCCESS: u16 = 0x0100;
const ERROR: u16 = 0x0110;

const A_USERNAME: u16 = 0x0006;
const A_INTEGRITY: u16 = 0x0008;
const A_ERROR: u16 = 0x0009;
const A_CHANNEL: u16 = 0x000C;
const A_LIFETIME: u16 = 0x000D;
const A_PEER: u16 = 0x0012;
const A_DATA: u16 = 0x0013;
const A_REALM: u16 = 0x0014;
const A_NONCE: u16 = 0x0015;
const A_RELAYED: u16 = 0x0016;
const A_MAPPED: u16 = 0x0020;

struct Alloc {
    relay: Arc<UdpSocket>,
    perms: HashSet<IpAddr>,
    channels: HashMap<u16, SocketAddr>,
}

type Allocs = Arc<Mutex<HashMap<SocketAddr, Alloc>>>;

/// Serve until the runtime ends. Returns the server's address, and a count
/// of datagrams relayed in either direction, which is how a test proves the
/// bytes went this way and not around it.
pub async fn start() -> (SocketAddr, Arc<std::sync::atomic::AtomicU64>) {
    let sock = Arc::new(UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap());
    let addr = sock.local_addr().unwrap();
    let relayed = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let allocs: Allocs = Arc::default();
    let key = key();
    let count = relayed.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        while let Ok((n, from)) = sock.recv_from(&mut buf).await {
            let m = &buf[..n];
            if m.len() >= 4 && (0x40..0x80).contains(&m[0]) {
                // ChannelData from a client.
                let ch = u16::from_be_bytes([m[0], m[1]]);
                let len = u16::from_be_bytes([m[2], m[3]]) as usize;
                let to = allocs
                    .lock()
                    .unwrap()
                    .get(&from)
                    .and_then(|a| Some((a.relay.clone(), *a.channels.get(&ch)?)));
                if let (Some((relay, peer)), Some(data)) = (to, m.get(4..4 + len)) {
                    count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let _ = relay.send_to(data, peer).await;
                }
                continue;
            }
            let Some(msg) = parse(m) else { continue };
            let reply = handle(&msg, m, from, &sock, &allocs, &key, &count).await;
            if let Some(r) = reply {
                let _ = sock.send_to(&r, from).await;
            }
        }
    });
    (addr, relayed)
}

fn key() -> Vec<u8> {
    Md5::digest(format!("{USERNAME}:{REALM}:{PASSWORD}")).to_vec()
}

struct Msg {
    kind: u16,
    tid: [u8; 12],
    attrs: Vec<(u16, Vec<u8>, usize)>,
}

impl Msg {
    fn get(&self, t: u16) -> Option<&[u8]> {
        self.attrs.iter().find(|a| a.0 == t).map(|a| a.1.as_slice())
    }
}

fn parse(m: &[u8]) -> Option<Msg> {
    if m.len() < 20 || u32::from_be_bytes(m[4..8].try_into().ok()?) != MAGIC {
        return None;
    }
    let len = u16::from_be_bytes([m[2], m[3]]) as usize;
    let body = m.get(20..20 + len)?;
    let mut attrs = vec![];
    let mut i = 0;
    while i + 4 <= body.len() {
        let t = u16::from_be_bytes([body[i], body[i + 1]]);
        let l = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        attrs.push((t, body.get(i + 4..i + 4 + l)?.to_vec(), 20 + i));
        i += 4 + l.div_ceil(4) * 4;
    }
    Some(Msg {
        kind: u16::from_be_bytes([m[0], m[1]]),
        tid: m[8..20].try_into().ok()?,
        attrs,
    })
}

/// The integrity of a request, over its bytes up to the attribute, with
/// the length rewritten to end there, as RFC 8489 has it.
fn integrity_ok(msg: &Msg, raw: &[u8], key: &[u8]) -> bool {
    let Some((_, mac, at)) = msg.attrs.iter().find(|a| a.0 == A_INTEGRITY) else {
        return false;
    };
    let mut head = raw[..*at].to_vec();
    head[2..4].copy_from_slice(&((at - 20 + 24) as u16).to_be_bytes());
    let mut h = Hmac::<Sha1>::new_from_slice(key).unwrap();
    h.update(&head);
    h.verify_slice(mac).is_ok()
}

struct Out {
    buf: Vec<u8>,
}

impl Out {
    fn new(kind: u16, tid: &[u8; 12]) -> Self {
        let mut buf = vec![0u8; 20];
        buf[0..2].copy_from_slice(&kind.to_be_bytes());
        buf[4..8].copy_from_slice(&MAGIC.to_be_bytes());
        buf[8..20].copy_from_slice(tid);
        Out { buf }
    }
    fn attr(mut self, t: u16, v: &[u8]) -> Self {
        self.buf.extend_from_slice(&t.to_be_bytes());
        self.buf.extend_from_slice(&(v.len() as u16).to_be_bytes());
        self.buf.extend_from_slice(v);
        while !self.buf.len().is_multiple_of(4) {
            self.buf.push(0);
        }
        let len = (self.buf.len() - 20) as u16;
        self.buf[2..4].copy_from_slice(&len.to_be_bytes());
        self
    }
    fn xor(self, t: u16, a: SocketAddr) -> Self {
        let SocketAddr::V4(v4) = a else {
            panic!("the stand-in is IPv4 only")
        };
        let mut v = vec![0, 1];
        v.extend_from_slice(&(v4.port() ^ (MAGIC >> 16) as u16).to_be_bytes());
        v.extend_from_slice(&(u32::from(*v4.ip()) ^ MAGIC).to_be_bytes());
        self.attr(t, &v)
    }
    fn signed(mut self, key: &[u8]) -> Vec<u8> {
        let len = (self.buf.len() - 20 + 24) as u16;
        self.buf[2..4].copy_from_slice(&len.to_be_bytes());
        let mut h = Hmac::<Sha1>::new_from_slice(key).unwrap();
        h.update(&self.buf);
        let mac = h.finalize().into_bytes();
        self.attr(A_INTEGRITY, &mac).buf
    }
}

fn xor_addr(v: &[u8]) -> Option<SocketAddr> {
    if v.len() < 8 || v[1] != 1 {
        return None;
    }
    let port = u16::from_be_bytes([v[2], v[3]]) ^ (MAGIC >> 16) as u16;
    let ip = Ipv4Addr::from(u32::from_be_bytes(v[4..8].try_into().ok()?) ^ MAGIC);
    Some(SocketAddr::new(IpAddr::V4(ip), port))
}

async fn handle(
    msg: &Msg,
    raw: &[u8],
    from: SocketAddr,
    sock: &Arc<UdpSocket>,
    allocs: &Allocs,
    key: &[u8],
    count: &Arc<std::sync::atomic::AtomicU64>,
) -> Option<Vec<u8>> {
    let method = msg.kind & 0x3EEF;
    let class = msg.kind & 0x0110;
    if class == INDICATION && method == SEND {
        let peer = xor_addr(msg.get(A_PEER)?)?;
        let data = msg.get(A_DATA)?;
        let relay = {
            let a = allocs.lock().unwrap();
            let a = a.get(&from)?;
            a.perms.contains(&peer.ip()).then(|| a.relay.clone())?
        };
        count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = relay.send_to(data, peer).await;
        return None;
    }
    if class != 0 {
        return None;
    }
    let authed = msg.get(A_USERNAME) == Some(USERNAME.as_bytes()) && integrity_ok(msg, raw, key);
    if !authed {
        let mut err = vec![0, 0, 4, 1];
        err.extend_from_slice(b"Unauthorized");
        return Some(
            Out::new(method | ERROR, &msg.tid)
                .attr(A_ERROR, &err)
                .attr(A_REALM, REALM.as_bytes())
                .attr(A_NONCE, NONCE.as_bytes())
                .buf,
        );
    }
    let ok = Out::new(method | SUCCESS, &msg.tid);
    match method {
        ALLOCATE => {
            let relay = Arc::new(UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.ok()?);
            let relayed = relay.local_addr().ok()?;
            allocs.lock().unwrap().insert(
                from,
                Alloc {
                    relay: relay.clone(),
                    perms: HashSet::new(),
                    channels: HashMap::new(),
                },
            );
            // Peer to client: a Data indication, or ChannelData once bound.
            let (allocs, sock, count) = (allocs.clone(), sock.clone(), count.clone());
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                while let Ok((n, peer)) = relay.recv_from(&mut buf).await {
                    let framed = {
                        let a = allocs.lock().unwrap();
                        let Some(a) = a.get(&from) else { return };
                        if !a.perms.contains(&peer.ip()) {
                            continue;
                        }
                        match a.channels.iter().find(|(_, p)| **p == peer) {
                            Some((ch, _)) => {
                                let mut f = ch.to_be_bytes().to_vec();
                                f.extend_from_slice(&(n as u16).to_be_bytes());
                                f.extend_from_slice(&buf[..n]);
                                f
                            }
                            None => {
                                let tid = [7u8; 12];
                                Out::new(DATA_IND | INDICATION, &tid)
                                    .xor(A_PEER, peer)
                                    .attr(A_DATA, &buf[..n])
                                    .buf
                            }
                        }
                    };
                    count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let _ = sock.send_to(&framed, from).await;
                }
            });
            Some(
                ok.xor(A_RELAYED, relayed)
                    .xor(A_MAPPED, from)
                    .attr(A_LIFETIME, &600u32.to_be_bytes())
                    .signed(key),
            )
        }
        REFRESH => Some(ok.attr(A_LIFETIME, &600u32.to_be_bytes()).signed(key)),
        CREATE_PERMISSION => {
            let peer = xor_addr(msg.get(A_PEER)?)?;
            allocs
                .lock()
                .unwrap()
                .get_mut(&from)?
                .perms
                .insert(peer.ip());
            Some(ok.signed(key))
        }
        CHANNEL_BIND => {
            let ch = u16::from_be_bytes(msg.get(A_CHANNEL)?.get(..2)?.try_into().ok()?);
            let peer = xor_addr(msg.get(A_PEER)?)?;
            let mut a = allocs.lock().unwrap();
            let a = a.get_mut(&from)?;
            a.channels.insert(ch, peer);
            a.perms.insert(peer.ip());
            Some(ok.signed(key))
        }
        _ => None,
    }
}
