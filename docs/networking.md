# Networking, end to end

Everything that crosses a network when two devices move a file, in the order it
happens: who the devices talk to, what each of those parties can see, and which
route the file itself ends up on. It covers the app, the command line and the
website, because the app runs the website's own code and the same wire. The
cryptography is in [protocol.md](protocol.md), and what all of this does and does
not protect is in [threat-model.md](threat-model.md). This page links to both
rather than repeating them.

## Who is involved

<!-- Source: docs/diagrams/network-parties.mmd, rendered by scripts/make-diagrams.mjs. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/network-parties.dark.png">
  <img alt="Diagram of every party a transfer involves. The sending device and the receiving device sit on either side. Between them are three services: signalling (seven Nostr relays and two WebTorrent trackers), which introduces the devices for pairing and then drops out; STUN servers from Google, Twilio, Cloudflare and Metered, which tell each device its public address; and a TURN relay from the Open Relay Project, used only when no direct route works, which forwards sealed bytes up to 100 MiB. The QR code goes from one device to the other by camera. The file, sealed, goes straight from sender to receiver over WebRTC, LAN or QUIC." src="diagrams/network-parties.light.png">
</picture>

There is **no qrdrop server**. Nothing run by this project sees a transfer, so
there is nothing that could log one. The parties are:

| Party | When | What it carries | What it can see |
| --- | --- | --- | --- |
| **The QR code** | first | 32 random bytes, by light and a camera | nothing: it never touches a network |
| **Signalling**: 7 Nostr relays, 2 WebTorrent trackers | pairing only | each device's announcement, and its WebRTC session description | a room ID derived from the code, both devices' IP addresses, and session descriptions sealed with a password derived from the code |
| **STUN servers** | pairing only | "what is my public address?" | that a device at some IP address asked |
| **TURN relay** | only when no direct route works | the WebRTC traffic, forwarded | both IP addresses, and sealed bytes it cannot open |
| **The other device** | throughout | everything | the file, after the four symbols match and the receiver accepts |

The relays and servers are listed in `src/transport/room.js`: `RELAYS`,
`TORRENT_TRACKERS` and `ICE_SERVERS`. The Rust copy is
`crates/qrdrop-session/src/networks.rs`, and a test there reads `room.js` so the
two lists cannot drift apart.

## The whole transfer

<!-- Source: docs/diagrams/network-sequence.mmd, rendered by scripts/make-diagrams.mjs. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/network-sequence.dark.png">
  <img alt="Sequence diagram of one transfer in five stages. Pairing: the QR code carries 32 random bytes to the receiver by camera; both devices join the derived room on every signalling network at once; each learns of the other and receives its session description, sealed with the code; both ask STUN for their public address; ICE settles a route, local, direct or TURN, and the WebRTC data channel opens; the two exchange ECDH public keys. Verifying: the two people compare four emoji, and the sender confirms they match. Negotiating, with every message sealed on the data channel: both send a path verdict, a lan-hello and a quic-hello, the receiver in reply; the listening side sends its offer of addresses, port, token and answer; the sender dials it, sending the token and getting the answer back; the sender sends the manifest with the name and size. The receiver presses Accept and sends accept, and only at that moment does the sender move to the best route that is up. Moving the file: sealed chunks over LAN, QUIC or WebRTC; pause and resume from the receiver, always on WebRTC; complete, with the file's digest; done. Leaving: a leave message, then every socket closes." src="diagrams/network-sequence.light.png">
</picture>

### 1. Pairing

The sender draws 32 random bytes and shows them as a QR code, or as a link that
carries them in the URL fragment, which a browser never sends to a server. Both
devices derive everything else from those bytes (the
[table in protocol.md](protocol.md#pairing-and-keys)). The derived **room ID** is
what they meet on, so a relay learns that two devices joined the same room and
never learns the code itself.

Each device then joins that room on **every signalling network at once**: the
Nostr relays and the WebTorrent trackers, through Trystero. Whichever network
introduces the two devices first wins, and the others are dropped. Racing them
means the two devices never have to agree on a network, and a relay that is
down or blocks writes costs nothing.

Through that introduction the two devices swap **WebRTC session descriptions**:
the offer and answer, with their network candidates and DTLS fingerprints.
Trystero seals these with a password derived from the code. So a relay sees
ciphertext, and someone who does not hold the code cannot swap in their own
fingerprint. This is the step the [threat model](threat-model.md) cares about
most.

**ICE** then finds a route between the two. Each device lists its candidate
addresses: its local ones, the public one a STUN server reports, and an address
on the TURN relay. Both sides then try the candidate pairs until one works. The
one it settles on is the **route**:

- **local**: both on one network, talking by private address.
- **direct**: across the internet, through each side's NAT, with no relay.
- **relay**: through the free TURN relay, because nothing direct worked.

Once the WebRTC data channel is open (DTLS over SCTP), the two exchange fresh
ECDH public keys over it. That gives one key per direction for this session
alone, salted with the code.

### 2. Verifying

Both screens show four emoji derived from that ECDH. The two people compare them.
Until the sender confirms they match, **nothing about the file and no network
address beyond what ICE needed** goes to the other device. After that point the
negotiation below can hand out a listening port, so the order matters.
[protocol.md](protocol.md#two-gestures-and-why-neither-is-decorative) explains
why neither gesture can be skipped.

### 3. Negotiating

Every message from here on is a **sealed control frame** on the data channel,
encrypted and counted like a file chunk. Four kinds matter to the network:

- **The path verdict.** Each side reads the route ICE chose from WebRTC's own
  statistics and tells the other, and the screen shows the more expensive of the
  two readings. If the route is the TURN relay and the file is over 100 MiB, the
  sender stops before the manifest goes out, because free TURN is metered and
  would throttle or cut a large file.
- **The hellos**, `lan-hello` and `quic-hello`. The sender sends them after its
  confirm, and the receiver sends them only in reply. A peer that doesn't know a
  message type drops it, so an older build or a browser tab simply never answers,
  and the session stays on WebRTC.
- **The offers.** The side chosen to listen sends `lan-offer`, which holds its
  private addresses, a port, a one-time token and an answer. A Rust peer also
  sends `quic-offer`, with its addresses and its certificate's fingerprint. These
  addresses go only to the verified peer, and never into the signalling, where
  anyone holding the code could read them.
- **The manifest**: the file's name and size.

The direct links are dialled while the person reads the offer. They are ready by
the time Accept arrives, but nothing moves over them yet.

### 4. Moving the file

The receiver's Accept is the **one moment the sender changes route**. At that
instant, every frame the sender has put on WebRTC is one the receiver has
provably handled, so nothing on a new link can overtake anything on the old one.
An authenticated frame arriving out of order is fatal by design. The receiver
never changes route: its replies, including `pause` and `resume`, stay on WebRTC.

The file goes as sealed chunks of 16,348 bytes on WebRTC: a size chosen so each
chunk crosses as exactly one message. The receiver also controls the pace. It
sends `pause` when 4 MiB is waiting to be written and `resume` below 1 MiB, so a
slow disk holds the sender back instead of filling memory. At the end, the
sender sends the file's SHA-256 digest in `complete`, and the receiver answers
`done` once its copy matches.

### 5. Leaving

Each side sends a leave message to the room and closes every socket it opened. A
device that disappears without leaving is noticed when WebRTC's connection checks
stop being answered, about 30 seconds later. That is also what happens to a phone
whose operating system freezes the app in the background
([app.md, ColorOS](app.md#android-on-coloros)).

## Which route carries the file

<!-- Source: docs/diagrams/network-routes.mmd, rendered by scripts/make-diagrams.mjs. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/network-routes.dark.png">
  <img alt="Flowchart of the route decision, made when the receiver presses Accept. If the two ends are not both native, meaning the app or the command line rather than a browser tab, the file goes over the WebRTC data channel, direct or through TURN. If they are, and either end can listen without a firewall prompt, as Android and Linux can, the sender waits up to 2 seconds for the LAN link; if it is up, the file goes over the LAN WebSocket, on the operating system's TCP. Otherwise, if both ends run the Rust session built with QUIC, which today means the Rust command line, the sender waits up to 3 seconds for QUIC; if it is up, the file goes over QUIC, direct UDP that crosses most NATs. In every other case the file goes over WebRTC." src="diagrams/network-routes.light.png">
</picture>

| Route | Who can use it | Why it exists | Gives way to |
| --- | --- | --- | --- |
| **WebRTC data channel** | everyone, including a browser tab | the only route a browser can make, and it works almost anywhere thanks to TURN | anything faster that is up |
| **LAN WebSocket** | two native ends on one network, one of which can listen quietly | the OS's TCP, about 4 to 6 times a data channel on one network | nothing: it wins whenever it is up |
| **QUIC** | two Rust sessions built with QUIC (the Rust CLI today) | direct across most NATs, and far faster than a data channel over distance or loss | LAN, when both are up |

Three rules make this safe to choose automatically:

- **Every route carries the same sealed frames into the same handler.** A faster
  route adds speed, never trust. A frame that fails its check is dropped and
  counted, on any route.
- **"Listen quietly" is a real constraint, not a preference.** Accepting a
  connection on Windows, or in an unsigned macOS app, puts an OS firewall prompt
  in front of the person. So those ends only ever dial out, and two Windows
  machines stay on WebRTC.
- **Each direct link proves who is on the other end.**
  - On LAN, the dialler presents the token, and the listener must reply with the
    answer from its sealed offer.
  - On QUIC, each side's TLS accepts only the certificate fingerprint the other
    named.
  - So someone on the network who takes the connection can neither join it nor
    pose as the peer
    ([protocol.md, the local-network fast path](protocol.md#design-notes)).

## Inside the app

<!-- Source: docs/diagrams/network-app.mmd, rendered by scripts/make-diagrams.mjs. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/network-app.dark.png">
  <img alt="Two panels showing who talks to the network inside the app. In the JS session, used on Windows, macOS and Android, the webview page runs Trystero, WebRTC and the sealing, and talks to the other device over WebRTC or a LAN connection it dials out on; when the other device dials in over the LAN instead, it reaches a Rust LAN relay that listens on 127.0.0.1 and the LAN, reads no frame, and forwards to the page over 127.0.0.1. In the native session, the default on Linux and opt-in elsewhere, the webview page only draws the screens and talks to a Rust session (qrdrop-session over tryst and str0m) by IPC, words in and events out, and the Rust session talks to the other device over WebRTC or LAN with its own sockets." src="diagrams/network-app.light.png">
</picture>

The app is a webview around the website's own code, plus a small Rust process.
Its page is bundled into the app, so opening the app fetches nothing. The
network traffic is exactly what the sections above describe. Which part of the
app makes it depends on the session.

**The JS session** is the default on Windows, macOS and Android. The page does
everything a browser tab does: Trystero, WebRTC, sealing. The app adds the LAN
route, which a browser tab cannot have, because a page can open a connection but
cannot accept one:

- **Dialling out** is the page's own WebSocket to the peer's private address.
- **Listening** (Android only, among these three) is
  `app/src-tauri/src/lan.rs`, a relay in the Rust process. It binds one socket
  on the LAN for the peer and one on `127.0.0.1` for the page. Both sides must
  present the session's token. The relay then forwards whole messages between
  the two, never reading a frame or holding a key.
- **Why a relay and not IPC:** on Android, IPC carries bytes as base64 inside
  JSON, which would cost the LAN route its speed.

**The native session** is the default on Linux, whose webview has no WebRTC, and
can be switched on elsewhere. There, the whole transfer runs in Rust:
`qrdrop-session` over `tryst`, a Rust port of Trystero, using `str0m` for WebRTC.
It speaks the same wire, so it meets a browser tab, the Node CLI or another app on
the same relays. The page only draws the screens. It sends the person's decisions
(confirm, accept, cancel) as words over IPC, and gets events back in order. Both
safety gestures still belong to the page:

- Nothing is sent to the peer until the page says the four emoji matched.
- Nothing is written until the page's Accept arrives.

The app is built **without QUIC** for now, so an app transfer takes the LAN route
or WebRTC. QUIC waits on measurements of the phone between two networks
(`docs/notes/rust-session.md`).

**What the app is allowed to reach.** The app's Content-Security-Policy is
generated from the same signalling list the website uses. It adds `ws:` for the
LAN route, and the website's policy does not. A pairing link opened from the
camera or a QR scanner reaches the app as a `qrdrop:` link or an App Link. Either
way the code goes into the page's URL fragment, and never into a request.

## The website and the command line

- **The website** is the JS session in a browser tab, with WebRTC as its only
  route. GitHub Pages serves the page itself at `share.stan-ely.com`, and its
  service worker caches nothing. So after the page loads, the only traffic is the
  signalling, STUN, TURN and the peer.
- **The Node CLI** is the JS session under Node, using node-datachannel for
  WebRTC. It dials LAN routes everywhere, and listens on Linux.
- **The Rust CLI** runs `qrdrop-session`, the same Rust session as the app's
  native one. It is the one peer that offers QUIC today. `--no-lan` keeps either CLI's file on WebRTC, which turns off both LAN
  and QUIC.

**Beam** is the exception to this whole page. It moves a file as an animated QR
code from one screen to a camera, and uses no network at all
([beam.md](beam.md)).

## Where it lives in the code

| Part | JS | Rust |
| --- | --- | --- |
| Signalling, ICE, the data channel, pairing | `src/transport/room.js` | `crates/tryst`, `crates/qrdrop-session/src/pair.rs` |
| Route classification and the TURN cap | `room.js` (`classifyPath`, `RELAYED_MAX_BYTES`) | `qrdrop-session/src/path.rs` |
| Switching a sender's frames between routes | `src/transport/channel.js` | `qrdrop-session/src/session.rs` (`at_accept`) |
| The LAN route | `src/transport/lan.js`, `src/node/lan-server.js` | `qrdrop-session/src/lan.rs`, `app/src-tauri/src/lan.rs` |
| The QUIC route | none | `qrdrop-session/src/quic.rs` |
| Sealed frames and the control stream | `src/core/` | `crates/qrdrop-protocol` |
| The app's choice of session | `app/src/main.js`, `src/web/platform.js` | `app/src-tauri/src/native.rs` |
