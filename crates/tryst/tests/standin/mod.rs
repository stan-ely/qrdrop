//! A stand-in Nostr relay and WebTorrent tracker on one local WebSocket
//! port, with the behaviour scripts/record-trystero.mjs gives its own: just
//! enough for two Trystero clients to find each other, and nothing a real
//! relay would add (no storage, no signature checks, no rate limits).
//!
//! Shared by the integration tests and `examples/standin-relay.rs`, which the
//! Rust-to-Node e2e runs.

#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct Shared {
    next: u64,
    conns: HashMap<u64, Conn>,
    /// info_hash -> peer_id -> connection
    swarms: HashMap<String, HashMap<String, u64>>,
}

struct Conn {
    tx: mpsc::UnboundedSender<String>,
    subs: HashMap<String, Value>,
}

/// Serve until the listener's task is dropped. Returns its address.
pub async fn start() -> SocketAddr {
    start_with(|_| false).await
}

/// As [`start`], but every connection for which `drop_it(n)` is true (n
/// counting accepts from 0) is closed straight after its handshake.
pub async fn start_with(drop_it: impl Fn(u64) -> bool + Send + 'static) -> SocketAddr {
    serve_on("127.0.0.1:0", drop_it).await
}

/// As [`start`], on a given address, for a peer in another network
/// namespace (`examples/bench.rs` in qrdrop-session).
pub async fn start_on(addr: &str) -> SocketAddr {
    serve_on(addr, |_| false).await
}

async fn serve_on(addr: &str, drop_it: impl Fn(u64) -> bool + Send + 'static) -> SocketAddr {
    let listener = TcpListener::bind(addr).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let shared = Arc::new(Mutex::new(Shared::default()));
    tokio::spawn(async move {
        let mut accepted = 0u64;
        while let Ok((tcp, _)) = listener.accept().await {
            let n = accepted;
            accepted += 1;
            let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else {
                continue;
            };
            if drop_it(n) {
                drop(ws);
                continue;
            }
            tokio::spawn(serve(ws, shared.clone()));
        }
    });
    addr
}

async fn serve(
    ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    shared: Arc<Mutex<Shared>>,
) {
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = {
        let mut s = shared.lock().unwrap();
        s.next += 1;
        let id = s.next;
        s.conns.insert(
            id,
            Conn {
                tx,
                subs: HashMap::new(),
            },
        );
        id
    };
    loop {
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Text(t))) => handle(&shared, id, &t),
                Some(Ok(_)) => {}
                _ => break,
            },
            Some(out) = rx.recv() => {
                if sink.send(Message::Text(out.into())).await.is_err() {
                    break;
                }
            }
        }
    }
    shared.lock().unwrap().conns.remove(&id);
}

fn handle(shared: &Mutex<Shared>, id: u64, text: &str) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let mut s = shared.lock().unwrap();
    let send = |s: &Shared, to: u64, v: Value| {
        if let Some(c) = s.conns.get(&to) {
            let _ = c.tx.send(v.to_string());
        }
    };
    if let Some(a) = msg.as_array() {
        match a.first().and_then(Value::as_str) {
            Some("REQ") => {
                let sub = a[1].as_str().unwrap_or_default().to_owned();
                if let Some(c) = s.conns.get_mut(&id) {
                    c.subs.insert(sub.clone(), a[2].clone());
                }
                send(&s, id, json!(["EOSE", sub]));
            }
            Some("CLOSE") => {
                if let Some(c) = s.conns.get_mut(&id) {
                    c.subs.remove(a[1].as_str().unwrap_or_default());
                }
            }
            Some("EVENT") => {
                let ev = &a[1];
                send(&s, id, json!(["OK", ev["id"], true, ""]));
                let tag = ev["tags"]
                    .as_array()
                    .and_then(|t| t.iter().find(|t| t[0] == "x"))
                    .map(|t| t[1].clone());
                for (cid, c) in &s.conns {
                    for (sub, f) in &c.subs {
                        let kinds = f["kinds"].as_array().cloned().unwrap_or_default();
                        let topics = f["#x"].as_array().cloned().unwrap_or_default();
                        if kinds.contains(&ev["kind"])
                            && tag.as_ref().is_some_and(|t| topics.contains(t))
                        {
                            send(&s, *cid, json!(["EVENT", sub, ev]));
                        }
                    }
                }
            }
            _ => {}
        }
        return;
    }
    if msg["action"] != "announce" {
        return;
    }
    let hash = msg["info_hash"].as_str().unwrap_or_default().to_owned();
    let peer = msg["peer_id"].as_str().unwrap_or_default().to_owned();
    s.swarms
        .entry(hash.clone())
        .or_default()
        .insert(peer.clone(), id);
    let swarm = s.swarms[&hash].clone();
    if !msg["answer"].is_null() {
        if let Some(to) = msg["to_peer_id"].as_str().and_then(|p| swarm.get(p)) {
            let v = json!({"action": "announce", "info_hash": hash, "peer_id": peer, "offer_id": msg["offer_id"], "answer": msg["answer"]});
            send(&s, *to, v);
        }
        return;
    }
    send(
        &s,
        id,
        json!({"action": "announce", "interval": 120, "info_hash": hash, "complete": 0, "incomplete": swarm.len()}),
    );
    let mut others: Vec<(&String, &u64)> = swarm.iter().filter(|(p, _)| **p != peer).collect();
    others.sort();
    let want = msg["numwant"].as_u64().unwrap_or(0) as usize;
    for (offer, (_, to)) in msg["offers"]
        .as_array()
        .into_iter()
        .flatten()
        .zip(others.into_iter().take(want))
    {
        let v = json!({"action": "announce", "info_hash": hash, "peer_id": peer, "offer_id": offer["offer_id"], "offer": offer["offer"]});
        send(&s, *to, v);
    }
}
