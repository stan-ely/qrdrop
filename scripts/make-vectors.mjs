#!/usr/bin/env node
/**
 * Writes test/vectors/*.json: fixed inputs and what the real JS produces from
 * them, for the Rust session to be tested against (docs/notes/rust-session.md,
 * phase 0).
 *
 *   node scripts/make-vectors.mjs           # rewrite the files
 *   node scripts/make-vectors.mjs --check   # exit 1 if they are stale
 *
 * Every value comes from the code that ships -- src/core/ for qrdrop's half and
 * Trystero 0.25.4's own modules for the transport's -- and never from a second
 * implementation written here. That is the property the vectors exist for: a
 * Rust port that passes them agrees with the JS, rather than with somebody's
 * reading of the JS. Where the script does have to compute something itself,
 * test/vectors.test.mjs checks it against the shipped code independently:
 *
 * - The session keys. establishSession() derives non-extractable AES keys, so
 *   their bytes cannot be read back; they are re-derived here with deriveBits,
 *   and the test proves the re-derivation by sealing the same frame with both.
 * - The signal ciphertexts. Trystero's encrypt() draws a random IV, so the
 *   vectors seal with a fixed one through WebCrypto directly, and the test
 *   opens every one with Trystero's own decrypt().
 * - The Nostr event. Trystero's createEvent() signs with a per-process random
 *   key and the wall clock; the vector uses a fixed key, time and auxiliary
 *   randomness, and the test holds createEvent()'s output to the same id rule.
 *
 * Everything is deterministic, so a re-run on an unchanged tree rewrites the
 * files byte for byte; `--check` and the test both rely on that. The ECDH keys
 * are fixed scalars rather than generated keys for the same reason.
 *
 * Bytes are lowercase hex throughout. A plaintext too large to be worth
 * spelling out is `{ "mod251": n }`, meaning n bytes where byte i is i % 251 --
 * a pattern with no period that divides CHUNK_SIZE, so a misplaced block shows
 * -- and its frame is given by length and SHA-256 rather than in full.
 *
 * The recorded Trystero traffic is a separate script (record-trystero.mjs):
 * it needs WebRTC and two processes, and its output is a recording, not
 * something a re-run reproduces.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import {
  decodeSecret, deriveTopic, derivePassword, encodeSecret, encodeSecretURL, toBase64url,
} from '../src/core/secret.js'
import { establishSession, SAS_EMOJI } from '../src/core/session.js'
import {
  CHUNK_SIZE, HEADER_BYTES, MAX_FRAME_BYTES, TAG_BYTES, TYPE_CHUNK, TYPE_CONTROL,
  decodeHeader, encodeHeader, open, seal, sealControl,
} from '../src/core/frame.js'
import { EMPTY_CHAIN, chainHash, hex } from '../src/core/digest.js'
import {
  TRYSTERO_VERSION, actionWire, createPasswordHandshake, crypto as tc, libName, roomFramer, strToNum, toHex,
} from '../test/helpers/trystero.mjs'
import { schnorr } from '@noble/secp256k1'

const OUT = new URL('../test/vectors/', import.meta.url)
const enc = new TextEncoder()

const APP_ID = 'qrdrop'
const CONTROL_SEQ = 0xffffffff
// What scripts/build-site.mjs serves the site from. Only the URL form's
// prefix; any absolute http(s) base behaves the same.
const BASE_URL = 'https://share.stan-ely.com/'

/** @param {string} s */
const fromHex = s => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16))
/** @param {Bytes} b */
const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
/** @param {string} label */
const labelled = label => sha256(enc.encode(`qrdrop vectors: ${label}`))
/** @param {number} n */
const mod251 = n => Uint8Array.from({ length: n }, (_, i) => i % 251)

/**
 * A plaintext as it appears in a vector: in full when small, as a pattern when
 * not. The threshold is one byte under a full chunk, so every full chunk is a
 * pattern and everything else is spelled out.
 * @param {Bytes} bytes
 * @param {number} [patternLength]
 */
const plaintextField = (bytes, patternLength) =>
  patternLength === undefined ? hex(bytes) : { mod251: patternLength }

/**
 * @param {Bytes} frame
 * @param {boolean} inFull
 */
const frameField = async (frame, inFull) =>
  inFull ? { frame: hex(frame) } : { frame_length: frame.length, frame_sha256: hex(await sha256(frame)) }

// --- secrets and codes -----------------------------------------------------

async function secretVectors() {
  const secrets = [
    new Uint8Array(32),
    Uint8Array.from({ length: 32 }, (_, i) => i),
    await labelled('secret'),
  ]

  const derive = []
  for (const secret of secrets) {
    derive.push({
      secret: hex(secret),
      code: encodeSecret(secret),
      url: encodeSecretURL(secret, BASE_URL),
      topic: await deriveTopic(secret),
      password: await derivePassword(secret),
      topic_epoch_1: await deriveTopic(secret, 1),
    })
  }

  const code = encodeSecret(secrets[2])
  const body = code.slice('qrdrop:'.length)
  // base64url of 32 bytes is 43 characters carrying 258 bits, so the last
  // character's two low bits are padding. fromBase64url goes through atob,
  // which ignores them, so a code whose last character differs only there
  // decodes to the same secret. A Rust decoder that insists on canonical
  // padding bits rejects it, and would refuse a code the website accepts.
  const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(body.at(-1) ?? '')
  const nonCanonical = `qrdrop:${body.slice(0, -1)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[lastIndex ^ 1]}`

  const inputs = [
    ['the bare form', code],
    ['the bare form, with whitespace around it (it is trimmed)', `  ${code}\n`],
    ['the URL form', `${BASE_URL}#${code}`],
    ['the URL form with a query beside the fragment', `${BASE_URL}?from=camera#${code}`],
    ['an upper-case scheme, which URL parsing lowercases', `HTTPS://share.stan-ely.com/#${code}`],
    ['a non-canonical last character, accepted because atob ignores the padding bits', nonCanonical],
    ['the code in the query string', `${BASE_URL}?code=${code}`],
    ['the code in the path', `${BASE_URL}${code}`],
    ['the URL form with something after the code in the fragment', `${BASE_URL}#${code}&x=1`],
    ['a non-http scheme', `ftp://share.stan-ely.com/#${code}`],
    ['an upper-case bare prefix', `QRDROP:${body}`],
    ['a code one character short', code.slice(0, -1)],
    ['a code one character long', `${code}A`],
    ['a character outside base64url', `qrdrop:${body.slice(0, -1)}+`],
    ['not a code at all', 'hello'],
  ]

  const decode = inputs.map(([why, input]) => {
    try {
      return { why, input, secret: hex(decodeSecret(input)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A category rather than the message: the wording is the JS UI's, and
      // the Rust side owes the same verdict, not the same sentence.
      const kind = /fragment/.test(message) ? 'fragment-only' : /Malformed/.test(message) ? 'malformed' : 'not-a-code'
      return { why, input, error: kind }
    }
  })

  return {
    about: 'Secret -> topic and password (HKDF-SHA-256, salt "qrdrop/v1", info "topic" / "signal", base64url without padding), the code forms, and what decodeSecret accepts. A decode case has either `secret` or `error` (fragment-only | not-a-code | malformed).',
    salt: 'qrdrop/v1',
    base_url: BASE_URL,
    derive,
    decode,
  }
}

// --- ECDH, session keys, SAS ----------------------------------------------

/**
 * A P-256 keypair from a fixed scalar, imported the way WebCrypto would hold a
 * generated one. PKCS#8 without the public point, which Node fills in, so the
 * script never needs EC arithmetic of its own.
 * @param {Bytes} d
 */
async function fixedKeypair(d) {
  const prefix = fromHex('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420')
  const der = new Uint8Array(prefix.length + 32)
  der.set(prefix)
  der.set(d, prefix.length)
  const extractable = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', extractable)
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const publicKey = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  )
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
  return { keypair: { privateKey, publicKey }, d, raw }
}

/**
 * session.js's derivation, step by step, with deriveBits where it uses
 * deriveKey -- the only way to see bytes it deliberately never exposes.
 * @param {CryptoKey} privateKey
 * @param {Bytes} myRaw
 * @param {Bytes} peerRaw
 * @param {Bytes} secret
 */
async function rederive(privateKey, myRaw, peerRaw, secret) {
  const peer = await crypto.subtle.importKey('raw', peerRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256))
  const [lo, hi] = Buffer.compare(Buffer.from(myRaw), Buffer.from(peerRaw)) <= 0 ? [myRaw, peerRaw] : [peerRaw, myRaw]
  const transcript = await sha256(new Uint8Array([...lo, ...hi]))
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  /** @param {string} label @param {number} bytes */
  const hkdf = async (label, bytes) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: secret, info: new Uint8Array([...enc.encode(label), ...transcript]) }, ikm, bytes * 8,
  ))
  return {
    shared,
    transcript,
    hostToGuest: await hkdf('host->guest', 32),
    guestToHost: await hkdf('guest->host', 32),
    sasBytes: await hkdf('sas', 4),
  }
}

/** @param {Bytes} bytes */
const renderSas = bytes => {
  const picked = [0, 1, 2, 3].map(i => SAS_EMOJI[bytes[i] & 0x3f])
  return {
    sas: picked.map(([emoji]) => emoji).join(' '),
    sas_words: picked.map(([, word]) => word),
    // src/cli.js prints each emoji beside its word, three spaces between.
    cli_line: picked.map(([emoji, word]) => `${emoji} ${word}`).join('   '),
  }
}

async function sessionVectors() {
  const cases = []
  /** @type {Awaited<ReturnType<typeof establishSession>> | null} */
  let first = null
  /** @type {Awaited<ReturnType<typeof rederive>> | null} */
  let firstKeys = null

  for (const n of [1, 2]) {
    const secret = await labelled(`session ${n} secret`)
    const host = await fixedKeypair(await labelled(`session ${n} host key`))
    const guest = await fixedKeypair(await labelled(`session ${n} guest key`))

    const hostSession = await establishSession({ keypair: host.keypair, peerPublicRaw: guest.raw, secret, role: 'host' })
    const guestSession = await establishSession({ keypair: guest.keypair, peerPublicRaw: host.raw, secret, role: 'guest' })
    if (hostSession.sas !== guestSession.sas) throw new Error('the two sides disagree on the SAS')

    const keys = await rederive(host.keypair.privateKey, host.raw, guest.raw, secret)
    const rendered = renderSas(keys.sasBytes)
    if (rendered.sas !== hostSession.sas) throw new Error('re-derived SAS does not match establishSession')

    cases.push({
      secret: hex(secret),
      host_private: hex(host.d),
      host_public: hex(host.raw),
      host_public_b64url: toBase64url(host.raw),
      guest_private: hex(guest.d),
      guest_public: hex(guest.raw),
      guest_public_b64url: toBase64url(guest.raw),
      shared: hex(keys.shared),
      transcript: hex(keys.transcript),
      host_to_guest: hex(keys.hostToGuest),
      guest_to_host: hex(keys.guestToHost),
      sas_bytes: hex(keys.sasBytes),
      ...rendered,
    })
    if (n === 1) { first = hostSession; firstKeys = keys }
  }

  // Byte patterns no real case is likely to hit: the high bits that `& 0x3f`
  // discards, both ends of the table, and the entries that carry U+FE0F.
  const render = ['00000000', 'ffffffff', '3f7fbfff', '1a24271a', '40800c33'].map(b => ({ sas_bytes: b, ...renderSas(fromHex(b)) }))

  return {
    vectors: {
      about: 'P-256 ECDH, raw uncompressed public keys (65 bytes; base64url without padding on the wire). shared = the 32-byte X coordinate; transcript = SHA-256(lo || hi) of the two public keys sorted bytewise; each value is HKDF-SHA-256(ikm = shared, salt = the QR secret, info = UTF-8(label) || transcript) for labels host->guest and guest->host (32 bytes, AES-256-GCM) and sas (4 bytes). The host (the QR side) sends with host_to_guest. SAS symbol i is sas_table[sas_bytes[i] & 0x3f].',
      cases,
      render,
      sas_table: SAS_EMOJI,
    },
    first: /** @type {NonNullable<typeof first>} */ (first),
    firstKeys: /** @type {NonNullable<typeof firstKeys>} */ (firstKeys),
  }
}

// --- frames ----------------------------------------------------------------

/**
 * @param {Awaited<ReturnType<typeof establishSession>>} session The host's
 *   session, whose sendKey is the real, non-extractable key every frame here
 *   is sealed with.
 * @param {Awaited<ReturnType<typeof rederive>>} keys
 */
async function frameVectors(session, keys) {
  const hostKey = session.sendKey
  const guestKey = session.recvKey

  const headers = [
    { type: TYPE_CHUNK, fileSeq: 0, index: 0, last: true },
    { type: TYPE_CHUNK, fileSeq: 0x01020304, index: 0x0506070809, last: false },
    { type: TYPE_CONTROL, fileSeq: CONTROL_SEQ, index: 3, last: false },
    { type: TYPE_CHUNK, fileSeq: 0, index: Number.MAX_SAFE_INTEGER, last: true },
  ].map(fields => ({ fields, header: hex(encodeHeader(fields)) }))

  // decodeHeader reads `last` as true only when the byte is exactly 1.
  const decode = ['01', '02', 'ff'].map(last => `01${'00'.repeat(12)}${last}`)
    .map(h => ({ header: h, fields: decodeHeader(fromHex(h)) }))

  const chunkSpecs = [
    { why: 'an empty file is one empty chunk', fileSeq: 0, index: 0, last: true, bytes: new Uint8Array() },
    { why: 'a small first chunk', fileSeq: 0, index: 0, last: false, bytes: enc.encode('hello, ') },
    { why: 'and its last', fileSeq: 0, index: 1, last: true, bytes: enc.encode('world') },
    { why: 'a full chunk, 16348 bytes sealed: exactly one Trystero chunk', fileSeq: 0, index: 2, last: false, bytes: mod251(CHUNK_SIZE), pattern: CHUNK_SIZE },
    { why: 'a large index and a non-zero fileSeq, both in the nonce', fileSeq: 7, index: 2 ** 40 + 3, last: true, bytes: Uint8Array.of(0, 255) },
  ]
  const chunks = []
  for (const { why, fileSeq, index, last, bytes, pattern } of chunkSpecs) {
    const frame = await seal(hostKey, { type: TYPE_CHUNK, fileSeq, index, last }, bytes)
    chunks.push({ why, key: 'host_to_guest', file_seq: fileSeq, index, last, plaintext: plaintextField(bytes, pattern), ...await frameField(frame, pattern === undefined) })
  }

  // One plausible session's control traffic, each side counting its own
  // indices from 0. The plaintext is given exactly: JSON.stringify's key
  // order and its non-ASCII output (no \u escapes) are what the sealed bytes
  // cover, so a port that wants to reproduce these frames must match both.
  /** @type {Array<[CryptoKey, 'host_to_guest' | 'guest_to_host', ControlMessage]>} */
  const flow = [
    [hostKey, 'host_to_guest', { t: 'path', path: 'direct' }],
    [hostKey, 'host_to_guest', { t: 'lan-hello', listen: 'quiet' }],
    [guestKey, 'guest_to_host', { t: 'path', path: 'direct' }],
    [guestKey, 'guest_to_host', { t: 'lan-hello', listen: 'quiet' }],
    [guestKey, 'guest_to_host', { t: 'lan-offer', addrs: ['192.168.1.20', '10.0.0.5'], port: 49152, token: '00112233445566778899aabbccddeeff' }],
    [hostKey, 'host_to_guest', { t: 'manifest', seq: 0, name: 'résumé 📄.pdf', size: 32641, mime: 'application/pdf', chunks: 3 }],
    [guestKey, 'guest_to_host', { t: 'accept', seq: 0 }],
    [guestKey, 'guest_to_host', { t: 'pause' }],
    [guestKey, 'guest_to_host', { t: 'resume' }],
    [hostKey, 'host_to_guest', { t: 'complete', seq: 0, chunks: 3, digest: 'ab'.repeat(32) }],
    [guestKey, 'guest_to_host', { t: 'done', seq: 0 }],
    [guestKey, 'guest_to_host', { t: 'decline', seq: 1 }],
    [guestKey, 'guest_to_host', { t: 'error', seq: 1, message: 'Saving failed: disk full' }],
  ]
  const counters = { host_to_guest: 0, guest_to_host: 0 }
  const controls = []
  for (const [key, keyName, message] of flow) {
    const index = counters[keyName]++
    const frame = await sealControl(key, index, message)
    controls.push({ key: keyName, index, message, plaintext: JSON.stringify(message), frame: hex(frame) })
  }

  // Frames a receiver must refuse, and how. `expect` is the receiver's own
  // expectation, never read off the wire; null means open without one.
  const good = await seal(hostKey, { type: TYPE_CHUNK, fileSeq: 0, index: 4, last: false }, enc.encode('payload'))
  /** @param {(f: Uint8Array) => void} edit */
  const tampered = edit => { const f = good.slice(); edit(f); return f }
  const expect4 = { type: TYPE_CHUNK, fileSeq: 0, index: 4 }
  const rejectSpecs = [
    { why: 'one bit of the tag flipped', frame: tampered(f => { f[f.length - 1] ^= 1 }), expect: expect4, error: 'unauthenticated' },
    { why: 'one bit of the ciphertext flipped', frame: tampered(f => { f[HEADER_BYTES] ^= 0x80 }), expect: expect4, error: 'unauthenticated' },
    { why: 'the header\'s index rewritten: it is the AAD and the nonce, so the tag fails before any order check sees it', frame: tampered(f => { f[12] = 13 }), expect: expect4, error: 'unauthenticated' },
    { why: 'the header\'s last byte rewritten', frame: tampered(f => { f[13] = 1 }), expect: expect4, error: 'unauthenticated' },
    { why: 'sealed under the other direction\'s key', frame: await seal(guestKey, { type: TYPE_CHUNK, fileSeq: 0, index: 4, last: false }, enc.encode('payload')), expect: expect4, error: 'unauthenticated' },
    { why: 'authentic, but not the index expected: fatal, it is our own peer', frame: good, expect: { ...expect4, index: 3 }, error: 'index' },
    { why: 'authentic, but not the type expected', frame: good, expect: { ...expect4, type: TYPE_CONTROL }, error: 'type' },
    { why: 'authentic, but from another file', frame: good, expect: { ...expect4, fileSeq: 1 }, error: 'file-seq' },
    { why: 'one byte under the 30-byte minimum', frame: good.slice(0, HEADER_BYTES + TAG_BYTES - 1), expect: expect4, error: 'too-short' },
  ]
  const reject = []
  for (const { why, frame, expect, error } of rejectSpecs) {
    const actual = await openError(hostKey, frame, expect)
    if (actual !== error) throw new Error(`reject case "${why}": the JS says ${actual}, the vector says ${error}`)
    reject.push({ why, key: 'host_to_guest', frame: hex(frame), expect, error })
  }
  // One over MAX_FRAME_BYTES is refused on size alone, before any decryption.
  const oversize = new Uint8Array(MAX_FRAME_BYTES + 1)
  if (await openError(hostKey, oversize, null) !== 'too-large') throw new Error('oversize frame was not refused on size')
  reject.push({ why: 'one byte over MAX_FRAME_BYTES, refused before decryption', key: 'host_to_guest', frame_zeros: oversize.length, expect: null, error: 'too-large' })

  return {
    about: 'Frames: a 14-byte header (type u8: 0 control, 1 chunk; fileSeq u32 BE; index u64 BE; last u8, read as true only when 1) then AES-256-GCM(ciphertext || 16-byte tag) with IV = header[1..13] and AAD = the whole header. Control frames use fileSeq 0xffffffff, last 0, one index counter per direction, and UTF-8 JSON plaintext. Keys are the session vectors\' first case. A plaintext of {"mod251": n} is n bytes where byte i = i % 251. reject.error is one of unauthenticated (drop and count, never fatal) | index | type | file-seq (fatal) | too-short | too-large.',
    keys: { host_to_guest: hex(keys.hostToGuest), guest_to_host: hex(keys.guestToHost) },
    constants: {
      HEADER_BYTES, TAG_BYTES, CHUNK_SIZE, MAX_FRAME_BYTES, CONTROL_SEQ, TYPE_CONTROL, TYPE_CHUNK,
      MIN_FRAME_BYTES: HEADER_BYTES + TAG_BYTES,
      FULL_FRAME_BYTES: HEADER_BYTES + CHUNK_SIZE + TAG_BYTES,
    },
    headers,
    decode,
    chunks,
    controls,
    reject,
  }
}

/**
 * What open() does with a frame, as a category. `key` stands in for the
 * guest's recvKey, which holds the same bytes as the host's sendKey.
 * @param {CryptoKey} key
 * @param {Bytes} frame
 * @param {FrameExpectation | null} expect
 */
async function openError(key, frame, expect) {
  try {
    await open(key, frame, expect)
    return null
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    if (name === 'UnauthenticatedFrame') return 'unauthenticated'
    if (/too short/.test(message)) return 'too-short'
    if (/maximum size/.test(message)) return 'too-large'
    if (/Out-of-order/.test(message)) return 'index'
    if (/unexpected file/.test(message)) return 'file-seq'
    if (/frame type/.test(message)) return 'type'
    return `unknown: ${message}`
  }
}

// --- digests and chunking ---------------------------------------------------

async function digestVectors() {
  /** @type {Array<{ why: string, size: number }>} */
  const files = [
    { why: 'an empty file: one empty chunk', size: 0 },
    { why: 'one byte', size: 1 },
    { why: 'exactly one full chunk', size: CHUNK_SIZE },
    { why: 'two full chunks and five bytes', size: 2 * CHUNK_SIZE + 5 },
  ]
  const cases = []
  for (const { why, size } of files) {
    const file = mod251(size)
    const count = Math.max(1, Math.ceil(size / CHUNK_SIZE))
    let chain = EMPTY_CHAIN()
    const steps = []
    for (let i = 0; i < count; i++) {
      chain = await chainHash(chain, file.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
      steps.push(hex(chain))
    }
    cases.push({ why, file: { mod251: size }, chunks: count, steps, digest: hex(chain) })
  }

  const sizes = [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 100 * 1024 * 1024, 2 ** 40]
    .map(size => ({ size, chunks: Math.max(1, Math.ceil(size / CHUNK_SIZE)) }))

  return {
    about: 'The rolling digest: start from 32 zero bytes; for each chunk c = SHA-256(c || SHA-256(chunk)); sent as 64 lowercase hex characters. A file is cut into CHUNK_SIZE (16318) pieces and has max(1, ceil(size / CHUNK_SIZE)) chunks, so an empty file is one empty chunk. Files are {"mod251": n}: n bytes, byte i = i % 251.',
    cases,
    chunk_counts: sizes,
  }
}

// --- Trystero 0.25.4 --------------------------------------------------------

/**
 * @param {string} roomId
 * @param {string} password
 */
async function trysteroVectors(roomId, password) {
  // Fixed 20-character IDs from Trystero's alphabet, standing in for the
  // per-process random selfId. One sorts below the other, which decides who
  // offers and who sends the handshake challenge.
  const ids = ['0aBcDeFgHiJkLmNoPqRs', 'zYxWvUtSrQpOnMlKjIhG']

  const rootPlain = [libName, APP_ID, roomId].join('@')
  const rootTopic = await tc.sha1(rootPlain)
  const peers = []
  for (const selfId of ids) {
    const selfPlain = [rootPlain, selfId].join('@')
    const selfTopic = await tc.sha1(selfPlain)
    peers.push({ self_id: selfId, self_topic_plaintext: selfPlain, self_topic: selfTopic, nostr_kind_self: strToNum(selfTopic, 1e4) + 2e4 })
  }
  const roomToken = await tc.deriveRoomNamespace(APP_ID, roomId)

  const topics = {
    app_id: APP_ID,
    room_id: roomId,
    root_topic_plaintext: rootPlain,
    root_topic: rootTopic,
    nostr_kind_root: strToNum(rootTopic, 1e4) + 2e4,
    torrent_info_hash: (await tc.sha1(rootTopic)).slice(0, 20),
    room_token_plaintext: `${libName}:${APP_ID}:${roomId}`,
    room_token: roomToken,
    peers,
  }

  // Trystero's "sha1": SHA-1, then each byte as unpadded lowercase base36.
  const sha1 = []
  for (const input of ['', 'abc', rootPlain]) {
    sha1.push({ input, digest: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(input)))), base36: await tc.sha1(input) })
  }

  // The signal cipher. Key = SHA-256("<password>:<appId>:<roomId>"), raw, no
  // salt and no PBKDF2; IV 16 bytes; wire = decimal IV bytes joined by ",",
  // then "$", then base64(ciphertext || tag).
  const keyBytes = await sha256(enc.encode(`${password}:${APP_ID}:${roomId}`))
  const aes = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const sdp = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuvwx\r\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n'
  const candidate = JSON.stringify({ candidate: 'candidate:1 1 UDP 2122317823 127.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' })
  const signals = []
  for (const [why, plaintext, ivSeed] of [['an offer SDP', sdp, 0], ['an ICE candidate, as Nostr trickles it', candidate, 100], ['an empty string', '', 200]]) {
    const iv = Uint8Array.from({ length: 16 }, (_, i) => (Number(ivSeed) + i * 17) & 0xff)
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(String(plaintext))))
    signals.push({ why, iv: hex(iv), plaintext, wire: `${iv.join(',')}$${Buffer.from(ct).toString('base64')}` })
  }

  // The password handshake, driven through Trystero's own module from the
  // responder's side: the lower ID challenges, the other answers.
  const challenge = 'abcdefghijklmnopqrstuvwxyz0123456789'
  /** @type {unknown} */
  let response
  await createPasswordHandshake(password, APP_ID, roomId).run(
    async (/** @type {unknown} */ data) => { response = data },
    async () => ({ data: { __trystero_pw: 'challenge', c: challenge } }),
    false,
  )
  const handshake = {
    initiator: ids[0],
    challenge_message: { __trystero_pw: 'challenge', c: challenge },
    response_message: response,
    response_plaintext: `${challenge}:${password}:${APP_ID}:${roomId}`,
    ready_payload: '',
  }

  // The action wire, from Trystero's own sender.
  const { wire, sent } = actionWire()
  /** @type {Array<[string, Bytes | unknown, unknown?]>} */
  const sends = [
    ['ecdh', 'BPublicKeyAsBase64urlGoesHere'],
    ['ecdh', 'a second send on one action: the nonce advances'],
    ['@_hsdata', { __trystero_pw: 'challenge', c: challenge }],
    ['@_hsready', ''],
    ['@_leave', ''],
    ['json', { n: 1, s: 'ünïcødé', a: [true, null] }],
    ['json', 42],
    ['frame', mod251(30)],
    ['frame', mod251(16348 + 10), undefined],
    ['frame', new Uint8Array()],
    ['meta', 'with metadata', { name: 'x' }],
    ['abcdefghijklmnopqrstuvwxyz012345', 'a 32-byte action name, the longest allowed'],
  ]
  const actions = []
  for (const [action, data, meta] of sends) {
    const before = sent.length
    await wire.makeInternalAction(action).send(data, 'peer', meta)
    const chunks = sent.slice(before)
    const large = data instanceof Uint8Array && data.length > 64
    actions.push({
      action,
      payload: data instanceof Uint8Array ? { binary: large ? { mod251: data.length } : hex(/** @type {Bytes} */ (data)) } : { json: data },
      ...(meta === undefined ? {} : { metadata: meta }),
      chunks: await Promise.all(chunks.map(async c => large
        ? { header: hex(c.subarray(0, 36)), length: c.length, sha256: hex(await sha256(c)) }
        : { hex: hex(c) })),
    })
  }

  // The room frame and the presence frame, from SharedPeerManager.
  const framer = roomFramer(APP_ID, roomId, roomToken)
  await framer.ready
  const inner = /** @type {Bytes} */ (sent[0])
  const room = {
    data: { inner: hex(inner), frame: hex(framer.wrap(inner)) },
    presence: [true, false].map(present => ({ present, frame: hex(framer.presence(present)) })),
  }

  // A Nostr event as Trystero builds one, with everything random fixed.
  const nostrKey = await labelled('nostr key')
  const pubkey = toHex(schnorr.getPublicKey(nostrKey))
  const event = { kind: topics.nostr_kind_root, tags: [['x', rootTopic]], created_at: 1760000000, content: JSON.stringify({ peerId: ids[1] }), pubkey }
  const serialised = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const id = await sha256(enc.encode(serialised))
  const sig = await schnorr.signAsync(id, nostrKey, new Uint8Array(32))
  const nostr = {
    secret_key: hex(nostrKey),
    aux_rand: hex(new Uint8Array(32)),
    id_preimage: serialised,
    message: JSON.stringify(['EVENT', { ...event, id: hex(id), sig: hex(sig) }]),
  }

  return {
    about: `Trystero ${TRYSTERO_VERSION}'s wire as qrdrop uses it, computed by Trystero's own modules wherever they can be driven with fixed inputs (see scripts/make-vectors.mjs). room_id and password are the first secret vector's topic and password. Recorded live traffic is in trystero-recording.json.`,
    trystero_version: TRYSTERO_VERSION,
    password,
    topics,
    sha1,
    signal: { key: hex(keyBytes), key_plaintext: `${password}:${APP_ID}:${roomId}`, iv_bytes: 16, cases: signals },
    handshake,
    action_wire: { header_bytes: 36, max_payload_bytes: 16348, cases: actions },
    room_frame: room,
    nostr_event: nostr,
  }
}

// --- assembly ----------------------------------------------------------------

/**
 * Every vector file, keyed by name. Exported so test/vectors.test.mjs can
 * rebuild them and compare against what is committed.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function buildVectors() {
  const secret = await secretVectors()
  const session = await sessionVectors()
  const first = secret.derive[2]
  return {
    'secret.json': secret,
    'session.json': session.vectors,
    'frames.json': await frameVectors(session.first, session.firstKeys),
    'digest.json': await digestVectors(),
    'trystero.json': await trysteroVectors(first.topic, first.password),
  }
}

/** @param {unknown} value */
export const serialise = value => `${JSON.stringify(value, null, 2)}\n`

async function main() {
  const check = process.argv.includes('--check')
  const files = await buildVectors()
  await mkdir(OUT, { recursive: true })
  let stale = 0
  for (const [name, value] of Object.entries(files)) {
    const url = new URL(name, OUT)
    const text = serialise(value)
    if (check) {
      const current = await readFile(url, 'utf8').catch(() => null)
      if (current !== text) { stale++; console.error(`stale: test/vectors/${name}`) }
    } else {
      await writeFile(url, text)
      console.log(`wrote test/vectors/${name}`)
    }
  }
  if (stale) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()

export { fixedKeypair, fromHex, mod251 }
