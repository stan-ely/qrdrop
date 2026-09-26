# Beam: no network at all

Everything else in qrdrop assumes a network. On an air-gapped machine there is none, so
there is no transfer. **Beam** is the answer to that, and it is a separate mode
rather than a fallback: the sender animates QR codes on screen, the receiver
points a camera at them, and nothing crosses a wire.

<!-- Source: docs/diagrams/beam.mmd, rendered by scripts/make-diagrams.mjs.
     A ```mermaid fence would be tidier and renders on GitHub, but not on npm,
     which shows the README too. The alt text is the diagram in words -- it is
     what a screen reader gets, and what the ASCII sketch this replaced gave. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/beam.dark.png">
  <img alt="Sequence diagram of beam mode. The sender screen emits about ten QR frames a second, roughly 600 bytes each, every one an LT-coded block, to the receiver camera. The manifest is woven in every 20 frames so a receiver can join mid-stream. There is no back channel at all: the sender cannot tell how the receiver is doing except by looking at it." src="diagrams/beam.light.png">
</picture>

Beam is reached from the browser UI only — `qrdrop web`, then the page's "No
network? Show it as a QR code" or "Scan a beamed file". There is no `qrdrop
beam` command, and there will not be one: the mode needs a screen to animate
and a camera watching it, which a terminal on the receiving end does not have.

> [!WARNING]
> **Beam is not encrypted, and it cannot be.** There is no handshake, so there
> is no ECDH, no forward secrecy, and no SAS — there is no peer to
> authenticate, only photons. The only adversary is someone who can see the
> screen, and a key shown on that same screen does not stop them. The UI says
> so in full before either side commits — on the sender's confirm sheet before
> the code starts, and on the receiver's sheet before Accept — and both beam
> screens carry a “Not encrypted” tag for the rest of the transfer. Everything
> the [threat model](threat-model.md) says about confidentiality applies to the
> WebRTC path and not to this one.

## What to expect

About **6 kB/s**, and a **1 MiB cap** applied after compression. Files are gzipped
first and the result kept only if it actually shrank, so text, CSV, JSON and
source typically compress 3–10× and a several-megabyte log file is fine, while a
900 KB JPEG is refused. `test/beam.test.mjs` pins the loss behaviour, including
the case where a manifest under-declares its own decompressed size.

gzip rather than brotli, though brotli is smaller and is now in the WHATWG
Compression Standard: a one-way channel cannot negotiate. The sender picks blind
and the receiver either can inflate it or cannot, and brotli is Safari 18.4+ and
Firefox 147+ with Chrome behind. Twenty-five seconds off a three-minute transfer
is not worth a failure whose only remedy is "try a different browser".

A fountain code has no ordering, so the decoder holds every block in memory
until peeling completes — the second reason for the cap. Raising it wants
independent ~256 KiB windows so memory stays bounded and each can be flushed as
it solves; that is not built.

## Why a fountain code

The obvious design is to number the chunks and loop them forever, as [qrbeam](https://www.npmjs.com/package/qrbeam)
does. That is a coupon-collector problem: gathering the last few of N chunks
means re-watching the whole loop repeatedly, so completion costs about `N·ln(N)`
frames. Frames *are* dropped — jsQR needs 50–100 ms per frame, so a Firefox
phone manages about ten decodes a second against a display emitting exactly
that.

The transfer is an LT code instead, so a frame does not care *which* frames were
missed, only how many arrived. Measured over 1748 blocks (a 1 MiB payload),
frames the sender must emit before the receiver has the file:

| frame loss | this codec | numbered chunks on a loop |
| --- | --- | --- |
| 0% | **1.05 × N** | 1.00 × N |
| 10% | **1.48 × N** | 8.3 × N |
| 30% | **2.08 × N** | 10.7 × N |
| 50% | **2.81 × N** | 14.9 × N |

The first N frames are the source blocks sent plain, and only then does the
fountain start. txqr does not do this, and the trade is real rather than a free
win: the decoder then needs ~1.3 distinct frames per block under loss, against
the ~1.15 a pure LT code reaches, because most blocks are already solved by the
time the fountain begins and a degree-d frame therefore carries fewer unknowns
than its degree suggests. What it buys is the common case — a clean capture
costs exactly N frames and nothing more. Which side of that is right depends on
how good you expect the camera to be, and this bets on it being good.

## Prior art, and what is actually ours

Neither the idea nor the design is original here, and it would be tidier but
dishonest to present them that way.

The prompt was **[qrbeam](https://www.npmjs.com/package/qrbeam)**, which sends a
file offline as animated QR codes to an iOS receiver. That is where the idea of
adding this to qrdrop came from. Its wire format numbers the chunks and loops
them, which is what the table above compares against — named, because a
benchmark against an unnamed strawman is worth less to a reader and is unfair to
the party being measured.

**[txqr](https://github.com/divan/txqr)** by Ivan Daniluk got to the fountain
code first, and it is the closest prior art to what is built here: animated QR
frames carrying [LT-coded](https://en.wikipedia.org/wiki/Luby_transform_code)
blocks, so the receiver needs *enough* frames rather than *particular* ones. The
[write-up on fountain codes and animated QR](https://divan.dev/posts/fountaincodes/)
is the better explanation of why this works and is worth reading before this
section. The reasoning above was arrived at independently, which makes it
convergent rather than novel — no code was taken from either project.

What differs here is small and worth stating plainly rather than dressing up:
the first N frames are systematic, compression is decided by measurement, the
manifest is interleaved so a receiver can join mid-stream, and both halves run
in a browser with no install on either side.

