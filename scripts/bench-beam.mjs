/**
 * The beam loss table, measured: every number docs/beam.md, the README and the
 * header of src/core/beam.js quote about frame loss comes from this file.
 *
 *   node scripts/bench-beam.mjs           # markdown tables
 *   node scripts/bench-beam.mjs --json    # the same, as data
 *
 * WHY THIS EXISTS. The first version of the table said a numbered loop needs
 * 8.3x N frames at 10% loss, and no script behind it was ever committed. That
 * number is what chunks picked at RANDOM cost -- the N*ln(N) coupon collector
 * -- not the in-order loop qrbeam actually uses, which offers every missing
 * chunk once a lap and finishes in about ln(N)/ln(1/loss) laps: 3.9x N, not
 * 8.3x. Both are measured below so the difference stays visible. A reader's
 * question about burst loss is what caught it, and the burst and stall tables
 * are the answer to that question.
 *
 * WHAT IS COUNTED. Frames the sender emits until the receiver is complete, as
 * a multiple of N. The fountain count includes the manifest frames woven into
 * the stream (hence 1.05x with no loss); the loop has none (hence 1.00x). The
 * overhead table counts something else: distinct DATA frames the decoder took
 * in per block, for the codec as shipped and for a pure LT code -- the same
 * stream with the systematic prefix skipped.
 *
 * WHY A HAND-RUN SCRIPT and not a test: it takes a couple of minutes, and the
 * numbers are offered as measurements, not as constants to assert. What the
 * suite pins is the shape -- test/beam.test.mjs fails if a 30%-loss transfer
 * stops beating a loop by a wide margin. Every case here is seeded with the
 * suite's own PRNG, so a run is reproducible to the digit.
 */

import { createBeamEncoder, createBeamDecoder, MANIFEST_INTERVAL } from '../src/core/beam.js'
import { fromBytes } from '../src/core/source.js'

const json = process.argv.includes('--json')

/**
 * test/beam.test.mjs's PRNG.
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

// Loss models. Each builds a fresh "is this frame lost?" function from a seed.

/** @typedef {(seed: number) => () => boolean} LossModel */

/**
 * Every frame an independent coin flip -- what the original table assumed.
 * @param {number} p
 * @returns {LossModel}
 */
const independent = p => seed => {
  const r = rng(seed)
  return () => r() < p
}

/**
 * Bursts: a two-state (Gilbert) chain with mean loss p and mean run length L.
 * Models a phone camera that hands the decoder only its newest frame, so the
 * frames shown while it is busy are lost together.
 * @param {number} p
 * @param {number} L
 * @returns {LossModel}
 */
const bursts = (p, L) => seed => {
  const r = rng(seed)
  const recover = 1 / L
  const enter = p / (L * (1 - p))
  let lost = r() < p
  return () => (lost = lost ? r() >= recover : r() < enter)
}

/**
 * A decoder that stalls on a fixed rhythm: `run` frames lost in every `period`.
 * @param {number} period
 * @param {number} run
 * @param {number} jitter
 * @returns {LossModel}
 */
const stall = (period, run, jitter) => seed => {
  const r = rng(seed)
  let pos = 0
  let next = 0
  let left = 0
  return () => {
    if (pos++ === next) {
      left = run
      next += period + (jitter ? Math.round((r() - 0.5) * 2 * jitter) : 0)
    }
    return left > 0 && left-- > 0
  }
}

// The payload: 1 MiB of seeded random bytes, incompressible so it stays 1,748 blocks.
const SIZE = 1024 * 1024
const bytes = new Uint8Array(SIZE)
{
  const r = rng(1)
  for (let i = 0; i < SIZE; i++) bytes[i] = Math.floor(r() * 256)
}
const encoder = await createBeamEncoder({
  source: fromBytes({ bytes, name: 'bench.bin', mime: 'application/octet-stream' }),
  sessionId: '0123456789abcdef',
})
const N = encoder.frameCount
/** @type {string[]} */
const frames = []
/** @param {number} p */
const frameAt = p => (frames[p] ??= encoder.frameAt(p))
const CAP = 60 * N

// Designs. Each takes a loss function and returns frames emitted / N, or Infinity.

/** @param {() => boolean} lost */
function fountain(lost) {
  const decoder = createBeamDecoder()
  let p = 0
  for (; !decoder.complete && p < CAP; p++) if (!lost()) decoder.offer(frameAt(p))
  return decoder.complete ? p / N : Infinity
}

/**
 * Numbered chunks shown in order, 1..N, round and round -- qrbeam's design.
 * @param {() => boolean} lost
 */
function loop(lost) {
  const have = new Uint8Array(N)
  let got = 0
  let p = 0
  for (; got < N && p < CAP; p++) {
    if (lost()) continue
    const c = p % N
    if (!have[c]) { have[c] = 1; got++ }
  }
  return got === N ? p / N : Infinity
}

/**
 * The model the old 8.3x matched: each frame carries a chunk picked at random.
 * @param {() => boolean} lost
 * @param {number} seed
 */
function randomPick(lost, seed) {
  const pick = rng(seed ^ 0x5bd1e995)
  const have = new Uint8Array(N)
  let got = 0
  let p = 0
  for (; got < N && p < CAP; p++) {
    if (lost()) continue
    const c = Math.floor(pick() * N)
    if (!have[c]) { have[c] = 1; got++ }
  }
  return got === N ? p / N : Infinity
}

/**
 * The data-frame seed at a stream position, or -1 for a manifest -- the same
 * arithmetic as encoder.frameAt.
 * @param {number} p
 */
const seedAt = p => {
  const slot = p % (MANIFEST_INTERVAL + 1)
  return slot === 0 ? -1 : Math.floor(p / (MANIFEST_INTERVAL + 1)) * MANIFEST_INTERVAL + slot - 1
}
let firstFountain = 0
while (seedAt(firstFountain) < N) firstFountain++

/**
 * Decoder overhead: distinct data frames taken in per block, manifests
 * excluded. `pure` starts at the first fountain frame, so the stream is a
 * plain LT code with no systematic prefix.
 * @param {() => boolean} lost
 * @param {boolean} pure
 */
function overhead(lost, pure) {
  const decoder = createBeamDecoder()
  decoder.offer(frameAt(0))
  let data = 0
  for (let p = pure ? firstFountain : 1; !decoder.complete && p < CAP; p++) {
    if (seedAt(p) < 0) { decoder.offer(frameAt(p)); continue }
    if (lost()) continue
    decoder.offer(frameAt(p))
    data++
  }
  return decoder.complete ? data / N : Infinity
}

const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i)

/** @typedef {{ mean: number, min: number, max: number, never: number }} Cell */

/**
 * @param {(lost: () => boolean, seed: number) => number} design
 * @param {LossModel} model
 * @returns {Cell}
 */
function measure(design, model) {
  const xs = SEEDS.map(s => design(model(s), s))
  const done = xs.filter(Number.isFinite)
  return {
    mean: done.length ? done.reduce((a, b) => a + b, 0) / done.length : NaN,
    min: done.length ? Math.min(...done) : NaN,
    max: done.length ? Math.max(...done) : NaN,
    never: xs.length - done.length,
  }
}

/** @param {Cell} m */
const fmt = m =>
  m.never === SEEDS.length
    ? `never (${m.never}/${SEEDS.length})`
    : `${m.mean.toFixed(2)}× (${m.min.toFixed(2)}–${m.max.toFixed(2)})`
      + (m.never ? `, never in ${m.never}/${SEEDS.length}` : '')

const rows = [0, 0.1, 0.3, 0.5].map(p => ({
  loss: p,
  fountain: measure(fountain, independent(p)),
  // Bursts are meaningless at 0% loss, where there are no runs to have.
  fountainBursts: measure(fountain, p ? bursts(p, 8) : independent(0)),
  loop: measure(loop, independent(p)),
  loopBursts: measure(loop, p ? bursts(p, 8) : independent(0)),
  randomPick: measure(randomPick, independent(p)),
}))

const shortRuns = [0.1, 0.3, 0.5].map(p => ({
  loss: p,
  fountain: measure(fountain, bursts(p, 3)),
  loop: measure(loop, bursts(p, 3)),
}))

const stalls = /** @type {const} */ ([
  ['1 frame in every 4, exactly (4 divides N)', stall(4, 1, 0)],
  ['1 frame in every 4, ±1 frame of jitter', stall(4, 1, 1)],
]).map(([label, model]) => ({ label, fountain: measure(fountain, model), loop: measure(loop, model) }))

const overheads = [0.1, 0.3, 0.5].map(p => ({
  loss: p,
  shipped: measure(lost => overhead(lost, false), independent(p)),
  pureLT: measure(lost => overhead(lost, true), independent(p)),
}))

if (json) {
  console.log(JSON.stringify({ N, seeds: SEEDS.length, rows, shortRuns, stalls, overheads }, null, 2))
} else {
  /** @param {number} p */
  const pct = p => `${p * 100}%`
  console.log(`N = ${N} blocks, ${SEEDS.length} seeds per cell, mean (min–max)\n`)
  console.log('| frame loss | fountain, independent | fountain, bursts (mean run 8) | loop, independent | loop, bursts (mean run 8) | random pick, independent |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const r of rows) {
    console.log(`| ${pct(r.loss)} | ${fmt(r.fountain)} | ${fmt(r.fountainBursts)} | ${fmt(r.loop)} | ${fmt(r.loopBursts)} | ${fmt(r.randomPick)} |`)
  }
  console.log('\n| frame loss | fountain, bursts (mean run 3) | loop, bursts (mean run 3) |')
  console.log('| --- | --- | --- |')
  for (const r of shortRuns) console.log(`| ${pct(r.loss)} | ${fmt(r.fountain)} | ${fmt(r.loop)} |`)
  console.log('\n| decoder stall | fountain | loop |')
  console.log('| --- | --- | --- |')
  for (const s of stalls) console.log(`| ${s.label} | ${fmt(s.fountain)} | ${fmt(s.loop)} |`)
  console.log('\n| frame loss | decoder overhead, as shipped | decoder overhead, pure LT |')
  console.log('| --- | --- | --- |')
  for (const o of overheads) console.log(`| ${pct(o.loss)} | ${fmt(o.shipped)} | ${fmt(o.pureLT)} |`)
}
