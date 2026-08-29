/**
 * A tiny static file server, for `qrdrop web` to hand the bundled browser UI
 * to a local browser.
 *
 * This is the shipped counterpart to `serveDist()` in scripts/build-site.mjs:
 * that one is a dev convenience living in a script the npm tarball does not
 * carry, this one is imported by src/cli.js and therefore has to be under
 * src/. Same job -- read a file out of one directory, guess a Content-Type,
 * stream it -- with the path-traversal guard from e2e/transfer.e2e.mjs folded
 * in, because "it only ever serves a build directory" is exactly what every
 * traversal hole was said about first.
 *
 * Node-only by construction (node:http, node:fs, node:path): it lives in
 * src/node/ so tsconfig.json (the browser project) never sees it, only
 * tsconfig.node.json does. Nothing here touches src/web/ -- serving its built
 * output is a file operation, not an import -- so the "never load src/web from
 * Node" rule is not in play.
 *
 * Bind address is 127.0.0.1, not 0.0.0.0: the browser reaches the UI over the
 * loopback address, which the platform treats as a secure context (same as
 * `localhost`) so WebCrypto and the camera work without a certificate.
 * http://<lan-ip> does not count, so exposing this to other machines would
 * serve a page that fails closed the moment it tried to derive a key.
 * Loopback only is a deliberate ceiling, not a missing feature.
 *
 * The returned URL uses the literal 127.0.0.1 rather than the name
 * `localhost`. On a host that resolves `localhost` to ::1 first (common on
 * Windows), a client hitting the name pays a connection-refused-then-retry
 * round trip before falling back to IPv4, which shows up as a multi-second
 * stall on the first request. The numeric address sidesteps the name
 * resolution entirely.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Same short map build-site.mjs uses. A built site/dist/ is only ever these
 * types plus the source maps; anything else falls through to a byte stream,
 * which is the safe default for a file whose type we did not expect to serve.
 *
 * @type {Record<string, string>}
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Serves `root` on 127.0.0.1 and resolves once it is listening.
 *
 * @param {object} args
 * @param {string} args.root  Absolute path to the directory to serve.
 * @param {number} args.port  TCP port; 0 lets the OS pick a free one.
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function serveStatic({ root, port }) {
  const rootResolved = path.resolve(root)

  const server = createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'

      // Confine every request to `root`. path.join collapses the `..` in a
      // crafted path, and the resolved result must still sit inside root --
      // either the directory itself or something under its separator, so a
      // sibling like `<root>-secret` cannot sneak past a bare startsWith.
      const file = path.resolve(path.join(rootResolved, pathname))
      if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) {
        res.writeHead(404).end('Not found')
        return
      }

      const info = await stat(file).catch(() => null)
      if (!info || !info.isFile()) {
        res.writeHead(404).end('Not found')
        return
      }

      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(res)
    } catch (error) {
      res.writeHead(500).end(String(error))
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      // address() is a string only for a pipe/socket; a TCP listener always
      // reports an object with a numeric port. The cast documents that.
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        url: `http://127.0.0.1:${actualPort}/`,
        port: actualPort,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}
