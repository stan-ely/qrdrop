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
import { generateSecret, deriveTopic, derivePassword, encodeSecret, toBase64url } from '../src/core/secret.js'
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

test('close() settles only once the peer has been told', async () => {
  // Trystero's leave() sends a leave message and waits 99 ms for it to go out.
  // close() used to drop that promise, and the CLI's Ctrl-C handler exited
  // straight after: a sender went on for 11 s before the connection timed out.
  // The slow leave here stands in for that wait.
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy: fast } = fakeNetwork()
  /** @type {SignalingStrategy} */
  const strategy = {
    ...fast,
    join: /** @type {SignalingStrategy['join']} */ ((config, joinTopic) => {
      const room = fast.join(config, joinTopic)
      const leave = room.leave.bind(room)
      room.leave = async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        await leave()
      }
      return room
    }),
  }

  const { host, guest } = await pair(strategy, { topic, password, secret })
  let told = false
  guest.onPeerLeave(() => { told = true })

  await host.close()
  assert.equal(told, true, 'the guest heard the leave before close() settled')
  await guest.close()
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

test('frames the paired peer sends before onFrame is registered are delivered, in order', async () => {
  // The other device does not wait for this one. The CLI registers its frame
  // handler only after its own SAS prompt returns, while the peer starts
  // sending the moment ITS person confirms: a CLI receiver sends its path
  // verdict at once, and the website's sender sends one before its verify
  // screen is even drawn. Dropped here, that verdict was control index 0, and
  // the next frame to arrive -- index 1 -- was fatal: "Out-of-order frame:
  // expected 0, got 1", seen live between two CLIs on 2026-09-12.
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()
  const { host, guest } = await pair(strategy, { topic, password, secret })

  await guest.channel.send(new Uint8Array([0]))
  await guest.channel.send(new Uint8Array([1]))
  await new Promise(resolve => setTimeout(resolve, 0))

  /** @type {number[]} */
  const seen = []
  host.onFrame(bytes => seen.push(bytes[0]))
  await guest.channel.send(new Uint8Array([2]))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(seen, [0, 1, 2], 'nothing the paired peer sent early is lost or reordered')

  host.close()
  guest.close()
})

/**
 * A flat negative, and it passes trivially today. That is the point.
 *
 * The two tests above are the shape a test usually takes: a feature works, and
 * here is the thing that breaks if it stops. Neither would have noticed the
 * bug this one guards, because that bug broke nothing a demo could see -- the
 * transfer completed, the file arrived, and the only casualty was a claim in
 * the README. Features have tests; promises usually do not.
 *
 * So this is the promise, written down where it can fail: the secret is the
 * whole credential, and it must never be a value any relay operator can read
 * off the wire. It exists for whoever later reads deriveTopic, notices it is
 * hashing 32 bytes that were already random, and concludes the hash is
 * ceremony. It is not: the topic is public and the secret is not.
 *
 * Checked against every encoding it could plausibly leak as rather than the
 * one it happens to use, since the failure mode being guarded is somebody
 * passing the secret somewhere it gets re-encoded on the way out.
 */
test('the secret never appears on the wire, in any encoding it could leak as', async () => {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy, sent, joins } = fakeNetwork()
  const { host, guest } = await pair(strategy, { topic, password, secret })

  // One frame each way, so `sent` is not just the two ecdh announcements: the
  // frame namespace carries the payloads, and a leak there would be the worse
  // one of the two.
  await host.channel.send(new Uint8Array([1, 2, 3]))
  await guest.channel.send(new Uint8Array([4, 5, 6]))
  await new Promise(resolve => setTimeout(resolve, 0))

  host.close()
  guest.close()

  const raw = String.fromCharCode(...secret)
  /** Every text form the 32 bytes could arrive in. */
  const forms = {
    'base64url': toBase64url(secret),
    'the qrdrop: code form': encodeSecret(secret),
    'standard base64': btoa(raw),
    'lowercase hex': [...secret].map(b => b.toString(16).padStart(2, '0')).join(''),
    'uppercase hex': [...secret].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
  }

  // Everything textual this process put on the wire, in one string: the topic
  // and Trystero config per join (appId, password, relayConfig, rtcConfig --
  // the one place a derived value could be swapped for the secret with no
  // payload changing), plus every string payload.
  const text = JSON.stringify({
    joins,
    strings: sent.map(m => m.data).filter(d => typeof d === 'string'),
  })

  for (const [name, form] of Object.entries(forms)) {
    assert.ok(!text.includes(form), `the secret must not reach the wire as ${name}`)
  }

  // The topic specifically, stated as its own equality rather than left to the
  // substring scan above -- this is the exact bug, and a failure here should
  // read as the bug rather than as a haystack miss.
  for (const { topic: joined } of joins) {
    assert.notEqual(joined, forms['base64url'], 'the rendezvous topic must not be the secret')
    assert.notEqual(joined, forms['the qrdrop: code form'], 'the rendezvous topic must not be the code')
  }

  // And the binary payloads, which no string scan reaches. A sealed frame is
  // ciphertext, so the 32 bytes appearing as a contiguous run in one is either
  // a spectacular coincidence or the secret being sent in the clear.
  const bytes = sent.map(m => m.data).filter(d => ArrayBuffer.isView(d) || d instanceof ArrayBuffer)
  assert.ok(bytes.length >= 2, 'expected the two frames above, or this checks nothing')

  for (const payload of bytes) {
    const view = ArrayBuffer.isView(payload)
      ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
      : new Uint8Array(payload)
    assert.ok(!containsBytes(view, secret), 'the secret must not reach the wire as raw bytes')
  }
})

/**
 * Whether `needle` appears as a contiguous run in `haystack`. Naive on
 * purpose: the inputs here are a handful of 16 KiB frames, and a real
 * substring search would be more code than the test it serves.
 *
 * @param {Uint8Array} haystack
 * @param {Uint8Array} needle
 */
function containsBytes(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}
