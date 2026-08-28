import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generateSecret, encodeSecret, decodeSecret, deriveTopic, toBase64url,
} from '../static/js/crypto/secret.js'
import {
  createEphemeralKeypair, exportPublicKey, establishSession,
} from '../static/js/crypto/session.js'

const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
const decrypts = async (key, iv, ct) => {
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); return true } catch { return false }
}

test('secret encodes to a QR-sized payload and round-trips', () => {
  const secret = generateSecret()
  assert.equal(secret.length, 32)
  const code = encodeSecret(secret)
  assert.equal(code.length, 50, 'stays trivially small for a QR')
  assert.ok(bytesEqual(decodeSecret(code), secret))
})

test('malformed codes are rejected rather than silently truncated', () => {
  assert.throws(() => decodeSecret('nope'))
  assert.throws(() => decodeSecret('qrbeam:tooshort'))
  assert.throws(() => decodeSecret(toBase64url(generateSecret())), /Not a qrbeam code/)
})

test('rendezvous topic is deterministic but does not leak the secret', async () => {
  const secret = generateSecret()
  const topic = await deriveTopic(secret)
  assert.equal(topic, await deriveTopic(secret), 'both peers must land on the same room')
  assert.notEqual(topic, await deriveTopic(generateSecret()))
  // The bug this guards against: publishing the key itself as the room name.
  assert.ok(!toBase64url(secret).startsWith(topic))
  assert.ok(!topic.includes(toBase64url(secret).slice(0, 12)))
})

test('epoch rotation changes the topic', async () => {
  const secret = generateSecret()
  assert.notEqual(await deriveTopic(secret), await deriveTopic(secret, 42))
  assert.notEqual(await deriveTopic(secret, 41), await deriveTopic(secret, 42))
})

test('both peers derive matching directional keys and the same SAS', async () => {
  const secret = generateSecret()
  const hostKp = await createEphemeralKeypair()
  const guestKp = await createEphemeralKeypair()

  const host = await establishSession({
    keypair: hostKp, peerPublicRaw: await exportPublicKey(guestKp), secret, role: 'host',
  })
  const guest = await establishSession({
    keypair: guestKp, peerPublicRaw: await exportPublicKey(hostKp), secret, role: 'guest',
  })

  assert.equal(host.sas, guest.sas, 'users compare these visually')
  assert.equal(host.sas.split(' ').length, 4)

  const iv = new Uint8Array(12).fill(1)
  const pt = new TextEncoder().encode('secret file bytes')

  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, host.sendKey, pt)
  assert.equal(new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, guest.recvKey, ct)), 'secret file bytes')

  const ct2 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, guest.sendKey, pt)
  assert.equal(new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, host.recvKey, ct2)), 'secret file bytes')

  // If the two directions shared a key they would share a nonce space, and the
  // per-file counters could collide into a catastrophic AES-GCM nonce reuse.
  assert.equal(await decrypts(host.recvKey, iv, ct), false)
})

test('a wrong QR secret yields a different session even with valid ECDH', async () => {
  const secret = generateSecret()
  const hostKp = await createEphemeralKeypair()
  const guestKp = await createEphemeralKeypair()
  const hostPub = await exportPublicKey(hostKp)

  const host = await establishSession({
    keypair: hostKp, peerPublicRaw: await exportPublicKey(guestKp), secret, role: 'host',
  })
  const attacker = await establishSession({
    keypair: guestKp, peerPublicRaw: hostPub, secret: generateSecret(), role: 'guest',
  })

  const iv = new Uint8Array(12).fill(1)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, host.sendKey, new Uint8Array([1, 2, 3]))

  assert.notEqual(attacker.sas, host.sas, 'the SAS is what surfaces this to the user')
  assert.equal(await decrypts(attacker.recvKey, iv, ct), false)
})

test('session keys are unique per session (forward secrecy)', async () => {
  const secret = generateSecret()
  const iv = new Uint8Array(12).fill(1)

  const mk = async () => {
    const a = await createEphemeralKeypair()
    const b = await createEphemeralKeypair()
    return establishSession({ keypair: a, peerPublicRaw: await exportPublicKey(b), secret, role: 'host' })
  }

  const s1 = await mk()
  const s2 = await mk()
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, s1.sendKey, new Uint8Array([9]))
  // Same QR secret, different session: holding the secret alone is not enough.
  assert.equal(await decrypts(s2.sendKey, iv, ct), false)
  assert.notEqual(s1.sas, s2.sas)
})
