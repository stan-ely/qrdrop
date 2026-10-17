# A Rust session for the apps and the CLI

Planned 2026-10-17. This is a multi-session plan, and this file is its tracking document. Every
session that works on it starts by reading the **Status** section and ends by updating it.

## Status

| Phase | State | Commits | Notes |
|---|---|---|---|
| 0. Groundwork | done, 2026-10-17 | `4c8508f`, `2498dac`, `f12c883`, `19a0184` | CI runs the Rust tests; workspace and vectors in; see "Phase 0: what it found" |
| 1. WebRTC spike and stack choice | not started | | |
| 2. `qrdrop-protocol` | not started | | |
| 3. `tryst`, sans-IO core and WebRTC peer | not started | | |
| 4. `tryst` signalling clients | not started | | |
| 5. `qrdrop-session` and LAN | not started | | |
| 6. Rust CLI and the cross-implementation suite | not started | | |
| 7. The apps on the native session | not started | | |
| 8. CLI distribution switch | not started | | |
| 9. QUIC path, Rust to Rust | not started | | |
| 10. Extraction prep | not started | | |

**Next step:** Phase 1, the WebRTC spike: a throwaway binary in the scratchpad that pairs with
node-datachannel and Chromium over a hand-carried SDP and moves bytes in Trystero's room frame and
action wire. `test/vectors/trystero.json` has both encodings, and the recordings show what a
working exchange looks like on the channel. ci.yml's `rust` job went green
on its first run (run 39016489083, 3 min 17 s), app host tests included.

**Decisions made so far:**
- **Scope.** Rust runs the whole session for the Tauri apps and the CLI. The website keeps the JS
  core.
- **Same wire.** The Rust side must interoperate with today's website and Node CLI.
- **QUIC signalling.** The QUIC path rendezvouses through the Trystero-compatible signalling, not
  through a discovery or relay system of its own. iroh is not assumed.
- **Location.** The code lives in this repo under `crates/` until the Trystero-compatible layer is
  mature enough to publish on its own.
- **Crate names.** `tryst` for the Trystero-compatible rooms, named apart from Trystero so a later
  crates.io release does not read as upstream's own; then `qrdrop-protocol`, `qrdrop-session` and
  `qrdrop-cli` (binary `qrdrop`). All four were free on crates.io on 2026-10-17, and `tryst` 0.0.1 was
  published that day, empty, to hold the name; the other three stay `publish = false`. Phase 10 can
  still revisit the name with upstream. Anything published after 0.0.1 bumps the version.
- **Feature flags.** Optional transports (the signalling strategies, WebRTC, LAN listen and dial,
  QUIC, file IO, the CLI's extras) are Cargo features, so each platform builds only what it uses.
  See "Feature flags".

**Still to decide, each in the phase that needs it:**
- the WebRTC crate (phase 1);
- the TLS crypto provider (phase 1);
- CLI distribution (phase 8).

**Open questions:** none yet.

## Why

The apps' transfers are capped by the JS side of the session, not the network. All figures are from
`app/CAPABILITIES.md`, "The bare transport, measured":

- **Phone sending on the LAN path: 15.5 MB/s**, over a socket that carries 30-50 bare. Every frame
  costs main-thread time in the page.
- **Phone receiving: 5.8 MB/s.** Android's sink takes base64 inside JSON IPC.
- **Over the internet, 1-2 MB/s at 50 ms RTT.** SCTP congestion control in Chromium's data channel
  holds it there, and JS cannot change it.
- **No network transfers on Linux.** WebKitGTK has no WebRTC, so the Linux app cannot transfer over
  the network at all.

In a Rust session, received bytes go from transport to decryption to file without passing through
the page, and sent bytes never pay for the page's main thread. A native transport also opens a QUIC
path between two Rust peers, with congestion control that is not SCTP's.

What it costs: a second implementation of the protocol, beside the JS one the website keeps. The
shared test vectors (phase 0) and the cross-implementation interop suite (phase 6) are what hold the
two together. Neither is optional.

## Architecture

The crates form a Cargo workspace at the repo root, under `crates/`, with its own `Cargo.lock`.
`app/src-tauri` stays a separate package with its own lock and depends on these crates by path. The
workspace declares `exclude = ["app"]`. That layout keeps every hard-coded `app/src-tauri/target`
path working, and so does the `sed` in `app-release.yml` that reads the first `version =` line of
`app/src-tauri/Cargo.toml`. A `version.workspace = true` there would break that `sed`.

| Crate | Role | IO | Extractable |
|---|---|---|---|
| `crates/tryst` | Trystero 0.25-compatible rooms. **Sans-IO core:** topics, signal crypto, the action wire, the room frame, the handshake, and the offer and glare state machine. **Async shell (tokio):** Nostr and torrent clients, and a WebRTC peer. Generic over app ID and actions. Exposes a signal channel so other transports (QUIC) can negotiate through it. | sans-IO core, tokio shell | **yes**, the library to publish |
| `crates/qrdrop-protocol` | Secret and code parsing (fragment only), KDFs, ECDH and SAS, frame seal and open, digest, control messages, and the sender and receiver state machines. | sans-IO, no tokio | maybe |
| `crates/qrdrop-session` | `open_room`: races the strategies, then the ECDH, the peer filter and early frames. Send and receive run loops. `Source` and `Sink` traits with std file implementations. LAN listener and dialer. Path classification. QUIC, later. | tokio | no |
| `crates/qrdrop-cli` | Binary `qrdrop`, with the same commands, flags, exit codes and stdout contract as `src/cli.js`. | | no |
| `app/src-tauri` | Tauri commands and events wrapping `qrdrop-session`. Android source and sink through the existing `sink.rs` and `storage.rs` code, refactored into plain functions. | | no |

Reusable today, from `app/src-tauri`:
- **From `lan.rs`:** `parse_token`, `same_token` (constant time), `offer_list`,
  `offered_addresses` (getifaddrs, private only, `MAX_ADDRS = 8`) and `authenticated()`.
- **From `storage.rs`, the pure std half:** `component` (the path-traversal guard), `candidate`,
  `split_name`, `create_unique` and `display_location`. The CLI's file sink can share these.
- **From `sink.rs`:** the open, write, close and abort lifecycle, with the Android media rescan on
  close. It is bound to `tauri::State` and `ipc::Request` today. Refactor it into plain functions
  taking `&AppHandle`, with thin commands on top.
- **From `share.rs`:** the share handoff already yields a file *path*, which is exactly what a native
  sender needs.

### Feature flags

Not every build needs every part of the session, so each optional transport is a Cargo feature, and
a build includes only what its platform uses. That keeps the Android `.so` smaller, which also means
fewer crates for f-droid.org to rebuild byte for byte. It also lets a platform rule become a build
property instead of a runtime check.

| Crate | Feature | Pulls in | Who enables it |
|---|---|---|---|
| `tryst` | `nostr` | WebSocket + TLS client, `k256` | everyone, by default |
| `tryst` | `torrent` | WebSocket + TLS client | everyone, by default |
| `tryst` | `webrtc` | the WebRTC stack chosen in phase 1 | everyone, by default; off only in a Rust-only build |
| `qrdrop-session` | `lan-dial` | WebSocket client | the CLI, every app target |
| `qrdrop-session` | `lan-listen` | WebSocket server, getifaddrs | the CLI; the app on Android and Linux only |
| `qrdrop-session` | `quic` | quinn, rustls | off until phase 9 passes its gate |
| `qrdrop-session` | `fs` | std file `Source` / `Sink` | the CLI and desktop apps; Android uses its own sink |
| `qrdrop-cli` | `web` | embedded `site/dist` for `qrdrop web` | release builds |
| `qrdrop-cli` | `qr` | terminal QR rendering | release builds |

Rules:

- **Features are additive and only ever add a path.** Cargo unifies features across a build, so a
  feature must never change how an existing path behaves, only whether an extra one exists.
- **The protocol says what a build lacks; it never guesses.**
  - A build without `lan-listen` answers `lan-hello` with `listen: "none"` (or `prompt`), exactly
    as a Windows peer does today.
  - A build without `quic` never advertises QUIC.

  So a peer cannot tell a missing feature from a peer that declined, and does not need to.
- **The platform rule moves into `Cargo.toml`.** The app chooses features per target with
  `[target.'cfg(...)'.dependencies]`. On Windows and macOS, `lan-listen` is simply not built, which
  is a stronger guarantee against a firewall prompt than today's runtime `MODE` constant in `lan.rs`.
- **The sans-IO crates have no transport features.** `qrdrop-protocol` and `tryst`'s core compile
  everywhere, with everything, so the vectors always test all of them.
- **CI builds a feature matrix:** every crate with `--no-default-features`, each feature on its own,
  and `--all-features`. A feature that only compiles alongside another is the bug this catches.
  Phase 0 sets this up; `cargo hack --each-feature` is the obvious tool, if adding it to `mise.toml`
  is acceptable.

### Dependency rules

**Pure Rust only.** f-droid.org publishes our signed APK only if its own build of the source matches
it byte for byte. That is what `app-reproducible.yml` and `scripts/android-env.mjs` check. Anything
built with `cc` or cmake needs NDK cross-compilation and still has to come out byte-identical, so it
is a risk to measure, not assume. The crate choices:

- **Crypto: RustCrypto.** `p256`, `hkdf`, `sha2`, `sha1`, and `aes-gcm`, with a 16-byte nonce for
  Trystero's signals; `k256` for BIP-340 Schnorr.
- **WebRTC: str0m or webrtc-rs, chosen in phase 1.** The criteria: DCEP data channels, trickle ICE,
  TURN, interop with Chromium and node-datachannel, and a reproducible aarch64 Android build.
- **TLS** for `wss://` relays and, later, QUIC: rustls with webpki-roots. The crypto provider (ring,
  or a pure-Rust one) is decided by the same reproducibility check.

`scripts/android-env.mjs` remaps the whole repo root and `CARGO_HOME`, so path dependencies under
`crates/` are covered. From phase 3, the path filters in `app.yml` and `app-reproducible.yml` must
include `crates/**`.

### Invariants carried over

Each of these is in CLAUDE.md for the JS, was broken once there, and gets its own Rust test:

- **Authenticate, then trust.** A frame that fails its tag is dropped and counted, never fatal, and
  there is no "give up after N drops". The order, type and fileSeq checks run only after
  decryption. A frame that passes its tag and is still out of order is fatal.
- **Peer filter.** Inbound frames are filtered by the paired `peerId`. The paired peer's frames are
  held until a handler exists, bounded at 16; a stranger's are dropped.
- **One ECDH keypair per strategy join**, never cached. Racing two strategies costs two keypairs.
  That is the price of forward secrecy.
- **One SAS roll per secret.** Nothing re-enters a pairing on the same secret. `--yes` skips the
  accept prompt and never the SAS.
- **Accept is never automatic**, and nothing is awaited ahead of opening the sink.
- **One control queue per direction.** Taking the index, sealing and sending are one queued step.
- **`fail()` is sticky, and the first error wins.** `next()` checks buffered messages before the
  failure. `flowGate()` checks the failure before the pause flag.
- **A leave fails the control stream only after `receiver.settled()`.**
- **Every exit closes the room** and waits for the leave, bounded at 2 s.
- **LAN timing.** The sender moves its frames to the LAN path only at the peer's Accept, and only
  after the SAS. The receiver never switches. A `lan-hello` goes out only after the SAS confirm.
- **Codes come from the URL fragment only**, never the query string. The bare `qrdrop:` form keeps
  working.
- **CLI colour is identity** when that stream is not a TTY, or when `NO_COLOR` is set.
- **`MAX_FRAME_BYTES` is the inbound tolerance and is not derived from `CHUNK_SIZE`.**
- **New, from Trystero's own failure: a signalling connection is never given up for good on a network
  error, and a room never joins an empty pool.** See phase 4.

## The wire, as the Rust side must speak it

Read from the code on 2026-10-17: `src/core`, `src/transport`, and Trystero 0.25.4 under
`node_modules/@trystero-p2p/`. All three Trystero packages are at 0.25.4, sharing one copy of core.
References are to those files.

### Trystero 0.25.4

**What qrdrop passes in** (`src/transport/room.js:686-695`):
- `appId: 'qrdrop'`;
- the room ID is the qrdrop topic;
- the `password`;
- `relayConfig.urls`, which replaces Trystero's own list and skips its shuffle;
- `rtcConfig.iceServers`, which replaces Trystero's default STUN list.

qrdrop joins Nostr and torrent at once, keeps whichever pairs first, and calls `leave()` on the
loser.

**IDs and topics** (`core/dist/utils.mjs`, `crypto.mjs`, `strategy.mjs:81-84`):
- **`selfId`:** 20 characters from `0-9A-Za-z`. One per process.
- **Trystero's "sha1" string:** SHA-1 of the UTF-8 input, then each byte as lowercase base36 with no
  padding, concatenated. Its length varies.
- **`rootTopic`** = sha1(`"Trystero@qrdrop@<roomId>"`).
- **`selfTopic`** = sha1(`"Trystero@qrdrop@<roomId>@<selfId>"`). A peer's topic uses their ID the
  same way.
- **Torrent `info_hash`** = the first 20 characters of sha1(rootTopic).
- **Room token** = lowercase hex of SHA-256(`"Trystero:qrdrop:<roomId>"`). Note the colons, not `@`.
- **Nostr kind** = (sum of the topic's char codes) mod 10000, plus 20000. That is in the ephemeral
  range.

**Signal encryption** (`core/dist/crypto.mjs:12-22`).
- **Key.** The raw AES-256-GCM key is SHA-256(`"<password>:<appId>:<roomId>"`). There is **no
  PBKDF2** and no salt; the comments in `room.js` and `secret.js` that say otherwise are wrong.
- **IV.** **16 random bytes**, not 12. WebCrypto accepts that through GHASH-derived J0. In Rust, use
  `AesGcm<Aes256, U16>`.
- **Wire form.** `iv.join(",") + "$" + base64(ciphertext ‖ 16-byte tag)`.
- **What is encrypted.** Only the SDP string. For candidates, the plaintext is
  `JSON.stringify({candidate, sdpMid, sdpMLineIndex, usernameFragment})`.
- **Failure.** An offer or answer that fails to decrypt is dropped.

**Nostr** (`nostr/dist/index.mjs`, `core/dist/topic-strategy.mjs`, `signal-handler.mjs`):
- **Keys and events.**
  - One secp256k1 Schnorr keypair per process.
  - Events are `{kind, tags: [["x", topic]], created_at, content, pubkey}`. The `id` and BIP-340
    `sig` follow NIP-01. There is no proof-of-work.
- **Subscription.** One REQ per relay, `{kinds, since: now, "#x": [rootTopic, selfTopic]}`, so the
  clock must be roughly right.
- **Announce, to rootTopic:** `{"peerId": selfId}`.
- **Signals, to the recipient's selfTopic:** `{peerId, offerId, offer}`, `{peerId, answer, offerId}`
  and `{peerId, offerId, candidate}`.
  - The `offer`, `answer` and `candidate` fields are ciphertext and must be non-empty strings.
  - `offerId` is a 12-character ID.
- **Who offers.** The lower ID offers. A peer that sees an announce from a lower ID sends
  `{"peerId": selfId}` to that peer's selfTopic as a nudge.
  - **Glare:** an incoming offer is ignored while we have one outstanding and our ID is lower.
  - An answer is applied only if its `offerId` matches.
- **Timing.**
  - Announce right after subscribing, then at 233, 533 and 1333 ms, then every 60 s. A disconnect
    restarts that warm-up.
  - An unanswered offer is re-sent with the same `offerId` after about 4.8 s. Offers expire after
    57.3 s.
  - A rate-limited relay backs off 60 s, doubling up to 15 min. A `CLOSED`, or an `OK false` that is
    not a duplicate, retires the relay.
- **ICE.** Nostr trickles ICE candidates.

**Torrent** (`torrent/dist/index.mjs`):
- **Every message** is `{"action": "announce", "info_hash", "peer_id": selfId, ...}`.
- **Active announce:** `numwant: 3`, plus up to three outstanding offers, each
  `{offer_id, offer: {type: "offer", sdp: <cipher>}}`. They are reused until answered or 120 s old.
- **Answer:** `{answer: {type: "answer", sdp: <cipher>}, offer_id, to_peer_id}`. Inbound answers are
  matched by `offer_id`, which here is 20 characters (`genId(20)`), not Nostr's 12.
- **Who answers.** In practice, the lower ID's offer is the one answered.
- **No trickle.** The full SDP goes out after gathering completes, or after 15 s.
- **Duplicates and pacing.** Repeats within 4 s are dropped. The tracker interval is clamped to
  10-120 s.

**Peer connection** (`core/dist/peer.mjs`):
- **The channel.** The offerer creates one channel, `createDataChannel("data")`, with default
  options: ordered, reliable, negotiated through DCEP. The answerer takes it from `ondatachannel`.
  `bufferedAmountLowThreshold` is 65535.
- **Closing.** The peer is closed on `failed` or `closed`, or after 5 s `disconnected`.
- **Timeouts.** An answered offer that has not connected is torn down after 23.3 s.

**Data channel framing.** Every message on the channel is wrapped in a room frame
(`core/dist/shared-peer.mjs`). A peer that sends bare action chunks is ignored.
- **Data frame:** `[0x01][token length, u16 BE][64-character hex room token][action chunk]`, 67
  bytes of overhead.
- **Presence frame:** `[0x02][1 present / 0 gone][length][token]`. A single-room peer may ignore
  inbound presence frames, but must tolerate them: the recordings show each JS side sending two per
  run.

**Action chunk** (`core/dist/action-wire.mjs`):

| Bytes | Contents |
|---|---|
| 0-31 | action name, UTF-8, NUL-padded |
| 32-33 | nonce, u16 BE, one counter per action |
| 34 | flags: bit0 last, bit1 metadata, bit2 binary, bit3 JSON |
| 35 | progress, `round((i+1)/total*255)` |
| 36.. | payload, at most `16384 - 36 = 16348` bytes per chunk |

- **Encodings.** A string payload has bits 2 and 3 clear. Binary has **both** bits 2 and 3 set (a
  final binary chunk is `0x0D`), so a receiver checks binary before JSON. Other values are JSON
  with bit 3.
- **Reassembly.** Chunks are reassembled per (peer, action, nonce) until the last flag.
- **Backpressure.** Before each chunk the sender waits while `bufferedAmount > 65535`. After 10 s it
  silently drops the rest of that message.

**Handshake and lifecycle** (`core/dist/handshake.mjs`, `room.mjs`):
- **The password check runs over the channel, and is always on for qrdrop.** The lower ID sends
  `@_hsdata` `{"__trystero_pw": "challenge", "c": <36-character ID>}`. The other side answers
  `{"__trystero_pw": "response", "h": hex(SHA-256("<c>:<password>:<appId>:<roomId>"))}`.
- **`@_hsready`.** Each side then sends `@_hsready` with payload `""`. A JS peer fires `onPeerJoin`
  only after its own check passes **and** the other side's `@_hsready` arrives. Without that, the
  peer is dropped after 10 s.
- **Pending peers.** Before activation, only `@_hsdata`, `@_hsready` and `@_leave` are accepted.
  `ecdh` and `frame` sent early are dropped.
- **Leaving.** `leave()` sends `@_leave ""` to every peer, waits 99 ms, then closes.
- **No keepalive.** `@_ping`/`@_pong` exist but are sent only on request.

**qrdrop on top** (`room.js:697-826`). After `onPeerJoin`, each side sends its public key as a JSON
string on action `ecdh`. The first `ecdh` received fixes the paired peer, and later ones are
ignored. File data goes as binary `frame` messages, sent to that peer only.

### qrdrop key derivation (`src/core/secret.js`, `src/core/session.js`)

**From the 32-byte secret.** HKDF-SHA-256, salt = UTF-8 `"qrdrop/v1"`:
- **topic:** 16 bytes with info `"topic"`, as base64url with no padding (22 characters);
- **password:** 32 bytes with info `"signal"`, as base64url with no padding (43 characters).

**Code formats.** The code is `qrdrop:` plus base64url(secret) and must match
`^qrdrop:([A-Za-z0-9_-]{43})$`. The URL form carries it **in the fragment only**.

**ECDH.**
- **Curve.** P-256. Public keys are exported raw: 65 bytes, uncompressed. They are exchanged as
  base64url with no padding.
- **Shared secret.** The 32-byte X coordinate.
- **Transcript.** SHA-256(lo ‖ hi), with the two public keys sorted bytewise.
- **Each session value.** HKDF-SHA-256 with IKM = the shared secret, **salt = the raw QR secret**,
  and info = UTF-8(label) ‖ transcript:
  - `"host->guest"` and `"guest->host"`: AES-256-GCM keys, 32 bytes each;
  - `"sas"`: 4 bytes.
- **Who uses which.** The host (the QR side, the sender) sends with `host->guest`. The guest is the
  reverse.

**SAS.**
- **Symbols.** `SAS_EMOJI[byte[i] & 0x3f]` for i = 0..3, from the 64-entry `[emoji, word]` table in
  `session.js:187-204`. Six of its entries carry U+FE0F.
- **`sas` and `sasWords`.** `sas` is the four emoji joined by a single space. `sasWords` is their
  words.
- **CLI form.** The CLI prints `"<emoji> <word>"` four times, joined by **three spaces**
  (`cli.js:438-441`).

### Frames (`src/core/frame.js`)

**Header (14 bytes).**
- `[0]` type: 0 = control, 1 = chunk.
- `[1..4]` fileSeq, u32 BE.
- `[5..12]` index, u64 BE.
- `[13]` last: written as 1 or 0, and read as true only when it equals 1.

**Frame.** A frame is the header ‖ AES-GCM(ciphertext ‖ 16-byte tag). The IV is `header[1..13]` and
the AAD is the whole header. There is no other nonce derivation.

**Sizes.**
- `CHUNK_SIZE` = `16384 - 36 - 14 - 16` = 16318, so a full sealed frame is 16348 bytes, exactly one
  Trystero chunk.
- `MAX_FRAME_BYTES` = `14 + 16384 + 16` = 16414. It is inbound only.
- The smallest frame is 30 bytes.

**Control frames.**
- Header: fileSeq `0xFFFFFFFF`, `last` = 0.
- Index: one counter per direction, starting at 0 and covering every control message.
- Plaintext: UTF-8 JSON.
- Inbound, the expected index advances on every authenticated control frame, unknown types
  included.
- Types arrive in no fixed order.

**Chunk frames.**
- fileSeq is the manifest's `seq`, always 0 today.
- The index runs from 0 to n-1, and `last` is set only on n-1.
- `chunks = max(1, ceil(size / CHUNK_SIZE))`, so an empty file is one empty chunk.

**What the receiver checks.**
- Bytes received never exceed `size`.
- `last` arrives only when the count equals `manifest.chunks`.
- On `complete`, the count and size match and the digest compares equal in constant time.

**Digest.** Start with 32 zero bytes, then for each chunk `c = SHA-256(c ‖ SHA-256(chunk))`. It is
sent as 64 lowercase hex characters.

### Control messages

| Message | Fields | Sent by |
|---|---|---|
| `manifest` | `{t, seq, name, size, mime, chunks}`; mime defaults to `application/octet-stream` | sender |
| `accept` / `decline` / `done` | `{t, seq}` | receiver |
| `complete` | `{t, seq, chunks, digest}` | sender |
| `error` | `{t, seq, message}`; message cut to 200 UTF-16 units | receiver |
| `path` | `{t, path}`, one of local / direct / relay / unknown | both, advisory |
| `pause` / `resume` | `{t}`; pause at 4 MiB written-but-unflushed, resume at 1 MiB; the sender gives up after 120 s paused | receiver |
| `lan-hello` | `{t, listen}`, one of quiet / prompt / none | sender first, receiver only in reply |
| `lan-offer` | `{t, addrs, port, token}`; token is 32 hex characters | whichever side listens |

Unknown types are ignored, and still consume their index. A waiter for `error` matches any `seq`.

**Sender order.**
1. Pair, then the SAS confirm, then the relay size cap (100 MiB).
2. Send the path verdict, `lan-hello` and the `manifest`.
3. Wait for accept, decline or error.
4. At accept, run `lan.ready()`, which waits up to 2 s.
5. Send the chunks, then `complete`.
6. Wait for `done` or error.

The web sender may send its path verdict before the SAS confirm. The manifest and the hello are
always after it.

**Receiver order.**
1. SAS confirm, then register the frame handler, which flushes held frames.
2. Send the path verdict.
3. Answer a `lan-hello` at once, ahead of Accept.
4. Show the offer and send accept or decline.
5. Take the chunks, verify at `complete`, close the file, send `done`.

### LAN fast path (`src/transport/lan.js`, `src/node/lan-server.js`)

- **Who listens.** The receiver if it is `quiet`, otherwise the sender if it is `quiet`, otherwise
  nobody, and the transfer stays on WebRTC. Unknown modes count as `none`. The CLI is quiet on Linux
  and Android and prompt elsewhere; `QRDROP_LAN_LISTEN` overrides it.
- **The offer.** The listener sends `lan-offer` even if it failed to listen, with `addrs: []` and
  `port: 0`. A valid offer has:
  - 1 to 8 addresses, each dotted IPv4, private, and not `127.*`;
  - a port from 1 to 65535;
  - a token matching `^[0-9a-f]{32}$`.
- **Dial.** Every address at once, as `ws://<addr>:<port>/`, with 2 s each.
- **Handshake.**
  - The dialler's first binary message is the 16 raw token bytes. The listener compares them in
    constant time and replies `0x06`.
  - The listener allows 5 s for the token and accepts exactly one connection.
- **After the handshake.** One sealed frame per binary message; text is dropped.
- **Server-side WebSocket rules.** Client frames must be masked. Messages over 64 KiB are closed with
  1009.
- **Switching.** Only the sender switches, at Accept. A sender that sees Accept with no `lan-hello`
  from the peer treats it as an older build and does not wait.
- **Send buffer.** High mark 1 MiB, low mark 256 KiB.

### The CLI's contract (`src/cli.js`, `e2e/interop.e2e.mjs`)

- **Commands:** `send <file>`, `receive [code]`, `web`, `--help`, `--version`. `beam` is refused,
  because it is browser-only.
- **Flags:** `--no-qr`, `--yes`, `--out <dir>`, `--port <n>`, `--no-open`,
  `--strategy nostr|torrent`, `--relay <url>`…, `--qr-url <base>`, `--no-lan`, `--debug`.
- **Exit codes:**
  - 0 on success, and on a declined receive;
  - 1 on an error, and on a declined send;
  - 2 on a usage error;
  - 130 on Ctrl-C, after the hooks run, bounded at 2 s.
- **What the interop suite parses.** It runs with `NO_COLOR=1` and stdout redirected. It looks for:
  - `qrdrop:[A-Za-z0-9_-]{43}`;
  - `Both devices should be showing:`, a blank line, then the SAS line, which must be identical on
    both sides;
  - `Incoming:.*Accept\?`;
  - `digest=[0-9a-f]{64}`;
  - `direct connection on the local network`, on the sender, exactly when the LAN path ran.

  It answers `y` on stdin, and the SAS prompt must read stdin even when stdin is not a TTY.
- **Out of scope.** Beam is web-only and stays in JS.

## Phases

Each phase is meant to fit one session and to end green, with this file updated. A phase that runs
long splits; it does not end half-done without a note here.

### Phase 0: groundwork

- **Rust in CI.** Add a `cargo test` job to `ci.yml` for `crates/` and for `app/src-tauri`'s host
  tests. Nothing runs Rust tests in CI today, so the existing ones in `lan.rs`, `share.rs`, `sink.rs`
  and `storage.rs` have never run there.
- **The workspace.** Create the `crates/` skeleton, settle crate names, and declare the feature names
  from "Feature flags" (empty for now). The CI Rust job builds the feature matrix from day one.
- **Vectors.** Write `scripts/make-vectors.mjs`. It drives the real JS core to write fixed vectors
  into `test/vectors/*.json`:
  - secret to topic and password;
  - ECDH to the session keys and SAS. The keys are non-extractable, so re-derive them with
    `deriveBits` in the script.
  - sealed chunk and control frames, and digests.
- **Trystero recordings.** A Node harness records real Trystero traffic: Nostr events, torrent
  messages, signal ciphertexts, action chunks, room frames and the handshake.
- **A JS test asserts the vectors**, so they cannot drift from the JS.
- **Comments.** Correct the PBKDF2 comments at `src/transport/room.js:657` and
  `src/core/secret.js:70-81`.

### Phase 0: what it found

Done on 2026-10-17. Where things are:

- **CI.** `ci.yml`'s `rust` job runs `cargo test --workspace --all-features`, then
  `cargo hack check --workspace --each-feature --no-dev-deps` (17 combinations today), then
  `cargo test` in `app/src-tauri` (16 host tests). `mise run rust:test` and `mise run
  rust:features` are the same commands locally; cargo-hack is pinned in `mise.toml`.
- **Workspace.** `Cargo.toml` at the repo root, `members = ["crates/*"]`, `exclude = ["app"]`, its
  own `Cargo.lock` and `/target/`. `cargo metadata` confirms `app/src-tauri` is still its own
  workspace root with its own target directory. All four crates are empty, `publish = false`, and
  declare the feature names from "Feature flags".
- **Vectors.** `node scripts/make-vectors.mjs` writes `test/vectors/{secret,session,frames,digest,
  trystero}.json`; `--check` exits 1 if they are stale. Each file's `about` field gives its
  encoding (hex bytes; `{"mod251": n}` for large plaintexts).
- **Recordings.** `node scripts/record-trystero.mjs` writes `trystero-recording.json` through a
  stand-in relay and tracker, offline; `--live` writes `trystero-recording-live.json` through
  the public ones. Peer connections are bound to 127.0.0.1, so no SDP names a real address.
- **The guard.** `test/vectors.test.mjs` (in `npm test`) rebuilds the vectors and compares them byte
  for byte, cross-checks the values the script had to compute itself, and checks the recordings
  against Trystero's own code. `test/helpers/trystero.mjs` refuses any Trystero but 0.25.4.

Found on the way, beyond what the wire section above already said:

- **A code's last character has two padding bits that the JS ignores.** `fromBase64url` goes through
  `atob`, so a code differing only there decodes to the same secret. The Rust decoder must accept
  non-canonical trailing bits, which the `base64` crate rejects by default. `secret.json` has the
  case.
- **Each side sends two room presence frames** per run, which Phase 3 must at least accept and drop.
- **Flags seen on the wire:** `@_hsdata` is JSON (`0x09` when last), `@_hsready` and `@_leave` are
  strings (`0x01`), a metadata chunk is `0x02` with nothing else set, and a full frame chunk is
  `0x0D` in a 16451-byte channel message (67 + 36 + 16348).

### Phase 1: WebRTC spike and stack choice

A throwaway binary, in the scratchpad and not the repo, pairs with node-datachannel and with
Chromium, using an SDP exchanged by hand. It opens the DCEP channel and moves bytes in Trystero's room
frame and action wire. Measure:
- interop;
- throughput on loopback, and under the WSL `unshare -rn` plus netem harness from
  `app/CAPABILITIES.md`, against the recorded Chromium and node-datachannel figures;
- whether an aarch64 Android build of the crate is byte-reproducible across two directories and two
  `CARGO_HOME`s.

Decide the WebRTC crate and the TLS provider. Record both here, and the numbers in CAPABILITIES.md.

### Phase 2: `qrdrop-protocol`

Port, sans-IO:
- secret and code parsing;
- the KDFs, session and SAS;
- frame seal and open;
- the digest;
- control messages;
- the sender and receiver state machines, with flow control and every invariant above.

It passes all of phase 0's vectors. Its tests port `test/frame`, `crypto`, `secret`, `transfer`,
`control-order` and `control-stream`.

### Phase 3: `tryst`, sans-IO core and WebRTC peer

- Topics and signal crypto.
- The action wire, including reassembly and the binary-before-JSON rule, and the room frame.
- The `@_hsdata` / `@_hsready` handshake, `@_leave`, and the offer and glare state machine.

Test all of it against the phase 0 recordings, then put the WebRTC peer behind it on the chosen
stack. Add `crates/**` to the path filters in `app.yml` and `app-reproducible.yml`.

### Phase 4: `tryst` signalling clients

Nostr and torrent clients:
- per-relay connections, backoff and retirement;
- the warm-up announce schedule;
- offer re-send and expiry.

**Compatible on the wire does not mean copying Trystero's client behaviour, and one behaviour must not
be copied.** Trystero 0.25.4's `makeSocket` (`core/dist/utils.mjs`) retries a closed relay socket
with backoff (3.3, 6.7, 13, 27, 53 s). After that it sets `isClosed` and never tries again.
`relayManager.register` then keeps handing that dead client to every later room, so the room joins
nothing and pairing ends in "Timed out waiting for the other device" until the app is force-stopped.

This was reproduced on 2026-10-17 on the API 35 emulator. Android 15's background firewall chain
blocks the app's uid within seconds of it leaving the foreground (a folder picker in front is
enough). About 10 s later every relay socket closes, and with a cold DNS cache the whole backoff runs
out inside the block. `navigator.onLine` stays true, so Trystero's online/offline pause never starts.
(The details are in the `trystero-relay-giveup` memory note.)

The Rust clients therefore follow these rules, each with a test:

- **Never retire a relay for a network failure.** Back off up to a cap, then keep retrying at the
  cap. Retirement (`CLOSED`, a non-duplicate `OK false`) is for what the relay *said*, never for a
  socket that dropped.
- **A room never joins on a pool with nothing alive in it.** Joining checks the pool. Every
  connection that is down is redialled at once, with its backoff reset, and the room waits for one
  to come up. If none does, the error names the cause ("no signalling server reachable"), not the
  peer.
- **Resume is an event.** The app tells the session when it returns to the foreground (Tauri's
  resume event on mobile; the page gets nothing, per CLAUDE.md), and the session resets every backoff
  and redials. This replaces the page's 1.5 s poll for this purpose.
- **A blocked network is not a timeout to wait out.** The test is the emulator repro: receive, idle
  75 s, picker 120 s, receive. It must pair.

The background block still kills a *live* transfer, as the ColorOS freeze does. Nothing in-process
can fix that, and this phase does not claim to.

Phases 1-6 are months away, so the JS fix the memory note proposes should not wait for them. That
fix is to check `getRelaySockets()` before joining and recover, or upstream a Trystero change.

Then the race across both. **Gate:** over the public relays, a Rust peer and a real Node Trystero peer
join one room and both fire `onPeerJoin`. That check is a new e2e script, out of `npm test` like the
others.

### Phase 5: `qrdrop-session` and LAN

- `open_room`, the run loops, file `Source` and `Sink`, path classification, and the LAN listener and
  dialer.
- On interrupt: close the room and wait for the leave.
- Tests port the behaviour of `test/room`, `lan`, `backpressure` and `transfer`, against an in-memory
  fake network as `test/helpers/fake-network.mjs` does.

### Phase 6: the Rust CLI and the cross-implementation suite

- **The CLI.** `crates/qrdrop-cli` matches `src/cli.js`'s output contract exactly.
- **The interop matrix.** `e2e/interop.e2e.mjs` takes a launcher override per side (for example
  `QRDROP_SEND_CLI` and `QRDROP_RECV_CLI`) and runs JS↔JS, JS→Rust, Rust→JS and Rust↔Rust, each with
  and without the LAN path.
- **Browser to Rust.** A new e2e drives a Chromium tab against the Rust CLI, which is the real check
  against the website's JS core.
- **Shipping.** The JS CLI keeps shipping until phase 8.

### Phase 7: the apps on the native session

- **Commands.** Tauri commands start a send or receive and pass on confirm, reject, accept, decline
  and cancel.
- **Events.** They carry status, the SAS, path, offer, progress, `lan`, done and error, in the state
  shape `element.js` already renders.
- **The page seam.** Add an optional `session` member to `Platform` in `src/web/platform.js`,
  registered only from `app/src/main.js`. `_startSend` and `_startReceive` branch on it, so the
  website cannot regress.
- **Where a sent file comes from:**
  - share handoffs already carry a path;
  - picking goes through plugin-dialog `open()`;
  - desktop drag and drop uses Tauri's drop event, which carries paths;
  - a pasted `File` with no path falls back to the JS session.
- **Android.**
  - Receiving writes through the refactored `storage.rs` and `sink.rs`, so no base64 crosses IPC.
  - Sending reads `content://` through plugin-fs's file descriptor.
- **What stays in JS.** Beam stays in JS, and so does `createTauriSink` for it. The JS session stays
  as a runtime fallback, behind a flag, until the device runs pass.
- **Measure on the RMX3868.** Run phone↔CLI and phone↔desktop app, both directions. **Gate:**
  clearly above 15.5 MB/s sending and 5.8 MB/s receiving on the LAN path, with no regression on
  WebRTC.
- **Linux** gets network transfers.
- **CLAUDE.md.** Update the Tauri section and the platform seam.

### Phase 8: CLI distribution switch

Decide at the start of the phase. The recommendation is:
- release binaries per target from `publish.yml`'s `release` job;
- the npm `qrdrop` package becomes an esbuild-style wrapper with per-platform optional packages, so
  `npx qrdrop` keeps working;
- the Homebrew formula and the Scoop manifest point at the binaries.

Handle these together:
- Trusted Publishing for each platform package;
- **never renaming `publish.yml`**;
- `qrdrop web` embedding `site/dist`;
- an explicit exception to CLAUDE.md's "no new runtime dependencies";
- what happens to the `./node` export.

### Phase 9: QUIC path, Rust to Rust

- **Advertising it.** A Rust peer advertises QUIC through the Trystero-compatible signalling, as an
  extra field or signal that a JS peer ignores. Verify that against the real Node Trystero before
  relying on it.
- **Negotiating.** Two Rust peers exchange QUIC candidates (host addresses, plus server-reflexive ones
  from STUN on `ICE_SERVERS`) and self-signed certificate fingerprints, inside the password-encrypted
  signal. They hole-punch by simultaneous open with quinn.
- **Fallback.** If that fails, WebRTC, TURN included.
- **What stays the same.** qrdrop's ECDH, SAS and frame AEAD run on top unchanged, with frames on one
  QUIC stream. Larger frames on this path are a separate protocol decision.
- **Keep it only if it wins.** Measure under netem at 20, 50 and 100 ms RTT, and on the phone. Keep
  it only if it clearly beats SCTP.

### Phase 10: extraction prep

- The `tryst` crate gets a clean API, docs, examples and its own vectors.
- Settle the licence and the name, then publish to crates.io.

## Verification, every phase

- **JS side.** `npm test` and `npm run typecheck` stay green, and the vector test proves the vectors
  still match the JS.
- **Rust tests.** From phase 0, `cargo test --workspace` in `crates/` and `cargo test` in
  `app/src-tauri` run in CI.
- **Reproducibility.** From phase 3, the two-directory APK check in `app-reproducible.yml` stays
  byte-identical.
- **Relays.** The e2e suites over real relays count a relay outage as weather, not as a pass.
- **Device measurements** go in `app/CAPABILITIES.md` in its existing form: receiver-side MB/s, at
  least three runs, digests equal.
