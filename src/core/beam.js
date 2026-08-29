/**
 * The beam codec: a file as a stream of QR-sized text frames, and back again.
 *
 * WHAT THIS IS FOR. The rest of this package assumes a network -- the QR
 * carries a key and the bytes go over WebRTC. On an air-gapped machine there
 * is no network to assume, so there is no transfer. Beam is the answer to
 * that: the sender animates QR codes on a screen, the receiver points a camera
 * at them, and nothing crosses a wire at all.
 *
 * WHAT IT IS NOT. It is not encrypted, and it cannot be. A one-way channel has
 * no handshake, so there is no ECDH, no forward secrecy, and no SAS -- there is
 * no peer to authenticate, only photons. The only adversary is someone who can
 * see the screen, and a key displayed on that same screen does not stop them.
 * Every caller must say so plainly in its UI. Anything else would make this
 * mode *look* as protected as the WebRTC path while not being so, which is
 * worse than having no offline mode at all.
 *
 * WHERE THIS CAME FROM. The idea arrived via qrbeam
 * (https://www.npmjs.com/package/qrbeam), which beams a file to an iOS app as
 * animated QR codes; its wire format is the numbered-chunk loop this file
 * measures itself against below. The fountain-coded version of the same idea
 * is txqr (https://github.com/divan/txqr) by Ivan Daniluk, which predates this
 * by years and whose write-up (https://divan.dev/posts/fountaincodes/) is the
 * better explanation of why LT codes suit animated QR at all. The design here
 * was reached independently and no code was taken from either, but "arrived at
 * the same answer separately" is convergence, not invention, and the comment
 * below should not be read as claiming otherwise. What is actually different
 * here is the systematic prefix, gzip-by-measurement, and the interleaved
 * manifest -- each noted where it happens.
 *
 * WHY A FOUNTAIN CODE. The obvious design -- number the chunks and loop them
 * forever, as qrbeam does -- is a coupon-collector problem:
 * to gather the last few of N chunks you re-watch the whole loop many times
 * over, so completion costs about N*ln(N) frames rather than N. At N=1500 that
 * is a twelve-minute transfer instead of a two-minute one, and every dropped
 * frame costs a full extra lap. An LT code makes a dropped frame cost very
 * little, and -- the part that matters -- it does not matter WHICH frames
 * arrived, only how many. That property is the entire reason this file exists
 * rather than a fifty-line chunk-and-cycle loop, because a phone camera
 * pointed at a laptop WILL drop frames: jsQR needs 50-100ms per frame, so
 * Firefox tops out near ten decodes a second against a display emitting
 * exactly that.
 *
 * MEASURED, not hoped for. Frames the sender must emit before the receiver has
 * the whole file, at 1748 blocks (a 1 MiB payload):
 *
 *     loss     this codec      chunk-and-cycle
 *       0%     1.05 x N        1.00 x N
 *      10%     1.48 x N        8.3 x N
 *      30%     2.08 x N       10.7 x N
 *      50%     2.81 x N       14.9 x N
 *
 * Note the shape rather than the constants: cycling falls off a cliff the
 * moment anything at all is lost, because ln(N) is the price of collecting the
 * last few coupons; this stays inside a small factor. The decoder's own
 * overhead -- distinct frames needed per block -- settles near 1.3x under
 * loss, not the ~1.05x a textbook LT code reaches, because the systematic
 * prefix means most blocks are already solved by the time the fountain starts,
 * so a degree-d frame drawn against all N carries fewer unknowns than its
 * degree suggests. That is a genuine cost of the prefix and it is still worth
 * paying, because the prefix is what makes the COMMON case -- a clean capture
 * -- cost exactly N and nothing more.
 *
 * WHY THE FIRST N FRAMES ARE SYSTEMATIC. This is the main departure from txqr,
 * and it is a trade rather than an improvement -- see the table below, where
 * the cost is a decoder overhead of ~1.3x under loss against the ~1.15x a pure
 * LT code reaches. A pure fountain pays its overhead
 * even when nothing is lost, and for small N a robust soliton distribution is
 * genuinely bad at it -- 1.3-1.5x for a handful of blocks. Sending the N
 * source blocks plain first, and only then fountaining, makes a clean capture
 * cost exactly N frames and leaves the fountain to pay for what the camera
 * actually missed. Nothing downstream needs to know: a systematic frame is
 * just a degree-1 frame whose single index the decoder derives the same way it
 * derives every other.
 *
 * THE MEMORY LIMITATION, STATED RATHER THAN HIDDEN. A fountain code has no
 * ordering, so the decoder cannot write anything to disk until peeling
 * completes -- every block is held in memory until the last one arrives. That
 * is the second reason for MAX_ENCODED_BYTES below (the first being that a
 * transfer at ~6 kB/s stops being reasonable long before it stops being
 * possible). The fix, if this ever has to carry more, is to fountain-code
 * independent ~256 KiB windows so memory stays bounded and each window can be
 * flushed as it solves. That is deliberately NOT built here; it doubles the
 * protocol's moving parts to raise a cap that the transfer rate makes
 * academic.
 *
 * ISOMORPHIC, like everything else in src/core/. `CompressionStream` and
 * `crypto.subtle` are web-platform globals present in both browsers and Node
 * >=18 -- the same category as the `TextEncoder` and `crypto.subtle` that
 * core/secret.js already leans on, and not "DOM" in the sense CLAUDE.md
 * forbids. There is no `document` and no `fs` reachable from this file.
 */

import { toBase64url, fromBase64url } from './secret.js'

/** Bumped only for a change that a decoder of the previous version would misread. */
export const PROTOCOL = 'QRD1'

/**
 * Raw bytes carried per frame.
 *
 * Sized backwards from the QR: a version-20 code at error correction L holds
 * 858 bytes of byte-mode data, the frame header below costs ~50 characters,
 * and base64url inflates the payload by a third. 600 raw bytes lands just
 * inside that with room for the header, which keeps every frame at a module
 * count a phone can actually lock onto from across a desk. Raising this pushes
 * the QR version up, and a denser code is one that takes three attempts to
 * scan -- which costs far more than the bytes gained.
 */
export const BLOCK_SIZE = 600

/**
 * The cap, applied to the COMPRESSED size, because that is what determines
 * both transfer time and the decoder's memory. At ~6 kB/s this is already a
 * three-and-a-half minute transfer; it is a limit on patience as much as on
 * anything technical.
 */
export const MAX_ENCODED_BYTES = 1024 * 1024

/**
 * The largest original size a manifest may declare.
 *
 * This is a decompression-bomb guard, not a convenience. The manifest arrives
 * from the peer exactly as the filename does, and this codebase already treats
 * that as hostile input (see web/sink.js's safeFilename). A manifest claiming
 * two gigabytes would otherwise have the receiver inflate until it died. The
 * inflate is *also* stopped the moment it exceeds the declared size, so a
 * truthful-looking header cannot smuggle an untruthful stream past this.
 */
export const MAX_DECODED_BYTES = 64 * 1024 * 1024

/**
 * How often the manifest is interleaved into the frame cycle.
 *
 * The receiver cannot do anything with a data frame until it knows N and the
 * block size, and it cannot be assumed to have been pointed at the screen when
 * the sender started. Repeating the manifest every twenty frames means a
 * receiver joining at any moment waits at most two seconds to get going,
 * against a ~5% cost in frames. Sending it once at the start would be free and
 * would strand anyone who did not scan the first two seconds of the loop.
 */
export const MANIFEST_INTERVAL = 20

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[i] = c >>> 0
}

/**
 * A per-frame integrity check, and deliberately not a cryptographic one.
 *
 * What this defends against is a QR decoder handing back a plausible-looking
 * string it got slightly wrong -- a real failure mode when a camera catches a
 * frame mid-repaint. One corrupt block XORed into the peeling state would
 * silently poison every block that depends on it, and the damage would only
 * surface as a SHA-256 mismatch minutes later with nothing to point at. CRC32
 * catches that at the door for eight characters. It is NOT a defence against a
 * deliberate forgery, and nothing here pretends otherwise -- an attacker who
 * can put frames on the screen has already won by definition (see the header).
 *
 * @param {Uint8Array} data
 * @returns {string} Eight lowercase hex characters.
 */
export function crc32(data) {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Deterministic PRNG and the degree distribution
// ---------------------------------------------------------------------------

/**
 * splitmix32, seeded per frame.
 *
 * The whole reason a frame carries a seed rather than a list of block indices
 * is that a degree-40 frame would otherwise need forty numbers in its header,
 * which at this frame size is a meaningful fraction of the payload. A seed is
 * eight characters whatever the degree, and the decoder replays this exact
 * sequence to recover the set. That makes the generator part of the wire
 * format: changing it breaks compatibility as surely as renaming a field, so
 * it is pinned here rather than reached for from anywhere general.
 *
 * splitmix32 specifically because it is seven lines, passes well enough for a
 * use that needs spread rather than unpredictability, and -- unlike a
 * Math.random() with a seed bolted on -- is identical in every engine.
 *
 * @param {number} seed
 * @returns {() => number} Successive floats in [0, 1).
 */
function splitmix32(seed) {
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
 * The robust soliton distribution, precomputed as a CDF.
 *
 * The ideal soliton distribution -- rho(1) = 1/N, rho(d) = 1/(d(d-1)) -- has
 * exactly the right *expected* behaviour and is useless in practice, because
 * it expects to have precisely one degree-1 frame available at every step and
 * the peeling stalls the moment variance takes that away. The robust version
 * adds a spike of extra low-degree frames (the tau term) so the ripple of
 * solvable frames stays populated, at the cost of a few percent more frames
 * overall. This is the standard fix and the constants below are the standard
 * ones; `c` around 0.03 and `delta` 0.05 are what the literature suggests for
 * N in the hundreds-to-thousands range, which is the whole of our N.
 *
 * Computed once per encoder or decoder, not per frame: N is fixed for a
 * transfer, and rebuilding a 1500-entry table for every one of 1600 frames was
 * measurably the slowest thing in the encoder before this was hoisted.
 *
 * @param {number} n Number of source blocks.
 * @returns {Float64Array} CDF, length n + 1, indexed by degree.
 */
function solitonCDF(n) {
  const c = 0.03
  const delta = 0.05
  const r = Math.max(1, c * Math.log(n / delta) * Math.sqrt(n))
  const spike = Math.max(1, Math.round(n / r))

  const p = new Float64Array(n + 1)
  // Ideal soliton.
  p[1] = 1 / n
  for (let d = 2; d <= n; d++) p[d] = 1 / (d * (d - 1))
  // Robust term.
  for (let d = 1; d < spike; d++) p[d] += r / (d * n)
  if (spike <= n) p[spike] += (r * Math.log(r / delta)) / n

  let total = 0
  for (let d = 1; d <= n; d++) total += p[d]
  let running = 0
  for (let d = 1; d <= n; d++) {
    running += p[d] / total
    p[d] = running
  }
  p[n] = 1 // Guard against float drift leaving the last bucket unreachable.
  return p
}

/**
 * Which source blocks a frame is the XOR of.
 *
 * Both halves of the codec call this, and they MUST agree exactly -- it is the
 * wire format in function form. A frame whose seed is below `blocks` is a
 * systematic frame carrying that one source block verbatim (see the header);
 * everything above is drawn from the distribution.
 *
 * @param {number} seed
 * @param {number} blocks
 * @param {Float64Array} cdf
 * @returns {number[]} Distinct source-block indices.
 */
export function frameIndices(seed, blocks, cdf) {
  if (seed < blocks) return [seed]

  const rand = splitmix32(seed)
  const roll = rand()
  let degree = 1
  while (degree < blocks && cdf[degree] < roll) degree++

  // Sampling without replacement by retry. Degree is at most `blocks`, and the
  // distribution puts almost all its mass on small degrees, so the expected
  // number of retries is negligible -- a shuffle would allocate an array of
  // `blocks` on every single frame to save collisions that mostly do not
  // happen.
  const picked = new Set()
  let guard = degree * 8 + 16
  while (picked.size < degree && guard-- > 0) picked.add(Math.floor(rand() * blocks))
  return [...picked]
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * gzip, and specifically not brotli.
 *
 * Brotli is the better algorithm -- 15-20% smaller on text at this size -- and
 * it is no longer a dependency question either, since the WHATWG Compression
 * Standard now lists it as a CompressionStream format. It is still the wrong
 * choice HERE, for a reason particular to this mode: a one-way channel cannot
 * negotiate. The sender picks blind and the receiver can either inflate it or
 * cannot, with no back channel to discover which. gzip has been baseline in
 * every browser since May 2023; brotli is Safari 18.4+ and Firefox 147+ with
 * Chrome -- the likely sender and a very common receiver -- behind. A sender
 * choosing brotli would hand some phones a file they structurally cannot open,
 * and the only remedy the UI could offer is "try a different browser". Trading
 * a guaranteed transfer for twenty-five seconds off a three-minute one is a
 * bad trade when the failure is total.
 *
 * This is why `encoding` is a string in the manifest rather than a boolean:
 * when Chrome ships brotli, preferring it is a feature-detect and one string.
 */
const ENCODING = 'gzip'

export const compressionAvailable = () =>
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'

/**
 * One buffer in, one stream out.
 *
 * A `Blob` would be the shorter way to say this, and `new Response(s)` the
 * shorter way to drain it -- but both drag a further web-platform global into
 * the isomorphic half of the package for no gain. A ReadableStream is the one
 * thing CompressionStream already requires us to have.
 *
 * @param {Bytes} bytes
 * @returns {ReadableStream<Bytes>}
 */
function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Drains a stream, refusing to produce more than `limit` bytes.
 *
 * The limit is enforced against the *stream*, not against the header that
 * claimed it. A manifest is peer-supplied, so a truthful-looking `size` field
 * in front of a stream that expands forever is exactly the shape of attack
 * worth closing, and checking only the header would close nothing at all.
 *
 * @param {ReadableStream<Bytes>} stream
 * @param {number} limit
 * @returns {Promise<Bytes>}
 */
async function collect(stream, limit) {
  const reader = stream.getReader()
  /** @type {Bytes[]} */
  const parts = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      throw new Error('The sender\'s file expands to more than it declared, so it was refused')
    }
    parts.push(value)
  }

  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/**
 * @param {Bytes} bytes
 * @param {'gzip'} format
 * @returns {Promise<Bytes>}
 */
async function deflate(bytes, format) {
  // No meaningful limit on the way out: compressing cannot expand by more than
  // a few bytes of framing, and the caller is about to check the result
  // against MAX_ENCODED_BYTES anyway.
  return collect(streamOf(bytes).pipeThrough(new CompressionStream(format)), Number.MAX_SAFE_INTEGER)
}

/**
 * @param {Bytes} bytes
 * @param {'gzip'} format
 * @param {number} limit
 * @returns {Promise<Bytes>}
 */
async function inflate(bytes, format, limit) {
  return collect(streamOf(bytes).pipeThrough(new DecompressionStream(format)), limit)
}

/**
 * @param {Bytes} bytes
 * @returns {Promise<string>} Lowercase hex SHA-256.
 */
async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BeamManifest
 * @property {string} protocol
 * @property {string} name Untrusted. Callers pass it through safeFilename.
 * @property {number} size Original, pre-compression.
 * @property {number} encodedSize What is actually on the wire.
 * @property {'gzip' | 'identity'} encoding
 * @property {string} mime
 * @property {number} blockSize
 * @property {number} blocks
 * @property {string} sha256 Over the ORIGINAL bytes, so the check covers what
 *   the user ends up with rather than an intermediate representation.
 */

/**
 * @typedef {object} BeamFrame
 * @property {'M' | 'D'} kind
 * @property {number} seed Absent meaning for a manifest frame; 0.
 * @property {Bytes} payload
 */

/**
 * Frames are TEXT, not binary, and that is a deliberate loss.
 *
 * base64url costs a third of every frame, and jsQR would hand back raw bytes
 * via its `binaryData` field if we asked. But the fast path is
 * `BarcodeDetector`, whose `detect()` returns `rawValue` as a *string* with no
 * binary equivalent -- so going binary would forfeit the native, hardware
 * decoder on exactly the devices that need it most, phones, in exchange for
 * 33% more payload. A frame that decodes is worth more than a frame that is
 * dense, so text it is.
 *
 * @param {string} sessionId
 * @param {BeamManifest} manifest
 * @returns {string}
 */
function manifestFrame(sessionId, manifest) {
  const raw = new TextEncoder().encode(JSON.stringify(manifest))
  return `${PROTOCOL}|M|${sessionId}|${toBase64url(raw)}|${crc32(raw)}`
}

/**
 * @param {string} sessionId
 * @param {number} seed
 * @param {Bytes} payload
 * @returns {string}
 */
function dataFrame(sessionId, seed, payload) {
  const seedHex = (seed >>> 0).toString(16).padStart(8, '0')
  return `${PROTOCOL}|D|${sessionId}|${seedHex}|${toBase64url(payload)}|${crc32(payload)}`
}

/**
 * Parses one scanned string, or throws.
 *
 * Throwing rather than returning null is right here because every caller is a
 * scan loop that already has to tolerate garbage -- the camera sees posters,
 * wifi codes, and half-repainted frames -- so the loop catches and moves on.
 * A null return would make "not a beam frame" and "a beam frame that failed
 * its CRC" indistinguishable at the call site, and those want the same
 * handling but very different messages if either is ever surfaced.
 *
 * @param {string} text
 * @returns {{ kind: 'M' | 'D', sessionId: string, seed: number, payload: Bytes }}
 */
export function parseFrame(text) {
  const parts = text.split('|')
  if (parts[0] !== PROTOCOL) throw new Error('Not a beam frame')

  const kind = parts[1]
  const sessionId = parts[2]
  if (!/^[0-9a-f]{16}$/.test(sessionId ?? '')) throw new Error('Invalid beam session id')

  let seed = 0
  /** @type {string} */
  let encoded
  /** @type {string} */
  let checksum

  if (kind === 'M' && parts.length === 5) {
    encoded = parts[3]
    checksum = parts[4]
  } else if (kind === 'D' && parts.length === 6) {
    if (!/^[0-9a-f]{8}$/.test(parts[3])) throw new Error('Invalid beam frame seed')
    seed = parseInt(parts[3], 16)
    encoded = parts[4]
    checksum = parts[5]
  } else {
    throw new Error('Malformed beam frame')
  }

  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error('Malformed beam payload')
  const payload = fromBase64url(encoded)
  if (!/^[0-9a-f]{8}$/.test(checksum)) throw new Error('Invalid beam checksum')
  if (crc32(payload) !== checksum) throw new Error('Beam frame failed its checksum')

  return { kind: /** @type {'M' | 'D'} */ (kind), sessionId, seed, payload }
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Reads a FileSource whole, compresses it if that helps, and turns it into an
 * endless sequence of frames.
 *
 * The source is read entirely into memory rather than sliced on demand, unlike
 * core/sender.js. Compression needs the whole buffer, the fountain reads
 * blocks in an order nobody can predict, and MAX_ENCODED_BYTES bounds the
 * whole thing anyway -- so the streaming discipline sender.js maintains would
 * buy nothing here but complexity.
 *
 * @param {object} args
 * @param {FileSource} args.source
 * @param {number} [args.blockSize]
 * @param {string} [args.sessionId] Injectable for tests; random otherwise.
 * @returns {Promise<{
 *   manifest: BeamManifest,
 *   frameCount: number,
 *   cycleLength: number,
 *   frameAt: (position: number) => string,
 * }>}
 */
export async function createBeamEncoder({ source, blockSize = BLOCK_SIZE, sessionId }) {
  const raw = await source.slice(0, source.size)

  // Compress, then keep the result only if it actually helped. The gain is
  // entirely file-type dependent -- 3-10x on text, JSON, CSV, logs and source,
  // which is most of what anyone moves across an air gap, and nothing at all
  // on a zip or a JPEG, where it can even grow. Deciding by measurement rather
  // than by extension takes the question away from the user completely: there
  // is no toggle to explain and no wrong answer to pick. The 5% margin stops
  // us paying a decompression step on the receiver for a rounding error.
  let encoded = raw
  /** @type {'gzip' | 'identity'} */
  let encoding = 'identity'
  if (compressionAvailable() && raw.length > 0) {
    const squeezed = await deflate(raw, ENCODING)
    if (squeezed.length < raw.length * 0.95) {
      encoded = squeezed
      encoding = ENCODING
    }
  }

  if (encoded.length > MAX_ENCODED_BYTES) {
    throw new Error(
      `Too large to beam: ${encoded.length} bytes after compression, and the limit is `
      + `${MAX_ENCODED_BYTES}. Use the network transfer instead.`,
    )
  }

  const blocks = Math.max(1, Math.ceil(encoded.length / blockSize))
  const cdf = solitonCDF(blocks)

  const id = sessionId ?? randomSessionId()
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('sessionId must be 16 lowercase hex characters')

  /** @type {BeamManifest} */
  const manifest = {
    protocol: PROTOCOL,
    name: source.name,
    size: raw.length,
    encodedSize: encoded.length,
    encoding,
    mime: source.mime,
    blockSize,
    blocks,
    sha256: await sha256(raw),
  }
  const mFrame = manifestFrame(id, manifest)

  /**
   * The nth source block, zero-padded at the tail so every block is exactly
   * blockSize -- XOR needs equal lengths, and the manifest's encodedSize is
   * what trims the padding back off at the far end.
   * @param {number} i
   */
  const blockAt = i => {
    const out = new Uint8Array(blockSize)
    out.set(encoded.subarray(i * blockSize, Math.min((i + 1) * blockSize, encoded.length)))
    return out
  }

  return {
    manifest,
    frameCount: blocks,
    cycleLength: blocks + Math.ceil(blocks / MANIFEST_INTERVAL),

    /**
     * Position counts frames emitted, not data frames -- the manifest is woven
     * in, so the caller just increments and never has to know the pattern.
     * Unbounded on purpose: the fountain is endless, and a sender loops until
     * the receiver says it is done (by a human watching their screen, since
     * there is no back channel to say it with).
     * @param {number} position
     */
    frameAt(position) {
      if (!Number.isSafeInteger(position) || position < 0) {
        throw new Error('Frame position must be a non-negative integer')
      }
      // One manifest, then MANIFEST_INTERVAL data frames, repeating.
      const slot = position % (MANIFEST_INTERVAL + 1)
      if (slot === 0) return mFrame

      const seed = Math.floor(position / (MANIFEST_INTERVAL + 1)) * MANIFEST_INTERVAL + slot - 1
      const indices = frameIndices(seed, blocks, cdf)
      const payload = blockAt(indices[0])
      for (let i = 1; i < indices.length; i++) {
        const other = blockAt(indices[i])
        for (let b = 0; b < blockSize; b++) payload[b] ^= other[b]
      }
      return dataFrame(id, seed, payload)
    },
  }
}

/** @returns {string} */
function randomSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Collects frames in any order and reconstructs the file once enough arrive.
 *
 * Stateful, and fed one scanned string at a time by a scan loop. It tolerates
 * anything: duplicates, frames from a different session, frames that arrive
 * before the manifest does, and outright garbage from a poster on the wall
 * behind the sender's laptop.
 *
 * @returns {{
 *   offer: (text: string) => boolean,
 *   readonly manifest: BeamManifest | null,
 *   readonly solved: number,
 *   readonly blocks: number,
 *   readonly complete: boolean,
 *   assemble: () => Promise<Bytes>,
 * }}
 */
export function createBeamDecoder() {
  /** @type {BeamManifest | null} */
  let manifest = null
  /** @type {string | null} */
  let sessionId = null
  /** @type {Float64Array | null} */
  let cdf = null

  /** @type {(Uint8Array | null)[]} */
  let solved = []
  let solvedCount = 0

  /**
   * Frames still carrying more than one unknown block, each reduced against
   * everything solved so far.
   * @type {{ indices: Set<number>, payload: Uint8Array }[]}
   */
  const pending = []

  /**
   * Data frames that arrived before the manifest did.
   *
   * Kept rather than dropped because a receiver typically starts scanning
   * mid-cycle and would otherwise throw away up to MANIFEST_INTERVAL frames
   * for no reason. Bounded, because until the manifest arrives there is
   * nothing to tell us how big this should get, and an unbounded buffer fed by
   * a camera pointed at an arbitrary screen is a memory leak with a nice name.
   * @type {{ seed: number, payload: Uint8Array }[]}
   */
  const early = []
  const EARLY_LIMIT = MANIFEST_INTERVAL * 4

  /** Seeds already folded in, so a duplicate frame is free rather than harmful. */
  const seen = new Set()

  /** @param {number} index @param {Uint8Array} block */
  const solve = (index, block) => {
    if (solved[index]) return
    solved[index] = block
    solvedCount++

    // Cascade: solving one block may expose a new degree-1 frame, which solves
    // another, and so on. This is the peeling decoder, and the queue is what
    // keeps it iterative -- the recursive form blows the stack on a long chain,
    // which for a 1700-block file is not a hypothetical depth.
    const queue = [index]
    while (queue.length) {
      const just = /** @type {number} */ (queue.pop())
      const block = /** @type {Uint8Array} */ (solved[just])
      for (let i = pending.length - 1; i >= 0; i--) {
        const frame = pending[i]
        if (!frame.indices.has(just)) continue
        for (let b = 0; b < block.length; b++) frame.payload[b] ^= block[b]
        frame.indices.delete(just)
        if (frame.indices.size > 1) continue

        pending.splice(i, 1)
        if (frame.indices.size === 0) continue
        const next = /** @type {number} */ (frame.indices.values().next().value)
        if (solved[next]) continue
        solved[next] = frame.payload
        solvedCount++
        queue.push(next)
      }
    }
  }

  /** @param {number} seed @param {Uint8Array} payload */
  const absorb = (seed, payload) => {
    if (seen.has(seed)) return
    seen.add(seed)

    const indices = new Set(frameIndices(seed, /** @type {BeamManifest} */ (manifest).blocks,
      /** @type {Float64Array} */ (cdf)))
    for (const index of [...indices]) {
      const block = solved[index]
      if (!block) continue
      for (let b = 0; b < payload.length; b++) payload[b] ^= block[b]
      indices.delete(index)
    }

    if (indices.size === 0) return
    if (indices.size === 1) {
      solve(/** @type {number} */ (indices.values().next().value), payload)
    } else {
      pending.push({ indices, payload })
    }
  }

  return {
    /**
     * @param {string} text One scanned QR value.
     * @returns {boolean} Whether it was a beam frame this decoder could use.
     */
    offer(text) {
      /** @type {ReturnType<typeof parseFrame>} */
      let frame
      try {
        frame = parseFrame(text)
      } catch {
        return false
      }

      // First frame of any kind fixes the session. A camera can see two
      // senders at once -- two laptops on one desk -- and interleaving their
      // blocks would corrupt both transfers into nonsense that still passes
      // every per-frame check.
      if (sessionId === null) sessionId = frame.sessionId
      else if (sessionId !== frame.sessionId) return false

      if (frame.kind === 'M') {
        if (manifest) return true
        const parsed = readManifest(frame.payload)
        manifest = parsed
        cdf = solitonCDF(parsed.blocks)
        solved = new Array(parsed.blocks).fill(null)
        for (const held of early.splice(0)) absorb(held.seed, held.payload)
        return true
      }

      if (!manifest) {
        if (early.length < EARLY_LIMIT) early.push({ seed: frame.seed, payload: frame.payload })
        return true
      }
      absorb(frame.seed, frame.payload)
      return true
    },

    get manifest() { return manifest },
    get solved() { return solvedCount },
    get blocks() { return manifest?.blocks ?? 0 },
    get complete() { return manifest !== null && solvedCount === manifest.blocks },

    /**
     * The original bytes, inflated and checked.
     *
     * @returns {Promise<Bytes>}
     */
    async assemble() {
      const done = manifest
      if (!done || solvedCount !== done.blocks) throw new Error('The transfer is not complete yet')

      const joined = new Uint8Array(done.blocks * done.blockSize)
      for (let i = 0; i < done.blocks; i++) {
        joined.set(/** @type {Uint8Array} */ (solved[i]), i * done.blockSize)
      }
      const encoded = joined.subarray(0, done.encodedSize)

      const out = done.encoding === 'gzip'
        ? await inflate(encoded, 'gzip', done.size)
        : new Uint8Array(encoded)

      if (out.length !== done.size) throw new Error('The received file is not the size it declared')
      if (await sha256(out) !== done.sha256) {
        throw new Error('The received file failed its checksum, so it was discarded')
      }
      return out
    },
  }
}

/**
 * Validates a manifest coming off the wire.
 *
 * Every field is checked before anything is sized from it. `blocks` sizes an
 * array, `size` bounds an inflate, and `blockSize` sizes every XOR -- so a
 * manifest is not "just metadata" here, it is a set of allocation instructions
 * arriving from a device nobody has authenticated. `name` is deliberately NOT
 * sanitised here: web/sink.js's safeFilename owns that, and doing it in two
 * places is how the two versions drift apart.
 *
 * @param {Uint8Array} payload
 * @returns {BeamManifest}
 */
function readManifest(payload) {
  /** @type {any} */
  let value
  try {
    value = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    throw new Error('The beam manifest was not readable')
  }

  if (!value || typeof value !== 'object') throw new Error('The beam manifest was not readable')
  if (value.protocol !== PROTOCOL) throw new Error(`Unsupported beam protocol: ${value.protocol}`)

  const blocks = value.blocks
  const blockSize = value.blockSize
  const size = value.size
  const encodedSize = value.encodedSize

  const positive = /** @param {unknown} n */ n => Number.isSafeInteger(n) && /** @type {number} */ (n) > 0
  if (!positive(blocks) || !positive(blockSize)) throw new Error('The beam manifest is malformed')
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('The beam manifest is malformed')
  if (!Number.isSafeInteger(encodedSize) || encodedSize < 0) {
    throw new Error('The beam manifest is malformed')
  }
  if (size > MAX_DECODED_BYTES) throw new Error('The sender declared a file too large to receive')
  if (encodedSize > MAX_ENCODED_BYTES) throw new Error('The sender declared a file too large to receive')
  if (blocks * blockSize > MAX_ENCODED_BYTES + blockSize) {
    throw new Error('The beam manifest is malformed')
  }
  if (value.encoding !== 'gzip' && value.encoding !== 'identity') {
    throw new Error(`Unsupported beam encoding: ${value.encoding}`)
  }

  // Checked here rather than at assembly time, and that gap is the point: a
  // receiver on a browser without DecompressionStream must find out in the
  // first two seconds, not after four minutes of holding a phone steady.
  if (value.encoding === 'gzip' && !compressionAvailable()) {
    throw new Error('This browser cannot decompress the incoming file. Try Chrome, Firefox or Safari.')
  }

  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error('The beam manifest is malformed')
  }

  return {
    protocol: PROTOCOL,
    name: typeof value.name === 'string' ? value.name : '',
    size,
    encodedSize,
    encoding: value.encoding,
    mime: typeof value.mime === 'string' ? value.mime : 'application/octet-stream',
    blockSize,
    blocks,
    sha256: value.sha256,
  }
}
