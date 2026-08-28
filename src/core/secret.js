/**
 * The QR secret and everything derived from it.
 *
 * The QR code carries 32 bytes of CSPRNG output. That is a full-entropy key,
 * not a human-typed passphrase, which is why this file contains no PAKE
 * (SPAKE2 / OPAQUE). Those exist to stretch low-entropy secrets safely; a
 * 256-bit secret needs only a KDF.
 *
 * Nothing derived here is ever used raw. The secret itself never leaves the
 * device -- only values HKDF'd out of it, under distinct `info` labels so that
 * no two purposes can ever collide.
 */

const SECRET_BYTES = 32
const TOPIC_BYTES = 16

// Domain separation salt. Fixed and public; its job is to make these
// derivations meaningless outside this protocol version, not to be secret.
const SALT = new TextEncoder().encode('qrdrop/v1')

const enc = new TextEncoder()

export function generateSecret() {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
}

/**
 * @param {Bytes} secret
 * @param {string} info Domain-separation label. Two purposes must never share one.
 * @param {number} byteLength
 * @returns {Promise<Bytes>}
 */
async function hkdf(secret, info, byteLength) {
  const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) },
    ikm,
    byteLength * 8,
  )
  return new Uint8Array(bits)
}

/**
 * Public rendezvous ID -- the room name peers meet on.
 *
 * This is deliberately NOT the secret itself. Using the raw secret as the room
 * ID is the obvious shortcut and it silently publishes your key to every relay
 * on the network; it works perfectly in testing, which is what makes it
 * dangerous. HKDF gives a value that identifies the session without revealing
 * anything that decrypts it.
 *
 * `epoch` supports a future persistent-pairing mode (reuse one QR across
 * sessions), where the topic must rotate on a timer or a relay operator could
 * link every transfer that pair ever makes. In the default flow the secret is
 * freshly generated per session, so the topic is already unlinkable and epoch
 * stays null.
 *
 * @param {Bytes} secret
 * @param {number | null} epoch
 * @returns {Promise<string>} base64url, 16 bytes' worth.
 */
export async function deriveTopic(secret, epoch = null) {
  const info = epoch === null ? 'topic' : `topic/${epoch}`
  return toBase64url(await hkdf(secret, info, TOPIC_BYTES))
}

/**
 * The password Trystero uses to encrypt session descriptions.
 *
 * Returned as a string because that is what Trystero's config takes; it hands
 * it to PBKDF2 internally. The entropy is ours either way -- this is 256 bits
 * of HKDF output, not a passphrase -- so the stretching is redundant rather
 * than load-bearing.
 *
 * Trystero without a password derives its key from the app ID and room name,
 * both of which any relay observer already has. That would leave the DTLS
 * fingerprint substitutable in transit, so this is not optional.
 *
 * Note the return type: a STRING, not a CryptoKey. Trystero's config field
 * takes the password and stretches it itself, so handing it key material
 * straight from WebCrypto is a type error rather than a subtle failure.
 *
 * @param {Bytes} secret
 * @returns {Promise<string>}
 */
export async function derivePassword(secret) {
  return toBase64url(await hkdf(secret, 'signal', 32))
}

/**
 * @param {Bytes} bytes
 * @returns {string}
 */
export function toBase64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * @param {string} str
 * @returns {Bytes}
 */
export function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

/**
 * What actually goes in the QR image. ~43 chars, trivially small for a QR.
 * @param {Bytes} secret
 * @returns {string}
 */
export function encodeSecret(secret) {
  return `qrdrop:${toBase64url(secret)}`
}

/**
 * @param {string} text Untrusted: this is whatever the camera decoded.
 * @returns {Bytes}
 */
export function decodeSecret(text) {
  const m = /^qrdrop:([A-Za-z0-9_-]{43})$/.exec(text.trim())
  if (!m) throw new Error('Not a qrdrop code')
  const bytes = fromBase64url(m[1])
  if (bytes.length !== SECRET_BYTES) throw new Error('Malformed qrdrop code')
  return bytes
}
