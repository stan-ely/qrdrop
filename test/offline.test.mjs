/**
 * The offline pairing end to end in one process: node/lan-server.js's
 * listenOffline, transport/rendezvous.js's dialler, the room their socket
 * becomes, and openRoom's two new ways in. Over loopback, with Node's own
 * WebSocket as the dialler, exactly as the CLI runs it.
 *
 * core/rendezvous.js's messages are pinned by test/rendezvous.test.mjs and
 * the vectors. What is here is the plumbing those cannot see: a listener
 * that a stranger or a wrong code must not end, a handshake cut before its
 * `ok` that must not latch, and a room that carries the whole session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { listenOffline } from '../src/node/lan-server.js'
import { nodeLanPlatform } from '../src/node/lan.js'
import { dialRendezvous, dialableAddresses } from '../src/transport/rendezvous.js'
import { dialWebSocket } from '../src/transport/lan.js'
import { openRoom } from '../src/transport/room.js'
import {
  rendezvousKey, sealDial, openListen, NONCE_BYTES,
} from '../src/core/rendezvous.js'
import { createEphemeralKeypair, exportPublicKey } from '../src/core/session.js'
import { generateSecret, deriveTopic, derivePassword } from '../src/core/secret.js'
import { fakeNetwork } from './helpers/fake-network.mjs'

const platform = nodeLanPlatform({ override: 'none' })
const LOOPBACK = ['127.0.0.1']

/** @param {Bytes} secret */
const listen = secret => listenOffline({ secret, host: '127.0.0.1', addresses: () => LOOPBACK })

/**
 * @param {OfflineListener} l
 * @param {Bytes} secret
 * @param {number} [timeoutMs]
 */
const dialTo = (l, secret, timeoutMs) => dialRendezvous({
  locator: /** @type {{ port: number, addresses: string[] }} */ (l.locator),
  secret,
  dial: platform.dial,
  addresses: LOOPBACK,
  timeoutMs,
})

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Whether a promise is still pending after the event loop has had a turn.
 * @param {Promise<unknown>} p
 */
async function pending(p) {
  const marker = Symbol('pending')
  return (await Promise.race([p.then(() => 'settled', () => 'settled'), sleep(50).then(() => marker)])) === marker
}

/** The next message on a socket. @param {LanSocket} s @returns {Promise<Bytes>} */
const next = s => new Promise(resolve => { s.onmessage = b => { s.onmessage = null; resolve(b) } })

test('a dialler holding the code pairs, and the socket carries frames both ways', async () => {
  const secret = generateSecret()
  const l = await listen(secret)
  assert.deepEqual(l.locator, { port: l.port, addresses: LOOPBACK })
  const guest = await dialTo(l, secret)
  assert.ok(guest, 'the dial pairs')
  const host = await l.accepted
  try {
    assert.equal(host.session.sas, guest.session.sas)
    assert.equal(host.direct, true)
    assert.equal(await host.path(), 'local')
    assert.equal(await guest.isRelayed(), false)

    // The peer's frames, sent before onFrame is registered, are held for it:
    // the CLI registers only after its SAS prompt, and the peer does not wait.
    await guest.channel.send(Uint8Array.of(1, 2, 3))
    await sleep(20)
    const got = new Promise(resolve => host.onFrame(resolve))
    assert.deepEqual([...await /** @type {Promise<Bytes>} */ (got)], [1, 2, 3])
    const back = new Promise(resolve => guest.onFrame(resolve))
    await host.channel.send(Uint8Array.of(9))
    assert.deepEqual([...await /** @type {Promise<Bytes>} */ (back)], [9])

    // The peer leaving is the socket closing; our own close is not news.
    let hostSawLeave = false
    host.onPeerLeave(() => { hostSawLeave = true })
    let guestSawLeave = false
    guest.onPeerLeave(() => { guestSawLeave = true })
    await guest.close()
    await sleep(50)
    assert.equal(hostSawLeave, true)
    assert.equal(guestSawLeave, false)
  } finally {
    await host.close()
    await guest.close()
  }
})

test('a dialler with another code is refused, and the listener keeps waiting for the real one', async () => {
  const secret = generateSecret()
  const l = await listen(secret)
  try {
    assert.equal(await dialTo(l, generateSecret()), null)
    assert.equal(await pending(l.accepted), true, 'a wrong code ended the wait')
    const guest = await dialTo(l, secret)
    assert.ok(guest)
    const host = await l.accepted
    assert.equal(host.session.sas, guest.session.sas)
    await Promise.all([host.close(), guest.close()])
  } finally {
    l.close()
  }
})

test('a stranger who connects and says nothing does not keep the peer out', async () => {
  const secret = generateSecret()
  const l = await listen(secret)
  const stranger = await platform.dial(`ws://127.0.0.1:${l.port}/`, 1000)
  try {
    const guest = await dialTo(l, secret)
    assert.ok(guest)
    const host = await l.accepted
    await Promise.all([host.close(), guest.close()])
  } finally {
    stranger.close()
    l.close()
  }
})

test('a handshake cut before its ok never pairs the listener', async () => {
  const secret = generateSecret()
  const l = await listen(secret)
  try {
    // Everything the real dialler does, up to and not including the ok.
    const key = await rendezvousKey(secret)
    const s = await dialWebSocket(/** @type {any} */ (globalThis.WebSocket), `ws://127.0.0.1:${l.port}/`, 1000)
    const nonce = await next(s)
    assert.equal(nonce.length, NONCE_BYTES)
    const dialPublic = await exportPublicKey(await createEphemeralKeypair())
    s.send(await sealDial(key, nonce, dialPublic))
    assert.ok(await openListen(key, nonce, dialPublic, await next(s)), 'the listener answered keyed')
    s.close()
    await sleep(100)
    assert.equal(await pending(l.accepted), true, 'the listener paired without an ok')

    const guest = await dialTo(l, secret)
    assert.ok(guest, 'the real pairing still gets in')
    const host = await l.accepted
    await Promise.all([host.close(), guest.close()])
  } finally {
    l.close()
  }
})

test('nothing listening is a quick null, the cue to try the relays', async () => {
  const l = await listen(generateSecret())
  const locator = /** @type {{ port: number, addresses: string[] }} */ (l.locator)
  l.close()
  await sleep(20)
  const started = Date.now()
  const guest = await dialRendezvous({ locator, secret: generateSecret(), dial: platform.dial, addresses: LOOPBACK, timeoutMs: 1000 })
  assert.equal(guest, null)
  assert.ok(Date.now() - started < 1500)
})

test('a locator aimed at this machine or the internet is not dialled', async () => {
  assert.deepEqual(dialableAddresses({ port: 9, addresses: ['127.0.0.1', '8.8.8.8', '192.168.1.4'] }), ['192.168.1.4'])
  let dialled = 0
  const guest = await dialRendezvous({
    locator: { port: 9, addresses: ['127.0.0.1', '8.8.8.8'] },
    secret: generateSecret(),
    dial: async () => { dialled++; throw new Error('no') },
  })
  assert.equal(guest, null)
  assert.equal(dialled, 0)
})

test('openRoom: a guest with a locator pairs locally and never joins a room', async () => {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()
  const l = await listen(secret)
  /** @type {string[]} */
  const said = []
  const [host, guest] = await Promise.all([
    openRoom({ topic, password, secret, role: 'host', strategies: [strategy], iceServers: [], timeoutMs: 5000, listener: l }),
    openRoom({
      topic, password, secret, role: 'guest', strategies: [strategy], iceServers: [], timeoutMs: 5000,
      onStatus: t => said.push(t),
      dial: () => dialTo(l, secret),
    }),
  ])
  try {
    assert.equal(host.direct, true, 'the host took the local pairing over the room it was in')
    assert.equal(guest.direct, true)
    assert.equal(host.session.sas, guest.session.sas)
    assert.ok(said.includes('Paired over the local network'), said.join(' | '))
  } finally {
    await Promise.all([host.close(), guest.close()])
  }
})

test('openRoom: a locator nobody answers at falls back to the room, and says so', async () => {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()
  /** @type {string[]} */
  const said = []
  const [host, guest] = await Promise.all([
    openRoom({ topic, password, secret, role: 'host', strategies: [strategy], iceServers: [], timeoutMs: 5000 }),
    openRoom({
      topic, password, secret, role: 'guest', strategies: [strategy], iceServers: [], timeoutMs: 5000,
      onStatus: t => said.push(t),
      dial: async () => null,
    }),
  ])
  try {
    assert.equal(guest.direct, undefined)
    assert.equal(host.session.sas, guest.session.sas)
    assert.ok(said.includes('Couldn’t reach the other device directly, trying the internet…'), said.join(' | '))
  } finally {
    await Promise.all([host.close(), guest.close()])
  }
})

test('openRoom: with every room failed, a host keeps waiting on its listener', async () => {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  /** @type {SignalingStrategy} */
  const broken = {
    name: 'broken',
    urls: [],
    join: /** @type {any} */ (() => { throw new Error('no route out') }),
  }
  const l = await listen(secret)
  /** @type {string[]} */
  const said = []
  const hostP = openRoom({
    topic, password, secret, role: 'host', strategies: [broken], iceServers: [], timeoutMs: 5000,
    listener: l, onStatus: t => said.push(t),
  })
  await sleep(100)
  assert.ok(said.includes('No signalling network answered; still waiting on the local network…'), said.join(' | '))
  assert.equal(await pending(hostP), true, 'the host gave up with its listener still up')
  const guest = await dialTo(l, secret)
  assert.ok(guest)
  const host = await hostP
  assert.equal(host.session.sas, guest.session.sas)
  await Promise.all([host.close(), guest.close()])
})

test('openRoom: a room that wins closes the listener', async () => {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()
  const l = await listen(secret)
  const [host, guest] = await Promise.all([
    openRoom({ topic, password, secret, role: 'host', strategies: [strategy], iceServers: [], timeoutMs: 5000, listener: l }),
    openRoom({ topic, password, secret, role: 'guest', strategies: [strategy], iceServers: [], timeoutMs: 5000 }),
  ])
  try {
    assert.equal(host.direct, undefined)
    await assert.rejects(l.accepted, /Stopped listening/)
    assert.equal(await dialTo(l, secret, 500), null, 'still answering after the room won')
  } finally {
    await Promise.all([host.close(), guest.close()])
  }
})
