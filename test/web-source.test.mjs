/**
 * fromFile's read-ahead buffer.
 *
 * The bug this exists for was invisible to every other test in this suite and
 * to every desktop browser: reading an in-memory Blob costs ~1 ms a block, so
 * issuing one read per 16 KiB frame looks free. A File backed by Android's
 * Storage Access Framework costs ~86 ms per read regardless of size, and the
 * same code turned a 3 MB transfer into 192 Binder round-trips and 30 seconds.
 *
 * So the property worth pinning is not "the bytes are right" -- a naive
 * implementation gets that too -- it is HOW MANY reads the adapter issues to
 * deliver them, and WHEN it issues them. These count the underlying reads
 * through a File-shaped stub, which is the only way to see either from Node.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { fromFile } from '../src/web/source.js'
import { CHUNK_SIZE } from '../src/core/frame.js'

const BLOCK = 2 * 1024 * 1024 // must track BLOCK_BYTES in src/web/source.js

/**
 * A File-shaped stub that counts reads. Deliberately not a real File: the
 * whole point is observing the call the platform charges for.
 *
 * `fail` names read numbers (1-based, in the order the adapter issues them)
 * that should reject, which is how the read-ahead's failure path is reached
 * without a real content:// provider to break.
 *
 * @param {Uint8Array} bytes
 * @param {{ name?: string, type?: string, fail?: number[] }} [opts]
 */
function countingFile(bytes, { name = 'f.bin', type = '', fail = [] } = {}) {
  /** @type {{ reads: number, bytesRead: number, ranges: number[][] }} */
  const stats = { reads: 0, bytesRead: 0, ranges: [] }
  // Cast rather than implement: a real File brings lastModified, stream(),
  // text() and the rest, none of which fromFile touches. Only the three
  // members it does read are worth standing up here, and the cast says that
  // the narrowness is deliberate.
  const file = /** @type {File} */ (/** @type {unknown} */ ({
    name,
    type,
    size: bytes.length,
    /** @param {number} start @param {number} end */
    slice(start, end) {
      return {
        async arrayBuffer() {
          const n = ++stats.reads
          stats.ranges.push([start, end])
          if (fail.includes(n)) throw new Error(`read ${n} failed`)
          stats.bytesRead += end - start
          return bytes.slice(start, end).buffer
        },
      }
    },
  }))
  return { stats, file }
}

/** @param {number} n */
const pattern = n => Uint8Array.from({ length: n }, (_, i) => (i * 7 + (i >> 8)) & 0xff)

test('sequential chunk reads are served from one block, not one read each', async () => {
  const bytes = pattern(3 * 1024 * 1024)
  const { file, stats } = countingFile(bytes)
  const source = fromFile(file)

  let offset = 0
  while (offset < bytes.length) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.length)
    const got = await source.slice(offset, end)
    assert.deepEqual(got, bytes.subarray(offset, end), `bytes differ at ${offset}`)
    offset = end
  }

  // The naive version issued one read per frame. Anything close to that number
  // means the buffer is not being reused and the Android path is slow again.
  // Exactly one read per block, no more: CHUNK_SIZE does not divide a megabyte
  // evenly, so a frame straddles every block boundary, and this is the pin on
  // that frame being stitched from two blocks rather than triggering a refill
  // from its own unaligned start. The unaligned refill was correct too, but it
  // cost a read per block AND left every prefetched window at the wrong offset
  // to ever be claimed.
  const frames = Math.ceil(bytes.length / CHUNK_SIZE)
  const blocks = Math.ceil(bytes.length / BLOCK)
  assert.equal(stats.reads, blocks, `${stats.reads} reads for ${blocks} blocks`)
  // A block holds BLOCK / CHUNK_SIZE = 128 frames. The naive version this
  // replaced scored exactly 1.
  const framesPerRead = frames / stats.reads
  assert.ok(framesPerRead >= 80, `only ${framesPerRead.toFixed(1)} frames per read; not amortised`)
})

test('the next block is read while the current one is still being served', async () => {
  const bytes = pattern(3 * BLOCK)
  const { file, stats } = countingFile(bytes)
  const source = fromFile(file)

  // One frame asked for, and the read for the block AFTER it is already out.
  // This is the whole point of the read-ahead: sender.js awaits slice() before
  // it seals, so a read issued at the boundary stalls the data channel for a
  // ~79 ms Binder round-trip, while one issued here overlaps the ~128 frames
  // still to be transmitted from the block just loaded.
  await source.slice(0, CHUNK_SIZE)
  assert.equal(stats.reads, 2, 'the next block should already be in flight')
  assert.deepEqual(stats.ranges[1], [BLOCK, 2 * BLOCK], 'the read-ahead is at the wrong offset')

  // Crossing into it costs nothing, because it is the read already issued --
  // the count rises only by the read-ahead armed behind it.
  let offset = 0
  while (offset < 2 * BLOCK) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.length)
    assert.deepEqual(await source.slice(offset, end), bytes.subarray(offset, end), `at ${offset}`)
    offset = end
  }
  assert.equal(stats.reads, 3, 'crossing a boundary should claim the read-ahead, not re-read')
})

test('a read-ahead that fails is retried by the call that needs it', async () => {
  // Read 2 is the read-ahead for the second block, issued before anyone has
  // asked for those bytes. It must not reject into nowhere (node --test fails
  // the run on an unhandled rejection, which is half of what this asserts) and
  // it must not fail the transfer: the frame that eventually wants that range
  // reads it itself, and only a failure THERE is the caller's problem.
  const bytes = pattern(2 * BLOCK)
  const { file, stats } = countingFile(bytes, { fail: [2] })
  const source = fromFile(file)

  await source.slice(0, CHUNK_SIZE)
  // Straddles the boundary, so this is the request that claims the read-ahead
  // -- and finds it empty.
  const across = await source.slice(BLOCK - 5, BLOCK + 5)
  assert.deepEqual(across, bytes.subarray(BLOCK - 5, BLOCK + 5))
  assert.equal(stats.reads, 3, 'the failed read-ahead should have been read again')
})

test('a backwards seek re-reads rather than serving stale bytes', async () => {
  const bytes = pattern(2 * BLOCK)
  const { file, stats } = countingFile(bytes)
  const source = fromFile(file)

  await source.slice(0, CHUNK_SIZE)
  await source.slice(BLOCK + 10, BLOCK + 10 + CHUNK_SIZE) // forward, past the block
  const readsBefore = stats.reads

  const back = await source.slice(0, CHUNK_SIZE)
  assert.deepEqual(back, bytes.subarray(0, CHUNK_SIZE), 'a backwards seek returned stale bytes')
  assert.ok(stats.reads > readsBefore, 'a backwards seek must refill, not reuse the window')
})

test('a request spanning the end of the held block is refilled, not truncated', async () => {
  const bytes = pattern(BLOCK + 4096)
  const { file } = countingFile(bytes)
  const source = fromFile(file)

  await source.slice(0, CHUNK_SIZE)
  // Straddles the 1 MiB boundary: the first half is in the block, the second
  // is not. Returning only what was buffered would be a silent short read.
  const straddle = await source.slice(BLOCK - 100, BLOCK + 100)
  assert.equal(straddle.length, 200)
  assert.deepEqual(straddle, bytes.subarray(BLOCK - 100, BLOCK + 100))
})

test('a request larger than the block reads through without caching it', async () => {
  const bytes = pattern(3 * BLOCK)
  const { file, stats } = countingFile(bytes)
  const source = fromFile(file)

  const big = await source.slice(0, 2 * BLOCK)
  assert.deepEqual(big, bytes.subarray(0, 2 * BLOCK))
  assert.equal(stats.reads, 1, 'an oversized request should be one read, not a loop')
  assert.equal(stats.bytesRead, 2 * BLOCK, 'it must not over-read past what was asked for')
})

test('the final partial block is not over-read past the end of the file', async () => {
  const bytes = pattern(BLOCK + 1234)
  const { file, stats } = countingFile(bytes)
  const source = fromFile(file)

  await source.slice(BLOCK, BLOCK + 1234)
  assert.equal(stats.bytesRead, 1234, 'the tail read must be clamped to file.size')
})

test('name, size and the mime fallback are carried through', async () => {
  const { file } = countingFile(pattern(10), { name: 'photo.bin', type: '' })
  assert.equal(fromFile(file).mime, 'application/octet-stream')

  const { file: typed } = countingFile(pattern(10), { name: 'a.png', type: 'image/png' })
  const s = fromFile(typed)
  assert.equal(s.mime, 'image/png')
  assert.equal(s.name, 'a.png')
  assert.equal(s.size, 10)
})
