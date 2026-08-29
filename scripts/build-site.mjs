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
 */

import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, copyFile, rm, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SIGNALING_URLS } from '../src/transport/room.js'
import { tokensCSS } from '../src/web/tokens.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SITE = path.join(ROOT, 'site')
const DIST = path.join(SITE, 'dist')

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
 */
async function bundle() {
  const result = await esbuild.build({
    entryPoints: [path.join(SITE, 'main.js')],
    outdir: DIST,
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

async function main() {
  const serve = process.argv.includes('--serve')

  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  const { entryFile, outputs } = await bundle()

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
  const siteCSS = await readFile(path.join(SITE, 'styles.css'), 'utf8')
  const css = tokensCSS(':root') + siteCSS

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
  await writeFile(path.join(DIST, cssFile), css)
  await copyFile(path.join(SITE, '_headers'), path.join(DIST, '_headers'))
  await writeFile(path.join(DIST, 'CNAME'), 'share.stan-ely.com\n')

  const csp = buildCSP(SIGNALING_URLS)
  const template = await readFile(path.join(SITE, 'index.html'), 'utf8')
  const html = template
    .replace('__CSP__', csp)
    .replace('__SCRIPT__', entryFile)
    .replace('__STYLES__', cssFile)

  if (html.includes('__CSP__') || html.includes('__SCRIPT__') || html.includes('__STYLES__')) {
    throw new Error('site/index.html placeholder was not replaced -- check the token still exists in the template')
  }

  await writeFile(path.join(DIST, 'index.html'), html)

  console.log(`Built site/dist/ (${outputs.length} JS output${outputs.length === 1 ? '' : 's'}, entry: ${entryFile})`)

  if (serve) await serveDist()
}

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

async function serveDist() {
  const PORT = 4173

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let filePath = path.join(DIST, decodeURIComponent(url.pathname))
      if (url.pathname === '/') filePath = path.join(DIST, 'index.html')

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
  console.log(`Serving site/dist/ at http://localhost:${PORT} (secure context: yes, via localhost)`)
}

// Run the build only when invoked as a script (`node scripts/build-site.mjs`),
// not when imported -- test/build-site.test.mjs pulls in buildCSP on its own.
if (import.meta.filename === process.argv[1]) {
  await main()
}
