# A Rust session for the apps and the CLI

Planned 2026-10-17. This is a multi-session plan, and this file is its tracking document. Every
session that works on it starts by reading the **Status** section and ends by updating it.

## Status

| Phase | State | Commits | Notes |
|---|---|---|---|
| 0. Groundwork | done, 2026-10-17 | `4c8508f`, `2498dac`, `f12c883`, `19a0184` | CI runs the Rust tests; workspace and vectors in; see "Phase 0: what it found" |
| 1. WebRTC spike and stack choice | done, 2026-10-17 | `a631f1f` | str0m chosen, TLS on ring; the spikes stayed in the scratchpad; see "Phase 1: what it found" |
| 2. `qrdrop-protocol` | done, 2026-10-17 | `d935920` | every phase 0 vector passes; see "Phase 2: what it found" |
| 3. `tryst`, sans-IO core and WebRTC peer | done, 2026-10-18 | `228f0f1` | every Trystero vector and both recordings pass; two str0m peers join in-process; see "Phase 3: what it found" |
| 4. `tryst` signalling clients | done, 2026-10-18 | `a798f24` | a Rust peer and Node Trystero pair over the public relays and trackers, both roles; see "Phase 4: what it found" |
| 5. `qrdrop-session` and LAN | done, 2026-10-18 | `2982bea` | two Rust sessions pair, verify and move a file over the stand-ins and over the public relays; TURN in `tryst`; see "Phase 5: what it found" |
| 6. Rust CLI and the cross-implementation suite | done, 2026-10-18 | `aa5026a` | the Rust CLI passes the interop matrix against the Node CLI in all four pairings, WebRTC and LAN, and a Chromium tab both ways; see "Phase 6: what it found" |
| 7. The apps on the native session | desktop done, 2026-10-18; device runs pending | `a142b52`, `04504bc`, `7573183`, `5b959bd` | the desktop app runs a transfer on `qrdrop-session` both ways against the Node CLI; on by default on Linux only, until the RMX3868 gate is measured; see "Phase 7: what it found" |
| 8. CLI distribution switch | done in the tree, 2026-10-18; first release pending | `ec79928` | `qrdrop` runs the Rust CLI from a per-platform npm package and falls back to the Node CLI; all five targets build on CI; the npm names need a first publish by hand; see "Phase 8: what it found" |
| 9. QUIC path, Rust to Rust | done for the CLI, 2026-10-18; the phone pending | `1a4f465` | the session moves a file over quinn after the SAS, through two NATs, and falls back to WebRTC; three to ten times SCTP under netem; on in the Rust CLI, off in the app until the RMX3868 gate; see "Phase 9: what it found" |
| 10. Extraction prep | done, 2026-10-18; the publish awaits the owner | `08990d5`, `5355471` | `tryst` 0.1.0 is documented, carries its own vectors and licence, and passes its tests built from its own tarball outside the workspace; the crates.io publish is the owner's call; see "Phase 10: what it found" |

**Next step:** every phase is done as far as this machine can take it. What is left waits on a
person or a device:
- **Publishing `tryst` 0.1.0** to crates.io: `cargo publish -p tryst`, once the owner agrees
  (see "Phase 10: what it found").
- **Phase 7's device runs** need the RMX3868 attached (switch the phone with
  `localStorage.setItem('qrdrop:native-session', '1')` in the WebView's devtools).
- **Phase 9's phone gate** needs the same phone, and an app built with `qrdrop-session/quic`;
  the QUIC path is the CLI's alone until then.
- **Phase 8's first release** needs the five platform names published once by hand, and a Trusted
  Publishing entry for each (see "Phase 8: what it found").

**Decisions made so far:**
- **Scope.** Rust runs the whole session for the Tauri apps and the CLI. The website keeps the JS
  core.
- **Same wire.** The Rust side must interoperate with today's website and Node CLI.
- **QUIC signalling.** The QUIC path rendezvouses through the Trystero-compatible room, not
  through a discovery or relay system of its own. iroh is not assumed. Phase 9 put the candidates
  on the room's sealed control stream after the SAS rather than in the signal itself, which anyone
  holding the code can read (see "Phase 9: what it found").
- **CLI distribution (phase 8).** Release binaries per target; the npm `qrdrop` package becomes a
  launcher over per-platform optional packages, so `npx qrdrop` keeps working; Homebrew and Scoop
  point at the binaries. Decided 2026-10-18, on the recommendation below.
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
- **WebRTC: str0m 0.24**, `rust-crypto` backend, with `str0m-rust-crypto` vendored inside the
  workspace minus its `rcgen` dependency. It interoperates with Chromium and node-datachannel in
  every role and direction, and it is the only stack measured whose receive side holds up over a
  round trip. webrtc-rs was the alternative: it ships TURN and gathering, and reproduces, but its
  receive side falls to 1.6 MB/s at 50 ms. See "Phase 1: what it found".
- **TLS provider: ring**, measured byte-reproducible for aarch64 Android in phase 1.
- **RustCrypto at str0m's generation**: `p256` 0.13, `aes-gcm` 0.10, `hkdf` 0.12 and `sha2` 0.10,
  although 0.14/0.11/0.13/0.11 are out. The app links str0m's DTLS stack too, and one generation
  means one copy of each crate in the Android `.so`. They move when str0m's do.

**Still to decide:**
- **A TURN server that works.** The openrelay entries in `ICE_SERVERS` are dead for the JS and the
  Rust alike (see "Phase 5: what it found"). Replacing them is an operator choice (a hosted service
  with credentials, or one run for qrdrop), not a code change, and it is the owner's to make.

**Open questions:**
- **Settled in phase 7: the app is a member of the root workspace.** A path dependency outside the
  building workspace's root is hashed by its absolute path into every symbol (phase 1 measured 128
  bytes between two checkouts), so the app could not stay its own workspace and depend on
  `crates/`. Moving `tryst` to its own repository would not have been enough, since the app also
  needs `qrdrop-protocol` and `qrdrop-session`. See "Phase 7: what it found".
- **Upstream the `rcgen` fix to str0m** (an optional feature in `str0m-rust-crypto`), so the vendored
  copy can go.

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

The crates form a Cargo workspace at the repo root, under `crates/`, and since phase 7
`app/src-tauri` is a member of it (not a default one), with one `Cargo.lock` at the root. It was a
separate workspace until then, and that could not survive its first dependency on `crates/`: see
"Phase 7: what it found". `app/src-tauri/.cargo/config.toml` keeps its output in
`app/src-tauri/target`, so every hard-coded path there still holds, and its `version` stays a
literal, so the `sed` in `app-release.yml` that reads the first `version =` line of
`app/src-tauri/Cargo.toml` still works. A `version.workspace = true` there would break that `sed`.

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
| `tryst` | `webrtc` | str0m (chosen in phase 1), `stun-proto`, `turn-client-proto` | everyone, by default; off only in a Rust-only build |
| `qrdrop-session` | `lan-dial` | WebSocket client | the CLI, every app target |
| `qrdrop-session` | `lan-listen` | WebSocket server, getifaddrs | the CLI; the app on Android and Linux only |
| `qrdrop-session` | `quic` | quinn, rustls, if-addrs | the CLI, by default; not the app until its phone gate |
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
- **WebRTC: str0m 0.24, with its `rust-crypto` backend, chosen in phase 1.** It needs one vendored
  patch (see "Phase 1: what it found") and brings no STUN gathering and no TURN client of its own;
  `stun-proto` and `turn-client-proto` are the sans-IO crates to fill that, from phase 3.
- **TLS** for `wss://` relays and, later, QUIC: rustls with webpki-roots and the **ring** provider.
  ring is a cc build, and phase 1 measured it byte-reproducible for aarch64 Android under
  `android-env.mjs`'s flags; the pure-Rust provider would be a less mature crate for no measured
  gain.

`scripts/android-env.mjs` remaps the whole repo root and `CARGO_HOME`, so path dependencies under
`crates/` are covered. From the app's first dependency on `crates/` (phase 7), the path filters in
`app.yml` and `app-reproducible.yml` must include `crates/**`, `vendor/**` and the root
`Cargo.toml`. Not before: until then nothing under `crates/` reaches the app, and the filters would
spend five runners per commit proving that, which is `app.yml`'s own argument for leaving out `src/`.

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
| `quic-hello` | `{t}` | Rust only: sender first, receiver only in reply |
| `quic-offer` | `{t, addrs, fp}`; addrs are `ip:port`, fp the certificate's SHA-256 as 64 hex characters | Rust only: both, once each |

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

### QUIC path (`crates/qrdrop-session/src/quic.rs`), Rust to Rust

Not part of the JS wire: a JS peer ignores the sender's one `quic-hello` and never sends one.

- **Negotiation.** After the SAS, on the control stream, with `lan-hello`'s timing: the sender's
  `quic-hello` follows its confirm, and a receiver's is only a reply, queued ahead of its Accept.
  Then each side binds a UDP socket, learns its reflexive address from the STUN servers, makes a
  fresh self-signed P-256 certificate and sends one `quic-offer`.
- **A valid offer.** 1 to 8 IPv4 `ip:port` candidates, none unspecified, broadcast, multicast or
  port 0, and loopback only when this side is bound to loopback (a test or the bench); a
  fingerprint matching `^[0-9a-f]{64}$`.
- **Roles.** The receiver is the QUIC server and the sender the client. The server punches each
  client candidate with a one-byte datagram every 200 ms, twenty times; the client dials every server
  candidate at once, and the first handshake wins. 8 s for either.
- **TLS.** 1.3 only, ALPN `qrdrop/1`, mutual: each end accepts exactly the certificate whose SHA-256
  the other offered, and still checks the handshake signature against it.
- **Stream.** One unidirectional stream from the sender; each frame is a 4-byte big-endian length
  and the sealed frame, at most 64 KiB. Windows of 16 MiB; the receiver reads at most 4 MiB ahead of
  the session.
- **Switching.** As LAN: only the sender switches, at Accept, waiting up to 3 s for a pending
  connection. With both up, QUIC wins.
- **A stream that closes** while carrying the file fails the transfer, as a LAN socket does.

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

### Phase 1: what it found

Done on 2026-10-17. The numbers and how they were taken are in `app/CAPABILITIES.md`, "The Rust
WebRTC stacks, against each other and the JS ones". The spikes were throwaway and are not in the
repo. What the next phases need from them:

- **Interop.** str0m and webrtc-rs both pair with node-datachannel and Chromium 153 as offerer and
  answerer, both directions, over Trystero's room frame and action chunk, every byte checked.
  Chromium's mDNS host candidates do not matter: the browser connects to the native peer's host
  candidate and str0m learns the peer-reflexive one.
- **The receiver decides the rate over a round trip.** str0m receiving: 46 MB/s at 20 ms, 16-19 at
  50, 9 at 100. Chromium or webrtc-rs receiving: about 80-100 KB per round trip, 1.5 at 50 ms. So
  the app gains over the internet when it receives, even from a browser, and gains nothing sending
  to one.
- **Settings phase 3 and 5 must carry, each found by a number that did not fit.** str0m caps an
  association's send buffer at 128 KiB including in-flight bytes, which pinned 20 ms at 3.96 MB/s;
  raise it with `set_sctp_max_buffered_amount`. Ask for 4 MB socket buffers on every platform;
  Windows' default drops a native peer's bursts, and Linux's held 20 ms to 5.7. str0m's 1 MiB SCTP
  receive buffer is its own long-RTT ceiling (sctp-proto's `with_max_receive_buffer_size`).
- **The DTLS certificate is ours to make.** The patched backend generates none, so `tryst` makes a
  self-signed P-256 certificate with `p256` and `x509-cert` and passes it through `set_dtls_cert`.
  It must be a self-issued **leaf**; a root profile's key usage makes OpenSSL refuse it as `bad ecc
  cert`. Random 16-byte serials, for the Firefox reason dimpl's own generator gives.
- **Reproducibility.** Both crates built byte-identical for aarch64 Android from two directories and
  two `CARGO_HOME`s, ring's C build included, once every patched crate sat inside the workspace. One
  outside it is the open question above.
- **webrtc-rs needs a default route**: without one, `PeerConnectionBuilder::build()` fails with
  `ENODEV` before any ICE.
- **A harness lesson.** netem on `lo` reorders about 0.4% of packets at 2-20 ms, because its release
  timer fires on different CPUs, and each reorder can halve an SCTP sender's window. Measure in two
  namespaces over veth with each peer pinned; the setup is in CAPABILITIES.md.

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

### Phase 2: what it found

Done on 2026-10-17. `crates/qrdrop-protocol` has 69 tests, in 0.2 s. `src/vectors.rs` reads
`secret`, `session`, `frames` and `digest.json` straight from `test/vectors/`, so a vector change fails
the Rust job as well as `npm test`. Every sealed frame, control frames included, is byte-identical to
the JS one. `transfer_tests.rs` also ports `test/backpressure`.

**The shape, which phase 5 drives:**
1. **`Secret`** is generated, or decoded from a code.
2. **`Keypair`** has one job: `establish` consumes it with the peer's key and returns a `Pairing`.
3. **`Pairing`** shows the SAS. `confirm()` is the only way to get a `Session`.
4. **`Session`** carries both directions:
   - frames go in through `handle_frame(bytes, now)` and out through `poll_transmit()`;
   - the driver's work comes from `poll_event()`, and the pause timeout from `poll_timeout()` and
     `handle_timeout()`;
   - the receive calls are `accept`, `decline`, `accept_failed`, `write_done` and `file_closed`;
   - the send calls are `send_file`, `start_chunks`, `chunk_wanted` and `send_chunk`.

   There is no IO and no clock beyond the `Instant`s the driver passes in.

**Invariants that became structural**, so what is left to test is the structure:
- **Control order.** Sealing is synchronous and every outbound frame goes through one FIFO, so
  index order is send order. The JS's per-direction queue has nothing left to do.
- **Leave after frames.** `handle_frame` is finished with a frame when it returns, so a `done`
  delivered before `peer_left()` has already completed the send. That was the interop flake.
- **Sticky failure.** `fail()` sets one flag once, and nothing after it reports.
- **The SAS before the manifest.** Nothing can seal before `Pairing::confirm`.
- **One keypair per join.** `Keypair` is neither `Clone` nor reusable.
- **fileSeq.** The session assigns it, so no caller can reuse a nonce prefix.

**Where it differs from the JS, deliberately.** Each difference is invisible on the wire or
stricter about a peer that has already broken the protocol:
- **A second manifest** before the first is answered is fatal. The JS checks only after Accept, and
  no sender sends one, since each waits for its reply.
- **Excess data** is checked before the bytes go out in `Write`, where the JS writes them and then
  throws. The failure is the same; the excess never reaches the file.
- **A malformed advisory message** (`path`, `pause`, `resume`, `lan-*`) is ignored like an unknown
  type. A malformed transfer message is fatal.
- **The 200-unit cut of an `error` message** stops before a surrogate pair rather than splitting it.
  Going the other way, a JS peer's split pair (`\ud83d` alone, from `slice` then `JSON.stringify`)
  parses as U+FFFD. Without that, serde would refuse the frame and hide the peer's message.
- **URLs** go through a small WHATWG subset in `code.rs`, not the `url` crate, because IDNA's
  Unicode tables would go into every Android build for one question. Where the subset is looser,
  the most it changes is which error a bad link gets. The code is still read from the fragment
  only.
- **The `error` reply** carries the seq of an offer that was never accepted, where the JS sends 0.
  Today both are 0.

**Left for phase 5**, because each needs IO or the room:
- the early-frame hold and the peer filter;
- the relay size cap;
- path classification;
- the transport's own high-water mark (the JS `drain()`, 4 MiB high and 256 KiB low). The driver
  must stop asking `chunk_wanted()` while its channel is above it.

The user-facing copy in `messages.js`, apart from the two shared constants, is phase 6's.

**Found on the way:**
- **Debug-build AES-GCM runs at about 1 MB/s,** and it took two profile overrides in the root
  `Cargo.toml` to fix:
  - the dependencies, for the cipher's rounds and SHA-256's compression;
  - `qrdrop-protocol` itself, because AES-GCM is generic and is compiled, optimised or not, in the
    crate that names it.

  Either override alone measured 5-6.5 s, and both 0.2 s.
- **`serde(other)`** works on a plain string enum, which is how an unknown `path` or `listen` value
  falls back to `unknown` or `none`, as the JS has it.

### Phase 3: `tryst`, sans-IO core and WebRTC peer

- Topics and signal crypto.
- The action wire, including reassembly and the binary-before-JSON rule, and the room frame.
- The `@_hsdata` / `@_hsready` handshake, `@_leave`, and the offer and glare state machine.

Test all of it against the phase 0 recordings, then put the WebRTC peer behind it on the chosen
stack. Add `crates/**` to the path filters in `app.yml` and `app-reproducible.yml`.

### Phase 3: what it found

Done on 2026-10-18. `crates/tryst` has 21 tests, in 0.05 s; 20 of them need no feature.

**The core, four modules and no features:**
- **`crypto`:** `sha1_b36`, `Topics` (root, peer topic, info hash, room token), `nostr_kind`,
  `SignalCipher` (AES-256-GCM with a 16-byte IV), `handshake_response` and `gen_id`.
- **`wire`:** `encode_action`, `decode_chunk`, a bounded `Reassembler`, and the room and
  presence frames.
- **`room`:** a `Room` over channels that are already open. It runs the `@_hsdata` / `@_hsready`
  handshake, `@_leave` and `@_ping`, and passes messages to and from joined peers. Like phase 2's
  `Session`, it is driven by `add_peer`, `handle_data`, `remove_peer`, `send`, `leave` and
  `handle_timeout`, and drained by `poll_transmit` and `poll_event`.
- **`signal`:** a `Signaller` per strategy. It holds the announce, nudge, offer, answer, glare and
  candidate rules, and each offer's and answer's timers. Connections are made through a
  `Connector` trait that the caller passes to each call. That trait is synchronous because str0m
  is, so Trystero's half-made-offer states (`offerInitPromise`, the offer pool's leases) have no
  counterpart. The tracker's outstanding offers are `pooled_offer` and `reclaim`; keeping them
  under offer IDs is the torrent client's job, in phase 4.

**Behind `webrtc`: `WebRtc`**, a `Connector` over str0m that is still sans-IO.
- **Sockets.** Datagrams from any of the driver's sockets go in through `handle_datagram`, which
  finds their connection by `Rtc::accepts`, and come out through `poll_transmit`.
- **Channel.** The offerer creates the one `"data"` channel; `BUFFERED_LOW` is 65535; each
  association's send buffer is 8 MiB.
- **ICE.** Every local candidate goes in the SDP, so nothing trickles out. JS candidates trickle in.
- **Crypto.** The crypto provider is set per connection, so the crate never installs a process
  default.
- **Vendored backend.** `str0m-rust-crypto` is vendored at `vendor/`, wired in through
  `[patch.crates-io]`, excluded from the workspace and described in `vendor/README.md`.
- **Pure Rust.** `cargo tree` shows no aws-lc, cc, cmake, ring or rcgen under `tryst`.

**Tested against the recordings:**
- **The room.** `room_replays_both_sides_of_every_recording` puts a Rust `Room` in each side's
  place in all four recorded runs, the stand-in and live recordings, Nostr and torrent. It feeds that
  side's inbound channel messages in order, and every Trystero-action message it sends is byte-equal
  to the recorded one, in the same order. Where the recorded side was the initiator, the test supplies
  its recorded challenge.
- **The signaller.** The Nostr replays feed each side the events its relay delivered. Everything the
  Rust signaller publishes, the recorded side published too, keyed by topic and field set. The lower
  ID offers and never answers; the higher one answers exactly once, and every trickled candidate
  reaches that answer's connection.
- **Torrent.** The higher ID answers the lower one's relayed offer, naming its `offer_id`. The lower
  ID ignores the higher one's offer.
- **Decryption.** Every offer, answer and candidate in both recordings opens under the recording's
  password, and every topic, kind and info hash is the derived one.

**Both layers together:** `two_rust_peers_signal_connect_handshake_and_move_a_frame` runs two
complete peers in one process (signaller, str0m and room) with datagrams moved in memory on a
simulated clock. It goes from an announce to a joined room through real ICE, DTLS, SCTP and DCEP,
then moves a full 16348-byte frame, a string and a 300 KB multi-chunk message, then a leave. The
JS-facing check on the same stack is phase 4's gate.

**Found on the way:**
- **`serde_json` sorts object keys unless `preserve_order` is on**, and Trystero's JSON payloads are
  compared byte for byte. The first `json` action vector failed on exactly that. `tryst` turns the
  feature on. It unifies across the workspace, so phase 2's crate builds with it too: its 69 tests
  pass either way, because its frames come from derived structs, which serialise in field order
  regardless.
- **An empty payload with metadata is one chunk, not two.** `ceil(0 / size) + 1 || 1` is 1, so the
  metadata chunk is marked last and carries no data chunk after it. The natural Rust reading,
  `max(ceil, 1) + 1`, sends two.
- **Every chunk carries its payload's type bits, the metadata chunk included.** So metadata on a
  JSON payload is `0x0A`, not `0x02`. Only the string case is in the vectors; this follows the code.
- **`x509-cert`'s builder needs `sha2`'s `oid` feature** to name its signature algorithm. Without
  it the error is a trait bound on `OidSha256`, two crates away from the cause. The `webrtc` feature
  turns it on.
- **Deliberately stricter than Trystero, in ways a JS peer cannot observe:**
  - A reassembled message is capped at 16 MiB, where the JS has no cap at all.
  - Callers cannot send on `@_` actions, so nothing can forge a leave.
  - At most 64 early candidates are held per offer.
  - Data for another room's token is dropped rather than held, since this room is the connection's
    only one.
- **Left out because qrdrop's wire never uses them:** passive rooms, rooms sharing one connection,
  media, and renegotiation over `@_signal`. Supporting any of them is phase 10's question, for the
  published crate.

**The CI path filters did not move**, against the original plan for this phase. Nothing under
`crates/` reaches the app until phase 7, so the filters move then. See "Dependency rules".

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

### Phase 4: what it found

Done on 2026-10-18. `tryst` has 31 tests with every feature on (24 unit, 7 integration, 4.2 s); 20
still need no feature at all, and `cargo hack check --each-feature --no-dev-deps` builds each feature
alone with no warnings.

**What was built, behind features:**
- **`relay`** (`relay.rs`): one task per relay URL holding a WebSocket over tokio-tungstenite and
  rustls on ring with webpki-roots. It reports `Up`, `Down` and `Text` and takes `send`, `resume` and
  `retire`. This brings ring, and `cc` to build it, into the tree; phase 1 chose ring for exactly
  this and measured it reproducible. No aws-lc, cmake or openssl.
- **`nostr`** (`nostr.rs`): the keypair, the NIP-01 event signed with BIP-340 Schnorr (k256), the
  subscription and the relay message classifier. The signed event is byte-identical to the
  vector's, given its secret key and auxiliary randomness.
- **`torrent`**: the tracker client is in `join.rs`, since everything it does is a few JSON fields
  around the phase 3 `Signaller`.
- **`join`** (`join.rs`, with `stun.rs`; needs `webrtc` and `relay`): `join(JoinConfig)` returns a
  `RoomHandle` with `next_event`, `send`, `resume` and `leave`. One task owns the UDP socket, every
  relay, the signaller, str0m and the room, and moves everything between them in `pump()`. A minimal
  STUN client finds the server-reflexive candidate (RFC 5769's sample is its test).
- **Not built: TURN.** qrdrop's `ICE_SERVERS` carries three openrelay TURN entries, and str0m has no
  TURN client, so a Rust peer cannot yet pair where only a relayed path works (both ends behind
  symmetric NATs, or UDP blocked). It is a gap against the JS session, not a choice. It belongs with
  phase 5, whose path classification already has to name a relayed path and apply its ceiling: a
  TURN allocation (RFC 8656) whose relayed candidate goes in the SDP, behind its own feature.

**The relay rules above, as built and tested:**
- **No network failure retires a relay.** Backoff doubles from 3.333 s to 60 s, jittered, then stays
  at 60 s forever. `a_relay_that_keeps_dropping_is_never_given_up` closes the first twelve
  connections straight after their handshake, more than twice Trystero's five retries, and the room
  still joins.
- **Only the relay's words retire it:** a `CLOSED`, or an `OK false` that is neither `rate-limited:`
  nor `duplicate:`. A rate limit backs off that relay's announces instead, from 60 s doubling to 15
  minutes.
- **`resume()` redials now**, with the backoff reset, even mid-wait. `resume_redials_at_once` puts a
  minute's backoff ahead of a dropped relay and sees it up again within 2 s of the call.
- **A room never joins on a dead pool.** `join` resolves once some relay has carried an announce,
  and otherwise fails after `join_timeout` (15 s) with `NoRelay`, "no signalling server reachable".
- **Not done here: the emulator repro** (receive, idle 75 s, picker 120 s, receive). It needs the
  app on the native session, so it is phase 7's to run. The two tests above are the in-process
  half of it.

**`send` is backpressured:** it resolves once its chunks are handed to str0m, and a connection
holding 4 MiB or more (`HIGH_WATER`) takes no more until it drains. The 8 MiB transfer in
`two_rust_peers_pair_over_*` sends frame by frame against it.

**The gate, `e2e/tryst.e2e.mjs`** (`npm run test:e2e:tryst`): a Rust peer (`examples/peer.rs`) and
a Node Trystero 0.25.4 peer on node-datachannel join one room. Each fires `onPeerJoin` with the
other's ID, and each hears the other on a `msg` action. It runs four ways, Nostr and torrent, with
Rust as the lower ID (it offers) and the higher (it answers), by giving the Rust peer an ID of
twenty `0`s or twenty `z`s.
- **Offline**, through the stand-in relay and tracker (`tests/standin/`, a port of
  `scripts/record-trystero.mjs`'s, served by `examples/standin-relay.rs`) on loopback: 4/4.
- **`--live`**, through qrdrop's `RELAYS`, `tracker.openwebtorrent.com`, `tracker.webtorrent.dev`
  and qrdrop's STUN servers: 4/4.

**The one interop bug the gate found was a tracker rule, not a wire one.** Live, the torrent pairing
with Rust as the lower ID timed out every time, while the other three passed. Traced:
- Rust announced through its warmup (233, 533 and 1333 ms), and the tracker then set its interval
  to 120 s.
- Node joined after that. Its offers reached Rust, and Rust ignored them, correctly by the glare
  rule: the lower ID holding offers of its own does not answer.
- Node never saw a Rust offer. A tracker forwards an announce's offers only to peers already in the
  swarm, so offers announced before Node arrived went nowhere, and the next were 120 s away.

The stand-in passed because two loopback peers start within the warmup of each other. The fix
keeps the wire: an offer the glare rule ignores proves its sender is now in the swarm, so the lower
peer pulls its next announce forward to now, at most once per 2 s per tracker
(`TRACKER_NUDGE_GAP`). `a_tracker_peer_that_joined_first_still_pairs_as_the_lower_id` waits out the
warmup before the second peer joins; it fails without the fix and passes with it.

**Found on the way:**
- **Trystero 0.25's `makeAction` returns an object**, with `send(data, { target })` and an
  assignable `onMessage`, not the older `[send, receive]` pair; the e2e uses it as
  `src/transport/room.js` does.
- **The CI path filters still did not move.** Nothing under `crates/` reaches the app yet; phase 7.

### Phase 5: `qrdrop-session` and LAN

- `open_room`, the run loops, file `Source` and `Sink`, path classification, and the LAN listener and
  dialer.
- A TURN client for `tryst` (phase 4 left it out; see "Phase 4: what it found").
- On interrupt: close the room and wait for the leave.
- Tests port the behaviour of `test/room`, `lan`, `backpressure` and `transfer`, against an in-memory
  fake network as `test/helpers/fake-network.mjs` does.

### Phase 5: what it found

Done on 2026-10-18. `qrdrop-session` has 29 tests with every feature on (21 unit, 8 integration, 4.4 s)
and one ignored live test; `tryst` has 43 (35 unit, 8 integration), 20 of them with no feature at
all. `cargo hack check --workspace --each-feature --no-dev-deps` builds every feature of every crate
alone with no warnings, and clippy is clean with every feature and with none.

**What was built:**
- **`open_room`** (`pair.rs`) races the strategies in `OpenConfig::networks`, Nostr and torrent by
  default, as `openRoom` does. Each attempt joins its own `tryst` room with **its own keypair**,
  generated inside the attempt and dropped with it, so the forward-secrecy rule in CLAUDE.md holds
  by construction: nothing outside an attempt ever holds a private key. The first attempt whose
  ECDH completes wins, and every loser leaves. `PAIR_TIMEOUT` (60 s) and the two errors carry the
  JS messages.
- **The peer filter and the early-frame hold** are in the same place as the JS's. Frames from
  anyone but the paired peer are dropped before they reach the session. The paired peer's frames
  arriving before `confirm()` are held, at most `EARLY_FRAME_LIMIT` (16), and released in order
  once the session starts; a leave in that window is held too, as a flag.
- **The driver** (`session.rs`). `Paired::confirm(role, opts)` returns a cloneable `SessionHandle`
  (`send_file`, `accept`, `decline`, `cancel`, `path`, `close`) and a `SessionEvents` stream that
  carries what `element.js` renders: path, offer, progress, received, accepted, sent, declined,
  `lan` and failed. One task owns phase 2's `Session`. Everything that reaches it (a frame, a leave,
  a LAN socket, a LAN close) comes in on one channel, and everything it sends goes out through
  **one writer FIFO**, which is the Rust shape of `sendControl`'s queue: an index is taken, sealed
  and written in one step, so two control frames cannot leave out of order. The switch to the LAN
  socket is a marker in that same FIFO, so every frame queued before Accept leaves on WebRTC ahead
  of it. The outbound queue stops taking chunks at 1 MiB.
- **Source and sink** (`io.rs`) are traits. The sink runs on a thread of its own and the source
  reads up to 128 chunks ahead, so neither file IO nor a slow disk stalls the driver; the receiver's
  pause and resume carry the backpressure, as `receiver.js` does. Behind `fs`, `FileSource` and a
  `FileSink` that opens `create_new`, steps to `name (1).ext` and deletes a partial file on drop.
  `safe_filename` strips the peer's name to its last component.
- **Path classification** (`path.rs`) reads tryst's selected candidate pair (new in this phase:
  str0m's stats, polled each second, with candidate types from the SDP and trickled candidates) and
  names it Local, Direct or Relayed exactly as `classifyPath` does, with the relayed ceiling. Both
  sides' verdicts combine as the JS combines them. The driver polls for up to 3 s; past that the
  path is unknown, as the JS's.
- **The LAN fast path** (`lan.rs`), behind `lan-listen` and `lan-dial`: the hello after the SAS,
  `choose_listener` with the JS's preference order, the offer of every non-loopback address, the
  token check, and a 2 s wait at Accept before staying on WebRTC. The socket is a WebSocket, as
  `lan-server.js`'s.
- **`close()`** leaves the room, bounded at `LEAVE_TIMEOUT` (2 s), for the CLI's interrupt hooks.

**TURN, in `tryst`, and the servers are dead.** Phase 4 left TURN out. It is now `tryst::turn`, a
sans-IO RFC 8656 client over UDP (allocate with the long-term credential, refresh, permissions,
channel binds, send and data indications), sharing the room's socket. `join` gathers STUN and TURN
together. A relayed transmit leaves str0m with the relayed address as its source, which is how the
loop knows to wrap it and send it to that server; anything arriving from a TURN server is unwrapped
and handed to str0m as arriving at the relayed address. `JoinConfig::relay_only` offers relayed
candidates only, as `iceTransportPolicy: 'relay'`. `webrtc` now implies `turn`: a peer that can
reach no one directly has nothing else, and the client costs `hmac` and `md-5`.
`two_relay_only_peers_pair_through_turn` pairs two relay-only peers through a stand-in TURN server
(`tests/standin/turn.rs`), asserts the selected pair is relayed, and checks the stand-in carried the
bytes.

Pointed at qrdrop's own servers it allocated nothing, and the reason is not this code:
`openrelay.metered.ca` resolved to `192.0.2.1` and `100::1`, a documentation range and a discard
prefix, on two public resolvers on 2026-10-18. **So the website and the Node CLI have no working
TURN either**, and nothing reported it, because a dead TURN server only removes the fallback a
pairing behind two symmetric NATs needs. The entries stay in `networks.rs`, where a test parses
`room.js` and requires the same list, so whatever replaces them replaces them on both sides. Which
replacement is the owner's decision (see "Still to decide").

**The tests are ports of the JS's, on two fakes.** `tests.rs` runs the driver over an in-memory link
(transfer, empty file, decline, unknown path, a leave right behind `done`, the sender leaving
mid-file, a bad tag dropped and counted, backpressure under a slow sink, an accept after the
session ended). `tests/session.rs` runs the whole stack over tryst's stand-in relay on loopback:
both strategies raced and a file moved on a Local path, early frames held, a stranger in the room
filtered, two pairings over one secret with different SAS, the timeout, LAN with either side
listening, and no quiet listener staying on WebRTC. The stranger and early-frame tests were
**mutation-checked**: with the filter removed, or the hold turned into a drop, each fails. The
ignored live test pairs two sessions with every default over the public networks: Nostr won, the
path was Local, and 8 MiB took 3.1 s.

**Found on the way:**
- **A leave right after the sink closed, before `done`, reports a disconnect** although the file is
  whole on disk. The window is narrow, and closing it means the receiver treats
  a finished sink as finished, which needs a look at what the JS does there first. Left for phase 6.
- **A runt from the paired peer is fatal**, by "authenticate, then trust": it fails its tag only if
  it is a frame at all. The bad-tag test sends 100 bytes of garbage instead.
- **`if-addrs` and `tokio-tungstenite`'s handshake are pure Rust**: `lan-listen` brings no `cc` and
  no new native code into the Android build.
- **The CI path filters still did not move.** Nothing under `crates/` reaches the app yet; phase 7.

### Phase 6: the Rust CLI and the cross-implementation suite

- **The CLI.** `crates/qrdrop-cli` matches `src/cli.js`'s output contract exactly.
- **The interop matrix.** `e2e/interop.e2e.mjs` takes a launcher override per side (for example
  `QRDROP_SEND_CLI` and `QRDROP_RECV_CLI`) and runs JS↔JS, JS→Rust, Rust→JS and Rust↔Rust, each with
  and without the LAN path.
- **Browser to Rust.** A new e2e drives a Chromium tab against the Rust CLI, which is the real check
  against the website's JS core.
- **Shipping.** The JS CLI keeps shipping until phase 8.

### Phase 6: what it found

Done on 2026-10-18. `crates/qrdrop-cli` builds the `qrdrop` binary: `send`, `receive` and `web`
with every flag, exit code and stdout line of `src/cli.js`, on `qrdrop-session`. It brings one new
crate, `qrcodegen` (pure Rust, no dependencies), behind `qr`.

**How the contract is held, rather than hoped for:**
- **The text is read from the JS.** `text.rs`'s tests parse `src/cli.js`'s `OPTIONS` table and its
  `USAGE` template and rebuild the help from them, and check every message against
  `src/core/messages.js` and the byte format against `format.js`, as `networks.rs` reads `room.js`.
  A sentence edited on one side fails the Rust tests.
- **Measured against Node, byte for byte:** `--help`, `--version` (build.rs reads it from
  `package.json`), `beam`, and the `send` usage error, output and exit code alike. `bytes()` rounds a
  tie up as `toFixed` does, on integers: Rust's `{:.1}` rounds 1280 bytes, exactly 1.25 KB, to "1.2
  KB" where the JS prints "1.3 KB".
- **A decline, both ways against the Node CLI:** the declined send exits 1, the declining receive
  exits 0, and nothing is written.

**The cross-implementation suite.** `e2e/interop.e2e.mjs` takes `QRDROP_SEND_CLI` and
`QRDROP_RECV_CLI` (`js`, `rust` or a path), and `--matrix` runs JS→JS, JS→Rust, Rust→JS and
Rust→Rust (`mise run test:e2e:interop:matrix` builds the binary and runs it over WebRTC, then
`--lan`). Live over the public relays: **12/12 over WebRTC** (the matrix three times) and **4/4
over the LAN path**, the sender reporting the direct connection in every one.
`e2e/browser-cli.e2e.mjs` (`mise run test:e2e:browser-cli`) puts a Chromium tab against the Rust
CLI both ways, with the page served by the Rust binary's own `qrdrop web` (`--features web` embeds
`site/dist`): **2/2**, SAS and digest equal on both ends, 1 MiB each way.

**One race found in phase 5's driver, by reading it for the CLI.** `shut()` sent the leave by one
road (the room task, or straight to the peer's link in memory) while the last frames went by
another (the writer), so a leave could overtake the frame before it. The CLI closes the moment it
has its file, which is exactly when the receiver's `done` is still in its writer's queue, and the
sender would report a finished transfer as a disconnect. `shut()` now puts a barrier in the
writer's FIFO and leaves only once the writer reaches it, bounded at `LEAVE_TIMEOUT` for a writer
parked behind a peer already gone. It could not be made to fail in a test: without the barrier, a
hundred rounds on four threads still passed, because the window is two channel hops wide. So the
order is now kept by construction rather than by scheduling, and the old test's comment, which
credited the memory link with an order it never guaranteed, says so.

**And one change to the session's events.** `Path` was emitted when the peer's verdict arrived even
if this side's was not in yet, reading `mine: Unknown` for a verdict merely pending. It is emitted
only once this side has its own now, so the first `Path` is `reportPath`'s one announcement.

**Deliberate differences from the Node CLI:**
- **An unknown option is a usage error, exit 2.** Node's `parseArgs` throws a TypeError there that
  cli.js does not catch, so the Node CLI exits 1 with a stack trace: an accident, not a contract.
- **The QR art differs; the code does not.** Forcing each of qrcodegen's eight masks, one
  reproduces the Node CLI's output exactly for each of three texts, so version, data and error
  correction are identical. qrcode-generator scores masks with a penalty of its own, on a matrix
  with the format bits blanked. Nothing parses the art, so porting that penalty was not done.
- **`--debug` prints the error, not a stack**, since a Rust error has none to print.
- **The second copy of a name** is `name (2).ext`, the Node CLI's sink's numbering, through
  `FileSink::create_numbered`; the app's providers keep `(1)`.

**Not verified: Ctrl-C.** The handler cancels the session, leaves the room (bounded at 2 s) and
exits 130, as `interruptHooks` does. No script here can deliver a console Ctrl-C to one child
process on Windows without delivering it to every process on that console, the shell included. It
needs a Linux run or a person at a terminal.

**Found on the way:**
- **A small send can end before its route is classified**, so the sender prints no path line at
  all. The JS behaves the same way (`room.path().then(announce)`, and then the process exits); it
  is the 3 s classification poll against a transfer that takes less.
- **The suites stay out of CI**, as every e2e here is: they need the public relays.

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

### Phase 7: what it found

The desktop half was done on 2026-10-18; the gate is a phone, and none was attached.

**The app had to join the root workspace first** (`a142b52`). A path dependency outside a
workspace's root is hashed into Cargo's metadata by its absolute path, so the app depending on
`crates/` from its own workspace built differently in every checkout directory, and
`app-reproducible.yml` builds in two. As a member, every path is relative to one root. The app
keeps its own `target/` (`app/src-tauri/.cargo/config.toml`), because every workflow and the
`gen/` Gradle project look for it there, and `default-members` keeps a bare `cargo` at the root
from compiling Tauri. Merging the two lock files unified 17 semver-compatible crates on the
higher version.

**What landed** (`5b959bd`):
- `src-tauri/src/native.rs`: commands to start a send or a receive and to pass the page's words
  (confirm, reject, accept, decline, cancel) into a running transfer, and its events back over a
  Tauri `Channel`.
- `sink.rs` split into `open_new`, `finish` and `discard`, which its own commands call too, so
  the native receive writes through exactly the JS sink's `storage.rs` choice.
- The page seam: `Platform.session`, registered only by `app/src/main.js`, and two methods in
  `element.js` that draw the existing screens from the events. The ids the e2e suite reads, the
  verify screen's controls and the done outcomes are unchanged.
- The sentences the CLI and the app both say moved into `qrdrop_session::messages` (`04504bc`).

**Where it differs from the plan:**
- **Android sends from a picked file keep the JS session.** plugin-dialog's `open()` returns a
  `content://` URI there with no display name, and getting the name needs new Kotlin. Share
  handoffs, which are real paths in the cache directory, do go native. A pasted or HTML-dropped
  `File` keeps the JS session everywhere, as planned.
- **The relay cap is checked just after the sender's Confirm, not just before it.** The route
  needs a running session, and the session starts only on Confirm, because starting it is what
  sends the lan-hello. The manifest still never goes out.
- **On by default on Linux only.** `QRDROP_NATIVE_SESSION` and a localStorage key switch it
  elsewhere. Linux itself is compiled by `app.yml` and was not run here.

**Measured on Windows:** `e2e/app-native.e2e.mjs` launches the real debug app with WebView2's
debugging port and attaches Playwright over CDP. Both directions against the Node CLI, plus a
decline. 1 MiB each way, SAS and digest equal on both ends, the bytes on disk identical: **3/3**.
The first runs failed in the harness alone, attaching while the webview was still at
`about:blank`. The test now waits for the app's origin.

**One real flow-control gap, found by chasing a CI flake.** `a_slow_sink_holds_the_sender_back`
failed once on CI at `7b55d7e` (8.4 MB against a bound of 7) and passed on the next commit.
- **The cause.** `receiver.js` counts a frame toward its pause on arrival, before decrypting it.
  The Rust protocol counted only what it had opened, so frames waiting in the session's inbound
  queue were a backlog the pause never heard about. `Session::set_queued` now folds that queue
  into the pause and the resume, and the session's `Inbox` counts it on every road in (`7573183`).
- **The test's own share.** The memory link had no receive window, which no real transport
  lacks, so it now has one. And the test subtracted a current figure from a stale one, which
  overflowed once the window slowed the sender. It now samples the backlog in the sink.
- **Result.** With four copies pinned to two cores: 2 failures in 24 before, 0 in 40 after. With
  the pause switched off, the test fails at 29.6 MB.

**Housekeeping worth knowing:** the disk filled during this phase (`app/src-tauri/target/debug`
alone was 28.6 GB). Deleting the two `debug/incremental` directories freed 13 GB, and nothing
else was touched.

**Still to do for phase 7:**
- The RMX3868 runs and the gate (above).
- Then the native session as Android's default.
- A Linux run of the app.
- An Android pick with a display name.

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

### Phase 8: what it found

Done in the tree on 2026-10-18 (`ec79928`). It reaches users at the next `v*` tag, once the npm
setup below has been done.

**The shape.**
- **The command.** `bin/qrdrop.js` is the package's `bin`. It runs
  `qrdrop-<platform>-<arch>`'s binary where npm installed that package, and imports `src/cli.js`
  everywhere else.
- **The list.** `scripts/npm-platforms.mjs` holds the five platforms, and the build matrix,
  the staging, the wiring and the placeholders all come from it.
- **The builds.** `cli-binaries.yml` builds them, called from `publish.yml` on a tag and run by
  itself on main.
- **Brew and Scoop.** The Release carries an archive per platform. The Homebrew formula and the
  Scoop manifest point at those and no longer need Node.

**The open questions, and how they were settled:**
- **Trusted Publishing for each platform package.** Each name needs its own entry on npmjs.com,
  against `publish.yml`. npm configures one only on a package that already exists, so the
  first publish of each name is by hand: `node scripts/npm-platforms.mjs --placeholders <dir>`,
  then `npm publish` in each directory it writes, then the entry.
- **Never renaming `publish.yml`.** Not renamed. The binary build became a second workflow that
  `publish.yml` calls, and the publishing steps stay in `publish.yml` itself.
- **`qrdrop web` embedding `site/dist`.** Each matrix job runs `npm run build` and builds with
  `--features web`.
- **The exception to "no new runtime dependencies".** Written into CLAUDE.md: optional, this
  project's own packages, one installed per machine, each nothing but the binary.
- **The `./node` export.** Unchanged, and so are `node-datachannel` and the Node CLI. They are the
  fallback, and the library API is not the CLI's to remove.

**Measured:**
- **The build.** A Windows release build is 11 MB and imports no Visual C++ runtime
  (`+crt-static`). CI built all five targets, each smoke-tested for its version, with Linux
  checked as static. CI's x86_64 Linux binary runs as is in WSL's Ubuntu (`static-pie linked`).
- **The install.** npm installed the wired `qrdrop` tarball plus the win32 package, and skipped
  the four platform packages not yet on the registry without an error.
- **A transfer through it.** The installed command moved 300 KB both ways against the Node CLI,
  and once more with `QRDROP_CLI=native`, which proves it was the binary.
- **Ctrl-C, unverified since phase 6, checked on Linux in WSL.** A SIGINT mid-transfer of 512 MB,
  to the sender and then to the receiver. The interrupted side printed `Cancelled.` and exited
  130 in 154 and 112 ms. The other side reported the disconnect 415 and 115 ms after the
  signal, and no partial file was left. That is the Node CLI's message, and well inside its
  2 s bound.

**Found on the way:**
- **No test may assert that `package.json` has no platform dependencies.** `npm publish` runs
  the suite again from `prepublishOnly`, after the wiring, and such a test would refuse every
  release.
- **Unstripped, the Linux binary was 13.8 MB.** The build now strips symbols, through an
  environment variable rather than the workspace's release profile, which the app's
  reproducible build shares.
- **winget's blocker is gone.** It was a vendored Node runtime, and an 11 MB portable exe in a
  zip is what winget takes. Not done here: a first submission to `microsoft/winget-pkgs` is by
  hand.

**Left for a person:**
- **The npm names.** Publish the five placeholders and add the five Trusted Publishing entries
  before the next `v*` tag. Without them, that tag's `publish` job fails at the first platform
  package, before `qrdrop` itself is published.

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

### Phase 9: what it found

Done for the CLI on 2026-10-18 (`1a4f465`). The Rust CLI offers the path by default; the app is built
without it until the phone has been measured.

**The shape.** `crates/qrdrop-session/src/quic.rs` holds the endpoint and the offer's rules, and
the driver negotiates it beside LAN. The wire is under "QUIC path" above; `docs/protocol.md` has
the reader's version and `docs/threat-model.md` the trust argument.

**What changed from the plan, and why:**
- **Not in the signal.** The plan put the candidates in Trystero's signal, as a field a JS peer
  ignores. That signal is sealed with a key derived from the code alone, so anyone holding the
  code reads it, and it goes out before the SAS: a fingerprint there would be one an attacker
  could swap before anyone had compared four symbols. So the offer travels on the session's own
  control stream, after the confirm, with `lan-hello`'s timing and its reasoning: only the sender
  switches, at Accept, the one moment every WebRTC frame already sent is provably handled. The
  room still does the rendezvous, so the decision above holds.
- **A JS peer is not asked to ignore a field; it ignores a control type.** Control types it does
  not know are advisory and dropped, after the AEAD and with their index consumed, which the
  interop matrix's QUIC leg proves against the Node CLI in both directions.
- **No TURN fallback of its own.** When the punch fails the transfer stays on WebRTC, which brings
  its own TURN. The dead openrelay entries are still the owner's decision.
- **The same frames.** 16 KiB sealed frames, one per length prefix on one stream. Larger frames
  remain a protocol decision of their own, and nothing measured here asked for them.

**Measured** (`app/CAPABILITIES.md`, "The QUIC path, against SCTP"). Between two sessions on
WSL, one pinned core per side:
- **Clean delay.** QUIC carried 101-108, 93, 51 and 32 MB/s at 0, 20, 50 and 100 ms, against
  WebRTC's 25-27, 17-18, 12-13 and 8.5.
- **Loss.** Five to thirty-five times WebRTC at 0.5% loss, and four to ten times with a 100 Mbit/s
  bottleneck and 0.1%.
- **Two NATs.** 105 and 50 MB/s at 0 and 50 ms, punched from the reflexive candidates alone.
- **Fallback.** With QUIC's handshake blocked, the transfer went over WebRTC after the 3 s wait.
- **So the gate passes on netem**, by a margin no tuning of SCTP came near (see the 2026-09-26
  netem grid, where Chromium's SCTP capped a WAN at 1-2 MB/s). It has not been measured on the
  phone.

**Found on the way:**
- **The WebRTC baseline was a third of what phase 1 measured**, because the runtime had been
  written without the 4 MB socket buffers phase 1 called for. Fixed first (`84cecc6`), so that the
  comparison is against SCTP at its best rather than its worst.
- **The offer handler took both halves before checking them.** When the peer's offer arrived
  before this side's own endpoint was ready, it was taken, found alone and dropped, and the path
  never came up. It now checks both and takes neither until both are there.
- **The first two-NAT run failed for a reason that was the harness's.** Unsolicited checks were
  delivered to the NAT namespace and confirmed conntrack entries on the tuple the peer behind it
  was about to use, so MASQUERADE changed its port. A real router drops that input. The finding
  is recorded in `examples/nat.sh` and in CAPABILITIES, because it reads exactly like a traversal
  bug.
- **Windows and WSL cannot stand in for two machines.** WSL's mirrored networking gives both the
  host's address, so a pairing between them is one host talking to itself through two stacks, and
  it timed out. A cross-machine run needs a second device.
- **Cubic stays.** A raw quinn spike measured BBR ahead at 20 and 50 ms and behind on a clean link
  and at 100 ms. Nothing there justifies leaving quinn's default before a real path is measured.

**The first device session (2026-10-18, RMX3868 on Wi-Fi to the Rust CLI on Windows, 64 MiB).**
A debug APK built with `--features quic` and the Rust optimised (`CARGO_PROFILE_DEV_OPT_LEVEL=3`),
the session picked by the `qrdrop:native-session` key, each run timed in the page from Confirm or
Accept to the done screen:
- **Phone receives:** the JS session over LAN 11.4-13.3 MB/s; the native session over QUIC
  8.4-11.8. Not better, on one network.
- **Phone sends:** the JS session over WebRTC 5.2-6.8, since a Windows receiver never listens; the
  native session 6.0-7.3, with every byte at the CLI and its digest right, but the phone reporting
  the transfer failed. Two bugs, both fixed in the tree and neither yet re-measured on the phone:
  a sender read its idle LAN socket closing at the end of a QUIC transfer as the link it was
  using, because "up" stood in for "carrying"; and a direct link closing after the last chunk
  could beat the receiver's `done` there, so a sender now waits `LINK_CLOSE_GRACE` for it.
- **The QUIC handshake was quick.** The CLI took 27 ms from the phone's offer to a connection;
  the phone's offer came 1.35 s after the CLI's, which is its STUN lookup.
- **Not measured:** the native session over LAN alone, in either direction.
- The app gained a `quic` feature for this, off in every shipped build.

**The second device session (same day, same setup, the APK and CLI built from `6657835`).** The
Wi-Fi was slower than in the first session: the JS session's send, unchanged between the two,
went from 5.2-6.8 to 4.1-5.5.
- **Both fixes hold.** Five native sends, every one ending on "sent", with all 67,108,864 bytes
  at the CLI.
- **Phone sends:** the native session with QUIC 3.2-5.9 MB/s; native with the CLI on
  `QRDROP_QUIC=0` 4.2-4.7; JS 4.1-5.5. All three are the same within the spread. The last two
  were first written down as WebRTC, on the reasoning that a Windows receiver never listens.
  The fourth session found them on LAN: the phone is the side that listens. On this network, nothing on the send
  side comes near the phase 7 gate's 15.5.
- **Phone receives:** native over QUIC 9.5-10.6; native over LAN alone (the CLI on
  `QRDROP_QUIC=0`) 12.9-13.6, with one run at 6.9; JS over LAN 12.6-12.9.
- **QUIC is not slow; the phone's radio is the ceiling.** The first two QUIC runs looked about a
  quarter behind LAN. A second set, alternated, put QUIC at 11.0-12.9 and LAN at 11.6-13.7, the
  same within the spread. The phone was on 2.4 GHz (channel 6, 229 Mbps receiving, 137 Mbps
  sending, RSSI -47), and the PC on 5 GHz 802.11ax at 1.4-2.1 Gbps. 229 Mbps of PHY rate is about
  13 MB/s of goodput, which is where every receive path landed, and 137 Mbps caps every send
  lower still. Measured with quinn's own counters, read from the CLI sender at close:
  - RTT 24-160 ms, which is queueing on the radio, not distance.
  - 2-9% of packets lost, and 22-63 congestion events per 64 MiB.
  - The phone's UDP `RcvbufErrors` stayed flat across a run, so the loss is in the air and not in
    the app's socket.
  - Turning GSO off changed nothing. BBR, which does not back off on loss, sent twice the data,
    lost half of it, and still delivered the same 12-13 MB/s. A full link was the clearest result.
  So the route order stays as it is. No result here says QUIC loses to LAN, and nothing on this
  network can say whether the native session clears the phase 7 gate: 15.5 MB/s of sending is
  past what a 137 Mbps link carries. That needs the phone on 5 GHz.

**The third device session (same evening, the phone on the router's 5 GHz, channel 52, 864 Mbps
receiving and 576 sending; two runs of each, so a first look and not a result).**
- **Phone receives:** native over QUIC 24.0 and 18.7 MB/s; native over LAN alone 33.7 and 9.2;
  JS over LAN 9.4 and 9.7. The JS session's ceiling sits near 9.5 wherever the radio allows more,
  which fits its sink's road into Rust being the limit and not the link.
- **Phone sends:** native over QUIC 14.4 and 12.8; native over LAN (the CLI on
  `QRDROP_QUIC=0`) 19.6 and 16.3; JS over LAN 18.6 and 0.57. These were first recorded as
  WebRTC; the fourth session corrects that. The route label on a phone send is the receiving
  CLI's and means nothing, since the receiver never switches.
- **Against the phase 7 gate:** receiving clears 5.8 on every route, and sending clears 15.5
  over LAN. QUIC sends at 64 MiB fall short. The fourth session found why.
- **A receiver failed a QUIC transfer when its idle LAN socket closed**, 24 MB in, over the
  hotspot tried first. A receiver counted any LAN link that was up as carrying; it now counts one
  only while no frame has come over QUIC.
- **tryst cannot pair across a second interface.** Over a Windows Mobile Hotspot (phone on
  192.168.137.x) neither session paired. tryst binds one socket to the default route's address
  (192.168.1.x) and offers only that, and Windows will not route between the two from a socket
  bound to the other interface. Binding the room to the hotspot address (a local patch, not kept)
  paired at once. A host candidate per interface, as quic.rs gathers them, is the fix if this
  matters; it has not been made.

**The fourth device session (2026-10-18, same 5 GHz link; quinn's counters and the writer's
waits logged once a second from the phone by a temporary patch, not kept).**
- **The ceiling.** Plain TCP from the phone (`dd | nc -l` on the phone, a Python reader on the PC)
  measured 25.6, 25.2 and 28.6 MB/s.
- **Every phone send recorded as WebRTC was on LAN.** That covers both sessions above. `ss -tn` on
  the phone shows the file in a TCP connection the PC dialled to the phone. The JS session does
  the same, at 25.0 MB/s for 128 MiB. No phone send in these sessions was measured on WebRTC.
- **The phone is not CPU-bound.** Its Rust threads together used about 65% of one core, out of
  eight. The writer spent 80-90% of each second blocked in quinn's `write_all`, with the session
  keeping it fed.
- **A QUIC send loses a burst early and pays for it in a short file.**
  - In the first second, slow start overshoots: 500-678 packets lost and 3-7 congestion events.
  - Cubic then regrows the window. RTT rises from a 4 ms floor to 11-58 ms, which is queueing.
  - At 64 MiB the file is over while the window is still regrowing. One run held 274-407 KB of
    window and 13-17 MB/s on the wire, and finished at 10.6 end to end.
- **At 256 MiB, QUIC settles at 22-25 MB/s on the wire, near the TCP ceiling.** End to end it
  measured 19.5, 20.7 and 19.8, against LAN's 23.8, 23.9 and 21.3, alternated.
- **So QUIC is about 15% behind kernel TCP on a phone's Wi-Fi uplink, more on a short file.**
  The usual suspects are ruled out: not the radio, not the phone's CPU, and not loss after the
  first second. What is left is quinn's slow-start overshoot, and userspace UDP against kernel TCP
  with segmentation offload on the same air. The levers are the start (pacing, or a congestion
  controller with HyStart-style exit) and BBR on this link. BBR was tried only on 2.4 GHz, where
  the radio decided everything.
- **Then the controllers, switched on the phone by a file in its cache (a temporary patch, not
  kept).** Default Cubic, BBR, NewReno, and Cubic with a 1 MiB initial window, two rounds each at
  64 and 256 MiB. Default Cubic alone swung from 19.0 to 8.8 at 64 MiB, so two rounds separated
  nothing, with one exception. BBR held 21 at 256 MiB while losing 26,000-37,000 packets, 10-15%
  of what it sent, for no more speed than the others, so it is out.
- **Five alternated rounds at 64 MiB:**

  | Route | MB/s | Mean |
  |---|---|---|
  | LAN | 17.8, 22.0, 17.6, 22.2, 19.2 | 19.8 |
  | QUIC, Cubic, 1 MiB initial window | 16.4, 11.7, 15.1, 17.8, 14.2 | 15.0 |
  | QUIC, default Cubic | 14.9, 13.5, 11.2, 10.6, 13.3 | 12.7 |

  LAN won every round. The larger initial window recovers about a fifth of the gap and no more.
  Two default runs that lost no packets at all still came in at 10.6 and 11.2, so slow start's
  loss is not the whole story. What is left is the cost of quinn's userspace UDP on the phone's
  uplink against kernel TCP. It does not show as CPU, and the RTT rises under load with no loss.
- **So for a phone sender, LAN beats QUIC wherever both are up**, and the route order (QUIC over
  LAN) is wrong in that case. QUIC still matters where LAN cannot reach: across NATs and between
  networks. Whether to change the order, or the initial window, is a decision these runs inform
  and have not made.

**Left for a device:**
- **The phone gate.** Build the app with `qrdrop-session/quic`, run phase 7's native session, and
  measure phone to CLI across two networks against the WebRTC path. Mind ColorOS's socket kill
  in the background (`app/CAPABILITIES.md`), which a UDP socket of the app's own may meet
  differently from WebRTC's.

### Phase 10: extraction prep

- The `tryst` crate gets a clean API, docs, examples and its own vectors.
- Settle the licence and the name, then publish to crates.io.

### Phase 10: what it found

Done on 2026-10-18 (`08990d5`, `5355471`), short of the publish itself.

**What was done:**
- **Its own vectors.** `trystero.json` and both recordings moved to `crates/tryst/vectors/`. A crate
  is packaged from its own directory alone, and the tests' `include_str!` paths climbed out of it,
  so a downloaded `tryst` would have built and then failed to compile its tests.
  `make-vectors.mjs` and `record-trystero.mjs` write there, through one `vectorUrl` that
  `test/vectors.test.mjs` reads by too. Moved, not copied, so there is one source of truth and the
  crate is whole if it moves to a repository of its own.
- **Docs.** Every public item has a doc comment, `missing_docs` warns, the crate docs open with a
  doctested example of joining a room beside a Trystero page, and docs.rs builds every feature.
- **The README** says what the crate is, its features, how it is tested, and its limits.
- **Licence: MIT**, as the repository. The text ships as `crates/tryst/LICENSE`, because the
  `license` field only names it.
- **Name: `tryst`**, unchanged, and 0.1.0, the first version with code in it.

**The API stays as it was.** It is what qrdrop's session uses and nothing it does not: `join`, a
`RoomHandle` with a cloneable `RoomSender`, `RoomEvent`, and the sans-IO modules beneath them. No
`#[non_exhaustive]`: a 0.x crate may break in its next minor version anyway, and the attribute
would only add wildcard arms to the session.

**Measured.** The packaged crate, unpacked and built outside this workspace, passes every one of
its tests from the tarball: 35 unit, 8 integration and the doctest. `cargo publish --dry-run`
packages 29 files, 124.7 KiB compressed.

**Found on the way:**
- **The str0m patch cannot travel.** `[patch.crates-io]` is the root workspace's, so a build from
  crates.io takes upstream `str0m-rust-crypto` 0.6.0 and compiles aws-lc-sys
  (`cargo tree -i aws-lc-sys` on the unpacked crate) for a certificate generator `tryst` never
  calls. Nothing at run time differs, the README says so, and it goes when str0m makes the
  generator optional. Upstreaming that remains an open question above; the newest str0m is still
  0.24.1 with backend 0.6.0.
- **This machine's disk is nearly full** (5 GB free of 390). A second target directory for the
  outside build is 2.1 GB and filled it once; it was deleted afterwards.

**Left for the owner:**
- **The publish.** `cargo publish -p tryst` from a clean tree. A published version can be yanked
  but never replaced.

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
