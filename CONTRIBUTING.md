# Contributing

Bug reports and pull requests are welcome. Security reports are not — those go
through [SECURITY.md](SECURITY.md), privately.

```bash
npm install
npm test            # unit suite, offline, about 2s
npm run typecheck   # two tsc runs; both must pass, see below
npm start           # build, then serve the site on :4173
```

[`docs/protocol.md`](docs/protocol.md) and [`docs/threat-model.md`](docs/threat-model.md)
are the long-form explanation of the protocol, what it protects, and why the
transport seam is where it is. Read them before changing anything under
`src/core/` or `src/transport/`. `CLAUDE.md` is the
same territory written as a list of things that have already broken once; it is
addressed to an agent, but the invariants in it are real and apply to everyone.

## The rules that are not negotiable

Each of these exists because it was broken before, usually invisibly.

**Both typecheck passes, always.** `src/core/` and `src/transport/` are checked
once with Node's globals and once without them. That double pass is the only
thing making "isomorphic" a property of the build rather than a claim in a
comment — a stray `Buffer.from` in core passes one and fails the other. Run
`npm run typecheck`, never a single `tsc`.

**Neither safety gesture may be softened.** The sender confirms the SAS before
a manifest goes out, because the manifest alone leaks the filename and size.
The receiver's Accept click is also the user activation that lets
`showSaveFilePicker` open, so nothing may be `await`ed ahead of `createSink` in
that handler. `--yes` skips the accept prompt and must never skip the SAS.

**The code comes from the URL fragment, never the query string.** A fragment is
the one part of a URL that is never sent to a server, which is the entire reason
a link may carry a key at all.

**No new runtime dependencies.** Four, plus one optional. Every dependency is
one more thing between `npm install` and a working transfer, which is why the
virtual DOM in `src/web/vdom.js` is hand-rolled rather than being preact.
devDependencies are a different question and a much easier one.

## House style

Two-space indent, no semicolons, single quotes, JSDoc types throughout —
`checkJs` over plain ES modules, with no build step for the published code.

Comments are long, and they explain **why**. The useful ones name the
alternative that was rejected and the failure it would have caused; a comment
restating what the line does is worse than no comment. Read the file you are
editing and match its register before writing.

Commit subjects are `type(scope): lowercase clause, and a second clause`.
Bodies are prose paragraphs rather than bullet lists, and say what was
reasoned, measured, or ruled out.

## Tests

`npm test` is offline and must stay that way — it is what CI runs.

The two end-to-end suites are not in CI and are expected to be run by hand:

```bash
npm run test:e2e          # two real browsers over public relays
npm run test:e2e:interop  # two Node processes driving the CLI
```

They depend on public Nostr relays, so they fail for reasons that have nothing
to do with your change — a relay being unreachable is weather. A red tick for
weather teaches everyone to ignore red ticks, which is why they are kept out.
A failure that is not a relay is worth chasing: the interop suite used to fail
on most runs for a real reason, and the note at the foot of `CLAUDE.md` records
what it was.

<details>
<summary><b>Why the interop suite spawns two processes</b></summary>

Trystero computes `selfId` once per module instance, so two rooms sharing a
process also share an identity: each sees the other's announcement carrying its
own id, discards it as itself, and they wait for each other until the timeout.
That is a property of Trystero rather than a bug here, but it is invisible
until you try it.

</details>

<details>
<summary><b>Type checking without a build step</b></summary>

`tsc --noEmit` with `checkJs` over the JSDoc. The published sources are plain ES
modules, unbundled and untranspiled; only the site's browser bundle is built.

There are three configs because there are three runtimes, and `src/core/` and
`src/transport/` deliberately appear in two of them. Being checked once without
Node globals and once with them is what makes "isomorphic" a property the build
enforces rather than a claim in a comment.

</details>

## Changing the web UI

`patch()` owns every child of the shadow root, so anything the view does not
describe is removed as stale, and the test suite reads text and visibility
rather than paint. Look at every screen when you change the view:
`node scripts/check-layout.mjs --shots` walks all of them, in Chromium and
Firefox, at four viewports, with a mouse and with touch, and fails on a page
that scrolls or a button off screen. Its assertions only see layouts that are
illegal, never ones that are legal and wrong, so read the pictures too. A whole
component reverting to unstyled browser defaults is invisible to a green test
run, and has happened. (`make-screenshots.mjs` renders the README's three
pictures and nothing else.)

All user-facing copy lives in `src/web/view.js`. If you are adding a string,
that is where it goes.

## Regenerating the images

Five hand-run scripts, none of them wired into `npm run build` — that runs in
CI and in `prepublishOnly`, neither of which should download a browser:

```bash
node scripts/make-og.mjs                             # site/og.png, the social card
node scripts/make-icon.mjs                           # the app mark and site/favicon.png
node scripts/make-diagrams.mjs                       # docs/diagrams/*.png, from the .mmd sources
npm run build && node scripts/make-screenshots.mjs   # docs/screenshots/*.png, for the README
node scripts/make-store-screenshots.mjs              # the store listing's phone screenshots
```

Their output is committed. Run the relevant one when the palette, the copy on
the card, or a diagram source changes.

## Where things are

```
src/index.js                 the isomorphic entry -- no DOM, no fs
src/core/secret.js           QR secret, HKDF derivations
src/core/session.js          ephemeral ECDH, directional keys, SAS
src/core/frame.js            per-chunk AEAD, nonce construction
src/core/control.js          ordered, sealed control messages
src/core/sender.js           chunking, backpressure, accept handshake
src/core/receiver.js         demux, verification, sink management
src/core/source.js           the FileSource contract
src/core/beam.js             beam's fountain code and framing
src/transport/room.js        Trystero pairing, relay list, ICE
src/transport/channel.js     the transport seam, on its own
src/web/view.js              every screen, and all user-facing copy
src/web/element.js           the qr-drop element: sessions, teardown, native events
src/web/vdom.js              h() and patch(), hand-rolled
src/web/styles.js            the component's CSS; tokens.js holds the design tokens
src/web/beam.js              beam's live halves: the canvas player, the camera collector
src/web/sink.js              File System Access, with a Blob fallback
src/node/                    fs sink, fs source, terminal QR, WebRTC polyfill
src/cli.js                   the qrdrop command

site/index.html              the page; CSP placeholder filled in at build
scripts/build-site.mjs       esbuild, and the generated CSP
scripts/check-layout.mjs     every screen, both engines, every viewport
types/qrdrop.d.ts            the Channel contract, and shared types

app/src/                     the Tauri shell's JS: native sink, deep links
app/src-tauri/               the Rust crate, and gen/ (committed; see CLAUDE.md)
docs/                        protocol, threat model, beam, app, hosting
```
