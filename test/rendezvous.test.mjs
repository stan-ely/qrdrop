/**
 * The offline rendezvous's four messages (src/core/rendezvous.js). Every
 * refusal here is one a listener on a shared network meets in ordinary use --
 * a stranger with no code, a replayed hello, a key swapped on the path -- so
 * each must come back as a quiet `null` or `false`, never a throw and never
 * a latch.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { generateSecret } from '../src/core/secret.js'
import {
  KEYED_BYTES, MAC_BYTES, NONCE_BYTES, createNonce, openDial, openListen, openOk, rendezvousKey, sealDial, sealListen,
  sealOk,
} from '../src/core/rendezvous.js'

const fromHex = (/** @type {string} */ s) => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16))

/** Any 65 bytes do for a MAC; a real key is not needed until establishSession. */
const fakePublic = (/** @type {number} */ fill) => new Uint8Array(65).fill(fill)

async function handshake() {
  const secret = generateSecret()
  const key = await rendezvousKey(secret)
  const nonce = createNonce()
  const D = fakePublic(1)
  const L = fakePublic(2)
  return { secret, key, nonce, D, L }
}

test('the four messages go round, and each side ends holding the other key', async () => {
  const { key, nonce, D, L } = await handshake()
  assert.equal(nonce.length, NONCE_BYTES)
  const dial = await sealDial(key, nonce, D)
  assert.equal(dial.length, KEYED_BYTES)
  assert.deepEqual(await openDial(key, nonce, dial), D)
  const listen = await sealListen(key, nonce, D, L)
  assert.equal(listen.length, KEYED_BYTES)
  assert.deepEqual(await openListen(key, nonce, D, listen), L)
  const ok = await sealOk(key, nonce, D, L)
  assert.equal(ok.length, MAC_BYTES)
  assert.equal(await openOk(key, nonce, D, L, ok), true)
})

test('a dialler without the code is refused at the first message, before the listener has said anything keyed', async () => {
  const { key, nonce, D } = await handshake()
  const stranger = await rendezvousKey(generateSecret())
  assert.equal(await openDial(key, nonce, await sealDial(stranger, nonce, D)), null)
})

test('a dial replayed from another connection does not latch: it covers that connection\'s nonce', async () => {
  const { key, nonce, D } = await handshake()
  const sniffed = await sealDial(key, nonce, D)
  assert.equal(await openDial(key, createNonce(), sniffed), null)
})

test('a public key swapped on the path fails its MAC, in either direction', async () => {
  const { key, nonce, D, L } = await handshake()
  const dial = await sealDial(key, nonce, D)
  dial.set(fakePublic(9))
  assert.equal(await openDial(key, nonce, dial), null)

  const listen = await sealListen(key, nonce, D, L)
  listen.set(fakePublic(9))
  assert.equal(await openListen(key, nonce, D, listen), null)
  // The listener's MAC covers D too: a dialler that sent D but is answered
  // for a different one has been talking to somebody else's listener.
  assert.equal(await openListen(key, nonce, fakePublic(9), await sealListen(key, nonce, D, L)), null)
  assert.equal(await openOk(key, nonce, D, fakePublic(9), await sealOk(key, nonce, D, L)), false)
})

test('no message can be reflected back as another', async () => {
  const { key, nonce, D, L } = await handshake()
  // A listener that echoed the dial back would hand the dialler a "listen"
  // carrying the dialler's own key; the labels keep that from verifying.
  const dial = await sealDial(key, nonce, D)
  assert.equal(await openListen(key, nonce, D, dial), null)
  const listen = await sealListen(key, nonce, D, L)
  assert.equal(await openDial(key, nonce, listen), null)
  assert.equal(await openOk(key, nonce, D, L, listen.slice(65)), false)
})

test('a message of the wrong length is refused rather than read short', async () => {
  const { key, nonce, D, L } = await handshake()
  const dial = await sealDial(key, nonce, D)
  assert.equal(await openDial(key, nonce, dial.slice(0, -1)), null)
  assert.equal(await openDial(key, nonce, new Uint8Array(0)), null)
  assert.equal(await openListen(key, nonce, D, new Uint8Array(KEYED_BYTES + 1)), null)
  assert.equal(await openOk(key, nonce, D, L, new Uint8Array(MAC_BYTES - 1)), false)
})

test('our own side refuses to seal a field of the wrong size', async () => {
  const { key, nonce, D } = await handshake()
  await assert.rejects(sealDial(key, nonce.slice(1), D), RangeError)
  await assert.rejects(sealDial(key, nonce, D.slice(1)), RangeError)
  await assert.rejects(sealOk(key, nonce, D, D.slice(1)), RangeError)
})

test('the committed vectors open with the shipped code', async () => {
  const v = JSON.parse(await readFile(new URL('./vectors/rendezvous.json', import.meta.url), 'utf8'))
  for (const c of v.cases) {
    const key = await rendezvousKey(fromHex(c.secret))
    const nonce = fromHex(c.hello)
    const D = fromHex(c.dial_public)
    const L = fromHex(c.listen_public)
    assert.deepEqual(await openDial(key, nonce, fromHex(c.dial)), D)
    assert.deepEqual(await openListen(key, nonce, D, fromHex(c.listen)), L)
    assert.equal(await openOk(key, nonce, D, L, fromHex(c.ok)), true)
  }
})
