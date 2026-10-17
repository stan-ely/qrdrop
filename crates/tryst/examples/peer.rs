//! One tryst peer as a process, for e2e/tryst.e2e.mjs: joins a room, says
//! one thing on the `msg` action to whoever joins, and exits once it has
//! heard one thing back. Every event is a JSON line on stdout.
//!
//! peer --strategy nostr|torrent --relay URL... --room ROOM --password PW
//!      [--id SELF_ID] [--bind IP] [--stun HOST:PORT]... [--say TEXT]

use std::time::Duration;

use serde_json::json;
use tryst::join::{JoinConfig, RoomEvent, join};
use tryst::signal::Strategy;
use tryst::wire::Payload;

fn emit(v: serde_json::Value) {
    println!("{v}");
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let mut cfg = JoinConfig::new(Strategy::Nostr, "qrdrop", "", "", &[]);
    let mut say = None;
    while let Some(a) = args.next() {
        let mut v = || args.next().unwrap_or_else(|| panic!("{a} needs a value"));
        match a.as_str() {
            "--strategy" => {
                cfg.strategy = if v() == "torrent" {
                    Strategy::Torrent
                } else {
                    Strategy::Nostr
                }
            }
            "--relay" => cfg.relays.push(v()),
            "--room" => cfg.room_id = v(),
            "--password" => cfg.password = v(),
            "--id" => cfg.self_id = Some(v()),
            "--bind" => cfg.bind = Some(v().parse().expect("an IP address")),
            "--stun" => cfg.stun.push(v()),
            "--say" => say = Some(v()),
            _ => panic!("unknown argument {a}"),
        }
    }
    let mut room = match join(cfg).await {
        Ok(r) => r,
        Err(e) => {
            emit(json!({"event": "error", "error": e.to_string()}));
            std::process::exit(2);
        }
    };
    emit(json!({"event": "ready", "self_id": room.self_id()}));
    let run = async {
        while let Some(e) = room.next_event().await {
            match e {
                RoomEvent::Joined(peer) => {
                    emit(json!({"event": "joined", "peer": peer}));
                    if let Some(s) = &say {
                        let sent = room
                            .send("msg", Payload::Text(s.clone()), None, Some(&peer))
                            .await;
                        emit(json!({"event": "sent", "ok": sent.is_ok()}));
                    }
                }
                RoomEvent::Message { peer, message } => {
                    let body = match &message.payload {
                        Payload::Text(t) => json!({"text": t}),
                        Payload::Json(v) => json!({"json": v}),
                        Payload::Binary(b) => json!({"bytes": b.len()}),
                    };
                    emit(
                        json!({"event": "message", "peer": peer, "action": message.action, "body": body}),
                    );
                    if message.action == "msg" {
                        return true;
                    }
                }
                RoomEvent::Left(peer) => emit(json!({"event": "left", "peer": peer})),
                RoomEvent::WrongPassword(peer) => {
                    emit(json!({"event": "wrong-password", "peer": peer}))
                }
                RoomEvent::Relays { up, total } => {
                    emit(json!({"event": "relays", "up": up, "total": total}))
                }
            }
        }
        false
    };
    let heard = tokio::time::timeout(Duration::from_secs(90), run)
        .await
        .unwrap_or(false);
    // Give our own message a moment to be acknowledged before the leave.
    tokio::time::sleep(Duration::from_millis(500)).await;
    room.leave().await;
    emit(json!({"event": "done", "heard": heard}));
    std::process::exit(if heard { 0 } else { 1 });
}
