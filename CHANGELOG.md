# Changelog

Notable changes, newest first. Dates are the release date; the commit history
is the finer-grained record.

## 0.4.0 — 2026-09-06

**Privacy: the camera could stay on after a scan was cancelled.** `scanQRStream` registered
its abort listener three awaits after opening the camera, so an abort arriving during
`getUserMedia`, `video.play()` or `createDetector()` found no listener — and a signal that
has already fired never fires again, so the scan promise never settled and the `finally`
that stops the track never ran. The webcam then stayed on for the life of the page. The way
in is ordinary rather than exotic: the hand-entered code field lives on the scanner screen,
so **pairing by pasted code aborted mid-open every time**. It was found by a light on a
laptop while the whole suite passed, because nothing headless can observe a camera that was
never released. If you embed `<qr-drop>`, this is the reason to update.

**Sending a file from a phone was between 12 and 18 times slower than it needed to be.**
`fromFile` read once per 16 KiB frame, and on Android a `File` picked through the Storage
Access Framework is backed by a `content://` provider — so every read was a Binder
round-trip to another process, ~79 ms fixed plus ~3.7 ms per MiB. A 3 MB send spent 29.7 s
of a 30.3 s transfer inside those reads: 98% of it, against 21 ms of AEAD and 9 ms of data
channel. It now reads in 2 MiB blocks and issues the *next* block's read as soon as the
current one lands, so the round-trip overlaps the ~128 frames still going out. Measured on
a real device: 3 MB went 30.2 s → 3.34 s, and 64 MiB went to 16.8 s at 4.03 MB/s, where the
per-frame path would have taken about eleven minutes. Across 31 block boundaries the
read-ahead was late zero times, so reads now cost the transfer nothing.

This was never a Tauri problem, which is why the fix is in `src/web/source.js` and reaches
everyone: Chrome on the same phone passes the `content://` through the same way, so the
deployed site had it too, at 0.22 MB/s for **every Android sender**. Desktop browsers were
unaffected — a `File` there is backed by a real filesystem — and the CLI uses a different
adapter entirely, which is exactly why it survived until someone pointed a phone at it.

**A slow sink no longer buffers the whole file in memory.** `RTCDataChannel` delivers
messages as fast as they arrive and the receiver serialised them into a promise chain, so
SCTP flow control never engaged — the receiver never stopped reading. A sink that drained
slower than the channel filled therefore grew the heap by the size of the transfer; measured
at its worst, 1 GiB of heap over a 1 GiB file. The receiver now tracks bytes accepted but not
yet written and sends an authenticated `pause` control message above a threshold, `resume`
below one, with a timeout so an indefinitely-paused transfer fails with a diagnostic rather
than hanging. Both directions degrade cleanly: a sender too old to act on `pause` drops it as
an unrecognised control type, and a receiver too old to send one simply never does.

**Fixes.** A sealed chunk now fits in one transport message. `CHUNK_SIZE` was a flat 16 KiB,
which overshot the action wire's per-message budget by 66 bytes — and the transport does not
reject an overshoot, it splits it, so every frame travelled as a full message plus a 102-byte
runt (measured: 393 sends for 192 frames). Inbound tolerance is deliberately unchanged, since
a peer on the old constant still sends 16414-byte frames.

**New.** A platform seam (`qrdrop/web`'s `registerPlatform`) lets a host application supply
its own file sink without the deployed site being able to regress from it. `<qr-drop>` now
consumes a code set on `location.hash` after load, guarded to the choose screen so it cannot
interrupt a live transfer — the mechanism behind opening a scanned link in an installed app.
Both still take the code only from the fragment, never the query string.

**A desktop and mobile app now exists**, built from this same code and released on its own
`app-v*` tags with its own changelog. See [the README](README.md#the-app) for what each
platform can and cannot do.

**If you self-host the browser bundle, redeploy.** The camera fix and the mobile send
performance both live in it.

## 0.3.1 — 2026-08-30

**Security: a stranger in the rendezvous room could end a transfer.** Frame headers were
checked for type, file sequence and chunk index *before* AES-GCM ran, and the transport
accepted frames from any peer in the room rather than only the paired one. Together those
meant anyone who could put a single packet into the room — no code, no pairing, never
holding a key — could kill a live transfer with fourteen bytes of well-formed cleartext:
the receiver refused the frame, aborted its sink, and discarded the partial file. Reported
from the field as `Out-of-order frame: expected 0, got 13877` on a sub-1 MB transfer, which
has about 64 chunks in it.

Confidentiality and integrity were never affected — the attacker could not read, forge or
alter file contents, and nothing unauthenticated ever reached a sink. Availability was.
Frames are now authenticated before their headers are trusted, and a frame that fails its
tag is dropped and counted (`receiver.dropped`) rather than treated as a fault in the
transfer; inbound frames are filtered by the paired peer, matching the targeting the send
side has always done. **If you self-host the browser bundle, redeploy.**

**Fixes.** A failed transfer now closes its room, so frames still in flight stop
re-entering a dead state machine and firing one error control frame each. Internal failure
text no longer reaches the user verbatim — the error sheet says what happened in plain
words, with the raw message under a Details disclosure for a bug report. The pairing QR and
the beam stage stay square when the window is short: the wide-layout branch pinned their
width while the card went on squeezing their height, which paid out as a white band beside
a code pinned to the corner.

**Layout sweep.** `scripts/check-layout.mjs` now runs Firefox as well as Chromium, and
asserts the QR and beam boxes are actually square — the check that caught the above. It
needs `npx playwright install firefox` once.

**Distribution.** `brew install stan-ely/tap/qrdrop` installs the CLI on macOS and Linux;
the formula is rewritten from the release workflow, so it cannot drift from what was
published. Tags now produce a GitHub Release as well as an npm publish, with notes taken
from this file rather than generated from commit subjects. Each release carries the npm
tarball, `qrdrop-site-<version>.zip` — the built browser bundle, for self-hosting, which is
what the redeploy note above was asking for and previously had nowhere to point — a
`SHA256SUMS` file, and a build provenance attestation over both archives. No winget: it
cannot install a Node CLI without a bundled runtime, and Windows already has `npx`, `npm i
-g`, and the deployed site.

## 0.3.0 — 2026-08-30

**Web UI overhaul.** Screens now animate on entrance and as you step through the transfer.
Info sheets hold long-form copy — reassurance text, warnings, and explanations — keeping
them off the main layout and freeing mobile screens from vertical scroll. The UI role
system collapsed to three clear treatments. A choose-screen heading and step dots
guide navigation. Media lays beside text on short windows instead of stacking.

**Path reporting and verdicts.** Both peers exchange what they learned about which
route the connection took (LAN, IPv4, IPv6, cost) and show the same answer instead
of guessing. Route selection is logged to the path debug page (`?debug=path`), showing
every candidate pair and why it won. The sender warns when the path has a cost (metered
carrier or VPN).

**Beam demo.** The README now leads with a video of a live file transfer, filmed from
both the sender and receiver at once. The loop was one real transfer, not staged.

**Fixes.** Styles render without constructable stylesheets for better compatibility.
Transfer screens get a media block so layout doesn't depend on content. Beam offers
are answered on the sheet only, leaving a way back. Unrecognized control messages are
ignored instead of crashing. LAN hops are recognized when only one peer resolves the
mDNS name. IPv4-mapped IPv6 addresses are judged as IPv4.

**Documentation.** The README is restructured with three rendered diagrams, screenshots
of the real UI, a contents strip, and deep-dive sections folded into details. Two
load-bearing warnings (the SAS that `--yes` cannot skip, and backpressure) are raised
into callouts. Added `SECURITY.md`, `CONTRIBUTING.md`, and `docs/diagrams/*.mmd`
sources rendered to PNG. Social preview tags moved before their explanation to stay
within crawlers' byte budgets.

## 0.2.0 — 2026-08-29

The air-gap release.

**Beam: file transfer with no network at all.** The sender animates QR codes on
screen at about ten frames a second, the receiver points a camera at them, and
nothing crosses a wire. The payload is a [fountain
code](https://en.wikipedia.org/wiki/Luby_transform_code), so the receiver needs
*enough* frames rather than *particular* ones — at 30% frame loss that is 2.08×N
frames against the 10.7×N a numbered loop would cost. The first N frames are
sent plain, so a clean capture costs exactly N. The manifest is interleaved
every 20 frames, so a receiver can join mid-stream. About 6 kB/s, with a 1 MiB
cap applied after gzip.

Beam is **not encrypted and cannot be**: no handshake means no key agreement, no
forward secrecy, and no SAS. Both beam screens say so, and the README carves it
out of the threat model rather than letting the document's other claims appear
to cover it.

**`qrdrop web`** serves the browser UI from the installed package on
`http://127.0.0.1:4173` — the way to use the browser flow while running code you
can read first. Loopback only: `http://<lan-ip>` is not a secure context, so
WebCrypto and the camera would fail there. `site/dist/` now ships in the tarball,
built by `prepublishOnly`, so nothing is compiled at `npx` time.

**Releases are published over OIDC trusted publishing**, with provenance. There
is no longer an `NPM_TOKEN` anywhere.

**The site** gained a three-step orientation strip above the transfer UI, an
Open Graph card (`site/og.png`, generated by `scripts/make-og.mjs`), links out
to source, issues and author, and a content-hashed stylesheet — GitHub Pages
serves `max-age=600` and ignores `site/_headers`, so a stale stylesheet was
being served against fresh markup.

**Fixes.** `node-datachannel` is pinned to 0.33.0, the last version with a
complete platform set. `adopt` is honoured when an element is created, not only
when it is patched. The pairing screen says each thing once, and buttons admit
they were clicked.

**Credit.** [qrbeam](https://www.npmjs.com/package/qrbeam) is where the idea of
beaming a file over animated QR came from, and [txqr](https://github.com/divan/txqr)
got to the fountain code first. Neither is a strawman and no code was taken from
either.

## 0.1.0

The first published version: the WebRTC path, the three entry points, and the
CLI.

It was released without a git tag, so its exact boundary cannot be reconstructed
from this repository — reproducing it here would be a guess presented as a
record. `git log` up to `b7e661f` is the honest answer. Tagging starts at 0.2.0.
