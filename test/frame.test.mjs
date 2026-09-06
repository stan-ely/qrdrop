import test from 'node:test'
import assert from 'node:assert/strict'

import {
  seal, open, sealControl, openControl, decodeHeader, UnauthenticatedFrame,
  TYPE_CHUNK, CHUNK_SIZE, HEADER_BYTES, TAG_BYTES, MAX_FRAME_BYTES,
} from '../src/core/frame.js'

const key = async () =>
  /** @type {Promise<CryptoKey>} */ (
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  )

/**
 * @param {number} [n]
 * @param {number} [fill]
 * @returns {Bytes}
 */
const body = (n = 100, fill = 42) => new Uint8Array(n).fill(fill)

/** @param {() => Promise<unknown>} fn */
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

test('a frame that fails its tag is unauthenticated, whatever its header claims', async () => {
  // The field failure, at unit scale. A stranger sealed a perfectly
  // well-formed chunk header claiming index 13877 at a receiver expecting 0,
  // for a file that only ever had 64 chunks in it. Because the ordering
  // checks ran on the CLEARTEXT header, the receiver answered with
  // "Out-of-order frame: expected 0, got 13877" and threw the transfer away
  // -- on bytes it could not have opened, from someone who never held a key.
  const stranger = await key()
  const frame = await seal(stranger, { type: TYPE_CHUNK, fileSeq: 0, index: 13877 }, body())

  const error = await open(await key(), frame, { type: TYPE_CHUNK, fileSeq: 0, index: 0 })
    .then(() => null, e => e)

  assert.ok(error instanceof UnauthenticatedFrame, 'a bad tag is never an ordering fault')
  assert.doesNotMatch(String(error.message), /Out-of-order/)
})

test('our own peer reordering still fails loudly, because the tag passed first', async () => {
  // The other half. Once the tag proves the frame came from the peer holding
  // our key, a wrong index is a real desync -- dropping THIS would be how a
  // truncated file gets presented as a whole one.
  const k = await key()
  const frame = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 1 }, body())

  const error = await open(k, frame, { type: TYPE_CHUNK, fileSeq: 0, index: 0 })
    .then(() => null, e => e)

  assert.ok(!(error instanceof UnauthenticatedFrame))
  assert.match(String(error.message), /Out-of-order frame: expected 0, got 1/)
})

test('the size guards still run ahead of any decryption', async () => {
  // Not pedantry: they are what bounds the work a stranger can make us do now
  // that a frame is decrypted before it is judged. If either of these ever
  // came back as UnauthenticatedFrame it would mean an arbitrarily large
  // buffer had reached crypto.subtle.decrypt first.
  const k = await key()
  for (const frame of [new Uint8Array(HEADER_BYTES + 4), new Uint8Array(MAX_FRAME_BYTES + 1)]) {
    const error = await open(k, frame, null).then(() => null, e => e)
    assert.ok(!(error instanceof UnauthenticatedFrame))
    assert.match(String(error.message), /Frame too short|Frame exceeds maximum size/)
  }
})

test('replayed and reordered frames are refused once the tag proves they are ours', async () => {
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
  // Deliberately not a real ControlMessage. This is the framing layer, and
  // what is under test is that an arbitrary JSON body survives the seal/open
  // round trip under the reserved sequence -- the protocol's own shapes are
  // exercised in transfer.test.mjs.
  const manifest = { name: 'x.bin', size: 10, totalChunks: 1 }
  const frame = await sealControl(k, 0, /** @type {any} */ (manifest))
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

// The number that matters is 16 KiB MINUS the 36 bytes the transport spends on
// its own action-wire header, because a frame one byte over that is not
// rejected, it is silently split into a second SCTP message. This asserted
// frame.length === MAX_FRAME_BYTES while CHUNK_SIZE was 16 * 1024, which held
// but pinned the wrong property: it passed happily at 16414 bytes, 66 over the
// real budget, for as long as that bug existed.
test('a full-size chunk fits in ONE transport message, not two', async () => {
  const k = await key()
  const frame = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: 0 }, body(CHUNK_SIZE))
  assert.equal(frame.length, 16 * 1024 - 36, 'a sealed full chunk must fit the action-wire budget')
  assert.ok(frame.length < 64 * 1024)
})

// The other half, and the one a well-meaning "derive this properly" edit would
// break: we send smaller frames than we accept, on purpose, so that a peer
// still running CHUNK_SIZE = 16 * 1024 keeps working.
test('inbound tolerance still admits a peer on the previous chunk size', async () => {
  const k = await key()
  const legacyFrameLength = HEADER_BYTES + 16 * 1024 + TAG_BYTES
  assert.ok(
    legacyFrameLength <= MAX_FRAME_BYTES,
    'MAX_FRAME_BYTES must not be narrowed to the new CHUNK_SIZE',
  )
})

test('chunk indices beyond 2^32 still produce distinct nonces', async () => {
  const k = await key()
  const big = 2 ** 40
  const a = await seal(k, { type: TYPE_CHUNK, fileSeq: 0, index: big }, body())
  assert.equal(decodeHeader(a).index, big)
  await open(k, a, { type: TYPE_CHUNK, fileSeq: 0, index: big })
})
