# Protocol

How qrdrop pairs two devices, derives its keys, and moves a file, and the
design decisions behind each step. The [README](../README.md#how-it-works) has
the short version; the [threat model](threat-model.md) says what all of this
does and does not protect.

## Pairing and keys

Two devices in the same room. One shows a QR code, the other points a camera at
it, and that scan is the one channel an attacker cannot stand in the middle of.

<!-- Source: docs/diagrams/handshake.mmd, rendered by scripts/make-diagrams.mjs.
     A ```mermaid fence would be tidier and renders on GitHub, but not on npm,
     which shows the README too. The alt text is the diagram in words -- it is
     what a screen reader gets, and what the ASCII sketch this replaced gave. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/handshake.dark.png">
  <img alt="Sequence diagram of the WebRTC path. The sender generates 32 random bytes and shows them as a QR code, which the receiver scans; the room ID, signalling password, session keys and the SAS all derive from those bytes. Both peers announce on every signalling network at once, exchange session descriptions encrypted under the derived password, and open a WebRTC data channel. An ephemeral ECDH gives one key per direction; four emoji are read aloud and matched by hand; only then does the manifest go out, the receiver accepts, and the file chunks follow, each one sealed." src="diagrams/handshake.light.png">
</picture>

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

"Per session" is the load-bearing word, and it rests on one line: the keypair is
generated inside `joinVia`, per call, and thrown away with the room. Since
`openRoom` races two signalling networks at once, one pairing generates two
keypairs and discards one — which makes lifting that line to module scope look
like an easy saving and would quietly turn every transfer a process ever made
into one long session. `test/room.test.mjs` pairs twice over the same secret
against an in-memory signalling strategy and asserts the second session cannot
decrypt the first's traffic, so that edit fails a test in two seconds rather than
surviving to a release.

DTLS also terminates at the peer's browser, and when NAT traversal fails packets
pass through a third-party TURN relay. Sealing each chunk ourselves means a
relay operator sees ciphertext and byte counts, never contents.

Nonces are unique by counting rather than by chance — `fileSeq || chunkIndex`,
with a separate key per direction — because AES-GCM does not degrade gracefully
under nonce reuse. The end-of-file flag is authenticated, so an attacker who
stops forwarding frames cannot pass a truncated file off as complete.

### Two gestures, and why neither is decorative

The sender confirms the four-emoji SAS before a manifest goes out — the manifest
alone would disclose the filename and size. The receiver accepts, which is also
the click that permits `showSaveFilePicker` to open, and that is what lets large
files stream to disk instead of accumulating in memory.

> [!IMPORTANT]
> Both gestures survive into the CLI as stdin prompts. `--yes` skips the accept
> prompt and **cannot** skip the SAS confirmation: the SAS is the entire
> man-in-the-middle defence, so a flag that skipped it would be a vulnerability
> wearing a convenience's clothes.

## Three faces, one protocol

```js
import { openRoom, sendFile, createReceiver } from 'qrdrop'        // isomorphic
import { defineQRDrop, fromFile } from 'qrdrop/web'                // browser
import { fromPath, createFileSink } from 'qrdrop/node'             // Node
```

<!-- Source: docs/diagrams/entries.mmd, rendered by scripts/make-diagrams.mjs.
     A ```mermaid fence would be tidier and renders on GitHub, but not on npm,
     which shows the README too. The alt text is the diagram in words -- it is
     what a screen reader gets, and what the ASCII sketch this replaced gave. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/entries.dark.png">
  <img alt="Diagram of the three entry points. qrdrop/web (the qr-drop custom element, File to FileSource, File System Access to Sink) and qrdrop/node (the qrdrop command, fs to FileSource and Sink) both supply a FileSource and a Sink to the isomorphic qrdrop core, which holds secret, session, frame, sender and receiver, and talks to the outside only through the five-member Channel seam. The core sits above Trystero: Nostr relays, WebTorrent trackers, and the WebRTC data channel." src="diagrams/entries.light.png">
</picture>

The `qrdrop` entry is the protocol and the transport, and it touches neither a
DOM nor an `fs`. That is enforced rather than asserted: `src/core/` and
`src/transport/` are typechecked twice, once with `types: []` and no Node lib
and once with Node's globals, so a stray `Buffer` in code destined for a browser
fails the build instead of throwing at runtime.

What is deliberately *not* in that entry is anything that knows where bytes come
from or go to. `sendFile` takes a `FileSource`, `createReceiver` takes a
`createSink`, and each runtime supplies its own. That is the whole trick behind
having a CLI at all.

### Drop the UI into a page

```html
<script type="module">
  import { defineQRDrop } from 'qrdrop/web'
  defineQRDrop()
</script>

<qr-drop></qr-drop>
```

A custom element with its own shadow root, so it brings its styles with it and
collides with nothing. No framework, and no framework adapter to keep up to
date — every framework already renders a custom element.

### Run the browser UI locally

`npx qrdrop web` serves the same browser UI that [share.stan-ely.com](https://share.stan-ely.com)
deploys, from the package you just installed, on `http://127.0.0.1:4173` — nothing
is uploaded and no other device can reach it. It is the way to use the browser
flow while running code you can read first.

| Flag | |
| --- | --- |
| `--port <n>` | changes the port; `0` picks a free one |
| `--no-open` | prints the URL instead of opening a browser |
| `Ctrl-C` | stops it |

Loopback only, by design: `http://<lan-ip>` is not a secure context, so
WebCrypto and the camera would fail there.

To host the built bundle yourself, see [hosting.md](hosting.md).

## Design notes

### The transport seam

Everything in `src/core/` is written against one interface and nothing else:
`Channel` in `types/qrdrop.d.ts`. Five members — `send`, `bufferedAmount`,
`bufferedAmountLowThreshold`, and the `addEventListener` / `removeEventListener`
pair.

That seam is why replacing the entire signalling layer — hand-rolled Nostr plus
WebRTC negotiation, for Trystero — cost 11 lines across all of the transfer code
and nothing at all in the framing, session, control, digest, or sink modules.
The security core was untouched by a total rewrite beneath it.

> [!IMPORTANT]
> The one subtlety worth knowing before writing another transport:
> **backpressure may be signalled either way, but it must be signalled.** A
> transport can defer the promise returned by `send`, or it can report
> `bufferedAmount` and fire `bufferedamountlow` — Trystero does the former, a
> raw `RTCDataChannel` the latter. A transport that does neither will let a
> large file queue entirely into memory and take the tab down.
> `test/channel.test.mjs` runs a full sealed transfer over a channel with
> exactly those five members and nothing else, so a new transport finds out
> what it is missing there rather than against a live relay.

<details>
<summary><b>More than one signalling network, raced</b></summary>

Trystero ships a package per strategy behind an identical `joinRoom` interface,
so `src/transport/room.js` lists them in `STRATEGIES` — Nostr relays and
WebTorrent trackers today — and `openRoom` joins all of them at once, pairs on
whichever completes the handshake first, and tears the rest down. Both peers are
present on every network simultaneously, so no agreement on *which* network is
needed; a sequential fallback could not promise that. The tracker strategy
shares Trystero's core and costs ~2 kB gzipped; `/mqtt` was measured at ~112 kB
and left out, `/ws-relay` would mean running a server. Adding a strategy is one
entry in `STRATEGIES` and its URL list — the CSP follows automatically, because
`scripts/build-site.mjs` generates `connect-src` from `SIGNALING_URLS` (every
strategy's URLs, reduced to origins) rather than a second list kept in step by
hand.

</details>

<details>
<summary><b>Relay choice was measured, not assumed</b></summary>

The best-known Nostr relays — `relay.damus.io`, `relay.nostr.band`,
`relay.snort.social` — were all unreachable when the list was built. The seven
in `room.js` were picked by connecting to every relay in Trystero's pool and
keeping the ones that answered. The tracker list is seeded from
`@trystero-p2p/torrent`'s defaults and has not had the same publish-test
scrutiny yet.

**Measure by publishing, not by connecting.** `relay.nostr.place` was dropped
after it began demanding proof-of-work (NIP-13) on writes. It still accepts
connections and still answers reads, so a connectivity probe calls it healthy —
it just cannot be used to announce a peer, which is the only thing a relay is
needed for here. A socket that opens is not a relay that works.

</details>

**The confidentiality path uses WebCrypto only** — P-256, HKDF, AES-GCM, no
third-party code. Trystero sits below that boundary: it protects signalling, but
a compromise there could not read a file byte.

### Sources and sinks

The mirror-image pair that make one protocol serve three runtimes.

`FileSource` is three fields and a range read; `Sink` is a name, a `write`, a
`close`, and an `abort`. `sendFile` and `createReceiver` know nothing else about
where bytes live. The browser supplies File System Access with a Blob fallback;
Node supplies `fs`; the tests supply arrays.

`createSink` is a *required* argument to `createReceiver` rather than a
defaulted one. Defaulting it to the browser implementation is what quietly made
the protocol layer depend on the DOM in the first place, and making every call
site answer the question out loud is what stopped it.

A sink's `createSink` has two ways not to hand back a sink, and they mean
different things. It **resolves `null`** when the person chose not to save — a
dismissed dialog — which declines the file. It **rejects** only when saving
failed, and that error is shown on the receiving screen and sent to the sender as
itself. They used to be one path, every rejection read as a dismissal, and that is
how the Android app spent a release unable to receive while telling people they had
closed the save dialog. `createReceiver` also returns `cancel()`, which aborts the
open sink so an abandoned receive does not keep a partial file, and `settled()`,
which resolves once every frame already handed to the receiver has been processed —
wait on it before treating the other side's departure as a failure, or a `done`
still being decrypted loses the race to the leave behind it. A paired room's
`close()` returns a promise that settles once the peer has been told and never
rejects; a process about to exit should await it.

