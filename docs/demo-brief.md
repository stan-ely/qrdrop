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

The loop is one continuous beat: a file dragged onto a laptop, a phone raised to
the screen, the file arriving. Nothing else. If it needs a caption to make
sense, it is the wrong ten seconds.

## Shot list for the film

| At | Beat | Why it is in the film |
| --- | --- | --- |
| 0:00 | Laptop and phone in one frame, one unbroken shot | Establishes "same room". The whole model collapses if a viewer thinks this is a cloud link |
| 0:05 | Drag a file onto the page; the QR appears | |
| 0:12 | Phone's **native camera app** over the QR → notification → qrdrop opens, already on Receive | The "nothing to install" claim. One continuous take — a cut here is exactly where a sceptic assumes the trick is |
| 0:22 | Both screens showing the same four emoji, held long enough to read both | The beat everyone will want to cut, and the only one carrying the security story |
| 0:32 | Accept; progress moves on both; the file lands with its real name | |
| 0:40 | `npx qrdrop send report.pdf` in a terminal; the QR prints as text; the phone scans the terminal | Proves the interop, and is the moment CLI users decide to try it |
| 0:52 | Aeroplane mode toggled **visibly**, then beam: animated QR, camera, progress | The most striking segment, and the one nobody expects |
| 1:05 | Close on what the relay saw | |

## Hard requirements

- **Real devices, real camera, continuous takes** wherever the claim is that it
  just works. A screen recording composited into a phone mockup would undercut
  the premise of the entire tool.
- **A boring file with a legible name.** `report.pdf`, not `test.bin`. The
  filename is on screen in the manifest and on the done screen.
- **The beam segment keeps the "not encrypted" banner in frame.** Both beam
  screens carry it and the README carves beam out of the threat model; a demo
  that crops it teaches the opposite of what the project believes. This is not
  negotiable for a shorter cut.
- **Burned-in captions.** Most autoplay is muted, and the loop has no audio
  track at all.
- **1080p minimum. 60 fps for the beam segment**, 30 is fine elsewhere. The
  player repaints at ~10 Hz and a 30 fps capture aliases that into a strobe.
- **Film the receiving phone during beam**, not the sender's flickering screen.
  A QR animating at 10 Hz shot head-on reads as noise.
- **Clean shell prompt, fresh browser profile.** No hostname, username,
  bookmarks, or autofill in shot.

## Traps specific to this app

- The camera **permission prompt** will appear on the receiving device. Either
  pre-grant it or leave it in — leaving it in is honest, and it is one of the
  few moments that proves this is a real browser rather than a video.
- `showSaveFilePicker` opens an **OS save dialog** on Chromium only. Decide
  deliberately whether it is in the cut; on Firefox and Safari the file simply
  downloads, which is a different-looking ending.
- **Pairing takes a couple of seconds** while both peers announce on every
  signalling network. That gap is real and should not be cut to zero — a
  transfer that appears instantaneous looks staged.
- The **QR on screen is inert by publication.** A qrdrop secret is per-session
  and dies with the page, so a recorded code opens nothing. Worth being able to
  say plainly if someone asks, rather than looking evasive about it.
- Beam refuses files over **1 MiB after gzip**. Pick the demo file with that in
  mind: a few hundred KB of Markdown or CSV compresses well and finishes in
  about half a minute at 10 fps.
- **Do not stage a SAS mismatch** as a dramatic beat unless the film then shows
  the correct response, which is to stop and start over. A mismatch played for
  drama and then waved past is worse than not showing one.

## The one test worth re-cutting for

Show it to someone who has never heard of qrdrop and ask what the four emoji
were for. If they cannot say, the SAS beat is too short — lengthen it and cut
somewhere else. Everything else in this document is a preference; that is the
criterion.
