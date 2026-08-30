# Loop — post-production

Turning the keeper pair (`../loop-kit.md`) into the silent, looping clip the
README, the npm page, and the site carry. Two inputs, both from **one real
transfer**:

- `laptop.webm` — the sender screen, Playwright's page capture from
  `scripts/demo-session.mjs`. Clean, landscape, no window chrome.
- the phone file — a screen recording of the phone completing the same receive,
  off the laptop's screen. Call it `phone.mov` below.

Two tools, both already installed, neither in `package.json` or CI — the same
standing as `scripts/make-*.mjs`: hand-run, output committed.

## 1. Trim — `ffmpeg`

No non-linear editor. Cut each input to the shared span — the moment the QR is
up through a beat past both done screens — so they start and end together.
Because they are one event filmed twice, the sync is a matter of lining up a
landmark (the verify screen appearing, the transfer bar starting) and trimming
to it, not retiming.

```bash
# Put -ss/-to before -i for fast seeking; re-encode (not -c copy) so the cut is
# frame-accurate. Adjust the timestamps against the actual recordings.
ffmpeg -ss 00:00:02.0 -to 00:00:14.5 -i laptop.webm \
  -c:v libx264 -crf 18 -preset slow -an laptop-trim.mp4

ffmpeg -ss 00:00:03.2 -to 00:00:15.7 -i phone.mov \
  -c:v libx264 -crf 18 -preset slow -an phone-trim.mp4

# Optional grade on the phone footage only, if the room light needs it.
ffmpeg -i phone-trim.mp4 -vf "eq=brightness=0.03:contrast=1.05:saturation=1.02" \
  -c:v libx264 -crf 18 -preset slow -an phone-trim-graded.mp4
```

`-an` drops audio — the loop has none. Keep the phone's frame rate (60 fps);
don't let ffmpeg resample it.

Anything more than exposure — the phone footage looks flat, dark, "boring", or
wants a camcorder/print look — is `media-use` territory, not a hand-written
`-vf`: invoke `/media-use` and treat it as media intent.

## 2. Compose and render — HyperFrames

The front door is `/hyperframes`; let its intent layer route. This is real
live-action of two devices, so it lands in **`/general-video`** (a freeform
build), not `/motion-graphics` (invented motion, no live subject).

The composition is small:

- `laptop-trim.mp4` as a placed `<video>`, full-frame.
- `phone-trim.mp4` as a second placed `<video>`, a phone-shaped inset in a lower
  corner (or a side panel on a wide crop). It is the smaller element — the
  laptop is the stage, the phone is the payoff.
- A short crossfade from the last held frame back to the head so the loop point
  is invisible on repeat. This is what **`seam-craft`** is for; read it before
  assembling the seam. The stage ground must be opaque or the dip flashes
  through (`seam-craft`'s white-flash guard).
- Optionally a small, static `qrdrop` wordmark in one corner — a persistent
  brand bug, **not** a caption. Nothing on this clip explains anything; if it
  needs words it is the wrong ten seconds (see `../demo-brief.md`).

Build, gate, preview, then render only after the preview is approved:

```bash
npx hyperframes lint
npx hyperframes check --snapshots
npx hyperframes preview --background      # eyeball the seam on loop
npx hyperframes render --quality high --output renders/loop.mp4
```

Verify the output exists, is non-empty, and is ~10–15 s:

```bash
test -s renders/loop.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 renders/loop.mp4
```

## 3. Output set

From `renders/loop.mp4`, produce the three files the site and docs reference:

```bash
# H.264 for the site and most browsers
ffmpeg -i renders/loop.mp4 -c:v libx264 -crf 20 -preset slow -movflags +faststart \
  -an ../../../site/loop.mp4

# VP9 for a smaller alternative source
ffmpeg -i renders/loop.mp4 -c:v libvpx-vp9 -crf 33 -b:v 0 -an ../../../site/loop.webm

# First-frame poster — the npm fallback (npm renders no video) and the <video> poster
ffmpeg -i renders/loop.mp4 -vframes 1 ../loop.poster.png
```

Commit `site/loop.mp4`, `site/loop.webm`, and `docs/loop.poster.png`. Keep the
HyperFrames project (`videos/<name>/` or wherever `/general-video` scaffolds it)
out of git unless it is small — a `.gitignore` entry for it is fine; what has to
be committed is the three outputs above.

## 4. Wire it in

Not done here yet — do it once the three files exist, so the repo never
references a missing video.

- **Site** — `site/index.html`, styled in `site/styles.css`:

  ```html
  <video autoplay muted loop playsinline poster="/loop.poster.png">
    <source src="/loop.webm" type="video/webm">
    <source src="/loop.mp4" type="video/mp4">
  </video>
  ```

  Same-origin, so the CSP already allows it: `buildCSP` in
  `scripts/build-site.mjs` emits `media-src 'self' blob: mediastream:` and
  `default-src 'self'`. Confirm `img-src` covers the poster; no `site/_headers`
  change is needed.

- **README** — a committed `<video>` file reference is unreliable on github.com.
  Either upload `site/loop.mp4` to a PR to get a
  `github.com/user-attachments/assets/…` URL and use it in a `<video>` tag with
  `poster="docs/loop.poster.png"`, or add `docs/loop.gif` (an extra
  `ffmpeg` output) and use a plain `<img>`. The npm render falls back to the
  poster either way.

- **npm** — leave `package.json` `files` unchanged. The loop does not ship in
  the tarball; the npm page shows `docs/loop.poster.png`, which is already under
  a published path.

## Not YouTube

The loop is chromeless, silent, and inline. A YouTube embed brings a player UI,
branding, and related-video chrome and cannot sit at the top of a README or
behind the site hero. Self-host it, per above. YouTube is for the 60–90 s film,
which is a separate artefact.
