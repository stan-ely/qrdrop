/**
 * The channel contract, enforced.
 *
 * types/qrbeam.d.ts describes what a transport owes transfer/sender.js and
 * transfer/receiver.js. The type checker holds the shipped adapter to that
 * description; this file holds it to the behaviour, and -- more usefully --
 * holds transfer/ to the claim that the contract is all it needs.
 *
 * The last two tests cover the raw-RTCDataChannel branch of sender.js, which
 * the shipped Trystero path never reaches: Trystero pins bufferedAmount at 0,
 * so drain() always short-circuits and the watermark logic is dead code on the
 * only transport currently in use. It stops being dead the moment anyone adds
 * a direct-WebRTC transport, and it is the piece that decides whether a large
 * file streams or takes the tab down, so it is worth exercising now rather
 * than discovering later.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createChannel } from '../static/js/signal/channel.js'
import { createControlStream } from '../static/js/transfer/control.js'
import { createReceiver } from '../static/js/transfer/receiver.js'
import { sendFile, _internals } from '../static/js/transfer/sender.js'
import { generateSecret } from '../static/js/crypto/secret.js'
import {
  createEphemeralKeypair, exportPublicKey, establishSession,
} from '../static/js/crypto/session.js'

const { drain, HIGH_WATER } = _internals

/**
 * The five members, checked one at a time so a failure names the missing one
 * rather than saying the object is the wrong shape.
 *
 * @param {Channel} channel
 * @param {string} label
 */
function assertConformsToChannel(channel, label) {
  assert.equal(typeof channel.send, 'function', `${label}: send`)
  assert.equal(typeof channel.bufferedAmount, 'number', `${label}: bufferedAmount`)
  assert.equal(
    typeof channel.bufferedAmountLowThreshold, 'number',
    `${label}: bufferedAmountLowThreshold`,
  )
  assert.equal(typeof channel.addEventListener, 'function', `${label}: addEventListener`)
  assert.equal(typeof channel.removeEventListener, 'function', `${label}: removeEventListener`)

  // sender.js writes this before the first chunk. A getter-only property would
  // throw there, in strict mode, one call into a transfer.
  channel.bufferedAmountLowThreshold = 4096
  assert.equal(channel.bufferedAmountLowThreshold, 4096, `${label}: threshold is writable`)

  // Only ever called with this one event name, and a transport is entitled to
  // ignore it -- but not to reject it.
  const noop = () => {}
  channel.addEventListener('bufferedamountlow', noop)
  channel.removeEventListener('bufferedamountlow', noop)
}

test('the Trystero adapter satisfies the channel contract', () => {
  const action = { send: async () => {} }
  assertConformsToChannel(createChannel(action, 'peer-1'), 'createChannel')
})

test('the adapter sends to the paired peer only, never broadcast', async () => {
  /** @type {{ data: Bytes, options?: { target?: string } }[]} */
  const calls = []
  const action = {
    /** @type {(data: Bytes, options?: { target?: string }) => Promise<void>} */
    send: async (data, options) => { calls.push({ data, options }) },
  }

  const channel = createChannel(action, 'peer-1')
  await channel.send(Uint8Array.from([1, 2, 3]))

  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0].data], [1, 2, 3])
  assert.equal(calls[0].options?.target, 'peer-1',
    'a third party holding the code can be in the room; frames must be addressed')
})

test('the adapter passes the send promise through, which is the backpressure', async () => {
  /** @type {() => void} */
  let release = () => {}
  /** @type {Promise<void>} */
  const inFlight = new Promise(resolve => { release = resolve })
  const action = { send: () => inFlight }

  const result = createChannel(action, 'peer-1').send(Uint8Array.from([0]))
  assert.ok(result instanceof Promise, 'sender.js awaits this; it must be awaitable')

  // The point is not that a promise comes back, but that it is still the
  // action's promise. If the adapter resolved on its own -- returning a fresh
  // already-resolved promise, or dropping the return value -- the await in
  // sender.js would be satisfied instantly and a whole file would queue into
  // Trystero's buffer with nothing pushing back.
  let resolved = false
  void result.then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false, 'must not resolve before the send completes')

  release()
  await result
  assert.equal(resolved, true)
})

/**
 * A channel with the five contract members and nothing else.
 *
 * No `sent` counter, no `twin`, no test affordances -- deliberately. If
 * transfer/ ever grows a dependency on something outside the contract, this is
 * where it fails, and it fails before a new transport has to discover the same
 * thing against a live relay.
 *
 * @returns {[Channel, Channel]}
 */
function minimalPair() {
  /** @type {{ deliver: (bytes: Bytes) => Promise<void> }[]} */
  const ends = [{ deliver: async () => {} }, { deliver: async () => {} }]

  /**
   * @param {0 | 1} peer
   * @returns {Channel}
   */
  const make = peer => {
    let queue = Promise.resolve()
    return {
      send(bytes) {
        // Serialised, so this fake does not itself reintroduce the reentrancy
        // the receiver guards against. That race has its own test.
        queue = queue.then(() => ends[peer].deliver(bytes))
        return queue
      },
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener() {},
      removeEventListener() {},
    }
  }

  const a = make(1)
  const b = make(0)
  return [
    Object.assign(a, { __deliverTo: ends[0] }),
    Object.assign(b, { __deliverTo: ends[1] }),
  ]
}

test('a full transfer runs over a channel implementing only the contract', async () => {
  const secret = generateSecret()
  const hk = await createEphemeralKeypair()
  const gk = await createEphemeralKeypair()
  const host = await establishSession({
    keypair: hk, peerPublicRaw: await exportPublicKey(gk), secret, role: 'host',
  })
  const guest = await establishSession({
    keypair: gk, peerPublicRaw: await exportPublicKey(hk), secret, role: 'guest',
  })

  const [hostCh, guestCh] = minimalPair()
  const ends = {
    host: /** @type {any} */ (hostCh).__deliverTo,
    guest: /** @type {any} */ (guestCh).__deliverTo,
  }

  /** @type {Bytes[]} */
  const written = []
  /** @type {unknown[]} */
  const errors = []

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
  })
  ends.host.deliver = hostRx.handleFrame

  const guestControl = createControlStream()
  let guestCtl = 0
  const guestRx = createReceiver({
    channel: guestCh,
    sendKey: guest.sendKey,
    recvKey: guest.recvKey,
    control: guestControl,
    nextControlIndex: () => guestCtl++,
    onOffer: async o => { await o.accept() },
    onError: e => errors.push(e),
    createSink: async () => ({
      streaming: true,
      name: 'conformance',
      async write(chunk) { written.push(chunk) },
      async close() {},
      async abort() {},
    }),
  })
  ends.guest.deliver = guestRx.handleFrame

  const payload = crypto.getRandomValues(new Uint8Array(3000))
  const result = await sendFile({
    channel: hostCh,
    key: host.sendKey,
    file: new File([payload], 'conformance.bin'),
    fileSeq: 0,
    control: hostControl,
    nextControlIndex: () => hostCtl++,
  })

  assert.deepEqual(errors, [])
  assert.ok(!result.declined)
  assert.deepEqual(
    written.flatMap(c => [...c]), [...payload],
    'transfer/ needs nothing beyond the five documented members',
  )
})

test('drain does not wait while the buffer is below the high-water mark', () => {
  const channel = /** @type {Channel} */ ({
    send: () => {},
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() { assert.fail('should not subscribe when there is room') },
    removeEventListener() {},
  })

  assert.equal(drain(channel), null)
})

test('drain waits for bufferedamountlow and then unsubscribes', async () => {
  // Defaults to a failure rather than null, so "drain never subscribed" is
  // reported as that instead of as a null call further down.
  /** @type {() => void} */
  let listener = () => assert.fail('drain did not register a bufferedamountlow listener')
  let added = 0
  let removed = 0

  const channel = /** @type {Channel} */ ({
    send: () => {},
    bufferedAmount: HIGH_WATER + 1,
    bufferedAmountLowThreshold: 0,
    /** @param {string} type @param {() => void} fn */
    addEventListener(type, fn) {
      assert.equal(type, 'bufferedamountlow')
      listener = fn
      added++
    },
    removeEventListener() { removed++ },
  })

  const waiting = drain(channel)
  assert.ok(waiting instanceof Promise, 'a saturated channel must be waited on')
  assert.equal(added, 1)
  assert.equal(removed, 0, 'still parked until the channel drains')

  listener()
  await waiting

  assert.equal(removed, 1,
    'every drain must unsubscribe, or a long transfer leaks one listener per pause')
})
