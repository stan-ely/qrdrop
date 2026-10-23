# tryst

Rooms that interoperate with [Trystero](https://github.com/dmotz/trystero) 0.25
peers, in Rust. A `tryst` peer joins the same room as a browser running
Trystero: it finds it through the same Nostr relays or WebTorrent trackers,
passes the same password handshake, and exchanges the same actions with it,
over a WebRTC data channel from [str0m](https://github.com/algesten/str0m).

It is a second implementation of Trystero's wire, not a port of its code or a
release of it, and it is not affiliated with the Trystero project. It was
written for [qrdrop](https://github.com/stan-ely/qrdrop), whose native apps
and command line have to speak to the same rooms as its website.

```rust,no_run
use tryst::join::{JoinConfig, RoomEvent, join};
use tryst::signal::Strategy;
use tryst::wire::Payload;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), tryst::join::JoinError> {
    // The app ID, room and password a Trystero page would pass to joinRoom.
    let mut cfg = JoinConfig::new(
        Strategy::Nostr,
        "my-app",
        "my-room",
        "a shared password",
        &["wss://relay.example.com"],
    );
    cfg.stun = vec!["stun.l.google.com:19302".into()];

    let mut room = join(cfg).await?;
    while let Some(event) = room.next_event().await {
        match event {
            RoomEvent::Joined(peer) => {
                // makeAction('chat')'s send, to that one peer.
                let _ = room
                    .send("chat", Payload::Text("hello".into()), None, Some(&peer))
                    .await;
            }
            RoomEvent::Message { peer, message } if message.action == "chat" => {
                println!("{peer}: {:?}", message.payload);
            }
            RoomEvent::Left(peer) => println!("{peer} left"),
            _ => {}
        }
    }
    room.leave().await;
    Ok(())
}
```

## What is in it

A sans-IO core with no feature gates, each part driven by plain calls and
drained by `poll_*`:

- `crypto`: topics, the room token, the signal cipher and the handshake hash.
- `wire`: the action chunk, its reassembly and the room frame.
- `room`: the password handshake, `@_leave`, and messages between peers.
- `signal`: who offers, glare, and the life of each offer and answer.

Behind features, the parts that do IO, and `join`, which drives the core on
tokio and is the equivalent of Trystero's `joinRoom`:

| Feature | What it adds |
| --- | --- |
| `nostr` (default) | the Nostr relay client, with BIP-340 signed events |
| `torrent` (default) | the WebTorrent tracker client |
| `webrtc` (default) | the str0m peer connection, its DTLS certificate, and ICE over one UDP socket |
| `turn` (default) | a UDP TURN client (RFC 8656) on the same socket; `relay_only` is `iceTransportPolicy: 'relay'` |

Strings and JSON travel as Trystero's text and JSON payloads, bytes as its
binary ones, with metadata, and every message is chunked and reassembled
exactly as Trystero does, so a JS peer's `makeAction` sees no difference.

## How it is tested

`vectors/trystero.json` holds values computed by Trystero 0.25.4's own modules
from fixed inputs: topics, signal ciphertexts, chunks, room frames, the
handshake and a signed Nostr event. `vectors/trystero-recording.json` and
`trystero-recording-live.json` are real traffic between two Trystero peers,
through a stand-in relay and through the public ones. Every value in them is
checked here, and the files are generated, and checked against Trystero again,
by qrdrop's test suite. In qrdrop's tree a `tryst` peer also pairs with a Node
Trystero peer over the public relays in both roles, and carries qrdrop's
transfers to and from browsers.

## Known limits

- **Trystero 0.25 only.** Its wire changes between minor versions, and the
  vectors describe 0.25.4.
- **Nostr and WebTorrent only.** Trystero's MQTT, IPFS, Firebase and Supabase
  strategies are not implemented.
- **IPv4 sockets, one per interface.** A room binds the default route's
  interface and one more socket on each other one, so a peer on a second
  network (a hotspot's clients, say) gets a host candidate it can reach.
  STUN and TURN use the first socket only. IPv6 only when `bind` names an
  IPv6 address, which then is the one socket, and that is untested. No TURN
  over TCP or TLS.
- **Data channels only.** No media.
- **aws-lc comes along.** str0m's `rust-crypto` backend, which this crate
  uses, enables aws-lc-rs only to generate a DTLS certificate that `tryst`
  makes itself with `p256`. qrdrop patches that out (its `vendor/README.md`
  says how), but a patch cannot travel with a published crate, so a build from
  crates.io compiles aws-lc-sys, a C library, until str0m makes it optional.
  Nothing at run time differs.

## Licence

MIT.
