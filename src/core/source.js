/**
 * Where sent bytes come from -- the mirror image of Sink in the same way that
 * reading a file is the mirror image of writing one.
 *
 * This exists because sender.js used to take a browser `File` and call
 * `file.slice(a, b).arrayBuffer()`. That was the last thing in the transfer
 * core that could only run in a browser, and it is what stood between this
 * protocol and a CLI. The contract below is the whole of what sender.js
 * actually needed from a File: three fields and a way to read a range.
 *
 * `slice` must return exactly the requested range, and callers only ever ask
 * for ranges inside `size`, so a short read is a fault rather than an EOF.
 *
 * The adapters live with their runtimes, not here: fromFile() in src/web/,
 * fromPath() in src/node/. Keeping this file free of both is what lets the
 * package's main entry promise it touches neither a DOM nor an fs.
 *
 * @typedef {object} FileSource
 * @property {string} name Sent to the peer as-is. The receiver sanitises it;
 *   see safeFilename() -- a name is never trusted at the far end.
 * @property {number} size
 * @property {string} mime
 * @property {(start: number, end: number) => Promise<Bytes>} slice
 * @property {() => Promise<void>} [close] Releases the underlying handle, if
 *   there is one. Closed by WHOEVER CREATED THE SOURCE, not by sendFile --
 *   the creator is the one who knows whether the source is still wanted, and a
 *   source may legitimately be sent twice (a retry, or two peers). Absent on
 *   sources that hold nothing, so call sites use `await source.close?.()`.
 */

/**
 * A FileSource over bytes already in memory.
 *
 * Useful in tests and for sending something generated rather than read -- both
 * runtimes can use it, which is why it is here and not in web/ or node/.
 *
 * @param {object} args
 * @param {Bytes} args.bytes
 * @param {string} args.name
 * @param {string} [args.mime]
 * @returns {FileSource}
 */
export function fromBytes({ bytes, name, mime = 'application/octet-stream' }) {
  return {
    name,
    mime,
    size: bytes.length,
    // subarray would alias the caller's buffer, so a caller that reuses or
    // mutates it after handing it over would change bytes already in flight.
    async slice(start, end) {
      return Uint8Array.prototype.slice.call(bytes, start, end)
    },
  }
}
