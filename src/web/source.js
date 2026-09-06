/**
 * FileSource adapter over a browser File.
 *
 * core/sender.js used to take a File directly and call
 * `file.slice(a, b).arrayBuffer()` itself, which meant the sending half of the
 * protocol could only ever run in a browser. Moving that one call behind the
 * FileSource contract (see core/source.js) is what makes sender.js runtime-
 * agnostic, and runtime-agnostic is what makes a Node CLI possible at all:
 * src/node/ gets its own adapter over fs, and sender.js never has to know
 * which one it was handed.
 *
 * This file used to be a thin wrapper on the theory that anything cleverer
 * than "read the File's own fields, slice on demand" was logic core should own
 * instead. The read-ahead below is the one exception that earned its place,
 * and Android is why.
 *
 * A File the Android Storage Access Framework hands back is not backed by
 * memory or by a file descriptor -- it is backed by a content:// provider, and
 * every arrayBuffer() on it is a Binder round-trip to another process. That
 * cost is per CALL, not per byte. Measured on a real device against a 3 MB
 * file:
 *
 *     block      ms per read    throughput
 *     16 KiB        86.2         0.18 MB/s
 *     64 KiB        82.9         0.75 MB/s
 *    256 KiB        81.5         3.07 MB/s
 *      1 MiB        98.2        10.18 MB/s
 *      3 MiB        87.9        34.13 MB/s
 *
 * Flat, across a 192x range of payload size. Reading three megabytes costs
 * what reading sixteen kilobytes costs.
 *
 * sender.js asks for one CHUNK_SIZE slice per frame, so before this buffer a
 * 3 MB transfer was 192 of those round-trips: 29.7 seconds out of a 30.3
 * second transfer, 98% of the wall time, while AEAD accounted for 21 ms and
 * the data channel 9 ms. It looked like a slow network and was nothing of the
 * kind. The same file read from an in-memory Blob takes 0.98 ms a block, which
 * is why no desktop browser ever showed this and why the bug survived every
 * measurement made before a phone was involved.
 *
 * This is the read-side twin of app/src/tauri-sink.js's write-side coalescing,
 * which buffers to 1 MiB before each invoke for the same reason: a fixed
 * per-call cost is beaten by making fewer, larger calls. BLOCK_BYTES matches
 * that 1 MiB deliberately. It is not chosen to maximise read throughput --
 * bigger blocks keep getting faster indefinitely, per the table -- but to
 * clear the transport, which Phase 2 measured end to end at 9.5 MB/s. At 1 MiB
 * the reads do 10.18 MB/s and stop being the bottleneck; past that the extra
 * throughput is bytes the channel cannot take, bought with resident memory on
 * the device that has the least of it.
 */

// One block in flight, and briefly two: the replacement is read before the
// previous one is dropped, so peak is 2 * BLOCK_BYTES rather than one.
const BLOCK_BYTES = 1024 * 1024

/**
 * @param {File} file
 * @returns {FileSource}
 */
export function fromFile(file) {
  /** @type {Uint8Array | null} */
  let block = null
  let blockStart = 0

  return {
    name: file.name,
    size: file.size,
    // File.type is '' when the browser could not determine one (an unknown
    // extension, or a file with none) -- never absent, just empty, so `||`
    // rather than `??` is the right fallback here.
    mime: file.type || 'application/octet-stream',

    async slice(start, end) {
      // Read straight through for a request larger than the buffer. Caching
      // it would evict a block that is probably still being served from to
      // hold one that by definition cannot be reused, and the per-call cost
      // this whole buffer exists to amortise is already amortised across a
      // request that big. sender.js never asks for more than CHUNK_SIZE, so
      // this is the contract staying honest for other callers rather than a
      // path the transfer takes.
      if (end - start > BLOCK_BYTES) {
        return new Uint8Array(await file.slice(start, end).arrayBuffer())
      }

      // Refill whenever the request is not wholly inside the block we hold.
      // The condition is a range check and not `start === blockStart + n`
      // on purpose: FileSource does not promise sequential access, and a
      // caller seeking backwards must get correct bytes rather than a
      // silently stale window.
      if (block === null || start < blockStart || end > blockStart + block.length) {
        blockStart = start
        block = new Uint8Array(
          await file.slice(start, Math.min(start + BLOCK_BYTES, file.size)).arrayBuffer(),
        )
      }

      // A copy, not a subarray view. src/node/source.js can hand back a view
      // of its reused buffer because it refills that buffer on every single
      // slice() -- there is never a live view and a refill at the same time.
      // Here one block backs up to 64 frames, and seal() is awaited between
      // them, so a view would stay valid in today's sender and would alias
      // the moment anything read ahead. The copy is CHUNK_SIZE, which is the
      // allocation sender.js was making per frame anyway.
      return block.slice(start - blockStart, end - blockStart)
    },
  }
}
