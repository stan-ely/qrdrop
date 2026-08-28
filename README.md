# qrbeam

Send a file straight from one device to another. A QR code carries the key; the
file goes over WebRTC; nothing in between ever holds a readable copy.

Fully static — no backend, no accounts. Deploy the contents of `dist/` anywhere
that serves files over HTTPS.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # unit suite, offline
npm run test:e2e   # two real browsers over public relays
npm run build      # -> dist/
```

## Deploying

Serve `dist/` over HTTPS. WebCrypto and the camera both require a secure
context, so plain HTTP will not work anywhere except `localhost`.

`public/_headers` sets the security headers a page cannot set for itself, and is
read automatically by Cloudflare Pages and Netlify. On other hosts, apply the
equivalent in their own config — particularly `frame-ancestors`, which browsers
ignore when it arrives in a `<meta>` tag. The page also refuses to run inside a
frame on its own, so framing is blocked even where the host ignores the file.

If you change the relay list in `src/signal/nostr.js`, update the `connect-src`
allowlist in `index.html` to match, or the new relays will be blocked.

## How it works

```
  Sender                         Public Nostr relays              Receiver
    |                                    |                            |
    |-- QR: 32 random bytes ----------------------- scanned by ------>|
    |                                    |                            |
    |          sealed offer + ECDH key   |    sealed answer + key      |
    |----------------------------------->|<----------------------------|
    |                                    |                            |
    |<========== WebRTC DataChannel, sealed per chunk ================>|
```

The QR carries 32 bytes of CSPRNG output. Everything else is derived from it:

| Derivation | Purpose |
| --- | --- |
| `HKDF(secret, "topic")` | public rendezvous ID — what peers meet on |
| `HKDF(secret, "signal")` | AES-GCM over the SDP and ECDH public keys |
| `HKDF(ECDH, salt=secret, "host->guest")` | file bytes, sender to receiver |
| `HKDF(ECDH, salt=secret, "guest->host")` | file bytes, the other way |
| `HKDF(ECDH, salt=secret, "sas")` | the four emoji shown on both screens |

The topic is derived rather than being the secret itself. Using the secret as
the room name is the obvious shortcut, works perfectly in testing, and silently
publishes your key to every relay on the network.

Ephemeral ECDH per session gives forward secrecy: a code photographed off a
screen later cannot decrypt a transfer that already happened. Feeding the QR
secret in as the HKDF salt is what makes the exchange *authenticated* — an
attacker who injects their own public key still cannot reach the same key.

### Why signalling is encrypted

The standard attack on WebRTC signalling is substituting the DTLS fingerprint
in transit to become an invisible man in the middle. Sealing the SDP under a
key only the QR holders have means an attacker cannot produce a payload either
peer will accept. Decryption failing *is* the authentication check: anyone may
publish to the topic, but only a holder of the secret can be heard.

### Why file chunks are encrypted again

DTLS terminates at the peer's browser, and when NAT traversal fails the packets
pass through a third-party TURN relay. Sealing each chunk under the session key
means a relay operator sees ciphertext and byte counts, never contents.

Nonces are unique by counting rather than by chance — `fileSeq || chunkIndex`,
with a separate key per direction — because AES-GCM does not degrade gracefully
under nonce reuse. The end-of-file flag is authenticated, so an attacker who
simply stops forwarding frames cannot pass a truncated file off as complete.

## Threat model

**Protected**

- Relay operators and TURN servers see ciphertext, timing, and volume only.
- A network attacker without the QR cannot join, read, or MITM the transfer.
- Past transfers stay closed if the code leaks afterwards.
- Truncated, reordered, or altered files are rejected, not silently written.

**Not protected**

- **Anyone with the code can join.** It is the entire credential. Show the QR
  to a person, not to a room.
- **Both peers learn each other's IP.** Inherent to a direct connection. Set
  `iceTransportPolicy: 'relay'` with a TURN server to hide it, at the cost of
  requiring TURN for the connection to work at all.
- **Relays see metadata**: that two throwaway keys met on a topic, when, and
  roughly how much moved.
- **The host serving this page could serve modified JavaScript.** No in-browser
  design prevents this. Mitigated by a pinned CSP, no inline scripts, and a
  small auditable dependency tree — but not eliminated. For genuinely sensitive
  material, use a tool you can verify before running.

## Design notes

**Dependencies are kept deliberately few.** Three at runtime:
`@noble/secp256k1` (Nostr event signing), `qrcode-generator`, `jsqr`. The
signalling transport is written directly rather than pulled from a library that
would have brought 180 packages for backends we never import.

**The confidentiality path uses WebCrypto only** — P-256, HKDF, AES-GCM, no
third-party code. `@noble/secp256k1` sits outside that boundary: it signs
transport events, so a backdoor there could disrupt or deanonymise signalling
but could not read a file byte.

**Two gestures gate every transfer.** The sender confirms the SAS before a
manifest goes out (the manifest alone leaks the filename and size). The
receiver accepts — which is also the click that lets the browser open a save
destination, since `showSaveFilePicker` requires a user gesture.

## Known limitations

- **Firefox and Safari buffer received files in memory** before saving, capping
  practical transfers around a gigabyte. Chromium streams to disk via the File
  System Access API. Closing this needs a Service Worker that fabricates a
  streaming download response.
- **STUN only by default.** Roughly 10–15% of NAT pairings need a TURN relay;
  pass one to `connectPeers` if you need that coverage.
- **One file at a time.** The framing supports a file sequence; the UI does not
  expose it yet.
- **Public relay dependence.** Four are used concurrently for redundancy, but
  all four being unreachable means no pairing. The relay list is pinned in the
  CSP, so changing it means changing `index.html` too — deliberately.

## Layout

```
src/crypto/secret.js     QR secret, HKDF derivations
src/crypto/session.js    ephemeral ECDH, directional keys, SAS
src/transfer/frame.js    per-chunk AEAD, nonce construction, wire header
src/transfer/sender.js   chunking, backpressure, accept handshake
src/transfer/receiver.js demux, verification, sink management
src/transfer/sink.js     File System Access, with a Blob fallback
src/signal/nostr.js      encrypted ephemeral events over public relays
src/signal/webrtc.js     offer/answer, ICE, key agreement
```
