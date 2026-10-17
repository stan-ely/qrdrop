/**
 * The wire vectors in test/vectors/, held to the JS that ships.
 *
 * They exist for the Rust session (docs/notes/rust-session.md): a second
 * implementation of this protocol that has to keep agreeing with the website.
 * A vector that drifts from the JS is worse than none -- the Rust side would
 * pass against a wire nobody speaks -- so this file fails the moment one does.
 *
 * Three kinds of check:
 *
 * - The deterministic files are rebuilt from src/core/ and Trystero and
 *   compared byte for byte with what is committed. A change to the protocol
 *   fails here until `node scripts/make-vectors.mjs` is re-run, which puts the
 *   change to the wire in the diff for whoever reviews it.
 * - The values make-vectors.mjs had to compute itself are checked against the
 *   shipped code by a route that does not go through the script: the session
 *   keys by sealing with both, the signal ciphertexts by Trystero's decrypt(),
 *   the Nostr event by Trystero's createEvent().
 * - The recordings, which no re-run reproduces, are checked against Trystero's
 *   own code: every topic re-derived, every ciphertext opened, every event's id
 *   and signature verified, every data-channel message parsed back through
 *   Trystero's reassembly. A recording Trystero would not have produced fails.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import { buildVectors, fixedKeypair, fromHex, mod251, serialise } from '../scripts/make-vectors.mjs'
import { establishSession } from '../src/core/session.js'
import { open, seal } from '../src/core/frame.js'
import { hex } from '../src/core/digest.js'
import { actionReader, createEvent, crypto as tc, strToNum } from './helpers/trystero.mjs'
import { schnorr } from '@noble/secp256k1'

const DIR = new URL('./vectors/', import.meta.url)
/** @param {string} name @returns {any} */
const load = name => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))
/** @param {Bytes} b */
const sha256 = async b => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b)))
/** @param {string} s */
const sha256Text = s => sha256(new TextEncoder().encode(s))
/** @param {Bytes} raw */
const aesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
/** @param {any} p */
const plaintextOf = p => (typeof p === 'string' ? fromHex(p) : mod251(p.mod251))

test('the committed vectors are exactly what the JS produces today', async () => {
  const built = await buildVectors()
  for (const [name, value] of Object.entries(built)) {
    assert.equal(
      readFileSync(new URL(name, DIR), 'utf8'), serialise(value),
      `test/vectors/${name} is stale: re-run node scripts/make-vectors.mjs and review the diff`,
    )
  }
})

test('the re-derived session keys are the keys establishSession really uses', async () => {
  const { cases } = load('session.json')
  for (const c of cases) {
    const secret = fromHex(c.secret)
    const host = await fixedKeypair(fromHex(c.host_private))
    const guest = await fixedKeypair(fromHex(c.guest_private))
    assert.equal(hex(host.raw), c.host_public)
    assert.equal(hex(guest.raw), c.guest_public)

    const hostSession = await establishSession({ keypair: host.keypair, peerPublicRaw: guest.raw, secret, role: 'host' })
    const guestSession = await establishSession({ keypair: guest.keypair, peerPublicRaw: host.raw, secret, role: 'guest' })
    assert.equal(hostSession.sas, c.sas)
    assert.deepEqual(hostSession.sasWords, c.sas_words)
    assert.equal(guestSession.sas, c.sas)

    // The real keys are non-extractable, so the only way to compare them with
    // the vector's bytes is to make both seal the same frame. AES-GCM with a
    // fixed nonce is deterministic, so equal output means equal keys.
    const fields = { type: 1, fileSeq: 0, index: 9, last: true }
    const plaintext = new TextEncoder().encode('which key is this')
    for (const [real, bytes] of [[hostSession.sendKey, c.host_to_guest], [guestSession.sendKey, c.guest_to_host]]) {
      const theirs = await seal(/** @type {CryptoKey} */ (real), fields, plaintext)
      const ours = await seal(await aesKey(fromHex(/** @type {string} */ (bytes))), fields, plaintext)
      assert.equal(hex(ours), hex(theirs))
    }
  }
})

test('every frame vector opens under the vector\'s raw key and refuses as it says', async () => {
  const v = load('frames.json')
  /** @type {Record<string, CryptoKey>} */
  const keys = {
    host_to_guest: await aesKey(fromHex(v.keys.host_to_guest)),
    guest_to_host: await aesKey(fromHex(v.keys.guest_to_host)),
  }

  for (const c of v.chunks) {
    const plaintext = plaintextOf(c.plaintext)
    const frame = await seal(keys[c.key], { type: 1, fileSeq: c.file_seq, index: c.index, last: c.last }, plaintext)
    if (c.frame) assert.equal(hex(frame), c.frame, c.why)
    else assert.deepEqual([frame.length, await sha256(frame)], [c.frame_length, c.frame_sha256], c.why)
    const opened = await open(keys[c.key], frame, { type: 1, fileSeq: c.file_seq, index: c.index })
    assert.equal(hex(opened.plaintext), hex(plaintext))
    assert.equal(opened.last, c.last)
  }

  for (const c of v.controls) {
    const opened = await open(keys[c.key], fromHex(c.frame), { type: 0, fileSeq: v.constants.CONTROL_SEQ, index: c.index })
    assert.equal(new TextDecoder().decode(opened.plaintext), c.plaintext)
    assert.deepEqual(JSON.parse(c.plaintext), c.message)
  }

  for (const c of v.reject) {
    const frame = c.frame ? fromHex(c.frame) : new Uint8Array(c.frame_zeros)
    await assert.rejects(open(keys[c.key], frame, c.expect), (/** @type {Error} */ error) => {
      const kind = error.name === 'UnauthenticatedFrame' ? 'unauthenticated'
        : /too short/.test(error.message) ? 'too-short'
          : /maximum size/.test(error.message) ? 'too-large'
            : /Out-of-order/.test(error.message) ? 'index'
              : /unexpected file/.test(error.message) ? 'file-seq'
                : /frame type/.test(error.message) ? 'type' : error.message
      assert.equal(kind, c.error, c.why)
      return true
    })
  }
})

test('every signal vector opens with Trystero\'s own decrypt, and only with its password', async () => {
  const v = load('trystero.json')
  const { app_id: appId, room_id: roomId } = v.topics
  assert.equal(await sha256Text(v.signal.key_plaintext), v.signal.key)
  const key = tc.genKey(v.password, appId, roomId)
  const wrong = tc.genKey(`${v.password}x`, appId, roomId)
  for (const c of v.signal.cases) {
    assert.equal(await tc.decrypt(key, c.wire), c.plaintext, c.why)
    await assert.rejects(tc.decrypt(wrong, c.wire))
  }
})

test('the action-wire vectors reassemble, through Trystero, into what was sent', () => {
  const v = load('trystero.json')
  for (const c of v.action_wire.cases) {
    // The oversized cases are kept as hashes and cannot be fed back.
    if (c.chunks.some((/** @type {any} */ k) => !k.hex)) continue
    const reader = actionReader([c.action])
    for (const chunk of c.chunks) reader.feed(fromHex(chunk.hex))
    assert.equal(reader.received.length, 1, c.action)
    const [got] = reader.received
    const payload = got.payload instanceof Uint8Array ? { binary: hex(/** @type {Bytes} */ (got.payload)) } : { json: got.payload }
    assert.deepEqual(payload, c.payload, c.action)
    assert.deepEqual(got.metadata, c.metadata)
  }
})

test('Trystero\'s createEvent follows the rule the Nostr vector is built by', async () => {
  const v = load('trystero.json')
  const vector = JSON.parse(v.nostr_event.message)[1]
  await assertNostrEvent(vector)
  assert.equal(vector.id, await sha256Text(v.nostr_event.id_preimage))

  const [type, event] = JSON.parse(await createEvent(v.topics.root_topic, 'content'))
  assert.equal(type, 'EVENT')
  assert.equal(event.kind, v.topics.nostr_kind_root)
  assert.deepEqual(event.tags, [['x', v.topics.root_topic]])
  await assertNostrEvent(event)
})

/** @param {any} event */
async function assertNostrEvent(event) {
  const preimage = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  assert.equal(event.id, await sha256Text(preimage))
  assert.ok(await schnorr.verifyAsync(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey)), 'BIP-340 signature')
}

for (const name of readdirSync(DIR).filter(f => f.startsWith('trystero-recording'))) {
  test(`${name} is traffic Trystero would have produced`, async () => {
    const r = load(name)
    const key = tc.genKey(r.password, r.app_id, r.topic)
    const rootPlain = ['Trystero', r.app_id, r.topic].join('@')
    const rootTopic = await tc.sha1(rootPlain)
    const roomToken = await tc.deriveRoomNamespace(r.app_id, r.topic)

    for (const run of r.runs) {
      const ids = [run.peers.host.self_id, run.peers.guest.self_id]
      assert.equal(run.peers.host.paired_with, run.peers.guest.self_id)
      assert.equal(run.peers.host.sas, run.peers.guest.sas)
      const selfTopics = new Set(await Promise.all(ids.map(id => tc.sha1(`${rootPlain}@${id}`))))
      const topics = new Set([rootTopic, ...selfTopics])

      /** @type {string[]} */
      const ciphertexts = []
      for (const m of run.relay) {
        const msg = JSON.parse(m.data)
        if (run.strategy === 'nostr') {
          if (msg[0] === 'REQ' && m.dir === 'out') {
            for (const t of msg[2]['#x']) assert.ok(topics.has(t), 'subscribed to a topic of this room')
            assert.deepEqual(msg[2].kinds, msg[2]['#x'].map((/** @type {string} */ t) => strToNum(t, 1e4) + 2e4))
          }
          const event = msg[0] === 'EVENT' ? msg.at(-1) : null
          if (!event || event.kind === undefined) continue
          await assertNostrEvent(event)
          assert.ok(topics.has(event.tags[0][1]))
          assert.equal(event.kind, strToNum(event.tags[0][1], 1e4) + 2e4)
          const content = JSON.parse(event.content)
          assert.ok(ids.includes(content.peerId))
          for (const k of ['offer', 'answer', 'candidate']) if (content[k]) ciphertexts.push(content[k])
        } else {
          if (msg.info_hash) assert.equal(msg.info_hash, (await tc.sha1(rootTopic)).slice(0, 20))
          if (m.dir === 'out') {
            assert.equal(msg.action, 'announce')
            assert.ok(ids.includes(msg.peer_id))
          }
          for (const o of msg.offers ?? []) ciphertexts.push(o.offer.sdp)
          if (msg.offer) ciphertexts.push(msg.offer.sdp)
          if (msg.answer) ciphertexts.push(msg.answer.sdp)
        }
      }

      assert.ok(ciphertexts.length >= 2, 'at least an offer and an answer')
      for (const c of ciphertexts) {
        assert.match(c, /^(\d{1,3},){15}\d{1,3}\$[A-Za-z0-9+/]+=*$/, 'a 16-byte IV, then base64')
        const plain = await tc.decrypt(key, c)
        // What lets these SDPs sit in a public repository beside their key.
        for (const [, addr] of plain.matchAll(/(?:IN IP4 |typ host|candidate:\S+ \d \S+ \d+ )(\d+\.\d+\.\d+\.\d+)?/g)) {
          if (addr) assert.match(addr, /^(127\.0\.0\.1|0\.0\.0\.0)$/, 'no address of the recording machine')
        }
      }

      for (const peer of ['host', 'guest']) {
        const sent = run.channel.filter((/** @type {any} */ m) => m.peer === peer && m.dir === 'out')
        const reader = actionReader(['@_hsdata', '@_hsready', '@_leave', 'ecdh', 'frame'])
        /** @type {string[]} */
        const order = []
        for (const m of sent) {
          const head = fromHex(m.hex ?? m.head)
          if (head[0] === 2) {
            assert.equal(new TextDecoder().decode(head.subarray(4)), roomToken, 'presence names this room')
            continue
          }
          assert.equal(head[0], 1, 'every message is a room frame')
          assert.equal((head[1] << 8) | head[2], 64)
          assert.equal(new TextDecoder().decode(head.subarray(3, 67)), roomToken)
          const action = new TextDecoder().decode(head.subarray(67, 99)).replaceAll('\0', '')
          order.push(action)
          if (m.hex) reader.feed(head.subarray(67))
          else {
            // A full sealed frame: one action chunk, binary, last.
            assert.equal(action, 'frame')
            assert.equal(head[67 + 34], 0x0d)
            assert.equal(m.length, 67 + 36 + 16348)
          }
        }

        // ecdh goes out only once the peer is active, which is after this
        // side has had the other's @_hsready; and the challenge comes from the
        // lower id.
        assert.ok(order.indexOf('@_hsready') < order.indexOf('ecdh'))
        const hs = reader.received.find(x => x.action === '@_hsdata')
        const me = run.peers[peer].self_id
        const lower = me < run.peers[peer].paired_with
        assert.equal(/** @type {any} */ (hs?.payload).__trystero_pw, lower ? 'challenge' : 'response')
        if (!lower) {
          const theirs = run.channel.filter((/** @type {any} */ m) => m.peer !== peer && m.dir === 'out' && m.hex)
          const challengeReader = actionReader(['@_hsdata'])
          for (const m of theirs) { const b = fromHex(m.hex); if (b[0] === 1) challengeReader.feed(b.subarray(67)) }
          const challenge = /** @type {any} */ (challengeReader.received[0].payload).c
          assert.equal(/** @type {any} */ (hs?.payload).h, await sha256Text(`${challenge}:${r.password}:${r.app_id}:${r.topic}`))
        }
        const ecdh = reader.received.find(x => x.action === 'ecdh')
        assert.match(String(ecdh?.payload), /^[A-Za-z0-9_-]{87}$/, 'a raw P-256 point, base64url')
        assert.ok(reader.received.some(x => x.action === '@_hsready' && x.payload === ''))
      }
    }
  })
}
