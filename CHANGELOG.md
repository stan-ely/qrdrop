# Changelog

Notable changes, newest first. Dates are the release date; the commit history
is the finer-grained record.

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
