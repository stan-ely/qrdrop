# Contributing

Bug reports and pull requests are welcome. Security reports are not — those go
through [SECURITY.md](SECURITY.md), privately.

```bash
npm install
npm test            # unit suite, offline, about 2s
npm run typecheck   # two tsc runs; both must pass, see below
npm start           # build, then serve the site on :4173
```

The [README](README.md) is the long-form explanation of the protocol, the
threat model, and why the transport seam is where it is. Read it before
changing anything under `src/core/` or `src/transport/`. `CLAUDE.md` is the
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
`npm run test:e2e:interop` in particular fails on most runs and did so before
the UI work; see the note at the foot of `CLAUDE.md` before chasing it.

## Changing the web UI

`patch()` owns every child of the shadow root, so anything the view does not
describe is removed as stale, and the test suite reads text and visibility
rather than paint. Take screenshots when you change the view —
`node scripts/make-screenshots.mjs` drives every screen and is the cheapest way
to see all of them at once. A whole component reverting to unstyled browser
defaults is invisible to a green test run, and has happened.

All user-facing copy lives in `src/web/view.js`. If you are adding a string,
that is where it goes.

## Regenerating the images

Three hand-run scripts, none of them wired into `npm run build` — that runs in
CI and in `prepublishOnly`, neither of which should download a browser:

```bash
node scripts/make-og.mjs           # site/og.png, the social card
node scripts/make-diagrams.mjs     # docs/diagrams/*.png, from the .mmd sources
npm run build && node scripts/make-screenshots.mjs
```

Their output is committed. Run the relevant one when the palette, the copy on
the card, or a diagram source changes.
