/**
 * Forward secrecy, checked where it can actually break.
 *
 * test/crypto.test.mjs already proves establishSession() derives different keys
 * from different keypairs. That is the derivation, not the plumbing: it builds
 * both keypairs by hand, so it would keep passing if room.js generated one
 * keypair at module load and reused it for the rest of the process. Nothing
 * else covers src/transport/room.js at all, because importing it drags Trystero
 * in and the pairing path looks like it needs a relay and a peer connection.
 *
 * It does not. openRoom takes its strategy list as an argument, and the only
 * things joinVia touches on a Trystero room are makeAction, onPeerJoin,
 * onPeerLeave, getPeers and leave -- none of which have to involve WebRTC. So
 * the fake below is a loopback network keyed by topic: two joins on the same
 * topic find each other and route messages between them, in memory, offline, in
 * about a millisecond.
 *
 * What that buys is the assertion this file exists for -- pair twice over the
 * SAME secret and get keys that cannot open each other's traffic. Hoist the
 * keypair out of joinVia and this file fails; the rest of the suite does not.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { openRoom } from '../src/transport/room.js'
import { generateSecret, deriveTopic, derivePassword } from '../src/core/secret.js'
import { fakeNetwork } from './helpers/fake-network.mjs'

/**
 * One full pairing over the fake network. Both halves have to be in flight at
 * once: openRoom does not resolve until a peer arrives.
 *
 * @param {SignalingStrategy} strategy
 * @param {{ topic: string, password: string, secret: Bytes }} args
 * @returns {Promise<{ host: PairedRoom, guest: PairedRoom }>}
 */
async function pair(strategy, { topic, password, secret }) {
  const open = (/** @type {'host' | 'guest'} */ role) =>
    openRoom({ topic, password, secret, role, strategies: [strategy], iceServers: [], timeoutMs: 5000 })

  const [host, guest] = await Promise.all([open('host'), open('guest')])
  return { host, guest }
}

/**
 * @param {CryptoKey} key
 * @param {Bytes} iv
 * @param {BufferSource} ct
 */
const decrypts = async (key, iv, ct) => {
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); return true } catch { return false }
}

const IV = new Uint8Array(12).fill(1)

test('openRoom pairs two peers and both derive the same session', async () => {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()

  const { host, guest } = await pair(strategy, { topic, password, secret })
  try {
    // Without this the freshness tests below would pass vacuously against a
    // fake that silently failed to pair anyone with anyone.
    assert.equal(host.session.sas, guest.session.sas)
    assert.deepEqual(host.session.sasWords, guest.session.sasWords)

    const pt = new TextEncoder().encode('secret file bytes')
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, host.session.sendKey, pt)
    assert.equal(
      new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: IV }, guest.session.recvKey, ct)),
      'secret file bytes',
    )
  } finally {
    host.close()
    guest.close()
  }
})

test('a second pairing on the same secret cannot open the first one', async () => {
  // THE forward-secrecy test. The secret, the topic and the room password are
  // all identical across the two pairings; the ephemeral keypair is the only
  // thing that differs, and it only differs because joinVia generates one per
  // call. Cache it anywhere and this assertion is what breaks.
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()

  const first = await pair(strategy, { topic, password, secret })
  const firstSession = first.host.session
  first.host.close()
  first.guest.close()

  const second = await pair(strategy, { topic, password, secret })
  const secondSession = second.host.session
  second.host.close()
  second.guest.close()

  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: IV }, firstSession.sendKey, new Uint8Array([9]))

  assert.equal(
    await decrypts(secondSession.recvKey, IV, ct), false,
    'holding the QR secret must not be enough to read an earlier session',
  )
  assert.notEqual(
    firstSession.sas, secondSession.sas,
    'and the SAS is what would show a user the two sessions are not the same',
  )
})

test('every pairing announces a public key it has never announced before', async () => {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy, announced } = fakeNetwork()

  for (let i = 0; i < 3; i++) {
    const { host, guest } = await pair(strategy, { topic, password, secret })
    host.close()
    guest.close()
  }

  // Two peers per pairing, and each announces once to the one peer it found.
  assert.equal(announced.length, 6)
  assert.equal(new Set(announced).size, 6, 'a repeated key here means one was reused')
})

test('frames from a third peer in the room never reach the receiver', async () => {
  // The send side has always been targeted at the paired peer, and
  // channel.js says why in as many words: a third party holding the code can
  // be sitting in this room. The receive side took frames from anyone, which
  // made that targeting a courtesy rather than a boundary -- and paired with
  // core/frame.js reading a cleartext header before authenticating it, one
  // stray frame was enough to end a live transfer.
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()
  const { host, guest } = await pair(strategy, { topic, password, secret })

  /** @type {Bytes[]} */
  const seen = []
  host.onFrame(bytes => seen.push(bytes))

  // A third member on the same topic, broadcasting untargeted. It never sends
  // on 'ecdh', so it does not disturb a pairing that has already settled.
  const intruder = strategy.join(
    /** @type {any} */ ({ appId: 'x', password, relayConfig: { urls: [] }, rtcConfig: {} }),
    topic,
  )
  await intruder.makeAction('frame').send(new Uint8Array([1, 2, 3]))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(seen, [], 'a stranger in the room must not reach the frame handler')

  // And the filter is not simply dropping everything: the peer we paired with
  // still gets through.
  await guest.channel.send(new Uint8Array([9, 9, 9]))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(seen.length, 1, 'the paired peer is still delivered')
  assert.deepEqual([...seen[0]], [9, 9, 9])

  host.close()
  guest.close()
})
