/**
 * Order-sensitive rolling digest over a file's plaintext, shared by both ends.
 *
 * WebCrypto has no streaming digest, so hashing a whole file in one call would
 * mean holding it entirely in memory -- the exact thing chunking exists to
 * avoid. Chaining per-chunk hashes keeps memory flat regardless of file size.
 *
 * The chain is a belt-and-braces check. Per-chunk AEAD plus the authenticated
 * end-of-file flag already make undetected corruption or truncation infeasible;
 * this catches the class of bug those cannot, namely our own code reassembling
 * correctly-sealed chunks in the wrong order or dropping one.
 */

/** @type {(bytes: Bytes) => Promise<Bytes>} */
const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

/** @returns {Bytes} */
export const EMPTY_CHAIN = () => new Uint8Array(32)

/**
 * @param {Bytes} previous
 * @param {Bytes} chunk
 * @returns {Promise<Bytes>}
 */
export async function chainHash(previous, chunk) {
  const joined = new Uint8Array(64)
  joined.set(previous, 0)
  joined.set(await sha256(chunk), 32)
  return sha256(joined)
}

/** @type {(bytes: Bytes) => string} */
export const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

/**
 * Constant-time comparison, so digest checking cannot be turned into an oracle.
 *
 * `b` is typed as unknown rather than string on purpose: it is whatever the
 * peer put in the `digest` field, and the typeof guards below are load-bearing
 * rather than defensive clutter.
 *
 * @param {string} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
