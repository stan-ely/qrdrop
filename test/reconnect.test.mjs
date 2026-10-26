/**
 * The reconnect gate, against Trystero's own makeSocket rather than a model of
 * it. The failure this guards against lives entirely inside Trystero -- a
 * socket that closes often enough is retired and never dialled again -- so a
 * fake of that behaviour would only prove the fake. What is faked is the
 * network: a WebSocket that closes as soon as it is made, which is what every
 * relay looks like from behind Android's background firewall.
 *
 * The first test pins the bug, so that a Trystero release which fixes it shows
 * up here as a failure and the gate can be reconsidered rather than carried.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSocket, pauseRelayReconnection, resumeRelayReconnection } from '@trystero-p2p/core'
import { createReconnectGate } from '../src/transport/reconnect.js'

const lock = { pause: pauseRelayReconnection, resume: resumeRelayReconnection }

/** Long enough for Trystero to walk its whole backoff, 3.3 s doubling to 60 s. */
const PAST_EVERY_RETRY_MS = 5 * 60_000

/**
 * Swaps in a WebSocket that is refused on every attempt, and counts attempts.
 * Trystero's backoff periods are kept per URL at module scope, so every test
 * dials a URL of its own.
 */
function refusingNetwork() {
  const real = globalThis.WebSocket
  const dials = { count: 0 }
  globalThis.WebSocket = /** @type {any} */ (class {
    constructor(/** @type {string} */ url) {
      dials.count++
      this.url = url
      this.readyState = 3
      /** @type {(() => void) | null} */
      this.onclose = null
      setTimeout(() => this.onclose?.(), 10)
    }
    send() {}
    close() {}
  })
  return { dials, restore: () => { globalThis.WebSocket = real } }
}

/**
 * Advance mocked time in small steps, letting the lock's promise callbacks run
 * between them, since a redial is queued on a `.then`.
 * @param {import('node:test').TestContext} t
 * @param {number} ms
 */
async function advance(t, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    t.mock.timers.tick(100)
    // setImmediate is not mocked, and it runs only once the microtask queue
    // is empty, however deep the lock's .finally/.then chain goes.
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** @param {import('node:test').TestContext} t */
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const net = refusingNetwork()
  t.after(() => {
    // Leave the shared lock released, as Trystero's own default is.
    resumeRelayReconnection()
    net.restore()
  })
  return net
}

test('without the gate, trystero retires a relay that keeps refusing, for good', async t => {
  const { dials } = setup(t)
  const client = makeSocket('wss://retired.invalid', () => {})

  await advance(t, PAST_EVERY_RETRY_MS)
  assert.equal(client.isClosed, true)

  const before = dials.count
  await advance(t, PAST_EVERY_RETRY_MS)
  assert.equal(dials.count, before, 'a retired socket is never dialled again')
})

test('held, a refusing relay is never retired, and redials when a pairing waits', async t => {
  const { dials } = setup(t)
  const gate = createReconnectGate(lock, 5000, fn => { setImmediate(fn) })
  gate.hold()
  const client = makeSocket('wss://held.invalid', () => {})

  await advance(t, PAST_EVERY_RETRY_MS)
  assert.equal(client.isClosed, false)
  assert.equal(dials.count, 1, 'nothing redials while no one is pairing')

  /** @type {(value?: unknown) => void} */
  let paired = () => {}
  const waiting = gate.whilePairing(new Promise(resolve => { paired = resolve }))

  await advance(t, 200)
  assert.equal(dials.count, 2, 'a pairing starting redials at once')

  await advance(t, 15_000)
  assert.ok(dials.count >= 4, `the wait redials on a tick (dialled ${dials.count} times)`)
  assert.equal(client.isClosed, false)

  paired()
  await waiting
  const after = dials.count
  await advance(t, PAST_EVERY_RETRY_MS)
  assert.equal(dials.count, after, 'the lock is held again once the pairing settles')
  assert.equal(client.isClosed, false)
})
