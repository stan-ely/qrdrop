# The app UI revamp

Planned 2026-11-02. This file is the plan and its tracking document: a session that works on it
starts by reading **Status** and ends by updating it. When a phase ships, behaviour that a future
change could break moves into CLAUDE.md, the way the LAN path's rules did.

## Status

| Phase | State | Depends on | Device needed | Notes |
|---|---|---|---|---|
| 1. Close the native gaps; start this note | built | none | no | text both ways and the QUIC badge on the native session; see "Phase 1: as built" |
| 2. App shell, Home, Settings, About | built | 1 | Android recommended | see "Phase 2: as built" |
| 3. Screen redesign, shared with the site | built | 2 | no | direction approved 2026-11-03; see "Phase 3: as built". Not yet seen on a phone |
| 4. History | not started | 2 | Android recommended | |
| 5. Platform polish | not started | 3, 4 | yes | |
| 6. Offline-pairing UI | blocked | 3 and offline pairing phase C | yes | phases B and C of `offline-pairing.md` are unbuilt, and this copy must not ship before the feature works |

Phases 3 and 4 can run in either order. Each runs in a fresh session.

## The problem

The native apps load the website's page: `scripts/build-site.mjs` reads `site/index.html` for every
channel, so the app shows a masthead, tagline, build stamp, a Source and Feedback footer, and a
floating card. That is why it reads as a web page. Recent work also left gaps in the UI: received
text was only shown on the JS session, the QUIC event was dropped, and offline pairing has no states
yet.

## Decisions

Made with the user:

| Topic | Decision |
|---|---|
| Platforms | Android, Windows, macOS and Linux desktop. iOS is not a target. |
| Approach | App-shaped in the Tauri webview, one qrdrop look on every platform |
| Website | Shared screens and copy, a separate app shell; the site keeps its chrome and gets the visual refresh |
| Scope | Restyle plus the review's gaps, plus app structure: History and Settings |
| Navigation | Home with a top bar (History and Settings icons), hidden while a session runs |
| History | App only, on by default, with an off switch and Clear history. Stores filename, size, direction, date, route, outcome, saved location. Never codes, keys or text content |

**No framework.** The look comes from the shell and the CSS, not the renderer. `vdom.js` already
gives `state -> view`, `exports["./web"]` serves raw ESM with no build step, and the root package has
a no-new-dependencies invariant. Preact or a component library would be a rewrite of `view.js` for no
visible gain.

Made for the plan, open to change:

- Keep the terracotta accent. No Material You dynamic colour.
- The theme follows the system, with no in-app switch, because the palette keys on
  `prefers-color-scheme`.
- App-only code lives in `app/src/`, so none of it reaches the website or the npm tarball.
- History is stored by the Rust shell, not in `localStorage`, because webview storage can vanish.

## Architecture

- **Template:** `app/index.html`, chosen by `build-site.mjs` on the `app` channel, with no website
  chrome.
- **Shell:** `app/src/shell.js` (state and pages) and `app/src/app-view.js` (pure render, built on
  `src/web/vdom.js`) own the top bar, Settings, About and History, and wrap `<qr-drop>`.
- **Seam out of the component:** `element.js` dispatches `screenchange` (`{ screen, running }`, from
  `RUNNING_SCREENS`) and `transferend` (the History record). It knows nothing about the shell.
- **App styling of the screens:** a `shell="app"` attribute, styled with `:host([shell="app"])` in
  `src/web/styles.js`. It is the same vnode tree on both, so the position-based `canReuse` is
  unaffected.
- **CLAUDE.md change:** "all user-facing copy lives in `view.js`" gains one exception, `app-view.js`
  for app-only pages. It needs the same rules: pure, no `innerHTML`.

## Rules every phase keeps

- SAS and Accept stay as they are: no auto-advance, no auto-focus, no re-pair control on verify,
  nothing awaited ahead of `createSink`.
- Navigation cannot be reached on a running screen, and Back never moves between session screens.
- Peer filenames stay text nodes. Adopted nodes (QR svg, video, canvas) keep their tree position.
- `check-layout.mjs` passes on both engines and every deployed tree, and the screenshots get looked
  at.
- New hand edits under `gen/` get a row in CLAUDE.md's table.

## Phase 3: proposed direction

Written 2026-11-02 from every fixture photographed in light mode on the site and app trees, at
390x844 touch and 1280x720 mouse, before any code changed. Nothing here is built yet.

**What the pictures show.** Six faults, and each one repeats across screens.

- The heading is the weakest thing on the screen. It is 18px, under the media on a phone, so
  `verify` asks its question below the thing it is asking about.
- The two most important moments are the smallest. The SAS tiles sit at about 80x60 with 200px of
  white above them. `transfer`'s 54% is 30px in a screen that is otherwise empty.
- Everything secondary is 13px muted text, and a ghost button looks like a line of that text. On
  desktop `choose` is four controls in one row, two of them reading as plain words.
- The rail reads as a status light: green and terracotta side by side, on a card that has no other
  green or red meaning at that moment.
- `verify-accept` has three exits and they wrap badly: Accept, then Decline and Cancel at different
  heights. `verify` is three rows of buttons on a phone.
- `done` splits one thought in two: a pale banner carrying the sentence, and the heading ~120px
  below it. `done-failed` is worse, with the whole card between them.
- Beam has the same faults, and a few of its own. On `beam` the media slot stretches, which leaves
  about 80px of nothing between "Tap the code to enlarge it" and the heading, and the heading still
  sits under the code. Speed is a raw native `<select>` with a 13px readout under it, and Stop, the
  only button, is ghost text. On `beam-receive` a person holds the phone up for minutes watching a
  6px bar and a 13px line, under a viewfinder twice as tall as it is wide.
- Text has no screens of its own: it is the compose sheet over `choose`, then `verify` and
  `transfer` exactly as a file, then `done`. Both ends of that need work. The compose sheet's box is
  six rows on a phone with the rest of the sheet's height unused, and its note repeats what `verify`
  will show. On `done-text` the message comes first with nothing to say what it is, and the
  heading, "Nothing was saved", Save as file, the path badge and the digest are stacked between it
  and Copy. The restart reads "Receive another file" after a message, where the sender's already
  reads "Send something else".

Two things are simply broken. `receive-no-camera` and `beam-receive-no-camera` draw `--muted` on
`--scan-bg`, about 3:1, in a frame the size of a camera that is not there. And the no-camera frame
takes the room from the form that is the only way through.

**The direction: one question per screen, asked at the top and answered by one large thing.**

1. *Structure.* The heading leaves `.card-copy` and becomes a slot the frame draws (`title`, on the
   same enforced-shape argument as the Details button). It goes above the media on a stacked
   layout, and beside it at the top of the copy column on the wide and flat branches. `transfer` and
   `done` put it below their hero with `order`, because there the hero is the answer and the
   heading its caption.
2. *Type.* Headings go to 22px at weight 700, tightened, and hold that on a phone. A new `--fs-4`
   (2.75rem) for `transfer`'s number. Notes and status go from 13px to 14px through a new token, so
   the site chrome that shares `--fs--1` does not move. No web font: the CSP and the install stay
   as they are.
3. *Colour.* The accent means "the one thing to press" and "how far along", and nothing else. The
   rail becomes accent-filled up to the current step on `--line`. Green and red are for outcomes
   only, which is what makes them mean something when they arrive: the outcome becomes a solid disc
   with a glyph on it, needing a new `--on-status` token. Every new pair gets measured in both
   palettes and the number goes in `tokens.js`.
4. *Buttons.* Three weights, named: `primary` (filled, one per screen), a tonal secondary (replacing
   the outlined `.btn`), and `ghost` for exits, which gains enough presence to look pressable.
   `.danger` stays outlined.
5. *Less copy.* `send` loses the camera sentence's second half and folds its bar and status into one
   line. `verify` says "If they differ, stop." and the path sentence goes behind nothing, since it
   is already gone on a phone. `receive`'s status becomes a caption inside the camera frame, where
   it is said once rather than beside a heading saying the same. This is what pays for the larger
   type, and it is the route to closing send's and verify's overflow at 800x360, so the
   `copyScroll` budget should fall from 28, not grow.
6. *Fewer exits.* Once there is an offer, `verify` drops Cancel: Decline already is the way out, and
   it tells the sender. The sender keeps one primary on its own row and "They don't match" beside
   Cancel on the next. The primary still names the file, truncated.
7. *Sheets.* On a coarse pointer: a drag handle, slide up and slide down, a backdrop that fades, and
   drag or backdrop tap to dismiss, in `element.js` since a view cannot hold a gesture. Dismissing is
   what Escape already does, so no sheet gains a way past a safety gesture. The compose sheet ignores
   a backdrop tap while its box has text, so a stray tap cannot lose a message. On a mouse they stay
   centred and fade. `@starting-style` and `allow-discrete` carry the exit, with a plain cut wherever
   an engine lacks them.
8. *Motion.* Each transition says something: the heading and hero rise on a new screen, the SAS
   tiles arrive in sequence, the outcome disc scales in once, a sheet comes from the edge it returns
   to. Nothing loops but a wait. Under reduced motion all of it cuts, and state still reads from
   colour and text.
9. *`choose`.* The dropzone fills its column on a mouse too. Send is primary, Receive is tonal, and
   Send text and No network? drop to a quiet second row.
10. *Beam.* Both ends get the title slot, so the instruction comes first and the code or camera
    under it. On `beam` the code takes the slot's full width with its caption directly under it, and
    the gap goes away. The filename and the Not encrypted tag go on one line, and the keep-showing
    callout follows. Speed becomes a segmented control of `FPS_CHOICES` (5, 10, 15, 20) with "Shown
    2× · 30 s a pass" beside it. These are still real radio inputs in `controls`, so the flat branch
    places them as before. Stop becomes the tonal secondary: it ends something running, and nothing
    here is the primary. On `beam-receive` the viewfinder is capped square-ish, which is the tall
    viewfinder follow-up, and the progress gets `transfer`'s treatment: the percentage at `--fs-4`,
    a thicker bar, and the time left as its caption. Review file stays the one primary. Both beam
    sheets get the bottom-sheet behaviour in point 7. `BEAM_WARNING` stays the danger callout at the
    top, Start beaming or Accept is the primary, and Cancel or Decline is secondary. The enlarged
    overlay is unchanged.
11. *Text.* The compose sheet's box grows to the height the sheet has, staying above the keyboard
    where `dvh` allows. Its note shortens to "You will both check four symbols before it is sent."
    The backdrop-tap guard in point 7 is the one exception to dismissal. On `done-text` the title
    slot puts "Message received" above the message, with a small solid check beside it, so the disc
    is not spent on a screen whose subject is the text. The message takes the slack. Copy stays the
    one primary. Save as file stays out of the bar, where a third button wrapped it at 800x360. It
    becomes a small tonal button on the box's caption row, beside "Nothing was saved to this
    device", which is the sentence it answers. The path badge and digest drop to one quiet row. The receiver's restart becomes "Receive something else" to
    match the sender's. `#done-text` and `btn-copy-text` are unchanged. A sent message takes the
    ordinary `done` treatment.

**Kept as they are:** every id in CLAUDE.md's contract, `#sas` verbatim, the QR and beam surfaces, the
scan tokens, the 2x2 SAS grid, `BEAM_WARNING`'s words and where it is said, the keep-showing callout,
Accept's no-await rule, and the vnode shape across pointer and orientation.

**`check-layout.mjs` has to change once.** It measures one frame after a state lands, and a sheet
sliding up is off-screen then, so it waits for finite animations first, as
`make-store-screenshots.mjs` already does.

**Phase 2's follow-ups taken here:** the disclosure's website-only wording, the `fastlane/`
screenshots, and how the tall viewfinder looks.

## Phase 3: as built

Built 2026-11-03 in five commits: tokens and weights, the title slot, the screens, beam, then
sheets and motion. CLAUDE.md now has the rules (the title slot, one primary per screen, no
copyScroll budget, and how sheets close). This section records what they do not say.

**The scroll budget fell to copy, not to CSS.** Every landscape overflow left the same way.
The screen's question moved into the heading the frame draws, the explanation moved behind
Details, and a bar that wrapped lost a button that repeated another one (the receiver's
Cancel beside Decline, and Save as file moved next to the sentence it answers). Rearranging
the grid bought a few pixels each time and nothing more.

**Beam's media slot hugs its code on a stacked layout, and that cost three tries.** In portrait
the code is bounded by the slot's width, so a slot that took the card's slack only centred a
square in a taller box: 80px of nothing between the caption and the filename. Hugging alone
fixed that, but made the slot rigid, so the copy scrolled 8px at 390x844. Adding
`min-block-size: 0` brought that to 3px, because the copy, with a shrink factor of 1 like the
slot, took half the loss. The slot needs the default media slot's 100 as well. The
keep-showing line was cut to "Keep this on screen until it is done." so it fits on one line.

**The speed picker is four radios, not a `<select>`.** A sender changes rate when the other
camera struggles, sometimes twice, and a select hides the choices behind the platform's
picker. Its label is hidden on a landscape phone, and the unit is in the readout.

**A closing sheet is still on screen.** Once the exit animation existed, patching the dialog
to nothing at close slid out an empty box. `_render` now patches the dialog only while a
sheet is wanted.

**What is not verified.** Every picture is from Playwright, in Chromium and Firefox. The
drag-to-dismiss, the sheet's rise and the compose box above a real keyboard have not been seen
on a phone. Safari and WebView2 have not run the `@starting-style` entrance. Without it the
sheet still appears, just with no motion.

## Phase 2: as built

CLAUDE.md has the rules, under "The app has its own page". What is recorded here is what they
do not say.

**The copy is lifted at build time, because the site template could not move.** The obvious
home for shared words is a JS module both pages import, and that rewrites `site/index.html`,
which had to stay byte-identical and whose copy reads with no script running. So
`infoCopy` reads the site's markup and `app/index.html` carries it in a `<template>`.

**Back took three shapes.** The first draft pushed one entry per page and read the page out of
`history.state`. A deep link arriving on About left two stale entries behind the sentinel, and
when the session ended the top one said "about", so the done screen was replaced by a page
nobody had asked for. The second had one entry, with Back from About re-pushing it from
`popstate`. Every desktop and Playwright run passed, and on the emulator a second press went
to the launcher. This note and `e9acf63` blamed a window before the push landed, and that was
wrong: see "A second Back" below. The third is one entry per page with the page held in state,
which fixes both. See the header of `shell.js`.

**A second Back closed the app at any speed, not just a quick one.** The guard re-pushes from
`popstate` with no user activation, and after a native `goBack()` a log in `MainActivity` read
index 2 of 3 and `canGoBack=false`, 1.9 s after the push. That looks like Chromium's history
manipulation intervention, though only the symptom was measured. Three readings were wrong
before that log. Slow presses seemed to work only because Playwright's `evaluate` carries a user
gesture, so reading the page between presses hid the bug; a spare entry alone changed nothing;
and `goBackOrForward(-1)` changed nothing. The app now reads the back/forward list and runs
`history.back()` in the page (`MainActivity.onWebViewCreate`), and `canGoBack` stayed true
throughout. Six double presses at gaps from 0 to 900 ms cancelled the session with the app
alive, where the same script closed it six times out of six. The spare entry is kept for the
real window before the re-push lands, 30 to 100 ms here. The site has no such callback, and how
a browser's own Back button treats a second press there has not been measured.

**`transferend` exists with nobody listening.** It is here because the plan puts the seam in
this phase and it is cheap to pin what the record leaves out. Phase 4 is where it is first
read, and the record's fields can change then: a failed transfer has cleared `file` by the
time it reaches done, so its record has no name.

**`plugin-opener` is a new app dependency, which the plan did not list.** The site's links
are `target="_blank"`, which a webview has nowhere to send. The npm package must stay on the
crate's minor version or `tauri build` refuses, and that refusal is easy to miss:
`app-native` will happily run the previous binary.

**Follow-ups for later phases.**

- The disclosure says "this page serves a bundle" and "the server hosting it", which is the
  website's situation. In the app the code is in the install. The copy is shared by decision,
  so changing it is a change to the site's page; phase 3 touches both and is the place.
- The store screenshots in `fastlane/` still show the website chrome. They are not regenerated
  here, because phase 3 restyles the same screens and they would change again.
- A viewfinder in a full-bleed window is taller than it is wide (`.scanner-frame` has no
  square assertion). It works; phase 3 owns how it looks.
- Settings has one setting. History's off switch and Clear history join it in phase 4.
- The strip under the navigation bar is the window's white rather than `--bg`, now that
  `clearNavigationBar` pads the content view. Phase 5's. It hides nothing.

**Measured on an emulator, not a phone.** No phone was attached, so everything Android here ran
on one API 29 emulator with WebView 158 and three-button navigation. Settings showed
`Download/qrdrop` and Change folder, the Source link opened Chrome and came back to About, the
bar was hidden in a session, and landscape fit. What that cannot show is whether a newer
device's WebView reports the navigation bar, which is why `clearNavigationBar` consumes it, or
how a gesture-navigation phone looks.

## Phase 1: as built

**Text on the native session.** The rule stays in one place. `offer` now carries `mime`, the page
applies `isText`, and Accept sends either `accept` or the new word `acceptText`. Rust has no copy of
the rule and no copy of the 64 KiB limit. Its `TextSink` bounds the bytes at the size the offer was
accepted at, as `createTextSink` does.

Text cannot reach the page before its digest, by construction rather than by care.
`handle_complete` compares the digest before it raises `Event::Complete`, which is what closes a
sink. `TextSink::close` is the only thing that fills the slot `drive` reads, and `received` is
emitted after that. Nothing opens a file for text, so nothing can be left behind.

`decode_text` matches `new TextDecoder('utf-8')`: U+FFFD for invalid bytes, and a leading byte order
mark dropped, which `String::from_utf8_lossy` alone would keep.

**Send text.** A new command, `native_send_text`, takes the text, and `TextSource` reads it from
memory. A temporary file to get a path was the alternative, and it would put a pasted password on
disk. Both commands go through `start_send` and `run_send`, so the fresh secret and the wait for
Confirm are shared rather than repeated. The page passes the name and type, so they are spelled only
in `text.js`. `_sendText` goes native whenever a session is registered, which includes Android on the
`qrdrop:native-session` override, even though a picked file keeps the JS session there.

**A file sent natively is never shown as text.** A native `FileSource` has no type, so it goes out
as `application/octet-stream`, and the receiver saves it. Only a typed message takes the text road
from a native sender. Both ends agree, so this is a gap and not a bug.

**QUIC on the badge.** `quic` is a separate state beside `lan`, and `lan` wins, because the session
prefers the LAN. It takes the `direct` colour and keeps the metered warning. `QUIC_PATH` claims only
that no relay is involved, since a QUIC link can cross the internet and nothing at this layer knows
which addresses it settled on. The app is still built without the `quic` feature, so **the event has
never fired in a shipped build**: the view test covers the badge, the `native.rs` test covers the
event's name, and no run has shown the two joined.

**The e2e's text leg needs its own peer.** Neither CLI offers `text/plain`, so
`e2e/send-text-peer.mjs` is the JS core sending what the compose sheet sends.

**Follow-ups for later phases.** None of these block phase 2.

- `app/CHANGELOG.md`'s 1.3.0 entry still says "Not yet on Linux", because it describes what shipped
  in 1.3.0. The Unreleased entry supersedes it.
- Send text and Show text on Linux have been checked on Windows with the native session forced on,
  not on a Linux machine. Phase 5 runs Linux if one is available.
