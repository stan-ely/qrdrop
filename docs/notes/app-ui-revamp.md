# The app UI revamp

Planned 2026-11-02. This file is the plan and its tracking document: a session that works on it
starts by reading **Status** and ends by updating it. When a phase ships, behaviour that a future
change could break moves into CLAUDE.md, the way the LAN path's rules did.

## Status

| Phase | State | Depends on | Device needed | Notes |
|---|---|---|---|---|
| 1. Close the native gaps; start this note | built | none | no | text both ways and the QUIC badge on the native session; see "Phase 1: as built" |
| 2. App shell, Home, Settings, About | not started | 1 | Android recommended | |
| 3. Screen redesign, shared with the site | not started | 2 | no | show the user the direction before implementing |
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
