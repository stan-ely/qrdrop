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

npm start                                  # build + serve site/dist/ flat on :4173 (deploy preview)
npm run web                                # build, then `qrdrop web`: serves the bundle, opens a browser
npm run cli -- send report.pdf             # drive the CLI without installing it
mise run web                               # same as npm run web, under mise (mise run web -- --no-open to pass args)
mise run cli -- receive --out ~/Downloads

node --test test/frame.test.mjs                          # one file
node --test --test-name-pattern="round-trips" test/frame.test.mjs   # one test
```

Three image generators, all hand-run and none of them in `npm run build` — that
runs in CI and in `prepublishOnly`, where downloading a browser is not
acceptable. Their output is committed; run the relevant one when the palette,
the card copy, or a diagram source changes:

```bash
node scripts/make-og.mjs                                 # site/og.png, the social card
node scripts/make-diagrams.mjs                           # docs/diagrams/*.png from the .mmd sources
npm run build && node scripts/make-screenshots.mjs       # docs/screenshots/*.png
```

`make-screenshots.mjs` produces the README's pictures and **only** those: three
screens, at one 760px-wide viewport. This file used to claim it drove `_setState`
"across all of them", and that claim is how `beam-receive` went unphotographed at
any size until a tester found its Accept button 99px below the fold on a phone.

Seeing every screen is `check-layout.mjs`'s job, and it is a check rather than an
image generator — it walks all of them at four viewport sizes and exits non-zero
on a page that scrolls or a button outside the viewport, writing a picture of
each failure to `docs/screenshots/layout/` (gitignored):

```bash
npx playwright install firefox        # one-time; only chromium ships by default
npm run build && node scripts/check-layout.mjs
```

It runs **both** engines, and the second one earns its place: everything this script used
to assert was an overflow or a position, and engines rarely disagree about those. They
disagree about *sizing*, which is why it also asserts that `.qr` / `.beam-stage` is
actually square. That assertion found a real one immediately — 352x306 at 1280x620, in
both engines, because the wide-layout branch pinned `inline-size: 100%` while
`.card-media` (`flex: 1 100 auto`) went on squeezing the block axis. `preserveAspectRatio`
pins the code into a corner of a box that is not square, so the difference pays out as a
white band beside the QR.

Run it after anything that touches `src/web/view.js`, `src/web/styles.js`, or the
site's page chrome. The fixtures both scripts drive are shared, in
`scripts/screen-states.mjs`, so a new screen gets added once and both see it. If
a screenshot comes out wrong, that is the finding.

`localhost` counts as a secure context, so WebCrypto and the camera work against
`npm start` without a certificate. The same is true of `127.0.0.1`, which is what
the `qrdrop web` subcommand (`src/cli.js` → `src/node/serve.js`) binds and prints
— it serves the prebuilt `site/dist/`, which now ships in the npm tarball
(`package.json` `files`). `npm run build` regenerates that directory; a stale one
in a working copy is exactly what `npm run web` (build + `qrdrop web`) or a bare
`node src/cli.js web` will serve. `prepublishOnly` rebuilds it so a hand-run
`npm publish` matches what CI ships. esbuild stays a devDependency — the bundle
is built before packing, never at `npx` time.

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

**Authenticate, then trust.** The ordering, type and `fileSeq` checks in `src/core/frame.js`
run **after** `crypto.subtle.decrypt`, never before. The header is the AAD and the nonce is
derived from it, so the tag already proves everything those comparisons could; running them
first bought a few microseconds of skipped decryption and cost a denial of service. Anyone
who could get one packet into the rendezvous room — no code, no pairing, never holding a key
— could end a live transfer with fourteen bytes of well-formed cleartext, and the receiver
would abort its sink and throw the partial file away. It was reported from the field as
`Out-of-order frame: expected 0, got 13877` on a sub-1 MB transfer that only ever had ~64
chunks in it. A frame that fails its tag is now dropped and counted (`receiver.dropped`),
never fatal; a frame that passes and is *still* out of order is our own peer contradicting
itself and stays fatal. Do not add a "give up after N drops" threshold — that hands the
same DoS back.

**Inbound frames are filtered by the paired `peerId`, exactly as outbound ones are targeted.**
`src/transport/channel.js` has always sent to one peer, and its comment names the reason: a
third party holding the code can be in the room. `src/transport/room.js` accepted from
anyone, which made that targeting a courtesy rather than a boundary. Both halves or neither.
`test/room.test.mjs` joins a third member to the topic and asserts it never reaches the
frame handler.

**The two safety gestures cannot be softened.** The sender confirms the SAS before a
manifest goes out (the manifest alone leaks filename and size); the receiver's Accept
click is also the user activation that permits `showSaveFilePicker` to open. Never
auto-advance past either, never auto-focus either button, and keep Accept's handler from
losing its user activation behind an `await`. `--yes` skips the accept prompt and must
never skip the SAS.

**The ECDH keypair is generated per `joinVia` call and never cached.** `src/transport/room.js`
is the only place `createEphemeralKeypair()` is called, and its result must stay a local.
`openRoom` races two strategies, so one pairing generates two keypairs and discards one —
hoisting the call to module scope to save that looks like an obvious win and silently
costs forward secrecy, which is the only reason there is an ECDH at all. `test/room.test.mjs`
pairs twice over one secret against an in-memory fake strategy and asserts the sessions
cannot open each other; nothing else in the suite notices.

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
found. `node scripts/check-layout.mjs` is that, automated.

**The layout is fixed-height and the page never scrolls.** The page owns the viewport
(`site/styles.css`: `body` is `100dvh`, `main` is an auto/1fr/auto grid) and the
component fills the row it is given — `:host` is `block-size: 100%`, never `100dvh`,
or it would overflow by exactly the height of the page chrome above it. Every screen
builder returns `{ body, actions }`: the body may scroll as a last resort, the action
bar never does. There is nowhere else for a button to go, which is the point.

**Anywhere a rule sets `display`, check what it just un-hid.** An author `display` beats
the UA stylesheet's `display: none` for both `[hidden]` and a closed `<dialog>`, and this
bit three times in one sitting — `.card` laid out all eight screens at once (a 4300px
page), and `.sheet` rendered both closed dialogs in flow. `.card[hidden]` and
`.sheet[open]` say the hiding again. Related: a host-page rule always beats `:host` for
the same property, regardless of specificity, which is why `site/styles.css` no longer
sets `display` on `qr-drop`.

**Long copy goes in a sheet, not on the screen.** The component owns one `<dialog>`
(`element.js`, adopted by the view) whose contents are patched as a *separate* root —
`patch()` stops at an adopted node and never descends into it. Its heading takes
`autofocus`, because `showModal()` would otherwise focus the first control, and on the
beam sheet that is Accept: a stray Enter would accept a file. Same rule, same reason as
`_focusScreenHeading`.

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
