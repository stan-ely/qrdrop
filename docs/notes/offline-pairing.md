# Pairing without the internet

Designed 2026-10-26. This file is the design and its tracking document: a session that works on
it starts by reading **Status** and ends by updating it. When it ships, the parts that describe
behaviour move into `docs/protocol.md` and `docs/threat-model.md`, and the invariants into
CLAUDE.md, the way the LAN path's did.

## Status

| Phase | State | Notes |
|---|---|---|
| A. Decoders tolerate a locator | released | npm 0.7.0 and app-v1.4.0, both 2026-11-03 |
| B. Rust: the session over a socket, and the rendezvous | built 2026-11-07, unreleased | `160824c`..`9e9a171`; the gate is `crates/qrdrop-session/examples/offline.sh`. See "As built" under B |
| C. Node CLI and the app | built 2026-11-08, unreleased; checked on an Android 10 emulator, not yet on a phone | `send --offline` in both CLIs, and "Pair without internet" in the app's Settings. The gate passes in all four CLI pairings with no route out, the matrix gained an `--offline` run, and app-native gained an offline send on each of the app's sessions. See "As built" under C |
| D. Docs, threat model, CLAUDE.md | done 2026-11-08 | `docs/protocol.md` ("Pairing with no internet"), two threat-model entries, and the CLAUDE.md invariant |

## The problem

Every pairing meets on public signalling: Nostr relays and BitTorrent trackers, through Trystero
or `tryst`. The LAN and QUIC paths are negotiated *after* pairing, over the sealed control stream
that the room carries. So two devices on one Wi-Fi cannot pair at all when that network has no
route out. That covers a phone hotspot with no data, a plane, a site network, and a corporate
network that blocks the relays. Beam is the only offline route today, and it is unencrypted and
runs at camera speed.

## What was considered, and why only one is being built

- **A locator in the QR, over the same Wi-Fi.** This is being built. The QR is already the
  out-of-band channel. Adding the listener's address to it removes the one thing the relays were
  needed for, which is finding each other. It needs no new radio, no new permission and no new
  dependency, and most of the socket code exists in `lan.rs` on both sides.
- **Android LocalOnlyHotspot, its credentials in the QR.** Later. It is the answer when the two
  devices share no network. It costs a Kotlin plugin and joining is awkward everywhere but
  Android: iOS needs `NEHotspotConfiguration`, and with it an Apple developer entitlement this
  project does not have. It builds on this design: once the receiver has joined the hotspot, the
  rest is the locator path.
- **Bluetooth LE.** No.
  - The only thing it would add is a return channel, and this design does not need one.
  - Web Bluetooth cannot advertise. In Rust, `btleplug` cannot be a peripheral, and `bluer` is
    Linux-only. That means native GATT code on every OS.
  - Android 12+ adds three more runtime permissions.
  - At tens of kB/s it could only ever bootstrap Wi-Fi, which makes it a rebuild of Nearby Share.
- **Wi-Fi Direct, Wi-Fi Aware, AWDL.** No. Each works on one platform family only.
- **Two-way QR for WebRTC, so the website can pair offline.** Possible later. The offer goes in
  the sender's QR and the answer comes back as a second QR, so it costs a second scan. Chrome's
  `.local` host candidates also need multicast to work on the network. Worth a spike only if
  offline use in the browser is wanted.
- **mDNS discovery** stays rejected (`iroh-prior-art.md`). The locator replaces discovery: the
  devices never need to find each other, because the scan already told one where the other is.

## Design

### The code grows an optional locator

`qrdrop:<43 chars>` becomes `qrdrop:<43 chars>.<locator>`.
- The locator is base64url of: a version byte, a port (u16), then up to four IPv4 addresses.
  That is 10 to 26 characters.
- `.` is outside the base64url alphabet, so the code's own 43 characters stay unambiguous.
- In the URL form the whole thing is still in the fragment. The address is not secret, but
  `decodeSecret`'s fragment-only rule is about the code, and splitting the two would mean reading
  half a code from somewhere else.
- The bare `qrdrop:<code>` form stays valid forever, as CLAUDE.md requires.

**The rollout order is forced, and phase A exists because of it.**
- Both decoders reject anything after the 43 characters today: `CODE_RE` in `src/core/secret.js`
  is anchored, and `bare_code` in `crates/qrdrop-protocol/src/code.rs` checks the length. An
  installed app or a pinned CLI would therefore answer a new code with "Not a qrdrop code".
- So phase A teaches every decoder to accept a locator and ignore a version it does not know, and
  nothing emits one. It goes out in an npm release and an app release.
- `test/vectors/secret.json` gains the decode cases. That is a contract change and gets
  regenerated on purpose, which is exactly what CLAUDE.md says a vectors diff is for.
- **Also in A:** `secretFromDeepLink` in `app/src/deep-link.js` re-encodes to the bare form. It
  must keep the locator, or the app's own deep link would strip it.

### Who listens, and who dials

The side that shows the QR listens, because only it can say where it is.
- **Only where it can listen quietly.** That is `default_listen()`'s rule unchanged: Linux and the
  Android app. On Windows and an unsigned macOS app a listener raises a firewall prompt, so there
  a sender emits no locator unless asked to (`--offline` on the CLI). The prompt is then the
  price of a choice the person made.
- **Addresses.** The private IPv4 addresses of every up interface, as the LAN offer already
  gathers them. IPv6 is left out at first, because a link-local address needs a scope ID that
  means nothing on the other device.
- **The dialler.** A scanner that can dial (the Rust session, the Node CLI, the app through its
  `lan.rs` relay) dials every address at once. The website cannot dial, so it ignores the locator
  and joins the relays as it does today.

### The rendezvous handshake

The listener's port is open to the whole network before anyone has paired. **Proving the code must
come before the latch, not after.**

In the relay room, a stranger cannot even find the room without the code: the topic and the
password both derive from it. A socket offers no such property. A listener that latched on the
first ECDH key to arrive would let anyone on the Wi-Fi port-scan, connect first, and force a SAS
mismatch. That would end the session, from someone who never held the code. This is a denial of
service the relay path does not have, and it would spend the one SAS roll.

So the handshake is keyed on `k_rv = HKDF(secret, "lan-rendezvous")`. This is a new label, and it
goes in the vectors. It runs over a WebSocket, the LAN path's socket kind, so the JS ends speak it
unchanged:

1. The listener sends a 16-byte nonce `n`.
2. The dialler sends its ECDH public key `D` and `HMAC(k_rv, "dial" ‖ n ‖ D)`.
3. The listener checks the MAC. Only a valid one latches, so a stranger without the code is
   closed unlatched and costs nothing but a handshake slot. The listener then sends its key `L`
   and `HMAC(k_rv, "listen" ‖ n ‖ D ‖ L)`.
4. The dialler checks that MAC, then sends `HMAC(k_rv, "ok" ‖ n ‖ D ‖ L)`.

Both ends then call the same `establishSession` (Rust: `establish`) that the room path calls, with
the secret as salt and the listener as host. The keys and the SAS come out of exactly the same
derivation, so `session.json`'s vectors already cover them.

**Why each part is there:**
- **The nonce** stops a sniffed hello from an earlier connection being replayed to latch.
- **The MACs cover both public keys**, so someone on the path without the code cannot substitute
  a key at all. That is stronger than the relay path, where a substitution is something the SAS
  has to catch.
- **The same limits as `lan.rs`:** at most `MAX_HANDSHAKES` running at once, each one dropped after
  `HANDSHAKE_TIMEOUT`, and the listener stops listening once it latches.

### One roll per secret, across two ways in

This part is the easiest to get subtly wrong.
- The scanner tries the locator first, for at most `DIAL_TIMEOUT`, and joins the relays only if
  that fails.
- The sender is waiting on both from the start.

The failure to design against is a handshake that half-completes. The listener latches at step 3,
but its reply is lost, so the dialler gives up and goes to the relays.

The rule is: **a side may fall back only if it has not shown a SAS. Once it has, any failure is
terminal**, exactly like a mismatch.
- The listener shows the SAS only after step 4's `ok`.
- The dialler shows it after sending `ok`.
- Before `ok`, a listener whose socket dies unlatches and keeps waiting. Its relay attempts stay
  up until `ok` arrives, rather than being torn down at the latch.

Every pairing that reaches a person's screen is still the only one that secret gets. A pairing
that never got that far was not a roll.

### The session over a socket

This is most of the work, and it is the part the plan before this note underestimated.
- **The room carries everything after pairing.** In both implementations the control stream, the
  path verdict, the manifest and Accept all ride the room's `frame` action. The LAN socket takes
  over only the sender's frames, and only from Accept on. An offline pairing has no room, so the
  socket has to carry the whole session.
- **Rust.** `session.rs` and `pair.rs`'s `Hold` hold a `tryst::join::RoomHandle` directly.
  - Phase B puts a carrier between them: an enum of the room or a socket, with the four things the
    session uses: send a frame, receive the next event, notice the peer leave, and leave.
  - On a socket, leaving is a WebSocket close, and the peer leaving is that close arriving.
  - The early-frame hold is unchanged, because the peer still does not wait for us.
- **JS.** A second `PairedRoom` in `src/transport/`, built over a `LanSocket`:
  - `channel` is `createLanChannel` from the start.
  - `onPeerLeave` is the socket's close.
  - `path()` is `local` for a private peer address.
  - `isRelayed()` is false.
  - `sendOverLan()` returns true without doing anything, because the frames are already there.

  `core/` never sees the difference. That is the transport seam doing its job, and
  `test/channel.test.mjs` is where the new channel proves itself.
- **No upgrade from a socket.** A sender paired over a socket sends no `lan-hello` and no
  `quic-hello`, since it is already on the fastest link either would offer. Because the receiver
  only ever replies, nothing else needs to know.

### What changes in the written rules

- **"Addresses never go in the signalling" (CLAUDE.md, the QUIC path) still holds, and the note
  under it gains a sentence saying why a QR locator is a different thing.**
  - That rule protects a public address in a signal readable by anyone with the code, who could
    race the real peer to it.
  - A locator is a private address in the same QR as the code, so anyone who can read it already
    holds the code. Racing to it gets them nothing that pairing with the code would not, and the
    handshake above means a racer without the code gets nothing at all.
- **The threat model's "Not protected" list gains a line.** A QR with a locator also shows the
  sender's local address to whoever sees it.
- **CLAUDE.md gains an invariant.** The handshake proves the code before it latches, and a side
  that has shown a SAS never falls back.

## Phases and how each is checked

- **A.**
  - Decode vectors with a locator, an unknown locator version, and a malformed one. The unknown
    version is ignored, not an error, so the format can grow.
  - `npm test` and `mise run rust:test`.
  - A deep-link test that keeps the locator.
  - Release, then wait a cycle before B ships an emitter.
  - **As built:** port 0, no address, more than four, a cut address or a length that is no
    whole byte are `malformed-locator`, an error and not ignored. Only an unknown *version* is
    ignored, because only that one can be a newer encoder rather than a damaged code. The
    plain `decodeSecret` / `Secret::decode` that every caller uses is unchanged and drops the
    locator. `encodeSecret(secret, locator)` and `Secret::code_with` exist for the tests and
    the deep link alone.
- **B.**
  - In `qrdrop-session`: the carrier, the listener and dialler, and the handshake, with unit tests
    for each MAC check and for the half-completed handshake above.
  - **The gate:** two Rust CLIs under `unshare -rn` with no default route, with `netem.sh`'s
    namespaces and the route removed. They must pair, verify and move a file.
  - **Also run:** the interop matrix, unchanged, to show a code without a locator behaves exactly
    as before.
  - **As built:**
    - **The carrier** is `carrier.rs`, landed first and alone (`160824c`) with the matrix green
      on all twelve legs. It holds the peer filter too, both halves, where `pair.rs` and
      `session.rs` used to match the peer ID each for itself.
    - **The four messages** are `src/core/rendezvous.js`, ported to `qrdrop-protocol`'s
      `rendezvous.rs` and pinned by `test/vectors/rendezvous.json` (`2b82ae1`). Each message is
      one fixed-length binary WebSocket message: hello 16 bytes, dial and listen 97, ok 32. The
      labels are ASCII `dial`, `listen` and `ok`.
    - **The dialler races only the hello and keys one connection**, which this note did not
      say and has to. Keying every address that answered gives each connection its own
      keypair, and a listener reachable at two addresses could finish on one while the dialler
      kept the other: a false SAS mismatch, the pairing race again
      (`docs/notes/pairing-race.md`). The ok is sent outside the dial timeout, so a timeout
      cannot cut it half-sent while the listener latches on the whole of it.
    - **The listener generates its keypair only after a dial verifies**, so a stranger costs a
      handshake slot and never a key.
    - **`open_room` keeps waiting on the listener when every room has failed.** With no route
      out, every room gives up at tryst's `JOIN_TIMEOUT` (15 s), and `NoNetwork` there would
      have taken the listener down on exactly the network it is for. A listener still up at
      the deadline is a `Timeout`. `with_every_relay_unreachable_the_listener_still_pairs` takes
      16 s on purpose: a shorter version passed without reaching the branch.
    - **The dial fallback is said** ("Couldn't reach the other device directly, trying the
      internet…"), as the open question below recommended.
    - **`Paired::strategy` became `Paired::via`** (`Via::Network(Strategy)` or `Via::Local`).
    - **`QRDROP_OFFLINE=1` on `send`, not `--offline`.** `text.rs` holds the Rust CLI's usage
      to `cli.js`'s, so the flag has to arrive in both CLIs at once, in phase C. `receive` needs
      no switch: it dials any locator it reads, unless `--no-lan`.
- **C.**
  - The Node CLI (dial and listen through `node/lan-server.js`'s pieces) and the app, through
    `src-tauri/src/lan.rs`.
  - The matrix gains offline legs.
  - **As built (the Node CLI):**
    - **`--offline` on `send`, in both CLIs at once**, replacing `QRDROP_OFFLINE=1`. It is
      still opt-in for the rollout reason in A. Beside `--no-lan` it is a usage error, exit 2,
      since the two ask for opposite things. A machine with no private address says so and
      prints a code without a locator.
    - **`src/transport/rendezvous.js`** holds both ends and `createSocketRoom`, the second
      `PairedRoom`. That room carries `direct: true`, which is how a sender knows to send no
      lan-hello. The server in `node/lan-server.js` became `listenOnce`, shared by
      `listenLan` and the new `listenOffline`. Both now cap handshakes in flight at 32;
      `listenLan` had no cap before.
    - **`openRoom` takes `listener` and `dial`**, with the Rust session's rules and status
      lines. `test/offline.test.mjs` pins the same cases as the Rust tests, over loopback.
    - **The gate runs either CLI on either side** (`SEND_CLI`, `RECV_CLI`). It answers each
      prompt only after the prompt is printed. Piping `y` in early worked for Rust and hung
      Node, whose readline drops a line that arrives before its question is asked.
    - **`interop.e2e.mjs --offline`** is the matrix's fourth run, 4/4 on Windows. The relays
      are reachable there, so it proves that the four pairings agree on the wire, not that
      they need no relay; the gate covers that.
  - **As built (the app, receiving):**
    - **The app dials a scanned locator on both of its sessions.** On the JS session that
      is `element.js`'s `_establish`, through the shell's `LanPlatform`, and every entry
      point (scan, typed code, `location.hash`) now keeps the locator. The website has no
      `LanPlatform`, so it ignores the locator and pairs over the relays as before. On the
      native session, `native.rs`'s `native_receive` decodes the locator and sets
      `OpenConfig::locator`; every app build already has `lan-dial`. A direct room skips
      the LAN link on both sides.
    - **Not measured on a device yet.** The next phone session should scan a CLI
      `send --offline` code on a Wi-Fi with no route out.
  - **As built (the app, sending):**
    - **"Pair without internet" in Settings, off by default**, in `app/src/offline.js`
      (localStorage). Off for A's rollout reason, and because on Windows and macOS it raises
      the firewall prompt, which the row says. It is read as each send starts, by both
      sessions, so it never changes a code already on screen. localStorage rather than
      history.rs's store, because storage that is lost reads as off, which is the harmless
      direction.
    - **The page's session listens through a second relay, `offline_listen` in `lan.rs`.**
      The fast-path relay decides which connection is the peer by the token Rust was
      handed. The rendezvous is keyed on the secret, which Rust is never handed, so this
      relay decides nothing. Each page socket presents the token and waits. Each connection
      that arrives is joined to one, the page is cued with ACK and the peer's address, and
      `acceptRendezvous` (`src/transport/rendezvous.js`) runs the handshake and keeps the
      first that proves the code. The page keeps at most 32 handshakes running by asking
      for one connection at a time, and the relay holds at most 32 waiting. Stopping the
      listener stops only the accept loop; each joined pair is a task of its own, so a win
      runs on. Each listener has an id, so a late close from an ended send cannot stop
      the next one's.
    - **The native session binds `OfflineListener`** in `native.rs`'s `start_send`, as the
      Rust CLI does, and `lan-listen` is now built on every app target. That changes
      nothing for the fast path: `default_listen()` still says `prompt` on Windows and
      macOS, so only the offline listener, asked for by the switch, listens there.
    - **The native send's QR used to drop the locator**, because it re-encoded the code
      through `decodeSecret`. It goes through `decodePairing` now. The typed code carries
      the locator on both sessions, as the CLI's does: a code read out is the other
      device's only other way to learn the address.
    - **A device with no private address** (mobile data alone) keeps no listener and shows
      the bare code, without a word. The person asked for a setting, not for this transfer.
    - **Two arrivals are kept asked for, not one** (`SPARE_ARRIVALS`), and a page socket
      that fails to open is retried rather than ending the listener. Both came from the
      emulator. The page answers each ask by opening a WebSocket to its own relay, and with
      one ask outstanding the replacement for a socket just handed a connection was still
      opening when the next connection arrived. On a probe that connected five times in a
      row, only the first ever heard a nonce. And an open that missed its five-second dial
      timeout rejected `arrivals()`, which acceptRendezvous reads as the source gone, so
      the device stopped accepting for the rest of the send. With both changes all five
      heard one.
    - **Measured on an Android 10 emulator** (`e2e/app-android-offline.e2e.mjs`): the app
      receiving a CLI `send --offline` code on both sessions, and sending with the switch
      on, each pairing at the address. Five runs in five, at 4 GB. At the AVD's default
      2 GB the guest was swapping and the send leg failed four in five, which is the guest
      and not the code. Two findings that are not about the app: the Node CLI sender
      accepts nothing for about two seconds after printing its code (it is loading its
      relay stack), so a scan inside that window falls back to the relays; and the
      emulator's own address cannot be reached from the host, so the send leg goes through
      `adb forward` and a rewritten locator.
    - **Tests:** `acceptRendezvous` against an in-memory relay in `test/offline.test.mjs`
      (a wrong code, the limit, a stop), the relay over loopback in `lan.rs`, the row in
      `test/app-view.test.mjs`, and two legs at the end of `e2e/app-native.e2e.mjs`: an
      offline send on each session, the Node CLI pairing at the code's address.
- **D.** The docs moves above, and this file's Status.
  - **As built:** "Pairing with no internet" in `docs/protocol.md`, with the new HKDF label
    in its table. Two threat-model entries: the listener under Protected, and the address a
    locator shows under Not protected. In CLAUDE.md, an invariant for the rendezvous, the QR
    locator's sentence under the QUIC rule, and the keypair rule, which now names
    `rendezvous.js` as its second home. This file stays as the record of why.

## Open questions

- **Should the scanner say when the dial fails** ("Couldn't reach the other device directly,
  trying the internet…"), or stay quiet and fall back? It should say so: a person on an offline
  network then knows at once why nothing is happening.
- **IPv6.** Global addresses would work across some networks without NAT, but every address in
  the QR makes it denser. Leave it out until someone asks.
