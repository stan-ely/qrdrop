/**
 * Where received bytes land, on a filesystem.
 *
 * The Node counterpart to src/web/sink.js. There is only one implementation
 * here, unlike the browser's File System Access / Blob split -- Node has had
 * an unconditional streaming write to disk since forever, so there is no
 * capability gap to route around and `streaming` is always true.
 *
 * safeFilename() is reused from src/web/sink.js rather than duplicated. That
 * file has no module-scope DOM access -- `window` and `document` are only
 * touched inside canStreamToDisk() and createSink(), which this module never
 * calls -- so importing across the web/node boundary for just that one pure
 * function is safe today. It is still a layering wrinkle: qrdrop/node ends up
 * with a static import of a file that lives under qrdrop/web's tree. The
 * cleaner long-term fix is to hoist safeFilename() into src/core/ (it touches
 * neither a DOM nor an fs) and have both runtimes import it from there.
 */

import { createWriteStream } from 'node:fs'
import { unlink, stat } from 'node:fs/promises'
import { extname, join, resolve, relative, isAbsolute } from 'node:path'
import { safeFilename } from '../web/sink.js'

/**
 * Finds a name that does not already exist in `dir`, preserving the
 * extension: "report.pdf", "report (2).pdf", "report (3).pdf", ...
 *
 * Silent overwrite is the wrong default for a peer-supplied name: two
 * transfers of "photo.jpg" from two different sessions should not destroy the
 * first one just because they happened to share a filename.
 *
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<string>}
 */
async function nextAvailableName(dir, name) {
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)

  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`
    try {
      await stat(join(dir, candidate))
      // Exists; try the next suffix.
    } catch {
      // ENOENT (or any other stat failure) means this name is free.
      return candidate
    }
  }
}

/**
 * @param {object} args
 * @param {string} args.outDir Must already exist; this module does not
 *   create it, matching the browser sink's contract of taking a destination
 *   the caller already resolved (a save dialog there, --out here).
 * @returns {(manifest: Manifest) => Promise<Sink>}
 */
export function createFileSink({ outDir }) {
  const outDirAbs = resolve(outDir)

  return async manifest => {
    const requested = safeFilename(manifest.name)
    const name = await nextAvailableName(outDirAbs, requested)

    const target = resolve(outDirAbs, name)
    // Belt-and-braces: safeFilename() already reduces the peer's name to a
    // bare basename with no separators, so this should be unreachable. It
    // stays here anyway because "should be unreachable" is not the same
    // guarantee as "is enforced" -- a future change to safeFilename(), or a
    // path.resolve() surprise on some platform, would otherwise turn a
    // filename bug into a directory-traversal write silently.
    const rel = relative(outDirAbs, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Refusing to write outside ${outDirAbs}: ${manifest.name}`)
    }

    const stream = createWriteStream(target)
    await new Promise((res, rej) => {
      stream.once('open', res)
      stream.once('error', rej)
    })

    return {
      streaming: true,
      name,

      write(chunk) {
        return new Promise((res, rej) => {
          // write() returning false means the internal buffer is full, but we
          // still must wait for 'drain' before handing over the next chunk --
          // otherwise this sink imposes no backpressure at all and a fast
          // sender/slow disk pairing queues the whole file into memory here
          // instead of on the network, defeating the point of streaming.
          const ok = stream.write(/** @type {Uint8Array} */ (chunk), err => {
            if (err) rej(err)
          })
          if (ok) res()
          else stream.once('drain', res)
        })
      },

      close() {
        return new Promise((res, rej) => {
          stream.end(/** @param {NodeJS.ErrnoException | null | undefined} err */ err => (err ? rej(err) : res()))
        })
      },

      async abort() {
        stream.destroy()
        // A failed transfer must not leave a half-written file that looks
        // complete -- unlink() is what makes "aborted" and "succeeded" tell
        // apart on disk, not just in the CLI's exit code. Best-effort: if the
        // file was never opened, or is already gone, there is nothing to undo.
        await unlink(target).catch(() => {})
      },
    }
  }
}
