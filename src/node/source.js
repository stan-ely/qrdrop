/**
 * FileSource adapter over the filesystem.
 *
 * The browser equivalent (src/web/source.js) can lean on File.slice(), which
 * is backed by the OS and allocates nothing until read. Node has no such
 * primitive: fs.promises.open() plus handle.read() is the whole surface, and
 * read() fills a buffer you hand it rather than returning a fresh one.
 *
 * That detail matters here. The obvious per-call `Buffer.allocUnsafe(len)`
 * would let a sender of a multi-gigabyte file allocate and discard a new
 * CHUNK_SIZE buffer on every slice(), which is exactly the kind of thing that
 * shows up as GC pressure only once someone actually tries a large transfer.
 * A single buffer, sized once and reused for the file's lifetime, is what
 * keeps memory flat regardless of file size -- the same property fromFile()
 * gets for free from the browser.
 *
 * The reused buffer is safe only because sender.js awaits every slice() and
 * every channel.send() before asking for the next one (see sender.js's
 * chunk loop) -- there is never a second read in flight to alias against.
 */

import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { CHUNK_SIZE } from '../core/frame.js'

/**
 * @param {string} filePath
 * @returns {Promise<FileSource>}
 */
export async function fromPath(filePath) {
  const handle = await open(filePath, 'r')
  const { size } = await handle.stat()

  // Sized to one chunk: every slice() sender.js issues is at most CHUNK_SIZE
  // bytes, so this never has to grow. A slice narrower than the buffer (the
  // final, partial chunk) is handled by returning a subarray view below.
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)

  return {
    name: basename(filePath),
    size,
    // Not sniffed from content or extension: that would pull in a mime-type
    // dependency for a field the manifest treats as advisory, and the
    // receiver never trusts it for anything security-relevant.
    mime: 'application/octet-stream',

    async slice(start, end) {
      const len = end - start
      // handle.read() returns however many bytes were actually available,
      // which can be less than requested if the file was truncated out from
      // under us mid-transfer. slice()'s contract (core/source.js) says a
      // short read is a fault, not an EOF to paper over -- the caller only
      // ever asks for ranges inside `size`, so anything short means the file
      // on disk no longer matches the manifest already sent to the peer.
      const { bytesRead } = await handle.read(buffer, 0, len, start)
      if (bytesRead !== len) {
        throw new Error(
          `Short read from ${filePath}: expected ${len} bytes at ${start}, got ${bytesRead}`,
        )
      }
      // A subarray view, not a copy: the caller (sendFile) awaits seal()
      // synchronously-ish before the next slice() is issued, so nothing
      // reuses `buffer` while these bytes are still in flight. See the
      // module comment for why that ordering is guaranteed.
      return /** @type {Bytes} */ (buffer.subarray(0, len))
    },

    async close() {
      await handle.close()
    },
  }
}
