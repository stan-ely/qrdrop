import test from 'node:test'
import assert from 'node:assert/strict'

import { generateSecret } from '../src/core/secret.js'
import { createEphemeralKeypair, exportPublicKey, establishSession } from '../src/core/session.js'
import { createControlStream, sendControl } from '../src/core/control.js'
import { createReceiver, sendPathVerdict } from '../src/core/receiver.js'
import { sendFile } from '../src/core/sender.js'
import { fromBytes } from '../src/core/source.js'
import { TYPE_CONTROL, decodeHeader } from '../src/core/frame.js'

// The field report: a phone receiving from the CLI failed with "Out-of-order
// frame: expected 0, got 1" before any offer appeared, and the identical retry
// worked. The CLI sends its path verdict and its manifest back to back, and each
// took its control index synchronously, awaited the seal, and only then sent --
// so whichever seal WebCrypto finished first went out first. Nothing here is
// faked but timing: real sessions, real framing, real receivers. The one
// intervention is making the seal of control index 0 slower than the one after
// it, an order WebCrypto was always free to finish two concurrent seals in.

/** @param {number} ms */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Slows the seal of every control frame at index 0 until the returned restore
 * function is called.
 *
 * @param {number} ms
 */
function slowControlIndexZero(ms) {
  const subtle = /** @type {any} */ (globalThis.crypto.subtle)
  const real = subtle.encrypt
  subtle.encrypt = async function (/** @type {any} */ alg, /** @type {any} */ key, /** @type {any} */ data) {
    const aad = alg?.additionalData
    if (aad && aad[0] === TYPE_CONTROL) {
      const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength)
      if (view.getBigUint64(5) === 0n) await delay(ms)
    }
    return real.call(subtle, alg, key, data)
  }
  return () => { subtle.encrypt = real }
}

async function pairedSessions() {
  const secret = generateSecret()
  const [hk, gk] = await Promise.all([createEphemeralKeypair(), createEphemeralKeypair()])
  const [host, guest] = await Promise.all([
    establishSession({ keypair: hk, peerPublicRaw: await exportPublicKey(gk), secret, role: 'host' }),
    establishSession({ keypair: gk, peerPublicRaw: await exportPublicKey(hk), secret, role: 'guest' }),
  ])
  return { host, guest }
}

/**
 * A channel that records the control index of every frame in the order it was
 * handed over, and delivers in that order, as an ordered SCTP stream does.
 *
 * @param {number[]} order
 * @param {(bytes: Bytes) => Promise<unknown>} deliver
 * @returns {Channel}
 */
function recordingChannel(order, deliver) {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve()
  return /** @type {Channel} */ (/** @type {unknown} */ ({
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() {},
    removeEventListener() {},
    /** @param {Bytes} bytes */
    send(bytes) {
      const header = decodeHeader(bytes)
      if (header.type === TYPE_CONTROL) order.push(Number(header.index))
      tail = tail.then(() => deliver(bytes))
      return Promise.resolve()
    },
  }))
}

/**
 * A full transfer with a path verdict sent alongside it, in one of the two
 * shapes the app actually has.
 *
 * @param {{ hostVerdictBesideSend?: boolean, guestVerdictBesideAccept?: boolean }} shape
 */
async function transferWithVerdict(shape) {
  const { host, guest } = await pairedSessions()
  /** @type {number[]} */ const hostSent = []
  /** @type {number[]} */ const guestSent = []
  /** @type {Bytes[]} */ const written = []

  // One function per direction, shared by every sender on that side -- the
  // contract sendControl's ordering rests on.
  let hostCtl = 0
  let guestCtl = 0
  const hostNext = () => hostCtl++
  const guestNext = () => guestCtl++

  /** @type {ReturnType<typeof createReceiver>} */ let hostRx
  /** @type {ReturnType<typeof createReceiver>} */ let guestRx
  const hostCh = recordingChannel(hostSent, bytes => guestRx.handleFrame(bytes))
  const guestCh = recordingChannel(guestSent, bytes => hostRx.handleFrame(bytes))

  const hostControl = createControlStream()
  hostRx = createReceiver({
    channel: hostCh, sendKey: host.sendKey, recvKey: host.recvKey,
    control: hostControl, nextControlIndex: hostNext,
    onOffer: () => {},
    createSink: async () => { throw new Error('the sending peer accepts no files') },
  })
  guestRx = createReceiver({
    channel: guestCh, sendKey: guest.sendKey, recvKey: guest.recvKey,
    control: createControlStream(), nextControlIndex: guestNext,
    createSink: async () => ({
      streaming: true,
      name: 'ordered.bin',
      async write(chunk) { written.push(Uint8Array.from(chunk)) },
      async close() {},
      async abort() {},
    }),
    onOffer: ({ accept }) => {
      // element.js's shape: the receiver publishes its verdict as the offer
      // lands, and the Accept click follows.
      if (shape.guestVerdictBesideAccept) {
        sendPathVerdict({ channel: guestCh, key: guest.sendKey, nextControlIndex: guestNext, path: 'local' })
          .catch(() => {})
      }
      accept()
    },
  })

  // cli.js's shape: exchange.send() fires the verdict, and sendFile starts on
  // the very next line.
  if (shape.hostVerdictBesideSend) {
    sendPathVerdict({ channel: hostCh, key: host.sendKey, nextControlIndex: hostNext, path: 'local' })
      .catch(() => {})
  }

  const payload = new Uint8Array(40_000).map((_, i) => i % 251)
  const result = await Promise.race([
    sendFile({
      channel: hostCh, key: host.sendKey,
      file: fromBytes({ bytes: payload, name: 'ordered.bin', mime: 'application/octet-stream' }),
      fileSeq: 0, control: hostControl, nextControlIndex: hostNext,
    }),
    delay(5000).then(() => { throw new Error('transfer did not finish') }),
  ])

  return { result, hostSent, guestSent, payload, written }
}

test('the CLI shape: a verdict beside sendFile cannot overtake the manifest', async () => {
  const restore = slowControlIndexZero(60)
  try {
    const { result, hostSent, payload, written } = await transferWithVerdict({ hostVerdictBesideSend: true })
    assert.equal(result.declined, false)
    assert.deepEqual(hostSent, [...hostSent].sort((a, b) => a - b), 'control frames left in index order')
    assert.deepEqual(hostSent.slice(0, 2), [0, 1])
    assert.deepEqual(Buffer.concat(written), Buffer.from(payload), 'the file still arrives byte-identical')
  } finally {
    restore()
  }
})

test('the receiver shape: a verdict beside Accept cannot overtake the reply', async () => {
  const restore = slowControlIndexZero(60)
  try {
    const { result, guestSent } = await transferWithVerdict({ guestVerdictBesideAccept: true })
    assert.equal(result.declined, false)
    assert.deepEqual(guestSent, [...guestSent].sort((a, b) => a - b), 'replies left in index order')
    assert.deepEqual(guestSent.slice(0, 2), [0, 1])
  } finally {
    restore()
  }
})

test('sendControl queues per counter: a slow first seal is not overtaken', async () => {
  const { host } = await pairedSessions()
  /** @type {number[]} */
  const order = []
  const channel = recordingChannel(order, async () => {})
  let ctl = 0
  const nextControlIndex = () => ctl++

  const restore = slowControlIndexZero(60)
  try {
    await Promise.all([
      sendControl({ channel, key: host.sendKey, nextControlIndex }, { t: 'path', path: 'local' }),
      sendControl({ channel, key: host.sendKey, nextControlIndex }, { t: 'accept', seq: 0 }),
    ])
  } finally {
    restore()
  }
  assert.deepEqual(order, [0, 1])
})

test('a failed control send does not stall the ones queued behind it', async () => {
  const { host } = await pairedSessions()
  /** @type {number[]} */
  const order = []
  let calls = 0
  const channel = /** @type {Channel} */ (/** @type {unknown} */ ({
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() {},
    removeEventListener() {},
    /** @param {Bytes} bytes */
    send(bytes) {
      if (calls++ === 0) return Promise.reject(new Error('channel closed'))
      order.push(Number(decodeHeader(bytes).index))
      return Promise.resolve()
    },
  }))
  let ctl = 0
  const nextControlIndex = () => ctl++

  const first = sendControl({ channel, key: host.sendKey, nextControlIndex }, { t: 'path', path: 'local' })
  const second = sendControl({ channel, key: host.sendKey, nextControlIndex }, { t: 'accept', seq: 0 })

  await assert.rejects(first, /channel closed/, 'the failure still reaches its own caller')
  await second
  // Index 0 was spent on the send that failed; the next message takes 1 rather
  // than reusing it, which would be AES-GCM nonce reuse under the same key.
  assert.deepEqual(order, [1])
})
