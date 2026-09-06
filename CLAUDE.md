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
npm run build                              # esbuild -> site/dist/ (the stable tree)
node scripts/build-site.mjs --channel edge --out site/dist-edge   # the other deployed tree

npm start                                  # build + serve site/dist/ flat on :4173 (deploy preview)
npm run web                                # build, then `qrdrop web`: serves the bundle, opens a browser
npm run cli -- send report.pdf             # drive the CLI without installing it
mise run web                               # same as npm run web, under mise (mise run web -- --no-open to pass args)
mise run cli -- receive --out ~/Downloads
mise watch build                           # rebuild site/dist/ on every change under src/ or scripts/ (mise run app:dev does not)

node --test test/frame.test.mjs                          # one file
node --test --test-name-pattern="round-trips" test/frame.test.mjs   # one test
```

Three image generators, all hand-run and none of them in `npm run build` — that
runs in CI and in `prepublishOnly`, where downloading a browser is not
acceptable. Their output is committed; run the relevant one when the palette,
the card copy, or a diagram source changes:

```bash
node scripts/make-og.mjs                                 # site/og.png, the social card       (mise run img:og)
node scripts/make-diagrams.mjs                           # docs/diagrams/*.png from the .mmd sources (mise run img:diagrams)
npm run build && node scripts/make-screenshots.mjs       # docs/screenshots/*.png              (mise run img:screenshots, which builds first)
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
npm run build && node scripts/check-layout.mjs           # or: mise run check:layout (builds first)
node scripts/check-layout.mjs site/dist-edge   # the edge tree, built as above; or: mise run check:layout site/dist-edge
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
site's page chrome, **and run it against both deployed trees** — they differ in the
build stamp, and the page chrome is where this layout has no vertical slack.

The stamp sits beside the wordmark (`.masthead`), and that is a layout decision as
much as an editorial one: the h1's line box is already taller than `--fs--1` text, so
a stamp on it costs 3px, where the same two links in the footer's `.meta` row wrapped
it onto a second line at 390px and a fixed-height grid pays for that out of the card —
`beam.phone` scrolled internally by 21px in both engines. `.masthead` is
`flex-wrap: nowrap` for exactly that reason. Do not let it wrap.

Two findings from the three attempts it took are worth more than the CSS. The first:
the stamp shipped once with the cross-link's label clipped to sr-only, on the theory
that a shorter row bought back the wrapped line. It does not — `.meta` measured 68px
with the label or without — and the clip cost the link its only visible cue, since the
icon beside it was `aria-hidden` like every other icon in that row. On a phone it read
as a bare shield glyph parked beside the byline, and **this script cannot see that**: a
link with no accessible name overflows nothing. Layout being legal is not layout being
right; look at the screenshots.

The second: the fix for that made both of them full pills, which was the wrong register
before it was in the wrong place. The links in `.meta` are navigation; a build stamp is
a readout, and it now has no icon and no pill — just muted text and a hairline divider.
Weight and placement are design decisions this script has no opinion about either.
The fixtures both scripts drive are shared, in
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

## Deploying

The site is **two builds of this repo served from one Pages artifact**: the latest
`v*` tag at `/`, the tip of `main` at `/edge/`. `.github/workflows/pages.yml` builds
both — edge from the checkout it starts on, then `git checkout --detach <tag>` plus a
fresh `npm ci` for stable — and uploads them together. Each page therefore runs
exactly the code of the ref it names; there is no tree mixing one ref's `scripts/`
with another's `src/`.

**The order of those two builds is load-bearing.** Only the checkout on `main` has a
`build-site.mjs` that understands `--channel` and `--out`, so edge must be built and
set aside before the job moves off `main`. Swapping them fails with a flag error, but
a subtler version of the same mistake — building stable first and reusing its `_site/`
— would quietly serve one build twice.

They ship in one workflow because **a Pages deploy replaces the whole site**. Split
across two workflows, whichever ran last would delete the other half, and the symptom
is an intermittent 404 rather than anything that looks like a YAML mistake. For the
same reason `pages.yml` now triggers on `tags: ['v*']` as well as pushes to `main`:
without it, cutting a release would never update `/`.

`readBuildMeta` in `scripts/build-site.mjs` asks **git before `GITHUB_SHA`**, which is
the reverse of the obvious order and is the point: the stable tree is built after
`git checkout <tag>`, where `GITHUB_SHA` still names the commit that triggered the run
— the tip of `main`. Trusting it there stamps the stable page with a sha it was not
built from.

One consequence that will age out on its own: a release tagged before this existed has
no `__VERSION__` in its template, so `/` serves that release's code with no version
pill until the next tag carries the change. `/edge/` is stamped from the first deploy.

CNAME is written by the **stable build only**. Pages reads exactly one, at the artifact
root; a second one inside `edge/` is inert but reads like a binding to whoever finds it.

## Releasing

A `v*` tag runs both `.github/workflows/publish.yml` (below) and `pages.yml` (above),
independently and in parallel.

`publish.yml` is three jobs in a chain:
`publish` (suite, typecheck, build, tag-matches-`package.json`, `npm publish` over OIDC),
then `release` (a GitHub Release whose body is the CHANGELOG section for that version,
carrying the npm tarball, `qrdrop-site-<version>.zip`, `SHA256SUMS`, and a build
provenance attestation), then `tap` (rewrites `Formula/qrdrop.rb` in `stan-ely/homebrew-tap`
from a template in that file).

**Never rename `publish.yml`.** npm Trusted Publishing is configured on npmjs.com against a
repository *and a workflow filename*. The file has long since grown past what its name says
— renaming it to `release.yml` typechecks, tests clean, and then fails the next publish
asking for a token this repo deliberately does not have. For the same reason the release
and tap steps are jobs in that one file rather than a second workflow on the same tag: two
runs would both `npm ci`, both run the suite, and race the version check.

The one secret is `HOMEBREW_TAP_TOKEN`, a fine-grained PAT with `contents: write` scoped to
the tap and nothing else. `GITHUB_TOKEN` cannot stand in — it is scoped to this repository,
and a cross-repository write is what it is not allowed to do. The tap already serves another
project under a secret of the same name; secrets are per-repository, so that one is invisible
here.

Release notes are extracted, not generated: `scripts/release-notes.mjs <version>` prints the
matching `## <version>` section of `CHANGELOG.md` and exits non-zero if there is none. The
`publish` job runs it before publishing, so a tag with no changelog entry fails while the
release can still be re-run — after publishing, the only fix is a hand-edited Release body.
Run it locally before tagging to see exactly what the Release will say.

The formula's `sha256` is taken from the *registry's* tarball, not a local `npm pack`, since
the registry URL is what the formula points at. That step retries: the CDN takes a few
seconds to serve a version published one job earlier, and a cold 404 there would fail an
otherwise fine release.

No winget. It has no npm step and its `PackageDependencies` field is only partly honoured by
the client, so a real Windows package means shipping a self-contained ~58 MB bundle (Node
runtime, `src/`, `site/dist`, platform-correct `node_modules`) plus a launcher shim, per
target. Windows users get `npx`, `npm i -g`, or the deployed site. If that changes, it is one
more job in the same file, not a rewrite.

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

**Every deep-link entry into the Tauri app funnels through `decodeSecret`, and the app
only ever writes a code into `location.hash`.** `app/src/deep-link.js`'s
`secretFromDeepLink` is the one place a `qrdrop:` scheme URL or a
`https://share.stan-ely.com/#qrdrop:…` app link becomes a secret; it delegates the
fragment-only check above rather than parsing the URL itself, then re-encodes to the bare
form so `app/src/main.js` can put it after a `#` and nowhere else. Unwrapping a deep link
into a code any other way — reading `url.searchParams`, handing the raw URL to the
element — reintroduces the `?code=` leak on a platform where the OS, not the user, chose
to open the app. `test/deeplink.test.mjs` covers it. The `hashchange` listener in
`element.js` (`_consumeHashCode`) is what makes a code set on the running window take
effect; it is guarded to the choose screen so it cannot interrupt a live transfer.

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

**`MAX_FRAME_BYTES` is not derived from `CHUNK_SIZE`, and must not be "tidied" into
being.** One SCTP message is 16 KiB and the transport's action wire spends 36 bytes
of each on its own framing, so `CHUNK_SIZE` is sized to make a sealed frame land on
exactly 16348. It used to be a flat 16 KiB, which overshot by 66 bytes -- and the
transport does not reject an overshoot, it splits it, so every frame travelled as a
full message plus a 102-byte runt (measured: 393 sends for 192 frames). But
`MAX_FRAME_BYTES` is the INBOUND tolerance and still spells out `16 * 1024`, because
a peer on the old constant still seals 16414-byte frames. Shrinking what we send is
a local decision; shrinking what we accept is a wire break.

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

## The Tauri app (`app/`)

The desktop/mobile shell. It has its own `package.json` and `src-tauri/`, and its
onboarding is recorded phase by phase in `app/CAPABILITIES.md` — read that for the
measurements behind the rules below.

**`app/` is not in the npm tarball, and `@tauri-apps/*` is not a root dependency.**
The root `package.json` `files` array lists `src`, `types`, `site/dist` and nothing
else; "no new runtime dependencies" (see `## Invariants`) is a root-package rule, so
the Tauri API and CLI live in `app/package.json` only. A dependency added to the root
to "share" it with the app breaks both at once.

**The app version is `app/src-tauri/Cargo.toml`'s `version`, and it is deliberately
not the npm package version.** `tauri.conf.json` omits its own `version` field so
Tauri reads the crate's — two copies of one number drift. A webview-permission fix
should ship an app release without republishing an unchanged library, which is why
the two version lines are independent and `cargo-release` (tag `app-v{{version}}`)
drives the app while `v*` tags drive npm.

**`app/src-tauri/tauri.conf.json` and `Cargo.lock` are committed and generated.**
`scripts/generate-tauri-config.mjs` fills the CSP in `tauri.conf.template.json` from
`buildCSP(SIGNALING_URLS)` — the exact policy the website serves — so a relay added
to `src/transport/room.js` reaches the app's `connect-src` with no second edit, same
reasoning as `buildCSP` itself. Hand-editing `tauri.conf.json`'s `connect-src` is the
drift this exists to prevent. `Cargo.lock` is committed because this is a binary.
`app/dist/` is *not* committed (it is `dist/`-gitignored); `mise run app:dev` /
`app:build` rebuild it from `--channel app`.

**`app/src-tauri/gen/` is committed source, except `gen/schemas/`.** It used to be
ignored whole, and the reasoning was sound while it held nothing but generated
schemas: `tauri android init` regenerates it in one command, so a committed copy
would be a second source of truth. Android broke that. The build needs
`<uses-permission android:name="android.permission.CAMERA"/>` in `gen/android`'s
`AndroidManifest.xml` and **`tauri.conf.json` has no field that can express it**, so
the delta lives only in `gen/` — where an ignored tree means every re-init silently
drops the camera permission and the scanner stops working with nothing to diff. A
script re-applying the delta after each init was the alternative; it relocates the
second source of truth rather than removing it, and it cannot carry the Kotlin file
that Android's runtime permission request may yet need. Do not re-run
`tauri android init` over the committed tree to "refresh" it — that is the
regeneration this arrangement exists to survive. iOS needs no such edit:
`Info.ios.plist` is merged natively, which is why it was staged in Phase 3.

**`bundle.targets` is desktop-only and that is not an oversight.** `tauri android
build` and `tauri ios build` do not consult it; the mobile knobs are
`bundle.android.minSdkVersion` and `bundle.iOS.minimumSystemVersion`, both stated
explicitly in `tauri.conf.template.json` at Tauri's own defaults rather than
inherited silently.

**mise pins the Android command-line tools; the `android` CLI pulls the packages.**
`android-sdk = "23.0"` installs cmdline-tools (~170 MB) and exports `ANDROID_HOME`,
`ANDROID_SDK_ROOT` and the bin dirs — it does *not* fetch the NDK, platforms or
build-tools, which is why pinning it is cheap. Those come from
`android sdk install …` into the same directory, so `mise uninstall android-sdk`
takes the NDK with it. `sdkmanager` is deprecated in favour of that `android` CLI,
whose package separator is `/` and not the `;` older instructions use, and the NDK
pin is the newest *stable* one: every 30.x build is still a release candidate, and
only the version field's `-rc.N` says so — the package path does not.

**`NDK_HOME` is built from `xdg_data_home`, and that is not a stylistic choice.**
`{{env.ANDROID_HOME}}` fails outright — a tool's own exports are not in scope while
`[env]` is evaluated, and mise says "Field ANDROID_HOME is not defined". The
documented `tools["android-sdk"].path` is out of scope there too. The cost is that
the SDK version appears twice in `mise.toml`; those two lines move together.
`JAVA_HOME` comes from mise's `java` and wins over any system JDK.

**`.github/workflows/app.yml` compiles the shell and ships nothing** — a desktop
`--no-bundle` matrix, an unsigned Android debug APK, and an iOS *simulator* build.
It has no tag trigger on purpose: `v*` belongs to `publish.yml` and `pages.yml`, and
app releases are a later phase. The iOS job runs `xcodebuild … -sdk iphonesimulator
CODE_SIGNING_ALLOWED=NO`, **not** `tauri ios build` — that drives an archive and
export which wants a development team even for the `debugging` export method, and so
fails on an identity-less runner for reasons that say nothing about the code. Before
this workflow, nothing compiled the Rust crate on a pull request at all.

**The platform seam must stay a seam.** `src/web/element.js` reads
`getPlatform().createSink` from `src/web/platform.js` rather than importing
`web/sink.js`. `registerPlatform()` is called by `app/src/main.js` and by nothing
else — never `site/main.js` — so the deployed site cannot regress from a change made
for the app. `platform.js` imports only `sink.js`; it ships in `qrdrop/web`.

**The native sink does not use `plugin-fs`, and must not be "simplified" back to it.**
On WebView2 `@tauri-apps/plugin-fs`'s `write()` moves bytes at ~2 MB/s regardless of
block size — its argument is not travelling the raw IPC path, whatever the docs
imply. `app/src-tauri/src/sink.rs`'s `sink_write` takes the bytes in the invoke
request's raw body (`tauri::ipc::InvokeBody::Raw`) instead and does ~40 MB/s. The
plugin is still registered for the throwaway harness's sake, but the sink's byte path
is the custom command. A JSON-array `invoke('save_chunk', { data: [...] })` is the
*other* wrong answer — a megabyte becomes a million stringified numbers.

**`tauri-sink.js` coalesces frames to 1 MiB before each `invoke`, and that buffer is
load-bearing.** `element.js` calls the sink once per 16 KiB transfer frame; at that
size even the raw-body path is ~5 MB/s, because ~3 ms of per-invoke cost dominates.
256 KiB gets ~34 MB/s, 1 MiB ~42 and then it flattens. Passing frames straight
through is ~8× slower for no memory saving worth having (the buffer is one block).

**`fromFile` reads in 2 MiB blocks, and that buffer is load-bearing the same way
`tauri-sink.js`'s is.** A `File` from Android's Storage Access Framework is backed
by a `content://` provider, so every `arrayBuffer()` is a Binder round-trip to
another process: ~79 ms fixed plus ~3.7 ms per MiB, measured on-device across
256 KiB to 16 MiB. `src/web/source.js` used to read once per `CHUNK_SIZE` frame,
which made a 3 MB Android send 192 round-trips and 29.7 s of a 30.3 s transfer --
98% of it, against 21 ms of AEAD and 9 ms of data channel. Blocks took that to
3.34 s, and 64 MiB to 23.6 s (2.72 MB/s) where the per-frame read would have taken
about eleven minutes. An in-memory `Blob` reads in 0.98 ms, so no desktop browser
shows this and no benchmark without a real picked file will either: Phase 2
measured over loopback, Phase 3 had the desktop as sender.

Two traps in that constant. It does **not** match `tauri-sink.js`'s 1 MiB -- the
write side amortises a ~3 ms invoke and flattens after 256 KiB, this amortises a
~79 ms round-trip and is still climbing at 16 MiB -- so "make them the same" is
wrong in both directions. And raising it is the wrong fix for the ~25% of a
transfer still spent reading: `sender.js` awaits `slice()` before it seals, so the
channel is idle for every read, and a bigger block only makes those gaps fewer and
longer. Prefetching the next block while the current one transmits is what removes
them. It returns a copy of the block rather than a subarray view, unlike
`src/node/source.js`, which can hand back a view only because it refills its buffer
on every single `slice()`.

**A slow sink is now throttled by the transport, and that mechanism is a `src/core`
property, not a Tauri one.** `RTCDataChannel` delivers `onmessage` as fast as bytes
arrive and `receiver.js` serialises them into a promise chain; SCTP flow control
never engages, because the receiver never stops reading. Before this was addressed, a
sink that drained slower than the channel filled let that chain accumulate the whole
file in RAM — measured at its worst with the app, the old 1.5 MB/s sink grew the JS
heap by 1 GiB over a 1 GiB transfer. The website ran the same code and was latent
only because the Chromium `showSaveFilePicker` path drains far faster than a WebRTC
transfer usually fills it and the Firefox/Safari Blob path buffers the whole file by
design anyway (see README "Known limitations").

The fix is app-level flow control over the authenticated control stream.
`receiver.js` tracks bytes accepted but not yet through `sink.write()` (exposed as
`receiver.pending`); above `PAUSE_AT` it sends a `{ t: 'pause' }` control message and
below `RESUME_AT` a `{ t: 'resume' }`. `sender.js`'s chunk loop consults
`control.flowGate()` between frames — shaped exactly like `drain()` — and blocks on
pause until resume, or until `PAUSE_TIMEOUT_MS` makes an indefinitely-paused transfer
fail with a diagnostic rather than hang. Both messages are sealed and index-counted
like every other control frame, so "authenticate, then trust" holds and a stranger
cannot forge one. It degrades cleanly in both directions: a sender too old to act on
`pause` drops it as an unrecognised control type and runs as it did before, and a
receiver too old to send it simply never does. `test/backpressure.test.mjs` pins the
bounded backlog under a deliberately slow sink and both old-peer paths.

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
