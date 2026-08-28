import test from 'node:test'
import assert from 'node:assert/strict'

import {
  seal, open, sealControl, openControl, decodeHeader,
  TYPE_CHUNK, CHUNK_SIZE, HEADER_BYTES, MAX_FRAME_BYTES,
} from '../src/transfer/frame.js'

const key = async () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
const body = (n = 100, fill = 42) => new Uint8Array(n).fill(fill)
const rejects = async fn => { try { await fn(); return false } catch { return true } }

test('a sealed chunk round-trips', async () => {
  const k = await key()
  const frame = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 0 }, body())
  const got = await open(k, frame, { type: TYPE_CHUNK, fileSeq: 0, index: 0 })
  assert.deepEqual([...got.plaintext], [...body()])
  assert.equal(got.last, false)
})

test('the end-of-file flag is authenticated, so truncation cannot be disguised', async () => {
  const k = await key()
  const frame = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 7, last: true }, body())
  assert.equal(decodeHeader(frame).last, true)

  // Attacker clears `last` to make a finished transfer look like it continues,
  // or sets it early to pass off a partial file as complete.
  const tampered = frame.slice()
  tampered[13] = 0
  assert.ok(await rejects(() => open(k, tampered, { type: TYPE_CHUNK, fileSeq: 0, index: 7 })))
})

test('header edits fail the tag because the header is the AAD', async () => {
  const k = await key()
  const frame = await seal(k, { type: TYPE_CHUNK, fileSeq: 3, index: 9 }, body())

  for (const pos of [0, 1, 4, 5, 12, 13]) {
    const t = frame.slice()
    t[pos] ^= 0xff
    // Opened without expectations, so only the AEAD tag can catch this.
    assert.ok(await rejects(() => open(k, t, null)), `byte ${pos} should not be malleable`)
  }
})

test('ciphertext edits are rejected', async () => {
  const k = await key()
  const frame = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 0 }, body())
  const t = frame.slice()
  t[HEADER_BYTES + 5] ^= 0x01
  assert.ok(await rejects(() => open(k, t, null)))
})

test('replayed and reordered frames are refused before decryption', async () => {
  const k = await key()
  const f0 = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 0 }, body(100, 1))
  const f1 = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 1 }, body(100, 2))

  await open(k, f0, { type: TYPE_CHUNK, fileSeq: 0, index: 0 })
  // Receiver now expects index 1. Both a replay of 0 and a skip to 2 must fail.
  assert.ok(await rejects(() => open(k, f0, { type: TYPE_CHUNK, fileSeq: 0, index: 1 })))
  assert.ok(await rejects(() => open(k, f1, { type: TYPE_CHUNK, fileSeq: 0, index: 2 })))
  await open(k, f1, { type: TYPE_CHUNK, fileSeq: 0, index: 1 })
})

test('a frame from another file cannot be spliced in', async () => {
  const k = await key()
  const other = await seal(k, { type: TYPE_CHUNK, fileSeq: 1, index: 0 }, body())
  assert.ok(await rejects(() => open(k, other, { type: TYPE_CHUNK, fileSeq: 0, index: 0 })))
})

test('a different key cannot open a frame', async () => {
  const frame = await seal(await key(), { type: TYPE_CHUNK, fileSeq: 0, index: 0 }, body())
  const wrong = await key()
  assert.ok(await rejects(() => open(wrong, frame, null)))
})

test('control frames use a reserved fileSeq so they never share a nonce with data', async () => {
  const k = await key()
  const manifest = { name: 'x.bin', size: 10, totalChunks: 1 }
  const frame = await sealControl(k, 0, manifest)
  assert.deepEqual(await openControl(k, frame, 0), manifest)

  // The reserved sequence is 0xffffffff, unreachable by a real file counter.
  assert.equal(decodeHeader(frame).fileSeq, 0xffffffff)
  assert.ok(await rejects(() => openControl(k, frame, 1)), 'control frames are also ordered')
})

test('oversized and undersized frames are rejected before decryption', async () => {
  const k = await key()
  assert.ok(await rejects(() => open(k, new Uint8Array(HEADER_BYTES + 4), null)))
  assert.ok(await rejects(() => open(k, new Uint8Array(MAX_FRAME_BYTES + 1), null)))
})

test('a full-size chunk stays within the SCTP-safe frame budget', async () => {
  const k = await key()
  const frame = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 0 }, body(CHUNK_SIZE))
  assert.equal(frame.length, MAX_FRAME_BYTES)
  assert.ok(frame.length < 64 * 1024)
})

test('chunk indices beyond 2^32 still produce distinct nonces', async () => {
  const k = await key()
  const big = 2 ** 40
  const a = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: big }, body())
  assert.equal(decodeHeader(a).index, big)
  await open(k, a, { type: TYPE_CHUNK, fileSeq: 0, index: big })
})
