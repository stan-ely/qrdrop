# Hosting and deploying

## Your own copy

To host the browser UI somewhere of your own, every [release](https://github.com/stan-ely/qrdrop/releases)
carries `qrdrop-site-<version>.zip` — the built bundle exactly as it is deployed,
ready to unpack into a webroot — alongside the npm tarball, a `SHA256SUMS` file and
a build provenance attestation for both. `npm run build` from a clone produces the
same directory.

`npm run build` produces a self-contained `site/dist/`. Serve it over HTTPS —
WebCrypto and the camera are unavailable otherwise.

## How share.stan-ely.com is deployed

**The deployed site is two builds, from one artifact.** share.stan-ely.com serves
the latest released `v*` tag; **share.stan-ely.com/edge/** serves the tip of
`main`. They are built from two checkouts of this repo in one CI run, so each
page runs exactly the code of the ref it names — never one ref's `scripts/`
wrapped around another's `src/`. The footer of each says which you are on: a
version that links to its Release, or a short commit sha that links to its
commit, with a link across to the other. `.github/workflows/pages.yml` assembles
both, because a Pages deploy replaces the whole site and two workflows would
each delete the other's half.

Locally, `npm run build` is the stable tree alone — that is what `prepublishOnly`
packs into the npm tarball. To build and check the other one:

```bash
node scripts/build-site.mjs --channel edge --out site/dist-edge
node scripts/check-layout.mjs site/dist-edge
```

## Headers and the CSP

**GitHub Pages serves no custom headers**, so `site/_headers` is inert there:
`frame-ancestors`, `X-Frame-Options`, `Referrer-Policy`, and
`Permissions-Policy` are simply not set on share.stan-ely.com. Framing is still
blocked, because `site/main.js` refuses to run inside a frame — that check
exists precisely for hosts that cannot set the header. The rest are
defence-in-depth rather than load-bearing, and `_headers` is kept for anyone
deploying the same build to Cloudflare Pages or Netlify, which do read it.

The CSP is unaffected either way: it is delivered in a `<meta>` tag generated at
build time, so it survives a host that sets no headers at all.

