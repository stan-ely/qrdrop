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
 * What actually goes in the QR image when there is nowhere for the QR to send
 * a stranger's camera. ~43 chars, trivially small for a QR.
 * @param {Bytes} secret
 * @returns {string}
 */
export function encodeSecret(secret) {
  return `qrdrop:${toBase64url(secret)}`
}

/**
 * The URL form: what lets a phone's built-in camera app actually do something
 * with the code, instead of the bare `qrdrop:` string above, which no camera
 * app treats as an openable link. Scanning it just opens the page, which is
 * where the web component picks the code back up (see element.js's
 * `location.hash` handling).
 *
 * The code goes in the URL's FRAGMENT, not a query parameter, and that choice
 * is load-bearing: a fragment is the one part of a URL a browser never
 * includes in the HTTP request it sends to the server. Putting the secret in
 * `?code=...` instead would still "work" -- and would silently start leaking
 * it to whatever serves that origin, plus every proxy and access log along
 * the way. `decodeSecret` below enforces the same rule on the way back in.
 *
 * @param {Bytes} secret
 * @param {string} baseURL Must be an absolute http(s) URL. Any existing
 *   fragment or query on it is discarded -- the code is the only thing that
 *   belongs there.
 * @returns {string}
 */
export function encodeSecretURL(secret, baseURL) {
  let url
  try {
    url = new URL(baseURL)
  } catch {
    throw new Error('base-url must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base-url must be an absolute http(s) URL')
  }
  url.hash = ''
  url.search = ''
  return `${url.toString()}#${encodeSecret(secret)}`
}

// Shared by both decodeSecret branches: turn a 43-char base64url code into
// the underlying bytes, validating length. Wrong length means truncation or
// corruption somewhere upstream -- silently accepting it would hand a short
// or padded key straight to HKDF.
/**
 * @param {string} code
 * @returns {Bytes}
 */
function decodeCode(code) {
  const bytes = fromBase64url(code)
  if (bytes.length !== SECRET_BYTES) throw new Error('Malformed qrdrop code — expected 32 bytes of key, base64url-encoded')
  return bytes
}

const CODE_RE = /^qrdrop:([A-Za-z0-9_-]{43})$/

/**
 * @param {string} text Untrusted: this is whatever the camera decoded.
 * @returns {Bytes}
 */
export function decodeSecret(text) {
  const trimmed = text.trim()

  // The bare form, unchanged. This is what CLI<->browser interop depends on
  // (e2e/interop.e2e.mjs) -- the CLI never gained a web page to point a URL
  // form at, so it always emits this, and this branch must keep accepting it
  // forever regardless of what the URL form below grows into.
  const bare = CODE_RE.exec(trimmed)
  if (bare) return decodeCode(bare[1])

  // The URL form. Only http(s) URLs are considered -- anything else (a bare
  // string that happens to parse as some other URL scheme, garbage, etc.)
  // falls through to the generic error below.
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Not a qrdrop code — expected qrdrop:… or a link with #qrdrop:… in it')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Not a qrdrop code — expected qrdrop:… or a link with #qrdrop:… in it')
  }

  // The code must live in the fragment. A fragment is the one part of a URL
  // that is never sent to the server in the HTTP request, which is the whole
  // reason this format is safe to put a decryption key in: the secret still
  // never leaves the device, exactly as with the bare form. Accepting the
  // code out of the query string or path would quietly throw that property
  // away for anyone who constructs -- or is tricked into scanning -- such a
  // URL, so that case gets its own error rather than falling through
  // silently to "Not a qrdrop code".
  const fragment = CODE_RE.exec(url.hash.slice(1))
  if (fragment) return decodeCode(fragment[1])

  if (/qrdrop:[A-Za-z0-9_-]+/.test(url.search) || /qrdrop:[A-Za-z0-9_-]+/.test(url.pathname)) {
    throw new Error('qrdrop code must be in the URL fragment (after #), not the query string or path')
  }

  throw new Error('Not a qrdrop code — expected qrdrop:… or a link with #qrdrop:… in it')
}
