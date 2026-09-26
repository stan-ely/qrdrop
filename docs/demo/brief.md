# Demo video brief

What a demo of qrdrop has to do, and the traps specific to filming this
particular app. Written as a production checklist rather than as marketing
copy — the point of the film is to make one claim believable, and most of the
decisions below exist to protect that claim.

## Two artefacts, not one

| | Length | Where | Audio |
| --- | --- | --- | --- |
| **The loop** | 10–15 s | Top of the README, the npm page, the site | None. Silent, looping, no controls |
| **The film** | 60–90 s | Shared as a link, embedded in the site | Narrated, with burned-in captions |

One file does neither job well. The loop has to read at thumbnail size with no
sound and no context; the film has time to explain the SAS, which the loop does
not.

The loop is one continuous beat: a send started on a laptop, a phone raised to
the screen, the file arriving. Nothing else. If it needs a caption to make
sense, it is the wrong ten seconds.

**How the loop is captured now:** one real transfer, two recorders. The laptop
side is driven by `scripts/demo-session.mjs` — it opens a headed browser on the
deployed site, starts a genuine send, and records its own page (landscape webm,
no window chrome) while waiting for the phone to pair and accept. The phone side
is an ordinary screen recording of that same receive, filmed off the laptop's
screen. Same pairing, same SAS, same file: two cameras on one event, not two
takes cut to resemble one. `scripts/record-walkthrough.mjs` (scripted
`_setState`, sender screen only) is the fallback for when there is no relay, no
phone, or no second person — see `docs/demo/loop-kit.md`.

**Current scope: the loop.** The film's shot list below is kept current so it is
ready to shoot, but it has not been produced. Where the two disagree about a
detail of the UI, the loop section is the one that has been checked against the
build.

## Filming origin — the phone needs real HTTPS

This is new, and it is the thing most likely to waste a filming session.

The phone must load **`https://share.stan-ely.com`**, the deployed build. It
must not point at a laptop running `npm start` or `qrdrop web`: that server binds
`127.0.0.1` only (`src/node/serve.js`), and `http://<lan-ip>` is not a secure
context, so on the phone WebCrypto and `getUserMedia` both fail closed — the page
loads and then cannot derive a key or open the camera. Loopback is a deliberate
ceiling, not a gap to tunnel around for a shoot.

The laptop half is `scripts/demo-session.mjs`, which points its own browser at
the deployed site. It could in principle be any surface that shows the same UI —
the sending side never touches the camera — but the script is what keeps the
send deterministic and the capture clean, and pairing it with the deployed site
on the phone is the simplest honest setup.

On the deployed site the send-screen QR is a link (`qrIsLink` is true), so the
phone's **native camera app** opens it directly into the receive flow. That is
the behaviour the film's 0:12 beat depends on; an embedder without `base-url`
gets the bare `qrdrop:` form instead, which no camera app resolves.

The QR is inert by the time anyone watches this. A qrdrop secret is per-session
and dies with the page, so a recorded code opens nothing — worth being able to
say plainly rather than looking evasive about it.

## Shot list for the film

| At | Beat | Why it is in the film |
| --- | --- | --- |
| 0:00 | Laptop and phone in one frame, one unbroken shot | Establishes "same room". The whole model collapses if a viewer thinks this is a cloud link |
| 0:05 | Drag a file onto the page; the screen advances itself and the QR animates in | The advance is automatic now — there is no button to press between dropping the file and the QR |
| 0:12 | Phone's **native camera app** over the QR → notification → qrdrop opens, already joining | The "nothing to install" claim. One continuous take — a cut here is exactly where a sceptic assumes the trick is |
| 0:20 | Both screens settle on the verify screen; the path badge ("Local network" / "Relayed") and a one-off toast arrive a second later | The pairing gap is real. Letting the badge land on camera is honest; cutting to an instant connection looks staged |
| 0:24 | Both screens show the same **four tiles — an emoji over a word each** — held long enough to read both | The beat everyone will want to cut, and the only one carrying the security story. The *words* are the SAS: a person says "elephant, trumpet, rocket, wave" aloud to their peer |
| 0:34 | The sender presses "They match — send report.pdf"; progress moves on both; the file lands with its real name | |
| 0:42 | `npx qrdrop send report.pdf` in a terminal; the QR prints as text; the phone scans the terminal | Proves the interop, and is the moment CLI users decide to try it |
| 0:54 | On the choose screen, open **"No network?"**, then "Show it as a QR code" / "Scan a beamed file". Aeroplane mode toggled **visibly** first. Then: animated QR, camera, progress | The most striking segment, and the one nobody expects. Beam is no longer a button on the first screen — it lives one tap deeper, in a sheet |
| 1:06 | Close on what the relay saw | |

## Hard requirements

- **Real devices, real transfer** wherever the claim is that it just works. The
  phone is always an actual phone, actually receiving — never a screen recording
  dropped into a phone mockup. The laptop side may be a clean screen/page
  capture (the loop uses one), because the sender never touches the camera and
  nothing about it is what a sceptic doubts; the phone is.
- **A boring file with a legible name.** `report.pdf`, not `test.bin`. The
  filename is on screen in the manifest, on the verify screen, and on the done
  screen. Keep it small — tens to low-hundreds of KB — so the transfer screen
  does not outlast the shot it is in.
- **The beam segment keeps the "not encrypted" banner in frame.** Both beam
  screens carry it (`.callout danger`, "This is not encrypted, and cannot be")
  and the README carves beam out of the threat model; a demo that crops it
  teaches the opposite of what the project believes. This is not negotiable for
  a shorter cut.
- **Burned-in captions** on the film. Most autoplay is muted, and the loop has
  no audio track at all — but the loop carries no captions either, by design.
- **1080p minimum. 60 fps for the beam segment and for the whole loop.** The
  beam player repaints at ~10 Hz and a 30 fps capture aliases that into a
  strobe; the loop now has screen-entrance and step-rail progression animations
  (see below) that a 30 fps capture judders. 30 fps is fine for the film's
  talking sections.
- **Film the receiving phone during beam**, not the sender's flickering screen.
  A QR animating at 10 Hz shot head-on reads as noise.
- **Clean shell prompt, fresh browser profile.** No hostname, username,
  bookmarks, autofill, or history bar in shot.

## Traps specific to this app

- **The UI animates now.** Screens slide in on entry and the `Connect · Verify ·
  Transfer` rail advances a segment at each step (commit `4778786`). None of it
  is decorative to the recording — a 30 fps capture turns the entrance into a
  stutter. Shoot 60 fps and let the animation finish before cutting.
- The camera **permission prompt** appears on the receiving phone. Either
  pre-grant it or leave it in — leaving it in is honest, and it is one of the
  few moments that proves this is a real browser rather than a video.
- `showSaveFilePicker` opens an **OS save dialog** on Chromium only. Decide
  deliberately whether it is in the cut; on Firefox and Safari the file simply
  downloads, which is a different-looking ending.
- **Pairing takes a couple of seconds** while both peers announce on every
  signalling network, and the path badge lands a beat after that. That gap is
  real and should not be cut to zero — a transfer that appears instantaneous
  looks staged.
- **Beam is behind a sheet.** On the choose screen there is no beam button; the
  frame's details button is relabelled "No network?" and opens a sheet holding
  "Show it as a QR code" and "Scan a beamed file". Film the tap that opens the
  sheet — skipping straight to a beam screen looks like a different app.
- Beam refuses files over **1 MiB after gzip**. Pick the demo file with that in
  mind: a few hundred KB of Markdown or CSV compresses well and finishes in
  about half a minute at 10 fps.
- **Do not stage a SAS mismatch** as a dramatic beat unless the film then shows
  the correct response, which is to stop and start over. A mismatch played for
  drama and then waved past is worse than not showing one.

## Post-production

The raw takes are `docs/demo/loop/laptop.webm` (from `scripts/demo-session.mjs`)
and the phone's screen recording of the same transfer. Everything after that is
two tools, both already installed, neither added to `package.json` or CI:

- **`ffmpeg`** for the mechanical cut: `-ss` / `-to` to trim each take to the
  shared span so the two line up, an optional `eq` / `curves` pass on the phone
  footage for exposure and white balance. No non-linear editor is in this
  pipeline.
- **HyperFrames** for the final render. It renders video from an HTML
  composition: the trimmed laptop clip goes in as a full-frame `<video>`, the
  phone clip as a phone-shaped inset, and the loop seam, any persistent wordmark
  bug, and the deterministic encode come out the other side. Start at `/hyperframes` and let its intent layer route: the
  footage is real live-action of two devices, so expect `/general-video` (a
  freeform build), not `/motion-graphics`, which is for invented motion with no
  live subject. `seam-craft` covers the loop point; `media-use` grades the
  footage if it needs it. The procedure lives in `docs/demo/loop/README.md`;
  the shot-side checklist is `docs/demo/loop-kit.md`.

**Hosting: self-host the loop, do not put it on YouTube.** It is a chromeless,
silent, inline autoplay-loop clip; a YouTube embed wraps it in a player UI,
branding, and related-video chrome and cannot sit inline at the top of a README
or behind the site's hero. Render it to a small same-origin `loop.mp4` +
`loop.webm` with a poster PNG for the npm page, which renders no video. YouTube
is the right home for the 60–90 s film — "shared as a link" above — just not for
the loop.

## The one test worth re-cutting for

Show it to someone who has never heard of qrdrop and ask what the four emoji
were for. If they cannot say, the SAS beat is too short — lengthen it and cut
somewhere else. Everything else in this document is a preference; that is the
criterion. (The loop is exempt: it deliberately does not explain the SAS, so
the question to ask of the loop is only whether a stranger sees a file move
from the laptop to the phone.)
