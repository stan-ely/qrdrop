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

/**
 * One member of a fake topic. `actions` is keyed by namespace, which is how a
 * send finds the matching handler on the other side.
 *
 * @typedef {object} FakeAction
 * @property {(data: TrysteroPayload, options?: { target?: string }) => Promise<void>} send
 * @property {((data: TrysteroPayload, context: { peerId: string }) => void) | null} onMessage
 *
 * @typedef {object} FakeMember
 * @property {string} id
 * @property {Map<string, FakeAction>} actions
 * @property {{ onPeerJoin: ((id: string) => void) | null,
 *              onPeerLeave: ((id: string) => void) | null }} room
 */

/**
 * A signalling network that never leaves the process.
 *
 * Returns the strategy plus `announced`, every payload sent on the 'ecdh'
 * namespace in order. That list is the most direct statement of the invariant
 * available: it is literally the public keys this process put on the wire.
 *
 * @returns {{ strategy: SignalingStrategy, announced: string[] }}
 */
function fakeNetwork() {
  /** @type {Map<string, FakeMember[]>} */
  const topics = new Map()
  /** @type {string[]} */
  const announced = []
  let nextId = 0

  /** @param {string} topic */
  const join = topic => {
    let members = topics.get(topic)
    if (!members) {
      members = []
      topics.set(topic, members)
    }
    const roster = members

    /** @type {Map<string, FakeAction>} */
    const actions = new Map()
    const room = {
      /** @type {((id: string) => void) | null} */
      onPeerJoin: null,
      /** @type {((id: string) => void) | null} */
      onPeerLeave: null,

      /** @param {string} namespace */
      makeAction(namespace) {
        /** @type {FakeAction} */
        const action = {
          onMessage: null,
          async send(data, options) {
            if (namespace === 'ecdh' && typeof data === 'string') announced.push(data)
            const target = options?.target
            for (const peer of roster) {
              if (peer === self) continue
              if (typeof target === 'string' && peer.id !== target) continue
              // Deferred, because a relay never calls back from inside send().
              // Delivering synchronously would run the peer's keyAction handler
              // partway through its own onPeerJoin, which is not a sequence the
              // real code can ever see and not one worth making it survive.
              queueMicrotask(() => peer.actions.get(namespace)?.onMessage?.(data, { peerId: self.id }))
            }
          },
        }
        actions.set(namespace, action)
        return action
      },

      // Never asked for a real one: openRoom's isRelayed() reads getPeers()[id]
      // and fails open when it is missing, which is exactly what we want -- the
      // TURN size cap is a courtesy to free infrastructure, not part of pairing.
      getPeers: () => ({}),

      async leave() {
        const i = roster.indexOf(self)
        if (i !== -1) roster.splice(i, 1)
        for (const peer of roster) peer.room.onPeerLeave?.(self.id)
      },
    }

    /** @type {FakeMember} */
    const self = { id: `peer-${nextId++}`, actions, room }
    roster.push(self)

    // Also deferred, and for a load-bearing reason: joinVia assigns
    // room.onPeerJoin *after* strategy.join() returns. Announcing synchronously
    // would fire into a null handler and no pairing would ever start -- the
    // same race the comment above joinVia's createEphemeralKeypair() call
    // describes, reproduced here so the fake cannot paper over it.
    queueMicrotask(() => {
      for (const peer of roster) {
        if (peer === self) continue
        peer.room.onPeerJoin?.(self.id)
        room.onPeerJoin?.(peer.id)
      }
    })

    return room
  }

  return {
    strategy: {
      name: 'fake',
      // Trystero's Room type has fifteen-odd media and RPC members the pairing
      // path never touches. Stubbing them all would be noise that hides drift
      // rather than catching it; the fake conforms to what joinVia actually
      // calls, and this cast is where that claim is made explicit.
      join: /** @type {SignalingStrategy['join']} */ (
        (_config, topic) => /** @type {import('@trystero-p2p/nostr').Room} */ (
          /** @type {unknown} */ (join(topic))
        )
      ),
      urls: [],
    },
    announced,
  }
}

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
