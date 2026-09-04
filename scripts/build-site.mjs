/**
 * Builds site/dist/: the static bundle deployed to share.stan-ely.com.
 *
 * Everything here is Node-only -- this file is checked under tsconfig.node.json,
 * not tsconfig.json, and unlike src/web/ it is free to use fs, path, and
 * http. Nothing under site/dist/ is committed; it is generated fresh by
 * `npm run build` (see package.json).
 *
 * Run with `--serve` to also serve the result on http://localhost:4173 for
 * local testing. localhost counts as a secure context even over plain HTTP,
 * so WebCrypto and the camera both work there the same as they would over
 * real HTTPS -- that is what makes local testing possible at all, since
 * site/main.js and the element both fail closed off a secure context.
 *
 * Two more flags exist for the deploy, which serves two builds of this repo
 * side by side (see .github/workflows/pages.yml): `--channel edge` marks the
 * output as the bleeding build from main rather than the last released tag,
 * and `--out <dir>` puts it somewhere other than site/dist so the two builds
 * do not clobber each other's `rm -rf`. Both default to the stable, single-tree
 * behaviour, because that is what `npm run build` and `prepublishOnly` want:
 * site/dist ships inside the npm tarball, and an edge/ subdirectory in there
 * would be a second copy of the app nobody asked for.
 */

import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, copyFile, rm, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SIGNALING_URLS } from '../src/transport/room.js'
import { tokensCSS, BREAKPOINT_WIDE, BREAKPOINT_SHORT } from '../src/web/tokens.js'
import { sheetCSS, buttonCSS } from '../src/web/styles.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SITE = path.join(ROOT, 'site')
const DIST = path.join(SITE, 'dist')

/**
 * The deployed origin, in one place.
 *
 * It has two consumers that must agree: the CNAME file written below (which
 * is what actually binds the custom domain on GitHub Pages) and the absolute
 * URLs in site/index.html's Open Graph tags, which crawlers fetch with no
 * document to resolve a relative path against. Those tags carry an
 * __ORIGIN__ placeholder rather than the domain typed out a second time --
 * the same reasoning as `buildCSP` below and src/web/tokens.js: two copies
 * of one fact drift the first time only one of them is edited, and here the
 * drift is silent, because a wrong og:image is invisible until someone else
 * pastes the link somewhere.
 */
const ORIGIN = 'https://share.stan-ely.com'

/**
 * The repository the build stamp links into, in one place for the same reason
 * ORIGIN is: releases/tag/<v> and commit/<sha> are two URLs derived from it,
 * and site/index.html's footer already names this repo a third time in the
 * Source link. That third one stays hand-written -- it is prose in the markup,
 * not a URL this script assembles -- but the two generated ones share a root.
 */
const REPO = 'https://github.com/stan-ely/qrdrop'

/**
 * Where the deployed site serves the bleeding build from main.
 *
 * A trailing slash, and it matters twice: as a directory name under the output
 * root it must not be absolute, and as the href of the "Edge build" link it
 * must not be `/edge` -- GitHub Pages would answer that with a redirect to
 * `/edge/`, which is a wasted round trip on a page whose whole pitch is that
 * it is small.
 */
const EDGE_PATH = 'edge/'

/**
 * What the footer's build pill says, where it points, and which og:url the
 * page claims -- everything that differs between the two channels, derived in
 * one pure function so test/build-site.test.mjs can pin it without a build.
 *
 * The two channels answer different questions, so they carry different
 * identifiers rather than the same one formatted twice. Stable is a release:
 * the only thing a visitor can act on is the version, which is what they would
 * `npm install`, so it reads `v0.3.1` and points at that Release. Edge is a
 * commit: there is no version to speak of -- package.json on main says whatever
 * the last bump said, which is the *previous* release and would be an actively
 * misleading label -- so it reads the short sha and points at that commit.
 *
 * The full ISO date rides in the title attribute rather than the label. It is
 * the thing someone wants when they are asking "is my fix deployed yet", and it
 * is also the thing that would wrap the footer row onto a second line if it
 * were visible, on a page that has no spare vertical pixels anywhere.
 *
 * @param {{ channel: string, version: string, commit: string, date: string }} meta
 * @returns {{ channel: string, label: string, href: string, title: string, ogUrl: string }}
 */
export function buildStamp({ channel, version, commit, date }) {
  if (channel !== 'stable' && channel !== 'edge') {
    throw new Error(`Unknown channel ${JSON.stringify(channel)} -- expected 'stable' or 'edge'`)
  }

  if (channel === 'edge') {
    return {
      channel,
      label: `edge · ${commit}`,
      href: `${REPO}/commit/${commit}`,
      title: `Built from main at ${commit}, ${date}. This is the development build; it may be broken.`,
      ogUrl: `${ORIGIN}/${EDGE_PATH}`,
    }
  }

  return {
    channel,
    label: `v${version}`,
    href: `${REPO}/releases/tag/v${version}`,
    title: `Release v${version}, ${date}.`,
    ogUrl: `${ORIGIN}/`,
  }
}

/**
 * The version, commit and date this build is of.
 *
 * Every lookup falls back rather than throwing, because this script runs in
 * three places that do not all have the same things available: a git checkout,
 * a CI runner, and `prepublishOnly` inside whatever directory npm is packing
 * from. A build that dies because `git` is not on PATH would be a stamp
 * breaking the thing it is supposed to describe.
 *
 * git is asked BEFORE process.env.GITHUB_SHA, which is the reverse of the
 * obvious order and is the point. The pages workflow builds the stable tree
 * after `git checkout <tag>`, and GITHUB_SHA still names the commit that
 * *triggered* the run -- the tip of main. Trusting it there would stamp the
 * stable page with a sha it was not built from. `git rev-parse HEAD` answers
 * for the tree actually on disk, always. The env var is kept only for a
 * checkout with no git history to read (a shallow clone with `fetch-depth: 0`
 * dropped, say), where a slightly-wrong sha still beats "unknown".
 *
 * @returns {Promise<{ version: string, commit: string, date: string }>}
 */
async function readBuildMeta() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))

  /** @param {string[]} args @returns {string | null} */
  const git = args => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }

  const commit = git(['rev-parse', '--short', 'HEAD']) ?? process.env.GITHUB_SHA?.slice(0, 7) ?? 'unknown'
  const date = git(['log', '-1', '--format=%cI']) ?? new Date().toISOString()

  return { version: pkg.version, commit, date }
}

/**
 * The Content-Security-Policy, as a single generated string.
 *
 * connect-src is built from SIGNALING_URLS -- every URL src/transport/room.js
 * may dial across all of its Trystero strategies (Nostr relays and WebTorrent
 * trackers) -- rather than typed out by hand a second time here. The old Hugo
 * template kept two lists (one in room.js, one in this meta tag) and a README
 * comment nagging whoever edited the first one to remember the second. Two
 * lists that must agree but are not the same list is a footgun waiting for a
 * distracted afternoon; deriving one from the other removes the chance of them
 * drifting apart, permanently.
 *
 * Each URL is reduced to its origin with `new URL(u).origin` (`wss:` is a
 * special scheme, so this yields `wss://host:port`) and deduped: a connect-src
 * entry that includes a path would restrict matching to that path prefix, and
 * a strategy whose URL carries one (a tracker announce path, say) would then
 * silently fail to connect. The STUN and TURN entries in ICE_SERVERS are
 * deliberately NOT here: `stun:` / `turn:` sockets are opened by the
 * RTCPeerConnection, which CSP does not govern.
 *
 * script-src is 'self' only. The previous build allowed
 * https://cdn.jsdelivr.net because the third-party modules (Trystero, the QR
 * libraries) were loaded as ESM directly from a CDN at runtime -- a real
 * concession, since jsDelivr could serve arbitrary JavaScript into the page
 * and saw every visitor's IP doing so. Bundling those dependencies into the
 * self-hosted output below closes that off entirely: nothing this page loads
 * comes from anywhere but this origin, so 'self' is honestly the whole list.
 *
 * style-src keeps 'unsafe-inline': the transfer progress bar is driven by a
 * `--progress` custom property set via `.style.setProperty` on an element
 * inside <qr-drop>'s shadow root (see src/web/element.js), which is an inline
 * style write. Style injection is a far smaller problem than script
 * injection, and there is no static CSS value to give that property instead
 * since it changes every animation frame.
 *
 * img-src allows data: and blob: for the QR code (rendered as inline SVG, so
 * strictly this is unused today, but harmless to allow) and any future
 * blob-based preview. media-src allows blob: and mediastream: for the camera
 * feed backing the QR scanner.
 *
 * frame-ancestors is deliberately absent from this tag: browsers only honour
 * it as an HTTP response header, never inside a <meta> tag, so putting it
 * here would be a comment that looks like protection and is not one.
 * site/_headers sets it properly for hosts that read that file (Cloudflare
 * Pages, Netlify), and site/main.js refuses to run inside a frame regardless
 * -- see that file -- so the protection does not depend on the host's
 * cooperation.
 *
 * @param {readonly string[]} signalingUrls
 * @returns {string}
 */
export function buildCSP(signalingUrls) {
  const origins = [...new Set(signalingUrls.map(u => new URL(u).origin))]
  const directives = [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `media-src 'self' blob: mediastream:`,
    `connect-src 'self' ${origins.join(' ')}`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `object-src 'none'`,
  ]
  // Semicolon-joined and collapsed to one line: a <meta> content attribute
  // tolerates newlines, but keeping it a single line avoids any doubt about
  // how a particular parser treats whitespace inside the attribute value.
  return directives.join('; ') + ';'
}

/**
 * Bundles site/main.js with esbuild's JS API (never the CLI -- the API keeps
 * this script a single `node scripts/build-site.mjs` with no separate esbuild
 * install step to document).
 *
 * `splitting: true` is not optional here. src/web/qr.js dynamically imports
 * jsqr so that its ~130 kB only loads on browsers without a native
 * BarcodeDetector (Firefox, mainly); without splitting, esbuild's ESM output
 * inlines every reachable module into the one entry chunk regardless of how
 * it was imported, and that lazy-load becomes pointless -- everyone pays for
 * jsQR whether their browser needs it or not. Splitting is verified after the
 * build by checking that more than one .js file landed in site/dist/.
 *
 * The output filename is content-hashed (`entryNames`/`chunkNames`) so a
 * redeploy is never served stale out of a browser or CDN cache under the old
 * name; site/index.html's script tag is rewritten to match after the build.
 *
 * SOURCE MAPS ARE SHIPPED ON PURPOSE, and this is the one place where that is
 * a security decision rather than a convenience one. This page asks people to
 * trust it with files on the strength of a threat model they cannot check by
 * reading 106 kB of minified output. A source map makes the deployed bundle
 * legible in devtools, so the claim "the confidentiality path is WebCrypto
 * only" is something a visitor can go and verify against the code actually
 * running in their browser rather than against the code in this repository.
 * They cost bandwidth on a page that is otherwise tiny, and they reveal
 * nothing: every line of this is public already.
 *
 * @param {string} dist
 */
async function bundle(dist) {
  const result = await esbuild.build({
    entryPoints: [path.join(SITE, 'main.js')],
    outdir: dist,
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'esm',
    target: ['es2022'],
    splitting: true,
    entryNames: '[name].[hash]',
    // Not 'chunk-[name]': esbuild already names shared split chunks "chunk",
    // so that prefix produces chunk-chunk.HASH.js.
    chunkNames: '[name].[hash]',
    metafile: true,
    absWorkingDir: ROOT,
  })

  const mainJsRel = path.relative(ROOT, path.join(SITE, 'main.js')).split(path.sep).join('/')
  /** @type {string | null} */
  let entryOutput = null
  for (const [outFile, info] of Object.entries(result.metafile.outputs)) {
    if (info.entryPoint === mainJsRel) {
      entryOutput = outFile
      break
    }
  }
  if (!entryOutput) throw new Error('esbuild did not report an output for site/main.js')

  return {
    // Filename only: index.html's script src is relative to site/dist/.
    entryFile: path.basename(entryOutput),
    outputs: Object.keys(result.metafile.outputs),
  }
}

/**
 * Reads `--name value` out of argv, or null if the flag is absent.
 *
 * Deliberately not `--name=value` as well: two accepted spellings is two
 * things to get wrong in a workflow file, and the only caller is that
 * workflow plus a hand-run check-layout.
 *
 * @param {string} name
 * @returns {string | null}
 */
function flagValue(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

async function main() {
  const serve = process.argv.includes('--serve')
  const channel = flagValue('--channel') ?? 'stable'
  const dist = flagValue('--out') ? path.resolve(ROOT, /** @type {string} */ (flagValue('--out'))) : DIST

  const stamp = buildStamp({ channel, ...(await readBuildMeta()) })

  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })

  const { entryFile, outputs } = await bundle(dist)

  // jsqr must land in a chunk of its own, separate from the entry bundle --
  // see the comment on splitting above. A build that silently regressed back
  // to a single bundle would still "work", so this is asserted rather than
  // left to be noticed later in a bundle-size graph nobody watches.
  const jsChunks = outputs.filter(f => !f.endsWith('.map'))
  if (jsChunks.length < 2) {
    throw new Error(
      `Expected at least 2 JS outputs (entry + a jsqr chunk), got ${jsChunks.length}: ${jsChunks.join(', ')}`,
    )
  }

  // site/styles.css consumes tokens (--bg, --sp-*, --fs-*, ...) but no longer
  // defines them -- see the comment at the top of that file. Writing the
  // dist copy is therefore `tokensCSS(':root') + the file`, not a copyFile,
  // so the page gets the same token values the component defines for its own
  // shadow root (src/web/tokens.js, via src/web/styles.js). Two token lists
  // that must agree but are not the same list is exactly the footgun
  // `buildCSP` above avoids for the CSP allowlist: one generator, read from
  // two places, instead of a second list someone has to remember to update.
  //
  // sheetCSS() and buttonCSS() are also injected here so there is one
  // definition of the .sheet dialog and .btn.ghost button styles, not hand-kept
  // copies in both src/web/styles.js and site/styles.css. The site's .sheet
  // uses var(--col) for a wider dialog than the component's 30rem.
  //
  // Breakpoint strings are interpolated at build time since CSS media queries
  // cannot read custom properties. This ensures the same breakpoint values are
  // used in both the component's shadow-DOM styles and the page's styles.
  let siteCSS = await readFile(path.join(SITE, 'styles.css'), 'utf8')
  // Interpolate breakpoint values into media query strings so they match the
  // component's styles exactly (defined in src/web/tokens.js).
  siteCSS = siteCSS.replaceAll('(min-width: 60rem) and (max-height: 62rem)', BREAKPOINT_WIDE)
  siteCSS = siteCSS.replaceAll('(max-height: 46rem)', BREAKPOINT_SHORT)
  const css = tokensCSS(':root') + sheetCSS('var(--col)') + buttonCSS() + siteCSS

  // Content-hashed exactly like the JS bundles, and for a reason that cost a
  // live deploy to learn: GitHub Pages serves everything with max-age=600 and
  // ignores site/_headers, so for ten minutes after a push a returning
  // visitor can hold a cached styles.css against freshly fetched HTML. New
  // markup with the previous stylesheet is not "slightly stale" -- an inline
  // <svg> the CSS was going to size renders at its 300x150 default in solid
  // black, which is what a phone showed. A hashed name makes that pairing
  // impossible: HTML that names styles.<hash>.css can only ever be served the
  // stylesheet it was built against, and an old cache entry is simply a file
  // nothing asks for any more.
  const cssFile = `styles.${createHash('sha256').update(css).digest('hex').slice(0, 8).toUpperCase()}.css`
  await writeFile(path.join(dist, cssFile), css)
  await copyFile(path.join(SITE, '_headers'), path.join(dist, '_headers'))

  // The social-preview card. Committed rather than rendered here, because
  // producing it needs a headless browser (scripts/make-og.mjs, run by hand
  // when the design changes) and `npm run build` runs in CI and in
  // prepublishOnly, where a browser download is not a dependency this repo
  // is willing to take on for an image that changes about never.
  await copyFile(path.join(SITE, 'og.png'), path.join(dist, 'og.png'))

  // Stable only. CNAME is what binds the custom domain, and GitHub Pages reads
  // exactly one of them, at the root of the deployed artifact -- the edge tree
  // is a subdirectory of that same artifact, so a CNAME inside it is not a
  // second binding, it is a file that looks like one. Skipping it keeps the
  // edge tree honest about being a subdirectory rather than a site.
  if (stamp.channel === 'stable') {
    await writeFile(path.join(dist, 'CNAME'), new URL(ORIGIN).host + '\n')
  }

  const csp = buildCSP(SIGNALING_URLS)
  const template = await readFile(path.join(SITE, 'index.html'), 'utf8')
  // replaceAll, not replace: __ORIGIN__ appears three times (og:url and two
  // image URLs) and `String.replace` with a string argument substitutes only
  // the first. The guard below is what turns that class of mistake into a
  // failed build rather than a page shipped with a literal __ORIGIN__ in an
  // href, so the two belong together.
  //
  // __OG_URL__ is separate from __ORIGIN__ rather than assembled from it,
  // because the two channels disagree about it and only about it: og:url must
  // name the page being previewed (/ or /edge/) while og:image stays on the
  // origin either way, since the edge tree has no og.png of its own worth
  // making and the card is the same picture regardless of which build served
  // it. One placeholder covering both would have to be right twice.
  const html = template
    .replaceAll('__CSP__', csp)
    .replaceAll('__SCRIPT__', entryFile)
    .replaceAll('__STYLES__', cssFile)
    .replaceAll('__OG_URL__', stamp.ogUrl)
    .replaceAll('__ORIGIN__', ORIGIN)
    .replaceAll('__CHANNEL__', stamp.channel)
    .replaceAll('__BUILD_LABEL__', stamp.label)
    .replaceAll('__BUILD_HREF__', stamp.href)
    .replaceAll('__BUILD_TITLE__', stamp.title)

  const leftover = [
    '__CSP__', '__SCRIPT__', '__STYLES__', '__OG_URL__', '__ORIGIN__',
    '__CHANNEL__', '__BUILD_LABEL__', '__BUILD_HREF__', '__BUILD_TITLE__',
  ].filter(t => html.includes(t))
  if (leftover.length) {
    throw new Error(`site/index.html placeholder(s) not replaced: ${leftover.join(', ')} -- check the token still exists in the template`)
  }

  await writeFile(path.join(dist, 'index.html'), html)

  const where = path.relative(ROOT, dist).split(path.sep).join('/')
  console.log(`Built ${where}/ (${stamp.label}, ${outputs.length} JS output${outputs.length === 1 ? '' : 's'}, entry: ${entryFile})`)

  if (serve) await serveDist(dist)
}

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** @param {string} dist */
async function serveDist(dist) {
  const PORT = 4173

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let filePath = path.join(dist, decodeURIComponent(url.pathname))
      // Any directory, not just '/': an assembled deploy has the edge tree at
      // /edge/, and this server is what a preview of that tree is looked at
      // through. GitHub Pages resolves a trailing slash to index.html the same
      // way, so matching it here is what makes the preview representative
      // rather than a local-only 404.
      if (url.pathname.endsWith('/')) filePath = path.join(filePath, 'index.html')

      const info = await stat(filePath).catch(() => null)
      if (!info || !info.isFile()) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      res.setHeader('Content-Type', MIME[path.extname(filePath)] ?? 'application/octet-stream')
      createReadStream(filePath).pipe(res)
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })

  await new Promise(resolve => server.listen(PORT, () => resolve(undefined)))
  const where = path.relative(ROOT, dist).split(path.sep).join('/')
  console.log(`Serving ${where}/ at http://localhost:${PORT} (secure context: yes, via localhost)`)
}

// Run the build only when invoked as a script (`node scripts/build-site.mjs`),
// not when imported -- test/build-site.test.mjs pulls in buildCSP on its own.
if (import.meta.filename === process.argv[1]) {
  await main()
}
