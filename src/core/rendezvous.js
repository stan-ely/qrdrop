/**
 * The offline rendezvous: two devices with no route to the relays, one of
 * them listening at the address in its QR (docs/notes/offline-pairing.md).
 *
 * WHY THE CODE IS PROVED BEFORE ANYTHING LATCHES:
 * in the relay room a stranger cannot even find the room without the code --
 * the topic and the password both derive from it. A listening socket has no
 * such property: anyone on the Wi-Fi can port-scan it and connect first. A
 * listener that latched onto the first public key to arrive would let that
 * stranger force a SAS mismatch, which ends the session and spends its one
 * roll, from someone who never held the code. The relay path has no such
 * denial of service, so this must not add one. Each message here therefore
 * carries an HMAC under a key only a holder of the code has, and a listener
 * answers nothing it has not checked.
 *
 * The four messages, each one WebSocket binary message of fixed length:
 *
 *   1. listener -> dialler  hello   n                          16 bytes
 *   2. dialler -> listener  dial    D || HMAC("dial" || n || D)       97
 *   3. listener -> dialler  listen  L || HMAC("listen" || n || D || L) 97
 *   4. dialler -> listener  ok      HMAC("ok" || n || D || L)          32
 *
 * n is a fresh nonce, D and L the two ephemeral P-256 public keys (raw,
 * uncompressed), and the HMAC is SHA-256 keyed by deriveRendezvousKey.
 * After `ok`, both ends call the same establishSession the room path calls,
 * with the listener as host, so the keys and the SAS come out of exactly the
 * derivation test/vectors/session.json already pins.
 *
 * - The nonce stops a hello sniffed from an earlier connection being
 *   replayed to latch: a MAC is only good for the connection whose nonce it
 *   covers.
 * - The MACs cover both public keys, so someone on the path without the code
 *   cannot substitute either. That is stronger than the relay path, where a
 *   substitution is something only the SAS catches.
 * - The labels differ per message, so no message can be reflected back as
 *   another. Every field is fixed-length, so the concatenations cannot be
 *   re-split into a different reading.
 *
 * The open* functions answer `null` or `false` for anything that does not
 * verify, never throw: a listener drops a stranger and keeps waiting, and a
 * stranger is the expected case on a shared network rather than an error.
 * The comparison is crypto.subtle.verify's, which is constant-time; a
 * hand-written byte compare is the tempting shortcut and leaks how much of a
 * guessed MAC was right.
 */

import { deriveRendezvousKey } from './secret.js'

export const NONCE_BYTES = 16
export const PUBLIC_KEY_BYTES = 65
export const MAC_BYTES = 32
/** The dial and listen messages: a public key and its MAC. */
export const KEYED_BYTES = PUBLIC_KEY_BYTES + MAC_BYTES

const enc = new TextEncoder()
const DIAL = enc.encode('dial')
const LISTEN = enc.encode('listen')
const OK = enc.encode('ok')

/** @returns {Bytes} */
export function createNonce() {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
}

/**
 * The HMAC key, non-extractable.
 * @param {Bytes} secret
 * @returns {Promise<CryptoKey>}
 */
export async function rendezvousKey(secret) {
  return crypto.subtle.importKey('raw', await deriveRendezvousKey(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/**
 * @param {...Bytes} parts
 * @returns {Bytes}
 */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/**
 * @param {CryptoKey} key
 * @param {Bytes} data
 * @returns {Promise<Bytes>}
 */
async function mac(key, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
}

/**
 * @param {Bytes} bytes
 * @param {number} length
 */
function checkLength(bytes, length) {
  if (bytes.length !== length) throw new RangeError(`expected ${length} bytes, got ${bytes.length}`)
}

/**
 * Message 2, the dialler's key and its proof of the code.
 * @param {CryptoKey} key
 * @param {Bytes} nonce
 * @param {Bytes} dialPublic
 * @returns {Promise<Bytes>}
 */
export async function sealDial(key, nonce, dialPublic) {
  checkLength(nonce, NONCE_BYTES)
  checkLength(dialPublic, PUBLIC_KEY_BYTES)
  return concat(dialPublic, await mac(key, concat(DIAL, nonce, dialPublic)))
}

/**
 * The listener's check of message 2: the dialler's public key, or `null` for
 * anyone who does not hold the code.
 * @param {CryptoKey} key
 * @param {Bytes} nonce
 * @param {Bytes} message
 * @returns {Promise<Bytes | null>}
 */
export async function openDial(key, nonce, message) {
  if (message.length !== KEYED_BYTES) return null
  const dialPublic = message.slice(0, PUBLIC_KEY_BYTES)
  const tag = message.slice(PUBLIC_KEY_BYTES)
  const ok = await crypto.subtle.verify('HMAC', key, tag, concat(DIAL, nonce, dialPublic))
  return ok ? dialPublic : null
}

/**
 * Message 3, the listener's key, bound to the dialler's.
 * @param {CryptoKey} key
 * @param {Bytes} nonce
 * @param {Bytes} dialPublic
 * @param {Bytes} listenPublic
 * @returns {Promise<Bytes>}
 */
export async function sealListen(key, nonce, dialPublic, listenPublic) {
  checkLength(nonce, NONCE_BYTES)
  checkLength(dialPublic, PUBLIC_KEY_BYTES)
  checkLength(listenPublic, PUBLIC_KEY_BYTES)
  return concat(listenPublic, await mac(key, concat(LISTEN, nonce, dialPublic, listenPublic)))
}

/**
 * The dialler's check of message 3: the listener's public key, or `null`.
 * @param {CryptoKey} key
 * @param {Bytes} nonce
 * @param {Bytes} dialPublic
 * @param {Bytes} message
 * @returns {Promise<Bytes | null>}
 */
export async function openListen(key, nonce, dialPublic, message) {
  if (message.length !== KEYED_BYTES) return null
  const listenPublic = message.slice(0, PUBLIC_KEY_BYTES)
  const tag = message.slice(PUBLIC_KEY_BYTES)
  const ok = await crypto.subtle.verify('HMAC', key, tag, concat(LISTEN, nonce, dialPublic, listenPublic))
  return ok ? listenPublic : null
}

/**
 * Message 4: the dialler has the listener's key and agrees on all of it.
 * @param {CryptoKey} key
 * @param {Bytes} nonce
 * @param {Bytes} dialPublic
 * @param {Bytes} listenPublic
 * @returns {Promise<Bytes>}
 */
export async function sealOk(key, nonce, dialPublic, listenPublic) {
  checkLength(nonce, NONCE_BYTES)
  checkLength(dialPublic, PUBLIC_KEY_BYTES)
  checkLength(listenPublic, PUBLIC_KEY_BYTES)
  return mac(key, concat(OK, nonce, dialPublic, listenPublic))
}

/**
 * The listener's check of message 4. Only after this may it show a SAS.
 * @param {CryptoKey} key
 * @param {Bytes} nonce
 * @param {Bytes} dialPublic
 * @param {Bytes} listenPublic
 * @param {Bytes} message
 * @returns {Promise<boolean>}
 */
export async function openOk(key, nonce, dialPublic, listenPublic, message) {
  if (message.length !== MAC_BYTES) return false
  return crypto.subtle.verify('HMAC', key, message, concat(OK, nonce, dialPublic, listenPublic))
}
