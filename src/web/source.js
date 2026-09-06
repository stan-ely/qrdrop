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
 * cost is dominated by the call, not the byte count. Measured on a real device,
 * reading 32 MiB per row out of a 64 MB file:
 *
 *     block      ms per read    throughput
 *    256 KiB        80.2          3.12 MB/s
 *      1 MiB        87.4         11.44 MB/s
 *      2 MiB        97.6         20.49 MB/s
 *      4 MiB       114.2         35.03 MB/s
 *      8 MiB       126.3         63.33 MB/s
 *     16 MiB       138.3        115.69 MB/s
 *
 * That fits ~79 ms fixed + ~3.7 ms per MiB. A first pass at this measured
 * against a 3 MB file instead and read the curve as perfectly flat, which it
 * looks like at that size -- the fixed term simply dominates until around
 * 21 MiB. It is worth having the larger measurement in front of you before
 * touching BLOCK_BYTES, because the flat reading argues for any block size at
 * all and the real curve does not.
 *
 * sender.js asks for one CHUNK_SIZE slice per frame, so before this buffer a
 * 3 MB transfer was 192 of those round-trips: 29.7 seconds out of a 30.3
 * second transfer, 98% of the wall time, while AEAD accounted for 21 ms and
 * the data channel 9 ms. It looked like a slow network and was nothing of the
 * kind. The same file read from an in-memory Blob takes 0.98 ms a block, which
 * is why no desktop browser ever showed this and why the bug survived every
 * measurement made before a phone was involved.
 *
 * This is the read-side twin of app/src/tauri-sink.js's write-side coalescing:
 * a fixed per-call cost is beaten by making fewer, larger calls.
 *
 * BLOCK_BYTES is 2 MiB because that is where the fixed term still dominates
 * -- a 2 MiB read spends 81% of its time on overhead, so the block is still
 * being bought cheaply -- while halving the read count against 1 MiB. The
 * payoff is largest on SMALL transfers, which is the common case here: a 3 MB
 * send goes from four reads to two and loses about 18% of its wall time, where
 * a 64 MiB send only gains ~5%. Past 4 MiB the per-byte term starts to matter
 * and the buffer doubles again for single-digit returns.
 *
 * Note it does NOT match tauri-sink.js's 1 MiB, and the asymmetry is real
 * rather than an oversight: the write side is amortising a ~3 ms invoke and
 * flattens after 256 KiB, while this is amortising a ~79 ms Binder round-trip
 * and is still climbing at 16 MiB.
 *
 * Verified at scale rather than only on the file that exposed the bug: 64 MiB
 * phone to desktop is 33 reads and 23.6 s (2.72 MB/s), with reads 25% of the
 * window. The same transfer on the per-frame read would have been about
 * eleven minutes.
 *
 * That 25% is the next thing worth attacking, and a bigger block is NOT the
 * way to do it. Reads are serialised BETWEEN sends -- sender.js awaits
 * slice() before it seals -- so the channel sits idle for every one of them.
 * Prefetching the next block while the current one transmits would hide that
 * cost behind the transport entirely; raising BLOCK_BYTES only makes the
 * idle gaps fewer and longer, for double the memory each time.
 */

// Peak is one block, not two. The refill drops its reference to the previous
// block BEFORE awaiting the next read, so the old one is collectable while the
// new buffer is being allocated -- holding both across the await would double
// the footprint on the device with the least memory to spare.
const BLOCK_BYTES = 2 * 1024 * 1024

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
        const slice = file.slice(start, Math.min(start + BLOCK_BYTES, file.size))
        // Released before the await, not after the read resolves: see the
        // note on BLOCK_BYTES. blockStart moves with it so a throw from
        // arrayBuffer() cannot leave a stale offset pointing at a null block.
        block = null
        blockStart = start
        block = new Uint8Array(await slice.arrayBuffer())
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
