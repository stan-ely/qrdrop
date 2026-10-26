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
 * Returned as a string because that is what Trystero's config takes. Trystero
 * 0.25.4 does not stretch it: its signal key is one SHA-256 of
 * `<password>:<appId>:<roomId>`, imported raw as an AES-256-GCM key, with no
 * salt and no iterations, and each signal is sealed under a fresh 16-byte IV
 * (core/dist/crypto.mjs). These comments said PBKDF2 until 2026-10-17, and
 * nothing here ever depended on it: all of the strength is ours, because this
 * is 256 bits of HKDF output rather than a passphrase, which is exactly the
 * case where a single hash is enough. A Rust peer has to reproduce the hash,
 * not a key-stretching function (crates/tryst/vectors/trystero.json).
 *
 * Trystero without a password derives its key from the app ID and room name,
 * both of which any relay observer already has. That would leave the DTLS
 * fingerprint substitutable in transit, so this is not optional.
 *
 * Note the return type: a STRING, not a CryptoKey. Trystero's config field
 * takes the password and hashes it into a key itself, so handing it key
 * material straight from WebCrypto is a type error rather than a subtle
 * failure.
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
 * @param {Locator | null} [locator] Nothing passes one yet: every decoder in a
 *   release has to accept it before anything emits it.
 * @returns {string}
 */
export function encodeSecret(secret, locator = null) {
  const code = `qrdrop:${toBase64url(secret)}`
  return locator ? `${code}.${encodeLocator(locator)}` : code
}

// The one locator layout so far. A decoder ignores any other version rather
// than refusing it, which is what lets the layout grow: a code from a newer
// device still pairs over the relays with an older one.
const LOCATOR_V1 = 1
const MAX_LOCATOR_ADDRESSES = 4

/**
 * Where the code's own device is listening on the local network, for pairing
 * with no route to the relays (docs/notes/offline-pairing.md). It is not
 * secret and authenticates nothing: whoever answers at it still has to prove
 * the code before anything latches.
 *
 * @typedef {{ port: number, addresses: string[] }} Locator
 */

/**
 * A version byte, the port big-endian, then one to four IPv4 addresses: 10 to
 * 26 base64url characters after the `.`.
 * @param {Locator} locator
 * @returns {string}
 */
function encodeLocator({ port, addresses }) {
  if (!Number.isInteger(port) || port < 1 || port > 0xffff) throw new Error(`Locator port out of range: ${port}`)
  if (addresses.length < 1 || addresses.length > MAX_LOCATOR_ADDRESSES) {
    throw new Error(`A locator carries 1 to ${MAX_LOCATOR_ADDRESSES} addresses, not ${addresses.length}`)
  }
  const bytes = [LOCATOR_V1, port >> 8, port & 0xff]
  for (const address of addresses) {
    const octets = address.split('.').map(Number)
    if (octets.length !== 4 || !octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255) || !/^[0-9.]+$/.test(address)) {
      throw new Error(`Not an IPv4 address: ${address}`)
    }
    bytes.push(...octets)
  }
  return toBase64url(Uint8Array.from(bytes))
}

/**
 * The locator's bytes, or null for a version this build does not know.
 *
 * A known version that does not parse is an error rather than ignored. Our own
 * encoder cannot produce one, so it means the code was damaged on the way here,
 * and a code damaged in one place is not one to trust the rest of.
 * @param {string} text
 * @returns {Locator | null}
 */
function decodeLocator(text) {
  let bytes
  try {
    bytes = fromBase64url(text)
  } catch {
    // atob refuses a length that is 1 mod 4: no whole byte in the last group.
    throw new Error(MALFORMED_LOCATOR)
  }
  if (bytes[0] !== LOCATOR_V1) return null
  const count = (bytes.length - 3) / 4
  const port = (bytes[1] << 8) | bytes[2]
  if (!Number.isInteger(count) || count < 1 || count > MAX_LOCATOR_ADDRESSES || port === 0) {
    throw new Error(MALFORMED_LOCATOR)
  }
  const addresses = []
  for (let i = 3; i < bytes.length; i += 4) addresses.push(Array.from(bytes.subarray(i, i + 4)).join('.'))
  return { port, addresses }
}

const MALFORMED_LOCATOR = 'Malformed qrdrop code — the part after the key is damaged'

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

// The key, then optionally `.` and a locator. `.` is outside the base64url
// alphabet, so the 43 characters of key stay unambiguous with one after them.
/**
 * @param {RegExpExecArray} match Of CODE_RE.
 * @returns {{ secret: Bytes, locator: Locator | null }}
 */
const fromMatch = ([, code, locator]) => ({
  secret: decodeCode(code),
  locator: locator === undefined ? null : decodeLocator(locator),
})

const CODE_RE = /^qrdrop:([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]+))?$/

/**
 * @param {string} text Untrusted: this is whatever the camera decoded.
 * @returns {Bytes}
 */
export function decodeSecret(text) {
  return decodePairing(text).secret
}

/**
 * `decodeSecret`, keeping the locator if the code has one this build reads.
 * @param {string} text Untrusted: this is whatever the camera decoded.
 * @returns {{ secret: Bytes, locator: Locator | null }}
 */
export function decodePairing(text) {
  const trimmed = text.trim()

  // The bare form, unchanged. This is what CLI<->browser interop depends on
  // (e2e/interop.e2e.mjs) -- the CLI never gained a web page to point a URL
  // form at, so it always emits this, and this branch must keep accepting it
  // forever regardless of what the URL form below grows into.
  const bare = CODE_RE.exec(trimmed)
  if (bare) return fromMatch(bare)

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
  if (fragment) return fromMatch(fragment)

  if (/qrdrop:[A-Za-z0-9_-]+/.test(url.search) || /qrdrop:[A-Za-z0-9_-]+/.test(url.pathname)) {
    throw new Error('qrdrop code must be in the URL fragment (after #), not the query string or path')
  }

  throw new Error('Not a qrdrop code — expected qrdrop:… or a link with #qrdrop:… in it')
}
