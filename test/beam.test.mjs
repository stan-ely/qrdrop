/**
 * The beam codec, offline and deterministic.
 *
 * The frame-loss test is the one that matters. A fountain code is a lot of
 * machinery to justify, and the justification is precisely that a transfer
 * survives a camera missing a third of what it was shown -- so that is the
 * property pinned here, not just "the bytes round-trip". The naive
 * chunk-and-cycle design it replaced would need N*ln(N) frames to close the
 * same gap; the bound below is what stops that regressing back in.
 *
 * Every case is seeded. A flaky erasure-code test is worse than none: it
 * trains people to re-run the suite until it passes, which is exactly how a
 * real decoder stall gets waved through.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createBeamEncoder, createBeamDecoder, parseFrame, crc32,
  PROTOCOL, MANIFEST_INTERVAL, MAX_ENCODED_BYTES,
} from '../src/core/beam.js'
import { fromBytes } from '../src/core/source.js'
import { toBase64url } from '../src/core/secret.js'

/**
 * A seeded PRNG, so a failure is reproducible rather than a rumour.
 * @param {number} seed
 * @returns {() => number}
 */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x9e3779b9) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad)
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97)
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296
  }
}

/**
 * Incompressible: random bytes, so `encoding` stays 'identity'.
 * @param {number} n
 * @param {number} [seed]
 * @returns {Bytes}
 */
function randomBytes(n, seed = 1) {
  const rand = rng(seed)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256)
  return out
}

/**
 * Highly compressible, and not trivially so -- repeated English-ish text.
 * @param {number} n
 * @returns {Bytes}
 */
function textBytes(n) {
  const line = 'the quick brown fox jumps over the lazy dog, and then does it again. '
  let s = ''
  while (s.length < n) s += line
  return new TextEncoder().encode(s.slice(0, n))
}

/** @param {Bytes} bytes @param {string} [name] @returns {FileSource} */
const source = (bytes, name = 'sample.bin') =>
  fromBytes({ bytes, name, mime: 'application/octet-stream' })

test('round-trips a file through encode and decode', async () => {
  const original = randomBytes(200 * 1024)
  const encoder = await createBeamEncoder({ source: source(original, 'report.pdf') })
  const decoder = createBeamDecoder()

  for (let p = 0; !decoder.complete; p++) decoder.offer(encoder.frameAt(p))

  assert.equal(decoder.manifest?.name, 'report.pdf')
  assert.deepEqual(await decoder.assemble(), original)
})

test('a clean capture costs exactly one frame per block', async () => {
  const original = randomBytes(60 * 1024)
  const encoder = await createBeamEncoder({ source: source(original) })
  const decoder = createBeamDecoder()

  let data = 0
  for (let p = 0; !decoder.complete; p++) {
    const frame = encoder.frameAt(p)
    if (parseFrame(frame).kind === 'D') data++
    decoder.offer(frame)
  }

  // The systematic prefix is what buys this: with nothing lost, the fountain
  // never has to pay for itself at all.
  assert.equal(data, encoder.frameCount)
  assert.deepEqual(await decoder.assemble(), original)
})

test('survives losing 30% of frames, without re-watching the loop', async () => {
  const original = randomBytes(200 * 1024, 7)
  const encoder = await createBeamEncoder({ source: source(original) })
  const decoder = createBeamDecoder()
  const drop = rng(99)

  let emitted = 0
  for (let p = 0; !decoder.complete; p++) {
    emitted++
    assert.ok(emitted < encoder.frameCount * 4, 'decoder stalled')
    if (drop() < 0.3) continue
    decoder.offer(encoder.frameAt(p))
  }

  assert.deepEqual(await decoder.assemble(), original)

  // The bound is the whole point. Cycling indexed chunks would need about
  // N*ln(N) frames to close the same gap, so a regression back to that shows
  // up here as a failure rather than as a user complaining it takes forever.
  const naive = encoder.frameCount * Math.log(encoder.frameCount)
  assert.ok(emitted < naive / 2, `${emitted} frames for ${encoder.frameCount} blocks`)
})

test('tolerates joining mid-cycle, before any manifest has been seen', async () => {
  const original = randomBytes(30 * 1024)
  const encoder = await createBeamEncoder({ source: source(original) })
  const decoder = createBeamDecoder()

  // Start at position 1: the first frame this decoder ever sees is a data
  // frame, which is what a receiver pointing a camera at an already-running
  // sender always gets.
  for (let p = 1; !decoder.complete; p++) decoder.offer(encoder.frameAt(p))
  assert.deepEqual(await decoder.assemble(), original)
})

test('duplicate frames are free', async () => {
  const original = randomBytes(20 * 1024)
  const encoder = await createBeamEncoder({ source: source(original) })
  const decoder = createBeamDecoder()

  for (let p = 0; !decoder.complete; p++) {
    const frame = encoder.frameAt(p)
    decoder.offer(frame)
    decoder.offer(frame)
    decoder.offer(frame)
  }
  assert.deepEqual(await decoder.assemble(), original)
})

test('ignores frames from a second, unrelated sender', async () => {
  const mine = randomBytes(20 * 1024, 3)
  const theirs = randomBytes(20 * 1024, 4)
  const a = await createBeamEncoder({ source: source(mine), sessionId: 'aaaaaaaaaaaaaaaa' })
  const b = await createBeamEncoder({ source: source(theirs), sessionId: 'bbbbbbbbbbbbbbbb' })
  const decoder = createBeamDecoder()

  for (let p = 0; !decoder.complete; p++) {
    decoder.offer(a.frameAt(p))
    // Two laptops on one desk. Interleaving these would corrupt both
    // transfers into nonsense that still passes every per-frame check.
    assert.equal(decoder.offer(b.frameAt(p)), false)
  }
  assert.deepEqual(await decoder.assemble(), mine)
})

test('compresses text and leaves incompressible bytes alone', async () => {
  const text = await createBeamEncoder({ source: source(textBytes(120 * 1024), 'notes.txt') })
  assert.equal(text.manifest.encoding, 'gzip')
  assert.ok(text.manifest.encodedSize < text.manifest.size / 3, 'gzip should win big on text')

  const noise = await createBeamEncoder({ source: source(randomBytes(60 * 1024)) })
  assert.equal(noise.manifest.encoding, 'identity')
  assert.equal(noise.manifest.encodedSize, noise.manifest.size)
})

test('a compressed file round-trips to the original bytes', async () => {
  const original = textBytes(120 * 1024)
  const encoder = await createBeamEncoder({ source: source(original, 'notes.txt') })
  const decoder = createBeamDecoder()

  for (let p = 0; !decoder.complete; p++) decoder.offer(encoder.frameAt(p))
  assert.deepEqual(await decoder.assemble(), original)
})

test('refuses a file too large to beam', async () => {
  await assert.rejects(
    createBeamEncoder({ source: source(randomBytes(MAX_ENCODED_BYTES + 1024, 11)) }),
    /Too large to beam/,
  )
})

test('rejects a manifest whose stream expands past its declared size', async () => {
  // A decompression bomb: the manifest under-declares, and the inflate has to
  // stop at the declared figure rather than trusting it and running on.
  const original = textBytes(200 * 1024)
  const encoder = await createBeamEncoder({ source: source(original) })
  const decoder = createBeamDecoder()

  const honest = parseFrame(encoder.frameAt(0))
  const manifest = JSON.parse(new TextDecoder().decode(honest.payload))
  manifest.size = 1024
  const raw = new TextEncoder().encode(JSON.stringify(manifest))
  const lie = `${PROTOCOL}|M|${honest.sessionId}|${toBase64url(raw)}|${crc32(raw)}`

  decoder.offer(lie)
  for (let p = 1; !decoder.complete; p++) decoder.offer(encoder.frameAt(p))
  await assert.rejects(decoder.assemble(), /expands to more than it declared/)
})

test('parseFrame rejects everything that is not a well-formed frame', () => {
  const payload = new Uint8Array([1, 2, 3])
  const good = `${PROTOCOL}|D|0123456789abcdef|00000000|${toBase64url(payload)}|${crc32(payload)}`
  assert.equal(parseFrame(good).seed, 0)

  /** @type {[string, RegExp][]} */
  const cases = [
    ['https://example.com', /Not a beam frame/],
    ['QRB1|D|0123456789abcdef|00000000|AQID|a1b2c3d4', /Not a beam frame/],
    [`${PROTOCOL}|D|nothex|00000000|AQID|a1b2c3d4`, /session id/],
    [`${PROTOCOL}|X|0123456789abcdef|00000000|AQID|a1b2c3d4`, /Malformed beam frame/],
    [`${PROTOCOL}|D|0123456789abcdef|zzzz|AQID|a1b2c3d4`, /seed/],
    [good.replace(/\|[0-9a-f]{8}$/, '|deadbeef'), /checksum/],
    [`${PROTOCOL}|D|0123456789abcdef|00000000|not*base64|a1b2c3d4`, /Malformed beam payload/],
  ]
  for (const [text, message] of cases) assert.throws(() => parseFrame(text), message, text)
})

test('a manifest frame appears at least once per interval', async () => {
  const encoder = await createBeamEncoder({ source: source(randomBytes(40 * 1024)) })
  for (let start = 0; start < 100; start++) {
    const window = Array.from({ length: MANIFEST_INTERVAL + 1 }, (_, i) => encoder.frameAt(start + i))
    assert.ok(window.some(f => parseFrame(f).kind === 'M'), `no manifest at ${start}`)
  }
})
