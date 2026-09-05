/**
 * Receiver -> sender backpressure under a slow sink.
 *
 * The failure this guards against: the transport hands inbound frames to
 * receiver.handleFrame() fire-and-forget, as fast as the DataChannel delivers
 * them, and handleFrame() only appends to a promise chain. When createSink()'s
 * write() drains slower than frames arrive, that chain fills with unresolved
 * closures -- each pinning one frame's bytes -- until the whole file is
 * resident. Measured once with the desktop app's old ~1.5 MB/s sink: a 1 GiB
 * transfer grew the JS heap by ~1 GiB. SCTP flow control never engages, because
 * the receiver never stops reading.
 *
 * The fix is an app-level pause/resume pair over the authenticated control
 * stream: above a high-water mark the receiver sends { t: 'pause' }, and the
 * sender's chunk loop blocks until { t: 'resume' }. These tests pin that the
 * backlog stays bounded well under the file size, that resume lets the transfer
 * finish with a matching digest, and that a peer on either side that does not
 * act on the message still completes -- just without the bound.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateSecret } from '../src/core/secret.js'
import { createEphemeralKeypair, exportPublicKey, establishSession } from '../src/core/session.js'
import { createControlStream } from '../src/core/control.js'
import { createReceiver } from '../src/core/receiver.js'
import { sendFile } from '../src/core/sender.js'
import { fromBytes } from '../src/core/source.js'
import { TYPE_CONTROL, decodeHeader, open, sealControl } from '../src/core/frame.js'

// Kept in step by hand with core/receiver.js: the tests only need the
// high-water mark, and importing an internal just to read it would be a wider
// seam than the one number is worth.
const PAUSE_AT = 4 * 1024 * 1024

/** @param {number} ms */
const delay = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * @param {number} n
 * @returns {Bytes}
 */
const randomBytes = n => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(i + 65536, n)))
  return b
}

/**
 * A DataChannel stand-in that reproduces the hazard: a real RTCDataChannel
 * fires 'message' on the far side without waiting for the handler to settle,
 * and send() resolves when the bytes are out rather than when they are dealt
 * with. So a fast sender and a slow receiver let frames pile up.
 *
 * bufferedAmount stays 0 -- like Trystero, this fake does its own buffering --
 * so sender.js's drain() never engages and the app-level pause/resume pair is
 * the only backpressure in play.
 *
 * Delivery is serialised per end through a promise chain so `filter` may be
 * async (it decrypts a control frame to read its type) without reordering
 * frames, which the receiver would treat as a fatal desync.
 *
 * @param {(dest: 0 | 1, bytes: Bytes) => (boolean | Bytes | Promise<boolean | Bytes>)} [filter]
 *   Called for every frame just before the destination end sees it: return true
 *   to drop it, a Bytes to deliver that in its place, or false to pass it
 *   through. End 0 is the host, end 1 is the guest.
 * @returns {[Channel & { onFrame: (b: Bytes) => unknown }, Channel & { onFrame: (b: Bytes) => unknown }]}
 */
function leakyChannelPair(filter) {
  const ends = [
    { onFrame: /** @type {(b: Bytes) => unknown} */ (() => {}), tail: Promise.resolve() },
    { onFrame: /** @type {(b: Bytes) => unknown} */ (() => {}), tail: Promise.resolve() },
  ]

  /** @param {0 | 1} dest */
  const make = dest => {
    const end = ends[dest]
    return {
      /** @param {Bytes} bytes */
      send(bytes) {
        const copy = Uint8Array.from(bytes)
        end.tail = end.tail.then(async () => {
          const verdict = filter ? await filter(dest, copy) : false
          if (verdict === true) return
          // Not awaited: the transport does not wait for the peer's handler,
          // and that is exactly the property under test.
          end.onFrame(verdict instanceof Uint8Array ? verdict : copy)
        })
        // Resolves once the frame is queued for delivery, never when it is
        // processed.
        return Promise.resolve()
      },
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener() {},
      removeEventListener() {},
      // A send on this end is delivered to the *other* end's handler.
      get onFrame() { return ends[dest === 0 ? 1 : 0].onFrame },
      set onFrame(fn) { ends[dest === 0 ? 1 : 0].onFrame = fn },
    }
  }

  // make(0) is the host's channel: a send on it is destined for end 0's twin,
  // i.e. the guest. Naming follows the [hostCh, guestCh] convention elsewhere.
  return [make(1), make(0)]
}

/**
 * A sink whose write() blocks until release() is called, then runs free. The
 * receiver serialises writes, so the first one parks the whole chain -- which
 * is what lets `pending` climb in a controlled way.
 */
function gatedSink() {
  /** @type {((value?: unknown) => void)[]} */
  const waiters = []
  let flowing = false
  /** @type {Bytes[]} */
  const parts = []
  return {
    streaming: true,
    name: 'gated',
    /** @param {Bytes} chunk */
    async write(chunk) {
      parts.push(Uint8Array.from(chunk))
      if (flowing) return
      await new Promise(resolve => { waiters.push(resolve) })
    },
    async close() {},
    async abort() {},
    release() {
      flowing = true
      for (const w of waiters.splice(0)) w()
    },
    bytes() { return Buffer.concat(parts.map(Buffer.from)) },
  }
}

async function pairedSessions() {
  const secret = generateSecret()
  const hk = await createEphemeralKeypair()
  const gk = await createEphemeralKeypair()
  return {
    host: await establishSession({ keypair: hk, peerPublicRaw: await exportPublicKey(gk), secret, role: 'host' }),
    guest: await establishSession({ keypair: gk, peerPublicRaw: await exportPublicKey(hk), secret, role: 'guest' }),
  }
}

/**
 * Reads the `t` of a control frame without disturbing index state -- open()
 * with a null expectation only needs the key. Returns null for a chunk frame or
 * anything that will not decrypt under `key`.
 *
 * @param {CryptoKey} key
 * @param {Bytes} bytes
 * @returns {Promise<string | null>}
 */
async function controlKind(key, bytes) {
  if (bytes[0] !== TYPE_CONTROL) return null
  try {
    const { plaintext } = await open(key, bytes, null)
    return JSON.parse(new TextDecoder().decode(plaintext)).t
  } catch {
    return null
  }
}

/**
 * Wires a sender to a receiver over one leaky channel pair and starts the
 * transfer without awaiting it.
 *
 * @param {object} args
 * @param {Bytes} args.payload
 * @param {ReturnType<typeof gatedSink>} args.sink
 * @param {Awaited<ReturnType<typeof pairedSessions>>} args.sessions
 * @param {(dest: 0 | 1, bytes: Bytes) => (boolean | Bytes | Promise<boolean | Bytes>)} [args.filter]
 */
function startTransfer({ payload, sink, sessions, filter }) {
  const { host, guest } = sessions
  const [hostCh, guestCh] = leakyChannelPair(filter)

  /** @type {unknown[]} */
  const errors = []
  /** @type {{ name: string, size: number, digest: string }[]} */
  const done = []
  let lastSent = 0

  const hostControl = createControlStream()
  let hostCtl = 0
  const hostRx = createReceiver({
    channel: hostCh,
    sendKey: host.sendKey,
    recvKey: host.recvKey,
    control: hostControl,
    nextControlIndex: () => hostCtl++,
    onOffer: () => {},
    onError: e => errors.push(e),
    createSink: async () => { throw new Error('the sending peer accepts no files') },
  })
  hostCh.onFrame = hostRx.handleFrame

  const guestControl = createControlStream()
  let guestCtl = 0
  const guestRx = createReceiver({
    channel: guestCh,
    sendKey: guest.sendKey,
    recvKey: guest.recvKey,
    control: guestControl,
    nextControlIndex: () => guestCtl++,
    onOffer: async o => { await o.accept() },
    onFileDone: f => done.push(f),
    onError: e => errors.push(e),
    createSink: async () => sink,
  })
  guestCh.onFrame = guestRx.handleFrame

  const result = sendFile({
    channel: hostCh,
    key: host.sendKey,
    file: fromBytes({ bytes: payload, name: 'payload.bin', mime: 'application/octet-stream' }),
    fileSeq: 0,
    control: hostControl,
    nextControlIndex: () => hostCtl++,
    onProgress: p => { if ('sent' in p) lastSent = p.sent },
  })
  // The suite always resolves it before the test ends; this keeps a transient
  // rejection from tripping the process-wide unhandled-rejection guard if an
  // assertion fails first.
  result.catch(() => {})

  return { result, errors, done, guestRx, sentSoFar: () => lastSent }
}

test('a slow sink makes the sender pause, and the backlog stays bounded', async () => {
  const payload = randomBytes(12 * 1024 * 1024) // 3x the high-water mark
  const sink = gatedSink()
  const { result, errors, done, guestRx, sentSoFar } = startTransfer({
    payload, sink, sessions: await pairedSessions(),
  })

  // Wait for the receiver to cross the high-water mark and the sender to stop
  // advancing in response. A bounded poll rather than a fixed sleep so a slow
  // CI box does not flake.
  let stalledAt = -1
  for (let i = 0; i < 400 && stalledAt === -1; i++) {
    const before = sentSoFar()
    await delay(20)
    if (guestRx.pending >= PAUSE_AT && before > 0 && sentSoFar() === before) stalledAt = before
  }

  assert.notEqual(stalledAt, -1, 'the sender should have paused once the sink fell behind')
  assert.ok(
    stalledAt < payload.length,
    `the sender stopped mid-file, not after sending all of it (sent ${stalledAt})`,
  )
  assert.ok(
    guestRx.pending < 2 * PAUSE_AT,
    `the pending-write backlog stayed bounded: ${guestRx.pending} < ${2 * PAUSE_AT}`,
  )
  assert.ok(
    guestRx.pending < payload.length / 2,
    'the backlog is a small fraction of the file, not the whole file in RAM',
  )
  assert.deepEqual(errors, [])

  // Let the sink run free; the receiver should fall below the low-water mark,
  // send resume, and the transfer should finish clean.
  sink.release()
  const finished = await result
  await delay(0) // let the last frame's settle handler run its decrement

  assert.equal(finished.declined, false)
  assert.deepEqual(errors, [])
  assert.equal(guestRx.pending, 0, 'every accepted frame drained through the sink')
  assert.deepEqual([...sink.bytes()], [...payload], 'the file arrives byte-identical')
  assert.equal(done.length, 1)
  assert.equal(
    done[0].digest,
    /** @type {{ declined: false, digest: string }} */ (finished).digest,
    'both ends agree on the digest',
  )
})

/**
 * A filter that turns the receiver's pause/resume frames into a control message
 * this build has never heard of, re-sealed at the same index so the control
 * stream stays contiguous.
 *
 * This is what an old peer actually does. It does not drop the frame off the
 * wire -- that would leave an index gap and desync the stream -- it opens it,
 * advances its control index, fails to recognise the type, and falls through to
 * the "Ignored, not fatal" arm in receiver.js. From the sender's side the
 * effect is identical whether the peer predates 'pause' (old sender ignores it)
 * or predates sending it (old receiver never generates it): no actionable pause
 * ever reaches the loop, and the transfer must still finish correctly.
 *
 * @param {CryptoKey} guestSendKey
 * @param {() => void} onPause Called each time a real pause was intercepted.
 * @returns {(dest: 0 | 1, bytes: Bytes) => Promise<boolean | Bytes>}
 */
function stripFlowControl(guestSendKey, onPause) {
  return async (dest, bytes) => {
    if (dest !== 0) return false // only frames heading to the host
    const kind = await controlKind(guestSendKey, bytes)
    if (kind !== 'pause' && kind !== 'resume') return false
    if (kind === 'pause') onPause()
    const { index } = decodeHeader(bytes)
    return sealControl(
      guestSendKey, index,
      /** @type {ControlMessage} */ (/** @type {unknown} */ ({ t: 'flow-from-a-newer-build' })),
    )
  }
}

test('an old sender that ignores pause still completes, unbounded', async () => {
  const sessions = await pairedSessions()
  let pausesSeen = 0
  const payload = randomBytes(10 * 1024 * 1024)
  const sink = gatedSink()

  const { result, errors, done, guestRx } = startTransfer({
    payload, sink, sessions,
    filter: stripFlowControl(sessions.guest.sendKey, () => { pausesSeen++ }),
  })

  for (let i = 0; i < 300 && guestRx.pending < PAUSE_AT * 1.5; i++) await delay(20)
  assert.ok(
    guestRx.pending >= PAUSE_AT,
    'with pause ignored, nothing stops the backlog growing past the high-water mark',
  )
  assert.ok(pausesSeen > 0, 'the receiver did try to pause; the sender simply did not act on it')

  sink.release()
  const finished = await result
  assert.equal(finished.declined, false)
  assert.deepEqual(errors, [])
  assert.deepEqual([...sink.bytes()], [...payload], 'the file still arrives byte-identical')
  assert.equal(done.length, 1)
})

test('an old receiver that never sends pause still completes', async () => {
  // Same wire behaviour from the sender's side -- no actionable pause -- but the
  // sink is released early here, so the point is narrower: a sender running
  // fully ungated drives the transfer to a correct finish rather than stalling
  // on a gate that will never open.
  const sessions = await pairedSessions()
  const payload = randomBytes(8 * 1024 * 1024)
  const sink = gatedSink()

  const { result, errors, done } = startTransfer({
    payload, sink, sessions,
    filter: stripFlowControl(sessions.guest.sendKey, () => {}),
  })

  await delay(40)
  sink.release()
  const finished = await result

  assert.equal(finished.declined, false)
  assert.deepEqual(errors, [])
  assert.deepEqual([...sink.bytes()], [...payload])
  assert.equal(done.length, 1)
  assert.equal(
    done[0].digest,
    /** @type {{ declined: false, digest: string }} */ (finished).digest,
  )
})
