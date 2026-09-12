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
mise run lint:workflows                    # actionlint, with shellcheck on every run: step; after touching a workflow

node --test test/frame.test.mjs                          # one file
node --test --test-name-pattern="round-trips" test/frame.test.mjs   # one test
```

Four image generators, all hand-run and none of them in `npm run build` — that
runs in CI and in `prepublishOnly`, where downloading a browser is not
acceptable. Their output is committed; run the relevant one when the palette,
the card copy, or a diagram source changes:

```bash
node scripts/make-og.mjs                                 # site/og.png, the social card       (mise run img:og)
node scripts/make-icon.mjs                               # the app mark + site/favicon.png    (mise run img:icon)
node scripts/make-diagrams.mjs                           # docs/diagrams/*.png from the .mmd sources (mise run img:diagrams)
npm run build && node scripts/make-screenshots.mjs       # docs/screenshots/*.png              (mise run img:screenshots, which builds first)
```

`make-icon.mjs` writes `app/src-tauri/icons/source.png` and stops there; the
fan-out to every platform size is `npx tauri icon app/src-tauri/icons/source.png`,
deliberately a second command because it writes into `app/src-tauri/gen/`, which
is committed source. **Read that diff.** It resets the adaptive-icon background
colour in `gen/android/.../values/ic_launcher_background.xml` to white every
time, and that file is a hand-edit — one of several in `gen/`, tabulated under
"**The Tauri app**" below. The mark occupies the middle 47% of the canvas and that is
arithmetic, not taste: the same image becomes Android's adaptive-icon
foreground, a launcher masks it to the central 66.7%, and the largest square
inside that circle is 47.1%. At 64% the corner eyes are outside the mask on any
phone with round icons, which is invisible in a file browser.

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

It crosses every viewport with a **pointer axis** (`hasTouch`), because without
one it had a blind spot exactly the shape of the bug it exists to catch: it
measured the phone viewport with a mouse, so the `@media (pointer: coarse)` rules
were never once laid out by it. That both engines report `pointer: coarse` from
`hasTouch` alone was measured, not assumed — `isMobile` is Chromium-only and
imposes a mobile meta viewport, which would have the two engines measuring
different pages.

`--shots` writes a picture of **every** combination rather than only the
failures, into the same gitignored directory. Use it after anything that changes
the touch layout: the assertions here can only see a layout that is *illegal*,
never one that is legal and wrong, and that distinction has already cost this
project once (the sr-only build-stamp label). Delete the pictures afterwards;
there are 8 × 4 × 2 × 2 of them.

It runs **both** engines, and the second one earns its place: everything this script used
to assert was an overflow or a position, and engines rarely disagree about those. They
disagree about *sizing*, which is why it also asserts that `.qr` / `.beam-stage` is
actually square. That assertion found a real one immediately — 352x306 at 1280x620, in
both engines, because the wide-layout branch pinned `inline-size: 100%` while
`.card-media` (`flex: 1 100 auto`) went on squeezing the block axis. `preserveAspectRatio`
pins the code into a corner of a box that is not square, so the difference pays out as a
white band beside the QR.

**Landscape is its own layout, and `BREAKPOINT_FLAT` is where it lives.**
`(min-width: 48rem) and (max-height: 30rem)`, in `tokens.js` beside the other two
and interpolated into `site/styles.css` the same way. Reaching the wide branch was
only the first half; the arrangement it reached was still stacked on the one axis
this shape is short of. Measured at 800x360 before this: 139px of the 360 went on
page chrome (a header of 61, a footer of 30, and 48 of padding and row gaps), 32
on card padding and 64 on a full-width action bar holding two 82px buttons — so
the content laid out inside **111px**, with the media box capped at 128 inside it.

Three changes, all in that branch:

- **The page chrome folds onto one row.** `main` becomes a two-row grid with the
  header at 1/1 and the footer at 1/2, so the wordmark, "How it works" and the
  security disclosure sit on one baseline. Nothing is hidden — same elements, same
  tab order — they have only stopped each claiming a row. Card: **221 → 292px**.
- **The card is a grid and the action bar leaves the bottom.** `.card-body` is
  `display: contents` so the two columns are siblings in one grid and the media can
  span the action row; the bar moves into the second column under the copy it
  belongs to. Media box: **128 → 258px square**. The media track is a bare `18rem`
  and not `minmax(0, 18rem)` — with a zero floor it gave way to the `auto` track
  beside it and the beam QR came out 186x258, which is the 352x306 failure again.
- **The controls slot.** `screen()` in `view.js` has a fourth slot beside `media`,
  `body` and `actions`; only beam-send fills it, with its speed picker and the
  readout that picker changes. It is a child of `.card` because CSS can only move
  an item within the grid it is in, and it is rendered on every screen and hidden
  when empty because `vdom.js`'s `canReuse` matches by position and the screens
  that use it are the ones with an adopted canvas being repainted beside it.
  Beside the buttons rather than above them, and that was measured: side by side
  the bottom row is `max(controls, buttons)`, stacked it is their sum.

**The square assertion could not have caught the original bug, and the reason
generalises.** A collapsed box is 0x0, and 0x0 passes `width === height`. What
catches it is the **clipped-above** assertion: any child sitting above the copy
column's own scroll origin is fatal on every viewport, because `scrollTop` is
already 0 there and nothing can scroll back up to it. That is what
`justify-content: center` does to a column it cannot fit — it pushes the overflow
out *both* ends — and on 800x360 it had taken the `<h2>` and beam's encryption
callout off the top while every existing assertion saw an ordinary overflow. The
rule is `safe center` now. Zero-box children are exempt, for the same reason the
offscreen check exempts a closed dialog: an element that is not laid out reports
0x0 at the origin, which is above every scroll container on the page.

**One screen still overflows and it is beam-send, by 79px at 800x360 and 49 at
844x390.** Those are the `copyScroll` budgets on those two viewports — a budget and
not the `allowBodyScroll` flag they replaced, because an on/off exemption lets the
one screen that legitimately overflows hide every screen that does not. Beam wants
228px of heading, encryption callout, filename and keep-it-on-screen instruction in
150; that is a shortfall in *area*, so no rearrangement closes it. The numbers are
Firefox's, 1px above Chromium's on the same fixture — take the larger, or the
budget passes one engine and fails the other on an unchanged tree.

**What the first screenshot of that branch caught, which no assertion did:** the
part below the fold was `.callout.warn`, the keep-it-on-screen instruction
`view.js` calls the most important thing on the screen. Legal, reachable, and the
exact shape of the Accept-below-the-fold bug this script was written after. So in
this branch `.card-copy > .filename` takes `order: 1` and the filename yields its
place — it is the only purely informational line in that column. The child
combinator is load-bearing: every other `.filename` in the app is nested in a
`.stack`, so this reaches the two beam screens and nothing else, and both want it.
Look at the pictures; the assertions cannot see this class of thing.

**"Take a photo" is `display: none` here.** Three buttons wrapped the choose bar
onto two rows and took 59px from the copy beside it. It is a second way to start a
send next to "Send a file", framing a photo is done with the phone upright, and it
returns the moment the phone is turned back. A rule rather than a branch in
`choose()`, so the vnode shape stays identical across orientations — and
`display: none` rather than `visibility`, so it leaves the tab order with the pixels.

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

**`_site/fdroid/` is copied into the artifact, never built there.** It is the F-Droid
repository — a signed index and the APKs it describes — checked out from the `fdroid-repo`
branch and `cp -R`'d in. `pages.yml` does not run `fdroid update` and must not learn how:
regenerating an index needs the repository signing key, and that key has no business in a
workflow whose job is publishing HTML.

It goes **straight into `_site/`** and not into `site/dist` or `_site/edge`, because both of
those are `--out` directories for `build-site.mjs`, whose `main()` does an `rm -rf` before
writing a byte. `_site/` itself is only ever merged into, so a directory placed there
survives both builds. And it must be in **every** artifact, for the same reason the two
site builds ship together: a Pages deploy replaces the whole site, so an artifact without
it silently unpublishes the repository.

The branch carries its own `.gitattributes` marking everything `-text`, and that is not
tidiness. `entry.json` pins `index-v2.json` by sha256 **and size**, so a single LF rewritten
to CRLF on checkout invalidates the signature and every client declines the repository with
nothing in any log to read. `pages.yml` re-checks the served hash against what `entry.json`
signed, because the `.gitattributes` is a setting someone could change and the assertion is
a check.

## Releasing

A `v*` tag runs both `.github/workflows/publish.yml` (below) and `pages.yml` (above),
independently and in parallel.

`publish.yml` is four jobs in a chain:
`publish` (suite, typecheck, build, tag-matches-`package.json`, `npm publish` over OIDC),
then `release` (a GitHub Release whose body is the CHANGELOG section for that version,
carrying the npm tarball, `qrdrop-site-<version>.zip`, `SHA256SUMS`, and a build
provenance attestation), then `tap` (rewrites `Formula/qrdrop.rb` in `stan-ely/homebrew-tap`
from a template in that file), then `scoop` (the same for `bucket/qrdrop.json` in
`stan-ely/scoop-bucket`).

**Never rename `publish.yml`.** npm Trusted Publishing is configured on npmjs.com against a
repository *and a workflow filename*. The file has long since grown past what its name says
— renaming it to `release.yml` typechecks, tests clean, and then fails the next publish
asking for a token this repo deliberately does not have. For the same reason the release
and tap steps are jobs in that one file rather than a second workflow on the same tag: two
runs would both `npm ci`, both run the suite, and race the version check.

Two secrets, one per tap: `HOMEBREW_TAP_TOKEN` and `SCOOP_BUCKET_TOKEN`, each a
fine-grained PAT with `contents: write` scoped to its own repository and nothing else.
`GITHUB_TOKEN` cannot stand in for either — it is scoped to this repository, and a
cross-repository write is what it is not allowed to do. The tap already serves another
project under a secret of the same name; secrets are per-repository, so that one is invisible
here. Widening one PAT to cover both taps was the alternative and is worse than it looks: a
secret called `HOMEBREW_TAP_TOKEN` that also writes a Scoop bucket cannot be reasoned about
from the workflow that uses it, and one leak then moves two package indexes.

**Scoop is not the winget case** (below), and that distinction is the whole reason
`bucket/qrdrop.json` exists. Scoop has `depends` and `post_install`, so the manifest pulls
`nodejs` from the main bucket and runs `npm install` in the package directory — the same
shape `Formula/qrdrop.rb` already has, not a new posture. What it does not have is a way to
run a `.js` file: **Scoop's shim generator switches on extension** — `.exe`/`.com`,
`.cmd`/`.bat`, `.ps1`, `.jar`, `.py` — and `.js` is not among them, falling through to a
generic branch that tries to translate the path for WSL or Cygwin. Pointing `bin` at
`src/cli.js` installs cleanly, writes a shim, and fails the moment anyone runs it, so
`post_install` writes a two-line `qrdrop.cmd` and `bin` shims that. It uses forward slashes
deliberately: `cmd.exe` and node both accept them, and the manifest is then free of
backslashes for a shell to eat.

Both manifests are built by piping JS into `node` through a **quoted** heredoc (`<<'JS'`),
not `node -e`. A scoop manifest is written in scoop's own `$version`, `$dir` and `$basename`
placeholders, which are bash variables too — an unquoted heredoc empties them silently. The
first draft used `node -e '…'` and lost a Windows path's backslashes to shell quoting, which
produced entirely valid JSON containing a broken command. That is a failure no JSON check can
see, which is why the generator is shaped this way rather than more simply.

The CLI manifest's `autoupdate` carries **no `hash` block**, so scoop downloads the new
tarball and hashes it. The registry's `dist.shasum` is the obvious field to point at and is
wrong: it is SHA-1, and scoop would compare it against a SHA-256 and refuse every update.
`dist.integrity` is SHA-512 in base64 where scoop wants hex.

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
target. **This paragraph is about winget specifically and not about Windows package managers
generally** — it read that way for a while, and Scoop is the counterexample: it has both of
the things winget lacks, which is why the `scoop` job above is a manifest pointing at the
registry tarball rather than a vendored runtime. Windows users get `scoop install`, `npx`,
`npm i -g`, or the deployed site. If winget changes, it is one more job in the same file, not
a rewrite.

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

The paired peer's frames, though, are **held until `onFrame()` is registered, not
dropped**. The two devices do not wait for each other: the CLI registers its handler
only after its own SAS prompt, while the peer starts sending when *its* person
confirms, and the first thing it sends is a path verdict at control index 0. Dropping
that made the next control frame fatal (`Out-of-order frame: expected 0, got 1`,
between two CLIs). The hold is bounded (`EARLY_FRAME_LIMIT`) and processes nothing
before the caller registers, so a stranger still gets nothing held and the SAS still
comes before any offer.

**The two safety gestures cannot be softened.** The sender confirms the SAS before a
manifest goes out (the manifest alone leaks filename and size); the receiver's Accept
click is also the user activation that permits `showSaveFilePicker` to open. Never
auto-advance past either, never auto-focus either button, and keep Accept's handler from
losing its user activation behind an `await`. `--yes` skips the accept prompt and must
never skip the SAS.

**And the SAS gets one roll per secret.** Four symbols out of 64 is 24 bits, which is
strength only if an attacker gets a single attempt at it — bits × shots, where the shots
are a property of how the screens are wired rather than of any crypto. A user who can
re-scan the same QR after a mismatch lets the attacker keep rolling, and by the third try
that user has been taught to read a re-pair as ordinary flakiness. The only route back to
a pairing is `choose` → `_startSend`, which calls `generateSecret()` for fresh bytes; the
secret is a local in that method and never reaches `this` or `state`. So the verify screen
must never grow a control that re-enters a pairing — a "Try again" button is the tempting
one, because a genuine pairing failure and an attack look identical from that screen.
`_rejectVerification` is the sanctioned exit and it is terminal: it ends the session and
lands on `done` with outcome `mismatch`, whose restart label says *fresh code* rather than
"Send another file". `test/view.test.mjs` walks the rendered verify screen, fires every
`onclick` at a recording dispatch, and fails on any pairing intent by name.

**The camera track is released on every path out of `scanQRStream`, including an
abort that lands while the camera is still opening.** `src/web/qr.js` checks
`signal.aborted` before `getUserMedia` *and* again after it, `video.play()` and
`createDetector()`, and `stop()` is defined the moment the stream exists with
everything after it inside the `try`. The second check is the one that looks
redundant and is not: an abort arriving during those awaits finds no listener yet,
and a signal that has already fired never fires again, so the scan promise never
settles and its `finally` never runs. That left the webcam on for the life of the
page. The way in is ordinary rather than exotic -- the hand-entered code field is
on the scanner screen, and `_submitManualCode` aborts exactly this signal, so
pairing by pasted code aborts mid-open every time. It was caught by a light on a
laptop while every test passed, because nothing headless can see a camera that was
never released; `test/qr.test.mjs` asserts both that the track ends and that the
call settles.

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
being.** The transport's action wire chunks a payload at `16 * 1024 - 36`, so
`CHUNK_SIZE` is sized to make a sealed frame land on exactly 16348 and travel as one
message (measured: 4,122 sends for 4,113 chunks, 1.002 per frame). It used to be a
flat 16 KiB, which overshot by 66 bytes -- and the transport does not reject an
overshoot, it splits it, so every frame travelled as a full message plus a 102-byte
runt (measured: 393 sends for 192 frames). Note the 36 is that chunking constant and
**not** the per-message header, which measured ~66 bytes on the wire (16,413.7 bytes
sent per call against a 16,348-byte frame): the emitted message is ~16414, i.e. over
16 KiB, which SCTP accepts because the negotiated `maxMessageSize` is far larger.
Do not re-derive the constant from "one SCTP message is 16 KiB" -- that reasoning
reaches the right number by luck. But
`MAX_FRAME_BYTES` is the INBOUND tolerance and still spells out `16 * 1024`, because
a peer on the old constant still seals 16414-byte frames. Shrinking what we send is
a local decision; shrinking what we accept is a wire break.

**The F-Droid repository signing key never changes.** A client pins its certificate when
the repository is added and refuses an index signed by any other, so a "rotation" is every
existing user silently stopping receiving updates until they remove and re-add the repo.
There is no migration path and there will not be one. Related, and load-bearing in the
opposite direction: the key must never reach `pages.yml` (whose job is publishing HTML) and
never reach a public branch — the `fdroid` job's staging step refuses outright if a
`*.p12`, `*.jks` or `*.keystore` is about to be pushed.

**`_site/fdroid` is copied, never built.** Anything under a `build-site.mjs --out` directory
is `rm -rf`'d by the next build, so it goes straight into `_site/` — and its bytes are
signed, so nothing anywhere may normalise their line endings.

**The APK filename is derived from `SHA256SUMS`, never spelled in a workflow.** That file is
generated by `sha256sum *` over the very directory that was uploaded, so it cannot disagree
with the Release by construction; a literal copy of `app-universal-release.apk` would be the
one string a bundler naming change could break with nothing in the diff to read. The
extraction tolerates a leading `./` because `app-v0.1.0` shipped that shape and the
bare-names change landed in `f4bf3d2` after it — and it requires **exactly one** match,
because picking the first of two would be a coin toss resolved in favour of whatever
`sha256sum` happened to sort first.

**Control frames in one direction leave in index order, and there is one
`nextControlIndex` function per direction.** A control frame's index is its nonce, so it
has to be fixed before the seal, and a frame arriving out of index order is fatal by
design (above: our own peer contradicting itself). Every call site used to take its
index, await the seal, then send — so two control messages started together went out
in whichever order WebCrypto finished. It reached a phone as `Out-of-order frame:
expected 0, got 1`, because the CLI fires its path verdict and its manifest back to
back. `receiver.js` had serialised pause/resume alone, believing everything else was
ordered by the inbound frame queue; the path verdict and the Accept click never were.
`sendControl` in `src/core/control.js` now makes take-index, seal and send one queued
step, keyed on the `nextControlIndex` function. So pass the **same function** to
`createReceiver`, `sendFile` and `sendPathVerdict` on one side, never a second closure
over the same counter — that gets a queue of its own and races again. Do not add a
control send that calls `sealControl` and `channel.send` directly.
`test/control-order.test.mjs` slows the first seal and asserts both shapes stay in order.

**A control stream's `fail()` is sticky, and the first error wins.** It used to reject the
waiter parked in `next()` if there was one and forget the error otherwise — and in the
middle of a file there is none, because the send loop is producing chunks rather than
awaiting a reply. Measured on a phone that cancelled at 25% of 64 MiB: the CLI sender took
the leave, streamed the other 48 MiB into an empty room through 3,012 `no peer with id`
warnings, printed "Sent 64 MB of 64 MB", and was still parked on a `done` two minutes
later. A `fail()` that only reaches a present listener looks exactly like handling, which
is why it survived. `src/core/control.js` now records the failure, and every wait after it
sees it: `next()`, `flowGate()` (checked before the pause flag, or a paused sender sits out
`PAUSE_TIMEOUT_MS` and then blames the pause), and `throwIfFailed()`, which `sendFile`
calls between chunks. `next()` checks the **buffered messages first** and the failure
second, and that order is load-bearing: a `done` that arrived before the leave has already
finished the transfer and must not lose to it. The first error rather than the last,
because what follows a real failure is usually its echo. `test/control-stream.test.mjs`.

**Every path that ends a paired session closes the room, and an exit awaits it.** A room's
`close()` returns Trystero's `leave()` promise, which sends the leave message and never
rejects. The CLI's SIGINT handler used to run its interrupt hooks and exit with the room
still open, so no leave message went out and the other device learned about a Ctrl-C only
when the connection timed out: measured by hand, a sender went on to "Sent 340 MB" and
reported the disconnect about 11 s later. `runSend` and `runReceive` now put `room.close`
among `interruptHooks`, and the handler waits for them, bounded at 2 s so a hook that
hangs cannot stop Ctrl-C exiting; pressed by hand again, the sender
reported the disconnect 89 ms after its last progress line. A new command that pairs a
room must add it too.

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
builder returns `{ media, body, controls, actions }`: the body may scroll as a last
resort, the action bar never does. There is nowhere else for a button to go, which is
the point. `media` is the screen's one visual thing and `controls` its one control
that is not a button (only beam-send has one) — both are slots rather than entries in
`body` because "beside" is not something CSS can say about one child among siblings,
and both are rendered as children of `.card` so a media query can place them. Adding
a slot means adding it to the type on `builders` too; the typecheck is what says so.

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

## The deployed site's own moving parts

**`site/sw.js` exists for exactly one reason and caches nothing.** Web Share
Target delivers files as a multipart POST, GitHub Pages cannot answer a POST, and
a service worker's `fetch` handler is the only thing that can — there is no
version of that feature without one. It has **no precache, no fetch fallback and
no cache-first anything**: every request but the share POST goes to the network
untouched, by simply not calling `respondWith`. Do not "finish" it by adding
offline support. This site is two builds out of one artifact, and a stale cached
bundle is a person running code from a release they cannot name on a page whose
build stamp says otherwise — for an app about authenticating the other end, two
devices silently running different framings is the one failure nobody could debug
from a screenshot. A transfer needs a network by definition anyway.

Registration is **relative** (`register('sw.js', { scope: './' })`), so stable at
`/` and edge at `/edge/` each get their own worker for their own tree. An
absolute `/sw.js` would have the stable worker claim `/edge/` too, and whichever
build was visited last would answer the other's shares.

**`manifest.webmanifest` is generated per channel**, for the reason CNAME and
og:url are. `start_url`, `scope` and `share_target.action` are all relative so
one generator is correct for both trees, and `id` is deliberately omitted so it
defaults to `start_url` and the two channels are distinct installs by
construction. `share_target` must stay `method: POST` with
`multipart/form-data`: the GET form carries a title, a text and a URL and cannot
carry files at all.

**The three share-handoff constants live in `site/share-keys.js`.** They are the
whole contract between a service worker and a page that never call each other,
and a disagreement would fail as "the app opened and nothing happened", only on
the path that runs when someone shares a file. The marker that says a file is
waiting is a **query parameter**, which is correct here and would never be for a
pairing code — it carries no secret, and the bytes never touch the URL.

**`viewport-fit=cover` and the `env(safe-area-inset-*)` padding are one
change.** Without the meta attribute every inset resolves to 0, which is how the
safe-area handling in `site/styles.css` sat there doing nothing from the day it
was written. Any rule that sets `main`'s `padding` shorthand must carry the four
env() terms, or it silently drops them — the narrow breakpoint did exactly that.

**`THEME_COLOR` lives in `src/web/tokens.js`** and feeds `--bg`, the
`theme-color` meta and the manifest. Drift there paints the wrong colour on the
splash and in the task switcher, before any stylesheet has loaded — visible only
on a cold start, which is the hardest moment to be looking.

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
would be a second source of truth. Android broke that. **This table is the only
thing standing between a `tauri android init` and losing the delta**, and it is
a table rather than the prose list it started as because the list reached the
size where "there are three of them" stopped being checkable at a glance.

Paths are under `app/src-tauri/gen/android/app/src/main/`.

**Edits to files Tauri generates** — a re-init overwrites these, silently:

| Path | What, and what breaks without it |
|---|---|
| `AndroidManifest.xml` | `<uses-permission android.permission.CAMERA>`. The scanner and beam cannot open the camera. |
| `AndroidManifest.xml` | The `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent-filter. The share sheet. |
| `AndroidManifest.xml` | `<meta-data android:name="android.app.shortcuts">`. The launcher shortcuts stop appearing, and `res/xml/shortcuts.xml` is orphaned with no error anywhere. |
| `AndroidManifest.xml` | The `QrdropTileService` `<service>`. The Quick Settings tile stops being offered; the class stays in the tree doing nothing. |
| `java/com/stan_ely/qrdrop/MainActivity.kt` | `stashSharedFile` and `stashLaunchAction`, the writing end of both handoffs. |
| `res/values/ic_launcher_background.xml` | The adaptive-icon background colour, which **`tauri icon` also** resets to white every time. |

**Files Tauri does not generate** — added rather than edited, so a re-init has
nothing to overwrite. They are listed because each is reached only through a
hand edit above, and losing that edit leaves the file inert:

| Path | What |
|---|---|
| `java/com/stan_ely/qrdrop/QrdropTileService.kt` | The Quick Settings tile. |
| `res/xml/shortcuts.xml` | The two launcher shortcuts. |
| `res/values/qrdrop_entry_points.xml` | Their labels, and the tile's. Deliberately **not** in the generated `strings.xml`. |
| `res/drawable/ic_qrdrop_scan.xml`, `ic_qrdrop_send.xml` | Their icons. |

The manifest's four entries and `MainActivity.kt` are one delta, not five: the
filter without the handler puts qrdrop in the share sheet and has it do
nothing, which is worse than not being there, and the same is true of a
shortcut that opens the app and forgets what it was for. See "**The Android
share sheet**" and "**The Android entry points**" below for the two chains.

**`tauri.conf.json` has no field that can express any of them**, so
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
`--no-bundle` matrix, an unsigned Android debug APK, and an iOS compile. It has no
tag trigger on purpose: `v*` belongs to `publish.yml` and `pages.yml`, and releasing
the app is `app-release.yml`'s job (below). Before this workflow, nothing compiled
the Rust crate on a pull request at all.

**The iOS job runs `cargo build --lib --target aarch64-apple-ios-sim`, and both of
the more ambitious things it tried first are dead ends.** `tauri ios build` archives
and exports, which wants a development team even for the `debugging` export method,
so it fails on an identity-less runner for reasons that say nothing about the code.
Driving the generated Xcode project with `xcodebuild` directly fails too, and less
obviously: the project's "Build Rust Code" phase shells out to `tauri ios
xcode-script`, which panics reading `$TMPDIR/<identifier>-server-addr` — a file the
tauri CLI writes just before *it* invokes xcodebuild. Skipping the CLI skips the step
that creates it, so the path can never exist. It surfaces as a bare `exit 65`. The
configuration is not the variable: it fails identically in `debug` and `release`, so
"debug means dev mode" is a plausible reading of that panic and a wrong one. What is
left covers the crate, its plugins and both mobile crate types; it does not cover the
Swift shell, which is generated code nothing here edits and which the `tauri ios init`
step already proves regenerates.

**`.github/workflows/app-release.yml` is the app's release, on `app-v*`, and the tag
prefix is load-bearing.** A workflow's `tags:` glob is anchored at the start, so `v*`
matches `v0.3.1` and does *not* match `app-v0.1.0` — which is the whole reason the
npm and app releases can live in one repository without racing. Put the prefix on the
back instead (`0.1.0-app`) and an app release starts an npm publish. `cargo-release`
(`app/src-tauri/release.toml`) produces the tag, `push = false` so a human looks at it
first, and stamps `app/CHANGELOG.md`'s `## Unreleased` heading — the notes are
extracted from that file by `scripts/release-notes.mjs --file app/CHANGELOG.md`,
never generated from commit subjects, exactly as `publish.yml` does for npm.

The jobs are `check` → `desktop` + `android` → `release` → `tap` + `fdroid` → `pages`.
Everything after `release` consumes the Release rather than the build outputs, and
everything after `release` is guarded off on a prerelease
(`!contains(needs.check.outputs.version, '-')`): a prerelease should still get a Release
page, and must not move what an `install` or an update check resolves to.

**The app is installable from both taps, as `qrdrop-app` and never as `qrdrop`.** A
`tap` job in `app-release.yml` writes `Casks/qrdrop-app.rb` to `stan-ely/homebrew-tap` and
`bucket/qrdrop-app.json` to `stan-ely/scoop-bucket`, beside the CLI's formula and manifest in
the same two repositories. The name is what keeps them apart: a formula and a cask sharing
one token in one tap is legal, and it makes `brew install qrdrop` warn and quietly resolve to
the formula — a trap for whoever meant the app. That job hashes the dmg and the zip
**downloaded from the Release**, not the copies the `release` job had on disk, for the reason
`publish.yml` gives about hashing the registry's tarball: the URL in a manifest is what an
install actually fetches.

The cask is `depends_on arch: :arm64`, and that is a refusal rather than a precaution.
`macos-latest` is an Apple-silicon runner and the desktop job builds exactly one dmg from it,
so without that stanza an Intel Mac installs a bundle that cannot launch and says nothing
useful about why. Adding an `x86_64-apple-darwin` build was the alternative: a second cold
Rust compile every release, for hardware Apple no longer sells. Its `caveats` must keep
saying the app is unsigned and give the `xattr` line, because `brew install --cask` applies
the quarantine attribute — a tap that installs these bytes silently routes people around the
one warning the Release notes go out of their way to make legible.

**Scoop gets a portable zip of `qrdrop.exe`, not the NSIS installer.** Scoop installs into a
directory it owns and does not run installers. Extracting the `.exe` with 7-Zip is the
shortcut and the wrong one: what comes out is `$PLUGINSDIR` and a layout belonging to the
installer generator, so a manifest built on it breaks on an nsis-plugin change with nothing
to read in the diff. The `desktop` job zips the binary it already built instead. The one
thing that loses: the NSIS package downloads the Evergreen WebView2 runtime when it is
missing and a zip cannot — that is Windows 11 and Windows 10 21H2 or later out of the box,
and the Release body says so. `shortcuts` in that manifest is what puts a GUI app in the
Start Menu; a bare `bin` shim is right for a CLI and would leave this launchable only by
path. Its `checkver` carries an explicit `app-v` regex because the default `github` strategy
reads whatever release is newest, and this repository alternates npm tags with app tags.

`SHA256SUMS` in the app release is written with bare filenames (`sha256sum *`, not `./*`)
because scoop's autoupdate reads that file to find the hash of the artifact it is about to
point at, matching on the basename. A leading `./` is invisible to `sha256sum -c` and
silently defeats that match.

**The Microsoft Store gets an MSIX, not the NSIS installer, because only an MSIX is signed
by somebody else.** The Store re-signs an MSIX with Microsoft's certificate after
certification. An EXE or MSI submission, which is the path Tauri's own docs describe, has to
arrive Authenticode-signed with a certificate chaining to a trusted CA, and this project has
none. So `scripts/make-msix.mjs` packs `app/src-tauri/AppxManifest.template.xml` beside the
release `qrdrop.exe` with the Windows SDK's `makeappx`, **unsigned**, and the `desktop` job
uploads it as the `store-msix` **workflow artifact**. It is not a Release asset and must not
become one: an unsigned MSIX does not install from a download, and the release job's
copy-by-extension is what keeps it off that page. The Store's signature covers Store installs
and nothing else. The zip, the installer, Scoop and winget are exactly as unsigned as before.
Individual Store registration has been free since 2025, so that fee is not a reason to go
back to the EXE path.

**The package version is the crate version with `.0` appended, and a 0.x crate cannot
produce one.** The Store reserves the fourth part and forbids a first part of 0. Mapping
`0.1.0` onto some other number was the alternative and was turned down, because the listing
would then show a version no tag, Release or changelog agrees with. The app went to 1.0.0
instead, and the `check` job runs `make-msix.mjs --check` so a tag the Store cannot carry
fails in seconds. `--version` exists only to sideload a 0.x tree locally, and it is refused
when `CI` is set.

**Three entries in that manifest are load-bearing, and each one is silent when it is
missing.**

- **`uap3:Protocol` for `qrdrop`.** `register_all()` in `src/lib.rs` writes
  `HKCU\Software\Classes`. A packaged app's HKCU writes go copy-on-write into a private
  per-package hive the shell never reads, so the call succeeds and registers nothing.
  `Parameters="&quot;%1&quot;"` is what puts the URI in `argv[1]`, where the deep-link and
  single-instance plugins already look; without it a packaged full-trust app is launched with
  no argument and the link is lost. `test/make-msix.test.mjs` checks that every scheme in
  `tauri.conf.template.json` is declared.
- **`DeviceCapability webcam`.** WebView2 inherits the package token, so the per-app switch
  under Settings, Privacy & security, Camera now gates qrdrop by name, before the
  `SetPermissionState` grant in `src/lib.rs` is ever consulted.
- **`TargetDeviceFamily MinVersion="10.0.19044.0"`.** An MSIX cannot run the WebView2
  bootstrapper the NSIS installer uses. That is the same caveat the portable zip carries, and
  21H2 is where the runtime ships in the box.

As with `AndroidManifest.xml`, **no `--` inside a comment**. makeappx reports it only as
`'>' expected` at a line number, and the first pack hit exactly that. The test checks it on
every platform now, since makeappx only runs on Windows.

The identity values (`stan-ely.qrdrop`, `CN=83DEB6F1-2747-47C0-B94F-38A296EF8C5B`, display
name `stan-ely`) are copied verbatim from Partner Center. They are public, and an upload that
disagrees with the reserved product is refused. Verified on a Developer Mode machine by
registering the loose layout (`Add-AppxPackage -Register
app/src-tauri/target/msix/stage/AppxManifest.xml`): `tasklist /apps` shows the process
running as `stan-ely.qrdrop_1.0.0.0_x64__h6gby7b5haf52`, a `qrdrop:` link launches the
packaged exe with the URI in `argv[1]`, a second link reaches the running window rather
than starting another process, and Receive opens the live camera once the per-app switch
(filed under `stan-ely.qrdrop_h6gby7b5haf52`) is on.

The Windows App Certification Kit passes it overall (23 of 24), and **its one failure,
"Blocked executables", is optional and expected, so do not chase it.** It scans the binary
for process-launch imports and for executable names as raw substrings. The imports
(`CreateProcessW`, `ShellExecuteW`) come from Rust's `std` and the webview host, which starts
its own `msedgewebview2.exe` processes. The "names" (`cmd`, `basH`, `DnX`) are byte runs that
happen to occur inside compiled code. Nothing in qrdrop launches a shell. `appcert.exe` needs
an elevated terminal, so it cannot run from an ordinary shell or from CI here. Publishing from CI with `msstore` needs Partner Center Entra
credentials that do not exist yet, so the first submission is made by hand from the
`store-msix` artifact.

**The Android app also ships from this project's own F-Droid repository, and it is a
_binary_ repository rather than an f-droid.org listing.** That is the entire design, not a
shortcut taken to avoid writing build recipes: an app built by F-Droid is signed with
F-Droid's key, whose fingerprint is not the one published at `.well-known/assetlinks.json`
on this very domain. Android checks app-link association against the signing certificate
and says **nothing at all** when it does not match — so a scanned pairing code would open a
browser tab instead of the app, for every install from such a build, indistinguishable from
association never having been set up. Serving our own signed bytes is what keeps
`ANDROID_CERT_FINGERPRINT` true for every install route at once, and it needed no change to
`wellKnownFiles()`. Measured: the signer recorded in the generated index is byte-identical
to that variable.

**Two keys, and they answer different questions.** `ANDROID_KEYSTORE_BASE64` signs the APK
and says "this is qrdrop" to Android. `FDROID_KEYSTORE_BASE64` signs `entry.jar` and
`index-v2.json` and says "this is the qrdrop repository" to the F-Droid client — which
**pins that certificate the moment a user adds the repo** and refuses an index signed by any
other one. So the repository key **cannot be rotated**: the only recovery from losing it is
asking every user to remove and re-add the repository. It is the one thing here with no
remediation, which is a second reason not to entangle it with a key that may one day have
to be replaced. Its fingerprint,
`889603b768cd2ca50f6c553086827880aa1aad5bbf0098a3028a7f1b7fd47582`, is **public** — it is
in the add-repo URL, the README and the Release notes, and it is deliberately not a
repository variable, because nothing in any workflow reads it (see `ANDROID_CERT_FINGERPRINT`
above for the doctrine, and note that a variable no job references is the mirror of the
mistake that doctrine warns about).

**The `fdroid` job's inputs are `fdroid/` on `main`; its output is the `fdroid-repo` branch,
which is a cache of bytes and not a history.** It force-pushes one fresh orphan commit every
release. `push_one` from the `tap` job deliberately does not carry over: a regenerated
`repo/` can *lose* files and `git add <dir>` does not stage a deletion, the target is a
branch of this repository rather than another repository's HEAD, and each APK is ~43 MB, so
ordinary history would grow by that much per release forever and `pages.yml` would clone all
of it on every single site deploy. Force-pushing is safe precisely because nothing on that
branch is a source of truth — the APKs are on the Releases page, the metadata is on `main`,
and the index is reproducible from the two. It uses `github.token`, not a PAT: the one-PAT-
per-index doctrine is about *cross*-repository writes.

**An F-Droid repository is cumulative**, so the job checks the branch out and carries the
previous APKs forward before regenerating. Building from this release's APK alone would
drop every earlier version from the index on the first release after this one, and a version
that vanishes from an index is not an error anywhere — it is simply gone, including for a
client that wants to reinstall it. The job then prunes to the newest three, which is a size
decision about one branch rather than a correctness one.

**`apksigner` must be installed in that job.** Without it `fdroidserver` falls back to
`jarsigner`, which cannot see an APK Signature v2 block — the only scheme the release APK
carries — concludes the jar is unsigned, moves the APK to `archive/` and publishes an
**empty** repository. That is a warning in the log and a green job, and the client shows the
repository as present with no apps in it, which reads as "no releases yet". The assertions
after `fdroid update` exist for exactly that failure and each one names its consequence.

**`fdroid/icon.png` is the repository icon's source, and it is deliberately not committed at
`fdroid/repo/icons/icon.png`.** `fdroid update` owns that directory and overwrites the file
there with a generated placeholder; the job copies the source in on every run.

**`fdroidserver` does not run on Windows**, so `mise run app:fdroid` is Linux/WSL only.
`update.py` builds its source-directory paths with `os.path.join` and then parses them by
splitting on `/`, so on Windows `os.walk`'s backslashes yield one segment and it dies with a
bare `IndexError`. That is upstream, not configuration.

**The site deploy after an app release is a `workflow_dispatch`, not a tag trigger on
`pages.yml`.** The race decides it: a tag-triggered pages run starts on the same push and
would check out `fdroid-repo` some fifteen minutes of Rust builds *before* the `fdroid` job
pushes to it, deploying the previous repository and never looking again. A `pages` job with
`needs: fdroid` is ordered by construction. It also sidesteps the tag-trigger staleness
documented at the top of `pages.yml` — whose recorded workaround *is* a `workflow_dispatch`
on `main` — and it leaves that file's anchored-glob comment true. That job needs an explicit
`permissions: { actions: write, contents: read }` block, and a job-level block **replaces**
the workflow one rather than adding to it.

**The APK is signed and everything else is not, and the Release body must keep saying
so.** There is no Windows certificate and no Apple Developer account, so macOS
quarantines the `.dmg` and SmartScreen warns about the installer. Those warnings are
accurate and the notes give the incantation for each rather than letting someone meet
them cold — a tool whose subject is authenticating the other end is the worst possible
place to teach people to click through a publisher warning. Build provenance
attestations are on every file, which is a verifiable claim about origin and not a
code signature; do not describe it as one. The Microsoft Store copy is signed by
Microsoft, but it is not an exception on the Release page: the `.msix` never becomes a
Release asset, and every Windows file there is still unsigned.

**The Android signing key never enters the repository.** `ANDROID_KEYSTORE_BASE64`
and its three passwords are repository secrets, written into `RUNNER_TEMP` and a
`keystore.properties` for the length of one job. `gen/android/app/build.gradle.kts`
reads that file *if it exists* and leaves the release build unsigned if it does not,
which is what keeps a keyless `mise run app:android:build` working — and is also
exactly how an unsigned APK could reach a Release unnoticed, so the workflow runs
`apksigner verify --print-certs` rather than trusting it. It deliberately does not
fall back to the debug key: a release APK signed with a per-machine debug certificate
installs, looks fine, and attests to nothing.

**`ANDROID_CERT_FINGERPRINT` is a repository *variable*, not a secret**, read by
`pages.yml` into `build-site.mjs`'s `wellKnownFiles`. A certificate fingerprint is
published by design at a well-known URL on that very domain; storing a public value
as a secret teaches that the secret list is where things go to feel safe. Setting it
is what makes `.well-known/assetlinks.json` non-empty — but on its own it was not
close to enough, and the two things it was hiding are worth knowing before debugging
a failed app link.

**`.well-known/` is a hidden directory, and `upload-pages-artifact` drops those unless
`include-hidden-files: true` says otherwise.** Measured live from one build:
`/edge/apple-app-site-association` served 200 while `/edge/.well-known/assetlinks.json`
served 404. Android reads assetlinks *only* from the dotted path, with no root
fallback. The comment above that step had predicted this failure and named the fix, and
it still shipped — so `pages.yml` now asserts the file is in `_site` rather than trusting
prose.

**The Android package name is not the bundle identifier.** `com.stan_ely.qrdrop`, with
underscores: a package name is a Java package name and cannot contain a hyphen, so Tauri
rewrites the configured `identifier` when it generates the Gradle project. `build-site.mjs`
derives it rather than restating it. Android matches it exactly and says nothing when it
does not match — the link just keeps opening the browser, which is indistinguishable from
association not being set up at all.

Note *which* half of the site the variable reaches: both trees are built in that job, but
the stable one at `/` comes from the latest `v*` tag, and a tag cut before `wellKnownFiles`
existed emits no association files at all. So association is live at `/edge/` and reaches
the domain root on the next npm release.

The lesson under all three: **check the served URL, not the built tree.** Everything here
was generated correctly in `site/dist/` the whole time.

**The Android share sheet is four files and a handoff on disk, and the handoff
is the design, not a shortcut.** An `ACTION_SEND` intent arrives as a
`content://` URI that only Android's ContentResolver can open — there is no path
for Rust to read and no way to pass the descriptor across without a full Tauri
Android plugin (a Kotlin class, a Rust binding, a Gradle entry and a permissions
manifest) for what is, in the end, one filename and one number. So
`MainActivity.kt` copies the stream into the app's cache directory and writes
`qrdrop-share.json` beside it; `src-tauri/src/share.rs`'s `take_shared_file`
**reads and deletes** that file; `app/src/main.js` turns it into a `File` and
calls the component's `sendFile`.

Four things there are load-bearing and none are obvious. The Rust side is plain
`std::fs` on the app's own cache directory and is registered on **every** target,
not gated behind `#[cfg(target_os = "android")]` — that is what lets it compile
and unit-test on a desktop host where no share sheet exists, and a command that
existed on one platform only would be a command whose absence JS has to
special-case. It is a **take**: leaving the handoff in place re-offers the same
file on every resume. Kotlin handles `onNewIntent` as well as `onCreate`, because
the activity is `launchMode="singleTask"` and a share into a *running* app never
calls `onCreate` — handling only the latter works exactly once per cold start,
which is the most misleading way this could fail. And JS takes both handoffs on
load, on `window.focus`, **and on a 1.5s poll** — where the poll is the half that
actually works on Android.

**`window.focus` never fires in this webview, and neither does anything else that
would announce a resume.** Measured on the device: across a background→foreground
cycle there is no `focus`, no `blur`, no `pageshow`, and no `visibilitychange` —
`document.visibilityState` reads `visible` and `document.hasFocus()` reads true
for the whole time the app sits behind the launcher. The webview is simply never
told. So the warm path — a share or a tile reaching an app that is already
running — silently did nothing: the handoff sat in the cache directory, unconsumed,
with the app foreground on top of it. Confirmed with no debugger attached, because
an attached debugger can itself keep a page from being backgrounded, and from both
the launcher and another app. The `focus` listener stays because it costs nothing
and does fire on desktop; the poll is what makes the feature work.

**The poll deliberately does *not* skip a busy component**, and gating it on the
choose screen was tried and reverted. Gating the *take* looks obviously right —
the take deletes, so why spend an intent that will only be declined? — and it
quietly converts "declined, and said so" into "deferred": the file waits and fires
whenever the app next reaches the choose screen. A transfer ends on **done**, not
choose, so a tile tapped mid-transfer would ambush the person with a scanner they
asked for minutes earlier and have stopped expecting. A tile pulled from inside
another app means *scan now*; if qrdrop cannot, the honest answer is the toast
`startAction` already shows while they are still looking.

The file is read through the **asset protocol** (`convertFileSrc` + `fetch`),
never `plugin-fs`. A Blob in a Chromium webview is disk-backed, so the `File`
built from the response slices lazily and `src/web/source.js`'s 2 MiB blocks and
read-ahead work on it unchanged. `plugin-fs`'s `readFile` would pull the whole
file across IPC into JS memory at the ~2 MB/s that path measures — eight minutes
and a gigabyte of heap for a 1 GB share, before the first frame goes out. Same
reasoning `tauri-sink.js` records for the write side. The asset scope is narrowed
to that one cache subdirectory in `tauri.conf.template.json`, and `ASSET_ORIGINS`
in `build-site.mjs` is what puts it in the app's CSP and, deliberately, not the
website's.

Verified as far as a machine here can take it: `mise run app:android:build --
--debug` compiles the Kotlin and packages an APK whose *packaged* manifest
carries the SEND/SEND_MULTIPLE filter with `*/*` beside the untouched
MAIN/LAUNCHER and deep-link filters (`aapt2 dump xmltree <apk> --file
AndroidManifest.xml`), the Rust cross-compiles for all four Android targets,
and `share.rs`'s tests pass on the host. What that cannot show is the share
actually appearing in the sheet and landing, and whether Tauri's
`app_cache_dir()` resolves to the same directory as Kotlin's `cacheDir` — the
one assumption the chain rests on. Check the served behaviour, not the built
tree, remains the rule. (That one is now answered: it does — measured on
device, `app_cache_dir()` is Kotlin's `cacheDir`.)

**The Android entry points are the share sheet's chain carrying an intention
instead of a file, and that reuse is the design.** A launcher shortcut
(long-press the icon) and the Quick Settings tile both mean "open qrdrop, on
this screen". Both put a string in `EXTRA_LAUNCH_ACTION`;
`MainActivity.stashLaunchAction` writes `qrdrop-launch.json` beside the share's
handoff; `share.rs`'s `take_launch_action` **reads and deletes** it;
`app/src/main.js` hands the name to the component's `startAction`. Same file-on-
disk bridge, same take-not-read, same called-on-load-and-on-focus, same
registered-on-every-target. A second mechanism for the second entry point was
the alternative and it is one more thing to keep in step with a chain that
already has four links.

Four things worth knowing before touching it. **The two handoffs are separate
files**, because both are taken on the same resume and a shared union would
have a shortcut's pickup swallow a file — `share.rs` has a test for exactly
that, since it would otherwise surface only as "sharing into a cold app
sometimes does nothing". **The action string is not trusted input** despite
coming from our own manifest: `MainActivity` is exported, so any app can fire
that extra at it. Nothing interpolates it — Kotlin filters it against
`LAUNCH_ACTIONS` and `startAction` looks it up in a fixed map — but the reason
it is safe is worth keeping true rather than rediscovering. **`startAction`
goes through `_dispatch`**, like `sendFile` goes through `_startSend`, and is
guarded to the choose screen for a sharper reason than any other caller: a tile
can be pulled down from inside another app while a transfer is running here,
and the person doing it cannot know that. And **`startActivityAndCollapse`'s
`Intent` overload throws on API 34+** — the version branch in
`QrdropTileService` is not politeness about a deprecation warning.

The set of action names is defined in three places and deliberately not four:
`res/xml/shortcuts.xml` names them, `MainActivity.LAUNCH_ACTIONS` filters them,
`element.js`'s `startAction` maps them to intents. `share.rs` carries the string
without an enum, because a fourth definition would be the only one nothing can
check against the others.

**`navigator.wakeLock` is held on every screen where something is running, and
that is a `src/web` concern rather than an Android one.** `RUNNING_SCREENS` in
`element.js` drives both it and the back guard below — one set, because they are
two readings of one fact and two sets would be two places to add the next screen
to. Beam is why it exists: minutes with the phone held up to another camera and
nothing touching the screen, which is exactly what a display timeout counts. A
Kotlin `FLAG_KEEP_SCREEN_ON` would have fixed the packaged app and left the
deployed site — where most of this runs, with the identical problem — alone.
The app has a secure context for it (`http://tauri.localhost`; `*.localhost` is
potentially trustworthy, which WebCrypto already working there proves). The
platform revokes the lock whenever the page is hidden and does not give it back,
so the `visibilitychange` listener is not optional: without it, one glance at a
notification frees the display for the rest of the transfer.

**The back gesture is answered, not navigated with.** It always existed —
`WryActivity` installs an `OnBackPressedCallback` that calls `mWebView.goBack()`
when `canGoBack()` and finishes the activity otherwise — so before this, an
accidental swipe closed the app mid-transfer, silently, and the installed PWA
and a browser tab did the same. `element.js` pushes one sentinel `pushState`
entry while a session is running and winds it off when it ends; a `pushState`
entry is a navigation-controller entry, so `canGoBack()` sees it and one
implementation covers the app, the PWA and the web. **Screens are not history
entries and back must never move between them.** The entry exists only to be
caught, and the answer to catching it is a question — refuse once with a toast,
cancel on a second press inside the toast's own 4000ms. That is what keeps the
two safety gestures safe: back may offer to cancel on the verify screen and on
beam's Accept, and nothing anywhere can advance past either. Do not "finish"
this by mapping back to screen transitions.

**Dark mode on this app is not under our control, and the investigation is
recorded here so it is not repeated.** The app theme is DayNight, so on a phone
in night mode the page comes out dark — but not by our doing. `tokens.js` has a
contrast-checked dark palette and it does not run: `prefers-color-scheme` reports
**light** while the render is dark, because what darkens it is a post-render
pixel transform, invisible to CSS and JS. The accent ships as `rgb(224,134,98)`
rather than `#a8462d`.

Two fixes were tried on a Realme RMX3868 (Android 16, WebView 151, targetSdk 36)
and only one of them belongs in the tree:

- `color-scheme: light dark` — **kept**, see below.
- `WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, true)` in a
  `MainActivity.onWebViewCreate` override — **reverted**. The call is reached and
  the feature is supported (WebView 105+), and `prefers-color-scheme` stays light
  regardless. WebView is evidently not the thing darkening: this device runs
  ColorOS's own force-dark compat engine (`customize_darkmode_opcompat=1`, tuned
  by `DarkMode_BackgroundMaxL` / `DarkMode_ForegroundMinL`), which sits outside
  WebView's `color-scheme` negotiation entirely. A permanent fourth hand-edit in
  `gen/` that measurably does nothing is worse than none — the same argument
  `tokens.js` makes about a token nothing consumes — so it is gone.

**The CSS half is kept and is not speculative.** `color-scheme: light dark` is
emitted by `tokensCSS` and stated in a `<meta>` for the first paint. Chrome for
Android under force-dark honours it with no app-side opt-in, so the deployed site
gets the real palette from that change alone, and it also fixes the UA-drawn form
controls and scrollbars everywhere. What it cannot do is beat a vendor
compositor.

The visible improvement on the app came from somewhere else entirely: `.dropzone`
was carrying a UA `buttonface` background (`appearance: none` does not clear it),
which the force-dark transform turned into a grey slab filling most of the
landing screen. That is fixed, so the darkened render is now merely not-our-
palette rather than broken.

**ColorOS freezes the app while the save dialog is open, and a slow choice loses the
sender.** Also vendor behaviour outside the WebView, also not worked around, and recorded
so the next device session does not re-derive it. The dialog is its own task, so opening
it is qrdrop leaving the screen, and `OplusHansManager` walks it through `R` for 6 s, `M`
for 5 s, then `F`: the process frozen and `OAppNetControlService: Close socket ...
App bg(IMMEDIATELY)` in the same millisecond, about 11 s after the dialog opened, every
run. The socket close is **not** what breaks a transfer — it takes the relay WebSockets
and leaves a direct UDP peer connection alone (a TCP-relayed one would presumably be cut;
not measured). What breaks it is a freeze longer than the sender's ICE consent timeout,
libjuice's `CONSENT_TIMEOUT` of 30 s: in the dialog 2 s and 20 s received, 45 s lost the
sender. Two things about testing it. **A run with the app on the `deviceidle` whitelist
passes for a different reason and proves nothing about a default install**: the freeze
still happens, but a whitelisted app is thawed by each incoming packet and so answers the
consent checks — the first passing Android receives had that whitelist on, which is why
this took a second session to find. And DocumentsUI cannot be read by `uiautomator dump`
("null root node"), so a timed Save is an `adb shell input tap` at coordinates taken from
a screenshot. The full table is in `app/CAPABILITIES.md`.

**Comments in `AndroidManifest.xml` must not contain a double hyphen.** XML
forbids it inside a comment and this repository's prose style uses it as an em
dash. Gradle reports the result only as `Error parsing AndroidManifest.xml`.

**`element.js`'s `sendFile()` is the one public way to hand the component a
file from outside it**, and it has two callers that are not a person clicking:
the deployed site receiving an OS share (`site/sw.js` → `site/main.js`) and the
Tauri shell receiving an Android intent. It is guarded to the choose screen
exactly as drop, paste and `_consumeHashCode` are — a share can arrive at an app
that is already open and busy — and it returns whether it was accepted so a
caller can tell "sent" from "ignored". It goes through the same `_startSend`
everything else does, so the SAS is still confirmed before any manifest leaves.
Do not add a second external entry that reaches past it into `_startSend`.

**The platform seam must stay a seam.** `src/web/element.js` reads
`getPlatform().createSink` from `src/web/platform.js` rather than importing
`web/sink.js`. `registerPlatform()` is called by `app/src/main.js` and by nothing
else — never `site/main.js` — so the deployed site cannot regress from a change made
for the app. `platform.js` imports only `sink.js`; it ships in `qrdrop/web`.

**The native sink's byte path does not use `plugin-fs`, and must not be "simplified"
back to it.** On WebView2 `@tauri-apps/plugin-fs`'s `write()` moves bytes at ~2 MB/s
regardless of block size — its argument is not travelling the raw IPC path, whatever
the docs imply. `app/src-tauri/src/sink.rs`'s `sink_write` takes the bytes in the
invoke request's raw body (`tauri::ipc::InvokeBody::Raw`) instead and does ~40 MB/s.
A JSON-array `invoke('save_chunk', { data: [...] })` is the *other* wrong answer — a
megabyte becomes a million stringified numbers.

**Opening the destination does use `plugin-fs` — its Rust API — and must not be
"simplified" back to `File::create`.** On Android, `plugin-dialog`'s `save()` returns
a `content://` URI from the Storage Access Framework, not a path. `File::create` on
that string fails with `os error 2`, and that is why the Android app shipped unable
to receive. `sink_open` hands the string to `app.fs().open()`, which resolves a
content URI through the ContentResolver into a real file descriptor and is plain
`std::fs` on desktop, so what `sink_write` holds is an ordinary `File` everywhere.
`sink_open` is `async` because on Android that open is a round-trip into plugin-fs's
Kotlin half, and a synchronous command would block the main thread on it.

**`sink_close` opens a `content://` URI a second time, in `"wa"`, and that is not
redundant.** Every file the app received on Android was listed as 0 B by the Files app
and by anything else reading the media index, while its bytes were whole. plugin-fs's
Kotlin half calls `detachFd()` so Rust can own an ordinary `File`; MediaProvider wraps
every *write* open in a close listener that rescans the file, and `ParcelFileDescriptor`
reports a detach to that listener exactly as it reports a close — immediately. So the
scan ran at `sink_open`, on a file `"wt"` had just emptied, and when Rust closed the real
descriptor nobody was listening. Measured on the Realme: the index row's `date_modified`
was the second of the open, and it still said 0 bytes ten minutes later. Reopening after
close fires the listener on the finished file (`_size=3000000`, hash equal). Both letters
of the mode are load-bearing: `"r"` gets no listener and rescans nothing, and a write mode
without append is allowed to truncate, which would wipe the file the index is being asked
to look at. Closing instead of detaching on the Kotlin side was the alternative, and it
means a Tauri plugin of our own or a patched plugin-fs for what one open achieves. The
reopen is best effort: the file is complete before it is tried, and failing a finished
transfer over a stale listing would report the wrong thing about the part that worked.

**Android has no raw body, so the sink's blocks go there as base64.** Tauri's IPC
script never uses the custom-protocol transport on Android (the WebView's request
interceptor cannot read a POST body), so every invoke arrives through `postMessage`
as JSON and `InvokeBody::Raw` never appears. Fixing `sink_open` alone got a device
to 1020 KB of a 2.9 MB receive and then `sink_write expects a raw body` at the first
1 MiB flush. `sink_write` now takes the raw body or `{ data: <base64> }`, and
`sink_open` returns which one this target can carry — `!cfg!(target_os = "android")`,
the same condition Tauri's script keys on — so `tauri-sink.js` never sniffs a user
agent. Desktop keeps the raw path unchanged. Do not "unify" the two by sending
base64 everywhere: that throws away the measured desktop rate for a platform that
was never going to have it. Nor by sending the bare `Uint8Array` on Android, which
the JSON path spells out one number at a time.

It also failed *invisibly*: `receiver.js`'s `accept()` used to turn any `createSink`
rejection into `null`, and `element.js` reports a `null` sink as "The save dialog was
closed without choosing a location". The person had pressed Save, the document existed
at 0 bytes, and the screen said they had cancelled. The contract is now two-valued: a
sink **resolves `null`** when the person dismissed the dialog, and **rejects** only
when saving failed, which `accept()` tells the peer and hands back to its caller. That
is why `web/sink.js` turns `showSaveFilePicker`'s `AbortError` into `null` itself. Do
not catch a sink rejection into `null` anywhere again — it is the one move that makes a
failure and a choice indistinguishable.

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
about eleven minutes. The read-ahead then took the same 64 MiB to **16.8 s
(4.03 MB/s)**, measured on the device with both sides rebuilt from one commit,
and **reads now cost the transfer nothing**: across the 31 block boundaries the
read-ahead was late zero times, finishing 160-440 ms before the sender wanted
it every time. Note total read *wall* time rose there, 5,988 ms to 7,475 ms --
a read that runs against a busy main thread is slower in wall time and cheaper
in cost, so "share of the window spent reading" stopped being a cost measure at
that point and must not be quoted as one. The bottleneck past this is the
transport, not this file.

**This was never Tauri-specific, and `src/web/source.js` is the right home for the
fix because of it.** Chrome 152 on the same phone, same file, same SAF dialog,
measures ~72 ms fixed + ~1.8 ms/MiB -- it does not copy the picked file into its
cache, it passes the `content://` through like wry. So the deployed site had this
for every Android sender too, at 0.22 MB/s on a 16 KiB frame. Desktop browsers were
fine because a `File` there is backed by a real filesystem, which is exactly why it
survived: the sender was always a desktop or the Node CLI (`src/node/source.js`, a
different adapter entirely) until a phone was pointed at it.

Two traps in that constant. It does **not** match `tauri-sink.js`'s 1 MiB -- the
write side amortises a ~3 ms invoke and flattens after 256 KiB, this amortises a
~79 ms round-trip and is still climbing at 16 MiB -- so "make them the same" is
wrong in both directions. And **raising it is the wrong fix for time spent
reading**, which is what the read-ahead beside it is for: `sender.js` awaits
`slice()` before it seals, so a read at a block boundary stalls the channel, and a
bigger block only makes those stalls fewer and longer for double the memory each
time. `fromFile` instead issues the *next* block's read as soon as the current one
lands, so the round-trip overlaps the ~128 frames still to be transmitted. Peak is
therefore two blocks, and that is the price the constant is chosen against.

Three things in that read-ahead are load-bearing and none are obvious. A frame
straddling a block boundary is **stitched from both blocks**, not refilled from its
own offset -- `CHUNK_SIZE` divides no power of two, so every boundary lands
mid-frame, and refilling there would leave each prefetched window at an offset
nothing ever asks for, discarding the read-ahead at every boundary. The prefetch
promise **swallows its own rejection into a `null`**, because nothing awaits it
until the caller reaches that offset (possibly never, on a cancelled transfer) and
an escaping rejection would surface unhandled, against unrelated work; the call
that actually wants those bytes re-reads them and throws in its own right. And it
returns a copy of the block rather than a subarray view, unlike
`src/node/source.js`, which can hand back a view only because it refills its buffer
on every single `slice()` -- here a view would alias a buffer being replaced by a
read already in flight. `test/web-source.test.mjs` counts the underlying reads and
their offsets, which is the only way to see any of this from Node.

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

`npm run test:e2e:interop` used to fail on most runs (4/4 at `87fb583`, 3/5 at `e8aaf50`):
the file transferred whole, both sides computed the digest, and the sender then reported
`The other device disconnected` and exited 1. This section blamed the receiver's
`room.close()` racing the flush of its `done`, and that was wrong. Trystero's `leave()`
sends its leave message *behind* the `done` on the same ordered channel, and both reach
the sender in order, one microtask apart — but `room.onFrame`'s callback does not await
`handleFrame`, so the `done` was still in AES-GCM decryption when the leave handler
failed the control stream. **A leave handler that fails a control stream must wait on
`receiver.settled()` first**, as `runSend` in `src/cli.js` and both `_startSend` and
`_startReceive` in `src/web/element.js` now do; failing straight away also turns a decline,
or an error the receiver sent before closing, into a disconnect.

The receive side came last (`18a4acc`) and carries two guards the send side does not. Its
leave handler fails the transfer only on `verify` or `transfer`, because a Decline resets
to choose **without** setting `_sessionEnded`, and a late leave must not fail a session
that already ended there. And the Accept handler (`_onOfferAccept`) checks `_sessionEnded` *before* reading a
`null` sink as a dismissed dialog: when the sender left while the dialog was up, the leave
handler has already cancelled the receiver, `accept()` hands back `null` for a file it
released, and reading that as "the save dialog was closed" replaces the real reason with
the wrong one. Without both, the phone opened the error sheet on the thaw, `accept()`
returned 400 ms later, the transfer screen replaced the sheet (a screen change clears a
modal), and "Receiving, 0%" stood there with the file open and nothing left that could
end it. `test/transfer.test.mjs` reproduces it
deterministically (both leave-right-behind tests fail without the wait), and after the
fix the interop suite passed 5/5 against 3/5 failures from the unfixed tree on the same
network in the same half hour.

Both e2e suites also fail for ordinary reasons — a relay being unreachable is expected
weather, not a bug in this code.
