# qrbeam

Send a file straight from one device to another. A QR code carries the key; the
file goes over WebRTC; nothing in between ever holds a readable copy.

A Hugo static site. No bundler, no `node_modules` to build it — third-party
modules load from a CDN as ES modules at runtime.

```bash
hugo server        # http://localhost:1313
hugo               # -> public/
```

Node is only needed for the tests, and only for the tests:

```bash
npm install        # playwright, nothing else
npm test           # unit suite, offline
npm run test:e2e   # builds with hugo, then drives two real browsers
```

## How it works

```
  Sender                          Nostr relays                    Receiver
    |                                   |                             |
    |-- QR: 32 random bytes ---------------------- scanned by ------->|
    |                                   |                             |
    |        Trystero pairing, session descriptions AES-GCM           |
    |        encrypted under a password derived from the QR           |
    |<--------------------------------->|<--------------------------->|
    |                                   |                             |
    |<======== WebRTC data channel, every chunk sealed by us ========>|
```

The QR carries 32 bytes of CSPRNG output. Everything else derives from it:

| Derivation | Purpose |
| --- | --- |
| `HKDF(secret, "topic")` | Trystero room ID — what peers meet on |
| `HKDF(secret, "signal")` | Trystero `password`, encrypting session descriptions |
| `HKDF(ECDH, salt=secret, "host->guest")` | file bytes, sender to receiver |
| `HKDF(ECDH, salt=secret, "guest->host")` | file bytes, the other way |
| `HKDF(ECDH, salt=secret, "sas")` | the four emoji shown on both screens |

The room ID is derived rather than being the secret itself. Using the secret as
the room name is the obvious shortcut, works perfectly in testing, and silently
publishes your key to every relay on the network.

### Why `password` is not optional

Trystero owns the session descriptions, so we cannot seal the SDP ourselves.
`password` is what replaces that. Without it Trystero derives its key from the
app ID and room name — both of which any relay observer already has — which
would leave the DTLS fingerprint substitutable in transit. That substitution is
the textbook man-in-the-middle on WebRTC signalling, and it is the thing the QR
code exists to prevent.

### Why file chunks are encrypted again on top

Two layers that fail independently. Ephemeral ECDH per session gives forward
secrecy — a code photographed later cannot decrypt a transfer that already
happened — and it uses the QR secret as its HKDF salt, so even if Trystero's
signalling encryption were broken outright an attacker would still need the code
to derive the session key.

DTLS also terminates at the peer's browser, and when NAT traversal fails packets
pass through a third-party TURN relay. Sealing each chunk ourselves means a
relay operator sees ciphertext and byte counts, never contents.

Nonces are unique by counting rather than by chance — `fileSeq || chunkIndex`,
with a separate key per direction — because AES-GCM does not degrade gracefully
under nonce reuse. The end-of-file flag is authenticated, so an attacker who
stops forwarding frames cannot pass a truncated file off as complete.

## Deploying

Serve `public/` over HTTPS. WebCrypto and the camera both require a secure
context, so plain HTTP will not work anywhere except `localhost`.

`static/_headers` sets the security headers a page cannot set for itself, and is
read automatically by Cloudflare Pages and Netlify. On other hosts, apply the
equivalent — particularly `frame-ancestors`, which browsers ignore when it
arrives in a `<meta>` tag. The page also refuses to run inside a frame on its
own, so framing is blocked even where the host ignores the file.

**Two lists must stay in step.** `RELAYS` in `static/js/signal/room.js` and the
`connect-src` allowlist in `layouts/index.html` name the same hosts. Change one
without the other and the CSP blocks the relays.

## Threat model

**Protected**

- Relay operators and TURN servers see ciphertext, timing, and volume only.
- A network attacker without the QR cannot join, read, or MITM the transfer.
- Past transfers stay closed if the code leaks afterwards.
- Truncated, reordered, or altered files are rejected, not silently written.

**Not protected**

- **Anyone with the code can join.** It is the entire credential. Show the QR to
  a person, not to a room.
- **jsDelivr can serve arbitrary JavaScript into the page**, and sees the IP of
  every visitor. Versions are pinned in `static/js/deps.js`, so an update is at
  least a visible commit, but Subresource Integrity is not usable for ESM
  imports. This is a deliberate trade for not needing a build step; copying
  those files into `static/vendor/` and pointing `deps.js` at them closes it,
  at the cost of updating by hand.
- **The host serving this page could do the same.** No in-browser design
  prevents that. Mitigated by a pinned CSP, no inline scripts, and a small
  auditable surface — not eliminated. For genuinely sensitive material, use a
  tool you can verify before running.
- **Both peers learn each other's IP.** Inherent to a direct connection. Add a
  TURN server and `iceTransportPolicy: 'relay'` in `room.js` to hide it, at the
  cost of requiring TURN to connect at all.
- **Relays see metadata**: that two throwaway keys met on a room, when, and
  roughly how much moved.

## Design notes

**Swapping the signalling network is one line.** Trystero ships a package per
strategy behind a shared interface, so the import in `static/js/deps.js` can
become `@trystero-p2p/mqtt`, `/torrent`, `/ws-relay`, `/supabase`, or
`/firebase`. Update `RELAYS` and `connect-src` to match the new network.

**Relay choice was measured, not assumed.** The best-known Nostr relays —
`relay.damus.io`, `relay.nostr.band`, `relay.snort.social` — were all
unreachable when the list was built. The eight in `room.js` were picked by
connecting to every relay in Trystero's pool and keeping the ones that answered.

**The confidentiality path uses WebCrypto only** — P-256, HKDF, AES-GCM, no
third-party code. Trystero sits below that boundary: it protects signalling, but
a compromise there could not read a file byte.

**Two gestures gate every transfer.** The sender confirms the SAS before a
manifest goes out (the manifest alone leaks the filename and size). The receiver
accepts — which is also the click that lets the browser open a save destination,
since `showSaveFilePicker` requires a user gesture.

## Known limitations

- **Firefox and Safari buffer received files in memory** before saving, capping
  practical transfers around a gigabyte. Chromium streams to disk via the File
  System Access API. Closing this needs a Service Worker that fabricates a
  streaming download response.
- **The streaming save path has no automated test.** Headless Chromium exposes
  `showSaveFilePicker` but has no UI to answer it, so the e2e forces the
  in-memory fallback.
- **STUN only by default.** Roughly 10–15% of NAT pairings need a TURN relay.
- **One file at a time.** The framing supports a file sequence; the UI does not
  expose it yet.

## Layout

```
hugo.toml                          site config
layouts/index.html                 the page, and the CSP
static/js/deps.js                  every CDN URL, pinned, in one place
static/js/crypto/secret.js         QR secret, HKDF derivations
static/js/crypto/session.js        ephemeral ECDH, directional keys, SAS
static/js/signal/room.js           Trystero pairing, relay list, ICE
static/js/transfer/frame.js        per-chunk AEAD, nonce construction
static/js/transfer/sender.js       chunking, backpressure, accept handshake
static/js/transfer/receiver.js     demux, verification, sink management
static/js/transfer/sink.js         File System Access, with a Blob fallback
static/_headers                    headers a static page cannot set itself
```
