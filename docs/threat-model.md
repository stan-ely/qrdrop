# Threat model

What qrdrop protects, what it does not, and the limitations worth knowing
before relying on it. The mechanisms referred to here are described in
[protocol.md](protocol.md).

> [!NOTE]
> Everything below describes the **WebRTC path**. [Beam](beam.md) shares
> none of it — see that page.

**Protected**

- Relay operators and TURN servers see ciphertext, timing, and volume only.
- A network attacker without the QR cannot join, read, or MITM the transfer.
- Past transfers stay closed if the code leaks afterwards.
- Truncated, reordered, or altered files are rejected, not silently written.
- Frames are accepted only from the peer this device actually paired with, and
  a frame that fails its authentication tag is dropped rather than treated as a
  fault in the transfer — so somebody else in the rendezvous room cannot
  *interrupt* a transfer they cannot read. This was not true before v0.3.1; see
  the note under [Known limitations](#known-limitations).

**Not protected**

- **Anyone with the code can join.** It is the entire credential. Show the QR to
  a person, not to a room. Note the boundary this draws, though: someone
  *without* the code cannot read your file, cannot forge or alter one, and
  cannot stop one being transferred.

  Because the QR *is* the credential, the leak paths stop being network paths:
  a screen share, an OBS scene, a recorded standup, a screenshot that syncs to
  a photo library. Unlike a password there is nothing to rotate afterwards. So
  it is worth being precise about how long that code stays useful, which is
  neither "one-shot" nor "live forever":

  - The rendezvous topic is `HKDF(secret, "topic")` — deterministic, and
    stable for the life of the secret. It is not a nonce and it does not
    expire.
  - **Pairing latches on first arrival.** In `joinVia`, the first peer to send
    its ECDH public key sets `settled` and `pairedPeerId`; every later `ecdh`
    message is ignored, and frames from anyone else are dropped.
  - So a code is spent *for pairing purposes* once a pairing settles. But that
    latch is the only thing that closes the window — and first-to-arrive can be
    the attacker rather than the intended phone. The
    [SAS](protocol.md#two-gestures-and-why-neither-is-decorative) is what surfaces that,
    and it is why a mismatch ends the session and asks for a fresh code rather
    than offering to retry: four symbols out of 64 is 24 bits, which holds only
    at one attempt per secret.
  - **There is no TTL.** The window lasts exactly as long as the sender's tab
    sits on the QR screen unpaired.

  Net: a QR in a recording is a *live* code precisely while the sender is still
  waiting for someone to scan — the same moment a screen share is typically
  running.
- **The host serving the page could serve modified code.** No in-browser design
  prevents that. It is mitigated by a strict CSP, no inline scripts, a small
  auditable surface, and shipped source maps — the deployed bundle is readable
  in devtools, so the claims here can be checked against what is actually
  running rather than against this repository. Mitigated, not eliminated.
- **Both peers learn each other's IP.** Inherent to a direct connection. A
  connection that falls back to TURN hides each IP from the other but shows both
  to the relay operator; forcing that path for everyone would need
  `iceTransportPolicy: 'relay'`, left opt-in.
- **Which route the bytes took is now shown, with a caveat.** Both surfaces
  report the path read off the nominated ICE candidate pair: *Local network*
  (both ends on a host candidate), *Direct, over the internet* (reached through
  NAT), *Through a public relay* (TURN), or *Path unknown*. Treat "Local
  network" as evidence, not proof — a host candidate can also belong to a VPN,
  Tailscale, or container interface, which is a local *interface* rather than a
  local *network*, so the copy never promises the transfer is free. The two peers do
  not see the same evidence: Firefox withholds the address of a peer-reflexive
  candidate, so the side that could not resolve the other's mDNS `.local` name
  can only answer "unknown" about a connection the other side describes
  exactly. Each peer therefore classifies its own end, sends the verdict as a
  sealed `path` control message, and both show the combination — evidence beats
  absence (`local` + `unknown` → `local`), and a genuine conflict resolves the
  expensive way (`local` + `direct` → `direct`), because being wrongly warned
  about data cost is an annoyance and being wrongly told a metered transfer is
  free is a bill. A peer that never sends one is not an error; nothing waits on
  it.

  Set `?debug=path` in the query string (never the fragment, which is where the
  secret lives) to see the raw candidate pairs behind a verdict on either
  device. Addresses are reported as a category — `mdns`, `ipv4-rfc1918`,
  `ipv4-cgnat`, `ipv4-public` — rather than as values, so a dump can be shared
  while diagnosing without disclosing anyone's network. "Local"
  describes the file bytes only: pairing always crossed the internet, over a
  public signalling network. "Path unknown" means this device could not read
  the stats — the ordinary answer under `node-datachannel`, and not a fault.
- **Relays and trackers see metadata**: that two throwaway keys met on a room,
  when, and roughly how much moved.
- **Beam transfers are in the clear.** No handshake means no key agreement and
  no SAS. Anyone who can see the sender's screen — or a photograph of it, or a
  camera in the room — has the file. It is offered for air-gapped machines,
  where the alternative is a USB stick, not as a private channel.

The CLI avoids the browser-delivery problem entirely: it is a versioned tarball
you can pin, audit, and check the provenance of. Releases are published with
`npm publish --provenance`, so the tarball is tied to the workflow run and
commit that built it.

## Known limitations

- **Firefox and Safari buffer received files in memory** before saving, capping
  practical transfers around a gigabyte. Chromium streams to disk via the File
  System Access API. Closing this needs a Service Worker that fabricates a
  streaming download response. The CLI has no such limit.
- **The streaming save path has no automated test.** Headless Chromium exposes
  `showSaveFilePicker` but has no UI to answer it, so the e2e forces the
  in-memory fallback.
- **The e2e suites depend on public Nostr relays**, so they need a network and
  fail for reasons unrelated to this code. Pointing them at
  `@trystero-p2p/ws-relay` against a local WebSocket server would make them
  deterministic and offline; worth keeping one Nostr run as a smoke test.
- **TURN is free, shared, and metered.** Roughly 10–15% of NAT pairings can't
  connect directly and fall back to the Open Relay Project's public TURN
  (static credentials, no signup). Because that bandwidth isn't ours, a transfer
  that ends up relayed is capped at 100 MB — the sender refuses and the receiver
  auto-declines a larger file. A direct connection has no such limit. There is
  no resume yet, so an interrupted transfer restarts from zero.
- **The metered warning and the TURN cap are different numbers on purpose.**
  Above 25 MB (`METERED_WARN_BYTES`) on a *direct* or *relay* path, both
  surfaces say so before the transfer starts — that threshold protects the
  user's data allowance, where the 100 MB cap protects free infrastructure.
  Collapsing them into one constant looks tidy and would let a 90 MB transfer
  over mobile data go out in silence. The warning is deliberately silent on a
  *local* path, and on *unknown*: warning about a route we've just said we can't
  identify would fire on every large CLI send and train the message into
  wallpaper. It is text beside the existing gestures, never a second click.
- **One file at a time.** The framing supports a file sequence; neither the UI
  nor the CLI exposes it yet.
- **Fixed in v0.3.1: a stranger in the room could end a transfer.** Up to
  v0.3.0, `open()` checked a frame's type, file sequence and chunk index on the
  **cleartext** header, before AES-GCM ran, and the transport accepted frames
  from any peer in the rendezvous room rather than only the paired one. So
  anyone who could get a single packet into that room — with no code, no
  pairing, and never holding a key — could end a live transfer with fourteen
  bytes of well-formed header: the receiver refused the frame, aborted its sink
  and discarded the partial file. It surfaced in the field as
  `Out-of-order frame: expected 0, got 13877` on a sub-1 MB transfer, which has
  only about 64 chunks in it.

  Confidentiality and integrity were never at risk. The attacker could not read,
  forge or alter file contents, and nothing unauthenticated was ever written to
  disk — the tag has always been checked before a byte reached a sink.
  **Availability was**: a transfer could be interrupted by someone who could not
  read it. Both halves are fixed — frames are authenticated before their headers
  are trusted, and inbound frames are filtered by the paired peer — and both are
  covered by regression tests. If you self-host the browser bundle, redeploy.

