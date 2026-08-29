# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is unusually complete — protocol, threat model, key derivations, and the
reasoning behind the transport seam are all there, and are not repeated here. Read it
before changing anything in `src/core/` or `src/transport/`. This file covers what the
README does not: the invariants a change can break silently, and where they live.

## Commands

```bash
npm test                                   # unit suite, offline, ~2s
npm run typecheck                          # two tsc invocations; see below
npm run build                              # esbuild -> site/dist/

npm run web                                # build + serve the UI on :4173 (= npm start)
npm run cli -- send report.pdf             # drive the CLI without installing it
mise run web                               # same two, under mise
mise run cli -- receive --out ~/Downloads

node --test test/frame.test.mjs                          # one file
node --test --test-name-pattern="round-trips" test/frame.test.mjs   # one test
```

`localhost` counts as a secure context, so WebCrypto and the camera work against
`npm start` without a certificate.

The e2e suites need a network and public Nostr relays, so they are out of `npm test`
and out of CI:

```bash
npm run test:e2e          # two real browsers over real relays
npm run test:e2e:interop  # two Node processes driving the CLI
```

`mise.toml` mirrors every npm script as a task; either runner works.

## Invariants

Each of these has already been broken once, and most were caught late or by accident.

**`src/core/` and `src/transport/` must not touch DOM or `fs`.** They are typechecked
twice — once under `tsconfig.json` with `types: []` and no Node lib, once under
`tsconfig.node.json` with Node's globals. A stray `Buffer.from` in core passes the second
and fails the first. That double-check is the only thing making "isomorphic" a build
property rather than a comment. Always run both (`npm run typecheck`), never one.

**The two safety gestures cannot be softened.** The sender confirms the SAS before a
manifest goes out (the manifest alone leaks filename and size); the receiver's Accept
click is also the user activation that permits `showSaveFilePicker` to open. Never
auto-advance past either, never auto-focus either button, and keep Accept's handler from
losing its user activation behind an `await`. `--yes` skips the accept prompt and must
never skip the SAS.

**`decodeSecret` accepts the code only from a URL fragment, never the query string.** A
fragment is the one part of a URL never sent to the server, which is the entire reason a
link may carry a decryption key. Accepting `?code=` would silently start leaking secrets
to the host and every proxy in between. The bare `qrdrop:` form must also keep working
forever — CLI↔browser interop depends on it.

**CLI colour helpers must be the identity function when stdout is not a TTY**, or when
`NO_COLOR` is set. `e2e/interop.e2e.mjs` parses stdout with it redirected. stdout and
stderr have independent `isTTY`; `src/cli/style.js` decides per stream.

**The beam player's canvas is never described in vnodes.** `src/web/beam.js`
creates one `<canvas>` and repaints it in place ~10 times a second; the view
`adopt`s it, exactly like the pairing QR's `<svg>` and the scanner's `<video>`.
Describing it in vnodes, or letting `patch()` rebuild it, means a full render of
every screen ten times a second and a canvas that loses its context. For the
same reason `onTick` only calls `_setState` when the *loop counter* changes, not
on every frame — a per-frame `_setState` renders the whole UI at 10 Hz and looks
fine right up until the QR starts stuttering on a slow phone.

**Beam's Accept fires when the manifest decodes, not when the file completes.**
Seconds in, not minutes. The click is the user activation that permits
`showSaveFilePicker`, and a beam transfer runs for minutes afterwards — asking
at the end spends an activation that expired long ago, and the picker silently
refuses to open. Nothing may be `await`ed ahead of `createSink` in that handler.
Beam has no SAS and must not grow a decorative one: there is no peer to
authenticate, and a fake gesture teaches that the real one on the network path
is theatre.

**No new runtime dependencies.** Four, plus one optional. The stated position
(`src/cli.js` header) is that every dependency is one more thing between `npm install`
and a working transfer. The virtual DOM in `src/web/vdom.js` is hand-rolled for this
reason rather than using preact.

## Web UI architecture

The UI is `state → view`, not imperative DOM mutation. Three files, and the split
matters:

- **`src/web/vdom.js`** — `h()` and `patch()`. No `innerHTML` path anywhere, which is
  what keeps peer-supplied filenames inert by construction. Event handlers are *assigned*
  (`el.onclick = fn`), not `addEventListener`'d, because render runs on every progress
  tick and stacked listeners would send one manifest per accumulated handler. The `adopt`
  prop is the escape hatch for real DOM nodes the view does not describe — the QR `<svg>`
  and the scanner `<video>`, whose `MediaStream` a rebuild would destroy.
- **`src/web/view.js`** — pure `render(state, dispatch) -> VNode[]`. **All user-facing
  copy lives here.** No DOM APIs, no room/session objects, no promises. This is the file
  to read to understand the UI.
- **`src/web/element.js`** — only what a pure function cannot hold: rooms, receivers,
  teardown, the `_sessionEnded` flag, and the whole-component native events (drag, drop,
  paste, `location.hash`).

### Traps specific to this design

**`patch()` owns every child of the shadow root.** Anything the view did not describe is
removed as stale. The stylesheet is therefore *adopted* (`adoptedStyleSheets`), not
appended as a `<style>` child — an appended one is deleted by the first render, stripping
the component to unstyled browser defaults while every test still passes, because the
e2e suite reads text and visibility, not paint.

**Screenshot the states when changing the view.** The above class of bug is invisible to
the test suite. Driving `_setState` from Playwright across every screen is how it was
found.

**These ids are a contract with `e2e/transfer.e2e.mjs`**: `#btn-send`, `#screen-send`,
`#manual-code`, `#qr`, `#btn-receive`, `#screen-receive`, `#manual-input`, `#manual-form`,
`#screen-verify`, `#sas`, `#verify-status`, `#screen-done`, `#done-digest`. `#sas` in
particular holds `session.sas` verbatim and is visually hidden and `aria-hidden`; the
visible emoji tiles are separate markup, and the *words* are what assistive tech reads,
since those are what a person says aloud to their peer.

**Design tokens have exactly one home**, `src/web/tokens.js`. `tokensCSS(':host')` feeds
the component; `scripts/build-site.mjs` injects `tokensCSS(':root')` into the site's CSS
at build time. They used to be copy-pasted into two files. Do not reintroduce the second
copy — the same reasoning already governs `buildCSP`, which derives `connect-src` from
`SIGNALING_URLS` rather than a hand-kept list.

CSS lives in `src/web/styles.js` as a JS string, not a `.css` file, because
`exports["./web"]` serves raw ESM and consumers have no build step.

## Code style

The house style is distinctive and worth matching before writing anything: two-space
indent, no semicolons, single quotes, JSDoc types throughout (`checkJs`, no build step).
Comments are long, explain **why**, and name the alternative that was rejected and the
failure it would have caused. A comment that restates the code is worse than none. Read
neighbouring files and match the register.

Commit subjects follow `type(scope): lowercase clause, and a second clause`. Bodies are
prose paragraphs, not bullets, and explain the reasoning and what was measured or ruled
out.

## Known-flaky and known-broken

`npm run test:e2e:interop` fails on most runs, and did so before the UI work — verified
against a clean worktree at `87fb583` (4/4 failures). The file transfers fully and both
sides compute a digest, then the sender reports `The other device disconnected` instead
of receiving the final `done` control frame. It looks like the receiver's `room.close()`
racing the flush of its own control frame, in `src/core/receiver.js` /
`src/transport/room.js`. Do not chase it as a regression from unrelated work.

Both e2e suites also fail for ordinary reasons — a relay being unreachable is expected
weather, not a bug in this code.
