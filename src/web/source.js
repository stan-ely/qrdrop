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
 * kind. The same file read from an in-memory Blob takes 0.98 ms a block.
 *
 * This is NOT a Tauri problem, and reading it as one is the mistake to avoid.
 * Chrome 152 on the same phone, picking the same file through the same SAF
 * dialog, measures ~72 ms fixed + ~1.8 ms per MiB -- marginally better than
 * wry's ~79 + ~3.7, and the same pathology. Chrome does not copy the picked
 * file into its own cache first; it hands the content:// through exactly as
 * wry does. So the deployed WEBSITE had this too, at 0.22 MB/s for the 16 KiB
 * frame it actually used, for every Android user who ever sent a file. Desktop
 * browsers were fine because a File there is backed by a real filesystem, and
 * that is the whole of why this survived: the sender was always a desktop or
 * the Node CLI until a phone was pointed at it.
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
 * phone to desktop was 33 reads and 23.6 s (2.72 MB/s) with the blocks alone,
 * and reads were still 25% of that window.
 *
 * That last 25% is what the read-ahead below is for, and a bigger block was
 * explicitly the wrong way to get it: sender.js awaits slice() before it
 * seals, so the reads are serialised BETWEEN sends and the channel sits idle
 * through every one of them. Raising BLOCK_BYTES only makes the idle gaps
 * fewer and longer, for double the memory each time. Issuing the NEXT block's
 * read as soon as the current one lands puts that round-trip alongside the
 * ~128 frames the current block still has to transmit, which is the one thing
 * that removes the gap rather than reshaping it.
 */

// Two blocks, not one: the block being served from and the one being read
// ahead. That doubling is the whole price of the read-ahead, and it is stated
// here rather than left implicit in prefetch(), because it is also the reason
// BLOCK_BYTES did not simply grow instead -- 2 MiB buys the overlap for 4 MiB
// of peak on the device with the least memory to spare, where 8 MiB blocks
// would want 16.
const BLOCK_BYTES = 2 * 1024 * 1024

/**
 * @param {File} file
 * @returns {FileSource}
 */
export function fromFile(file) {
  /** @type {Bytes | null} */
  let block = null
  let blockStart = 0

  // The read-ahead, in flight or already settled. Held as one { start, bytes }
  // object rather than two variables so "which offset is this promise for"
  // cannot drift from the promise itself.
  /** @type {{ start: number, bytes: Promise<Bytes | null> } | null} */
  let ahead = null

  /** @param {number} at */
  function prefetch(at) {
    ahead = null
    if (at >= file.size) return
    const slice = file.slice(at, Math.min(at + BLOCK_BYTES, file.size))
    ahead = {
      start: at,
      // The rejection is swallowed HERE, into a null, and that is deliberate
      // twice over. Nothing awaits this promise until the caller happens to
      // reach the boundary -- possibly seconds later, possibly never, if the
      // transfer is cancelled first -- so a rejection left to escape would
      // surface as an unhandled rejection at an unrelated moment, or against a
      // transfer that had already moved on. And a failed read-ahead is not an
      // error anyone asked for: null makes it indistinguishable from no
      // read-ahead at all, so load() reads the range itself and a real failure
      // is thrown from the call that actually wanted those bytes.
      bytes: slice.arrayBuffer().then(b => new Uint8Array(b), () => null),
    }
  }

  /**
   * Makes `block` the window starting at `at` -- from the read-ahead if one is
   * waiting for exactly that offset, otherwise by reading it -- and arms the
   * next read-ahead.
   *
   * The match is an exact offset comparison rather than a range check: the
   * only offset ever prefetched is the one immediately after the block being
   * served, and accepting a merely *containing* window would hand a sequential
   * caller a window it had already half consumed. Correct, but it shortens the
   * runway to the next boundary for no gain.
   *
   * @param {number} at
   */
  async function load(at) {
    const claimed = ahead && ahead.start === at ? ahead : null
    // Both references dropped before the await rather than after it resolves,
    // so the old block is collectable while the new one is being allocated and
    // the peak stays at the two blocks named above instead of three.
    // blockStart moves with them, so a throw from arrayBuffer() cannot leave a
    // stale offset pointing at a null block.
    ahead = null
    block = null
    blockStart = at

    if (claimed) block = await claimed.bytes
    if (block === null) {
      const slice = file.slice(at, Math.min(at + BLOCK_BYTES, file.size))
      block = new Uint8Array(await slice.arrayBuffer())
    }
    prefetch(blockStart + block.length)
  }

  return {
    name: file.name,
    size: file.size,
    // File.type is '' when the browser could not determine one (an unknown
    // extension, or a file with none) -- never absent, just empty, so `||`
    // rather than `??` is the right fallback here.
    mime: file.type || 'application/octet-stream',

    async slice(start, end) {
      // Read straight through for a request larger than the buffer. Caching it
      // would evict a block that is probably still being served from to hold
      // one that by definition cannot be reused, and the per-call cost this
      // whole buffer exists to amortise is already amortised across a request
      // that big. sender.js never asks for more than CHUNK_SIZE, so this is
      // the contract staying honest for other callers rather than a path the
      // transfer takes. Any read-ahead in flight is left alone: it is still
      // valid for its own range, and a one-off large read says nothing about
      // where the caller is going next.
      if (end - start > BLOCK_BYTES) {
        return new Uint8Array(await file.slice(start, end).arrayBuffer())
      }

      // Wholly inside the block we hold: the overwhelmingly common case, and
      // the only one that costs nothing at all.
      if (block !== null && start >= blockStart && end <= blockStart + block.length) {
        return copy(block, start - blockStart, end - blockStart)
      }

      // Straddling the end of it: head from this block, tail from the next.
      // Stitching earns its awkwardness because CHUNK_SIZE does not divide
      // BLOCK_BYTES, so EVERY block boundary lands mid-frame. The earlier
      // version refilled from the straddling frame's own start instead, which
      // cost one extra read per block and -- far worse once there was a
      // read-ahead -- left the prefetched window, aligned to the block, never
      // the window actually asked for. It would have been discarded at every
      // boundary, and a read-ahead thrown away each time is not a read-ahead.
      if (block !== null && start >= blockStart && start < blockStart + block.length) {
        const head = copy(block, start - blockStart, block.length)
        await load(blockStart + block.length)
        const out = new Uint8Array(end - start)
        out.set(head)
        out.set(copy(block, 0, out.length - head.length), head.length)
        return out
      }

      // Anywhere else: a first read, or a caller that seeked. FileSource does
      // not promise sequential access, and a backwards seek must get correct
      // bytes rather than a silently stale window.
      await load(start)
      return copy(block, start - blockStart, end - blockStart)
    },
  }
}

/**
 * A copy, not a subarray view. src/node/source.js can hand back a view of its
 * reused buffer because it refills that buffer on every single slice() --
 * there is never a live view and a refill at the same time. Here one block
 * backs up to 128 frames AND the next block is being read while they are
 * sent, so a view would alias a buffer this file is actively replacing. The
 * copy is CHUNK_SIZE, which is the allocation sender.js was making per frame
 * anyway.
 *
 * @param {Bytes | null} buf
 * @param {number} from
 * @param {number} to
 * @returns {Bytes}
 */
function copy(buf, from, to) {
  // Unreachable: every caller has just loaded the block or checked it. The
  // throw states the invariant rather than talking the typechecker out of it
  // with a cast.
  if (buf === null) throw new Error('read from an unloaded block')
  return buf.slice(from, to)
}
