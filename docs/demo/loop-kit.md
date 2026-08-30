# Loop production kit

The shot-side checklist for the silent 10–15 s loop described in
`../demo-brief.md`. This covers what happens with the recorders running; the
post-production procedure is `loop/README.md`.

The loop is **one real transfer**, captured live from both ends at once. The
laptop drives a genuine send with `scripts/demo-session.mjs`; the phone does a
genuine receive off the laptop's screen and screen-records itself doing it. The
two recordings are the same pairing, the same SAS, the same file — they are
married in the edit only because they are two cameras on one event, not two
takes stitched to look like one.

## Before you start

- **Deployed site reachable from the phone.** Open `https://share.stan-ely.com`
  on the phone and confirm the page loads and the camera works there *before*
  setting up. A laptop running `npm start` / `qrdrop web` will not do — it binds
  `127.0.0.1`, and `http://<lan-ip>` is not a secure context, so the phone's
  WebCrypto and camera fail closed (see the brief's "Filming origin").
- **`report.pdf`.** `scripts/demo-session.mjs` writes a real 0.6 kB one to
  `docs/demo/report.pdf` on first run and reuses it after. Small on purpose: the
  transfer screen should be visible for a beat, not outlast the shot.
- **Layout check** at the capture size: `npm run build && node
  scripts/check-layout.mjs`. The script's window is 1600×1000; the check sweeps
  four sizes and exits non-zero on anything clipped.
- **The laptop window is the script's, not yours.** `demo-session.mjs` opens its
  own Chromium at 1600×1000 with a fresh profile — no bookmarks bar, no
  autofill, no extensions. Nothing to clean up there. Do close other windows so
  a notification does not slide in over it while the phone is filming.
- **Phone housekeeping:** Do Not Disturb on (the camera app's "open link"
  notification is the one exception — it is part of the beat), auto-dimming off
  so the screen does not fade mid-take, brightness up, home indicator / clock
  tidy.
- **Camera permission on the phone:** pre-grant it for the loop. The permission
  prompt is honest and belongs in the *film*; the loop has no time to explain a
  dialog.
- **Phone screen recorder:** 1080p minimum, **60 fps**. The screen-entrance and
  step-rail animations judder at 30. The laptop side is captured by Playwright
  at the viewport size (VP8 webm) and re-encoded downstream, so its frame rate
  is not something you set here.

## The run

1. **Start the phone's screen recorder.**
2. **Run the script:** `node scripts/demo-session.mjs`. A browser window opens on
   `share.stan-ely.com`, it clicks "Send a file", attaches `report.pdf`, and a
   QR appears on the send screen. The script prints `>>> QR is up. Scan it with
   the phone now. <<<` and waits (up to 5 min — not a clock, just a ceiling).
3. **Phone:** open the **native camera app** — not qrdrop, it is not open yet —
   and point it at the laptop's QR. Tap the notification; `share.stan-ely.com`
   opens and starts joining.
4. **Both screens** land on the verify screen: heading "Check both devices show
   the same symbols", then **four tiles, an emoji over a word each**. A path
   badge ("Local network" / "Relayed") and a small toast arrive a beat later —
   let them, the pause is real. The script prints the four words it sees and
   holds ~10 s. Confirm by eye that the phone shows the same four.
5. **Script clicks "They match — send report.pdf" on the laptop.** Now **tap
   Accept on the phone.** (The phone's Accept is also the user activation that
   lets the OS save dialog open, on Chromium — decide whether that dialog is in
   your phone recording.)
6. **Both screens** run the transfer bar, then land on the done screen with
   `report.pdf` shown. The script holds ~3.5 s, saves
   `docs/demo/loop/laptop.webm`, and exits.
7. **Stop the phone recorder.** Copy the phone file off the device.

If a run fumbles, just run the script again — a fresh code, a fresh QR. Ctrl+C
mid-run still saves whatever was captured.

## If there is no relay, no phone, or no second person

`scripts/record-walkthrough.mjs` is the fallback: it drives the same `<qr-drop>`
through the same screens with `_setState` on a fixed clock, against local
`site/dist/`, and writes `docs/demo/loop/walkthrough.webm`. No pairing, no
timing luck, fully retakeable — but it is the sender screen only, so it cannot
carry the "it arrived on the phone" beat that is the whole point of the loop.
Use it to rehearse the edit or to stand in for the laptop track; do not ship a
loop that never shows a real phone.

## Take log

| Take | Time | Phone recorder fps | SAS words seen | Notes | Keep? |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

## What "done" looks like

Hand the keeper pair — `laptop.webm` plus the phone file — to the post step in
`loop/README.md`. The bar for the finished loop:

- Reads at thumbnail size, silent, with no caption.
- A stranger watching once can say a file went from the laptop to the phone.
- The loop seam is not visible on repeat.
- `report.pdf` is legible on both done screens.
