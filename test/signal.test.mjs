import test from 'node:test'
import assert from 'node:assert/strict'
import { schnorr } from '@noble/secp256k1'

import { generateSecret, deriveSignalKey, deriveTopic } from '../src/crypto/secret.js'
import { _internals } from '../src/signal/nostr.js'

const { sealPayload, openPayload, signEvent, KIND } = _internals

const hexToBytes = h => Uint8Array.from(h.match(/../g).map(b => parseInt(b, 16)))

test('signalling payloads round-trip under the QR-derived key', async () => {
  const key = await deriveSignalKey(generateSecret())
  const offer = { t: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB', ecdh: 'abc' }

  const sealed = await sealPayload(key, offer)
  assert.deepEqual(await openPayload(key, sealed), offer)
})

test('the sealed payload does not leak the SDP to a relay', async () => {
  const key = await deriveSignalKey(generateSecret())
  const sealed = await sealPayload(key, { t: 'offer', sdp: 'a=fingerprint:sha-256 DE:AD:BE:EF' })

  // A relay operator sees exactly this string.
  assert.ok(!sealed.includes('fingerprint'))
  assert.ok(!sealed.includes('DE:AD'))
  assert.ok(!sealed.includes('offer'))
})

test('a payload sealed under a different secret cannot be opened', async () => {
  const mine = await deriveSignalKey(generateSecret())
  const theirs = await deriveSignalKey(generateSecret())
  const sealed = await sealPayload(theirs, { t: 'offer', sdp: 'hostile' })

  // Decryption failing IS the authentication check: anyone may publish to the
  // topic, but only a holder of the QR secret can be heard.
  await assert.rejects(() => openPayload(mine, sealed))
})

test('a tampered payload is rejected rather than partially parsed', async () => {
  const key = await deriveSignalKey(generateSecret())
  const sealed = await sealPayload(key, { t: 'offer', sdp: 'x'.repeat(40) })
  const raw = Buffer.from(sealed, 'base64')

  raw[30] ^= 0xff
  await assert.rejects(() => openPayload(key, raw.toString('base64')))
})

test('each sealing uses a fresh IV', async () => {
  const key = await deriveSignalKey(generateSecret())
  const msg = { t: 'ready' }
  const seen = new Set()
  for (let i = 0; i < 50; i++) seen.add((await sealPayload(key, msg)).slice(0, 16))
  assert.equal(seen.size, 50, 'identical plaintexts must not produce identical ciphertexts')
})

test('events are signed correctly and carry only the topic in the clear', async () => {
  const secretKey = crypto.getRandomValues(new Uint8Array(32))
  const pubkey = Buffer.from(schnorr.getPublicKey(secretKey)).toString('hex')
  const topic = await deriveTopic(generateSecret())
  const key = await deriveSignalKey(generateSecret())

  const event = await signEvent({
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: KIND,
    tags: [['d', topic]],
    content: await sealPayload(key, { t: 'ready' }),
  }, secretKey)

  // The id must be the hash of Nostr's canonical serialisation, or relays drop it.
  const canonical = JSON.stringify([
    0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
  ])
  const expectedId = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)),
  ).toString('hex')

  assert.equal(event.id, expectedId)
  assert.ok(await schnorr.verifyAsync(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(pubkey)))

  // Everything a relay can index is either random or HKDF output.
  assert.equal(event.tags.length, 1)
  assert.equal(event.tags[0][1], topic)
  assert.ok(KIND >= 20000 && KIND < 30000, 'must be in the ephemeral range so relays do not store it')
})

test('the topic tag reveals nothing about the secret', async () => {
  const secret = generateSecret()
  const topic = await deriveTopic(secret)
  const signalKey = await deriveSignalKey(secret)

  // Same secret, two different derivations that must not be relatable.
  const sealed = await sealPayload(signalKey, { t: 'ready' })
  assert.ok(!sealed.includes(topic))
  assert.ok(!topic.includes(Buffer.from(secret).toString('base64').slice(0, 10)))
})
