/**
 * Per-session key agreement: ephemeral ECDH, authenticated by the QR secret.
 *
 * WHY ECDH ON TOP OF A SHARED SECRET WE ALREADY HAVE:
 * forward secrecy. The QR secret alone could decrypt everything, so a code
 * photographed off a screen -- or recovered from a screenshot months later --
 * would retroactively open every transfer made with it. The ephemeral keypairs
 * here exist only in memory for one session, so past transfers stay closed even
 * if the secret leaks afterwards.
 *
 * WHY P-256 AND NOT X25519:
 * this file deliberately uses nothing but WebCrypto. X25519 is well supported
 * now and is the nicer curve, but reaching it in-browser means either a
 * userland implementation or a newer-baseline assumption, and P-256's security
 * margin is entirely adequate here. The payoff is that the *confidentiality*
 * path has zero third-party code in it. The one crypto dependency this project
 * does carry (@noble/secp256k1, for signing Nostr transport events) sits
 * strictly outside this boundary: if it were ever backdoored it could disrupt
 * or deanonymise signalling, but it could not read a single file byte.
 */

const enc = new TextEncoder()

/**
 * @returns {Promise<CryptoKeyPair>}
 */
export async function createEphemeralKeypair() {
  // Non-extractable: the private key cannot be read back out by any later code
  // on the page. WebCrypto always leaves the public half exportable.
  //
  // generateKey's return type is CryptoKey | CryptoKeyPair because the same
  // call produces either depending on the algorithm; ECDH always yields a
  // pair, which the checker cannot know from the object literal alone.
  return /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  )
}

/**
 * @param {CryptoKeyPair} keypair
 * @returns {Promise<Bytes>} The raw uncompressed P-256 point, 65 bytes.
 */
export async function exportPublicKey(keypair) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey))
}

/**
 * @param {Bytes} raw Untrusted: this arrived from the peer.
 * @returns {Promise<CryptoKey>}
 */
async function importPeerKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

/**
 * Both sides must hash the two public keys in the same order. Sorting them
 * bytewise gets that without either side needing to agree on who is who, and
 * pins the derived key to this exact pair of keys -- an attacker who replays a
 * public key from another session lands on a different transcript and derives
 * a different, useless key.
 *
 * @param {Bytes} a
 * @param {Bytes} b
 * @returns {Promise<Bytes>}
 */
async function transcriptHash(a, b) {
  const [x, y] = compare(a, b) <= 0 ? [a, b] : [b, a]
  const joined = new Uint8Array(x.length + y.length)
  joined.set(x, 0)
  joined.set(y, x.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', joined))
}

/**
 * @param {Bytes} a
 * @param {Bytes} b
 * @returns {number}
 */
function compare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * One HKDF step, producing either raw bits or an AES-GCM key.
 *
 * OVERLOADED ON `usage` DELIBERATELY. This function is the one place in the
 * codebase that returns key material as two different kinds of thing, and
 * confusing them is not a loud failure -- a CryptoKey where bytes were wanted
 * stringifies to "[object CryptoKey]" and a comparison quietly succeeds or
 * quietly fails. Splitting the signature makes the checker pick the right one
 * from the literal at each call site.
 *
 * @overload
 * @param {Bytes} sharedBits
 * @param {Bytes} secret
 * @param {string} label
 * @param {Bytes} transcript
 * @param {'bits'} usage
 * @returns {Promise<Bytes>}
 */
/**
 * @overload
 * @param {Bytes} sharedBits
 * @param {Bytes} secret
 * @param {string} label
 * @param {Bytes} transcript
 * @param {'key'} usage
 * @returns {Promise<CryptoKey>}
 */
/**
 * @param {Bytes} sharedBits
 * @param {Bytes} secret HKDF salt -- this is what authenticates the exchange.
 * @param {string} label
 * @param {Bytes} transcript
 * @param {'bits' | 'key'} usage
 * @returns {Promise<Bytes | CryptoKey>}
 */
async function derive(sharedBits, secret, label, transcript, usage) {
  const ikm = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits', 'deriveKey'])
  const info = new Uint8Array(enc.encode(label).length + transcript.length)
  info.set(enc.encode(label), 0)
  info.set(transcript, enc.encode(label).length)
  const params = { name: 'HKDF', hash: 'SHA-256', salt: secret, info }
  return usage === 'bits'
    ? new Uint8Array(await crypto.subtle.deriveBits(params, ikm, 32))
    : crypto.subtle.deriveKey(params, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/**
 * Derives directional keys plus the short authentication string.
 *
 * Separate send/recv keys mean the two directions never share a nonce space,
 * so neither peer has to coordinate counters with the other to stay safe.
 *
 * The QR secret goes in as the HKDF salt, which is what makes this an
 * *authenticated* exchange: an attacker who could somehow inject their own
 * public key still cannot land on the same key without the secret.
 *
 * `role` is 'host' for the peer that generated the QR, 'guest' for the scanner.
 *
 * @param {object} args
 * @param {CryptoKeyPair} args.keypair
 * @param {Bytes} args.peerPublicRaw Untrusted: straight off the relay.
 * @param {Bytes} args.secret The QR secret, used here as the HKDF salt.
 * @param {'host' | 'guest'} args.role
 * @returns {Promise<SessionKeys>}
 */
export async function establishSession({ keypair, peerPublicRaw, secret, role }) {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importPeerKey(peerPublicRaw) },
      keypair.privateKey,
      256,
    ),
  )
  const transcript = await transcriptHash(await exportPublicKey(keypair), peerPublicRaw)

  const hostKey = await derive(shared, secret, 'host->guest', transcript, 'key')
  const guestKey = await derive(shared, secret, 'guest->host', transcript, 'key')
  const sasBytes = await derive(shared, secret, 'sas', transcript, 'bits')
  const { sas, sasWords } = renderSAS(sasBytes)

  return {
    sendKey: role === 'host' ? hostKey : guestKey,
    recvKey: role === 'host' ? guestKey : hostKey,
    sas,
    sasWords,
  }
}

// Visually distinct, describable out loud, no near-duplicate pairs. Each
// entry is [emoji, name]; the name exists so two people on a phone call can
// read the SAS aloud and agree on it without staring at the same screen --
// "cactus" is unambiguous over a bad connection in a way that trying to
// describe a small green emoji is not. The same "no near-duplicates" rule
// applies to the names themselves: no two are near-homophones (nothing like
// "whale"/"wale", no two names sharing a first syllable), since a pair that
// sounds alike read aloud defeats the point as thoroughly as two emoji that
// look alike on screen.
//
// Exported so tests can check sas and sasWords line up positionally without
// keeping a second copy of this table.
/** @type {ReadonlyArray<[string, string]>} */
export const SAS_EMOJI = [
  ['🍎', 'apple'], ['🐝', 'bee'], ['🌵', 'cactus'], ['🐬', 'dolphin'],
  ['🐘', 'elephant'], ['🔥', 'fire'], ['👻', 'ghost'], ['🍄', 'mushroom'],
  ['🧊', 'ice'], ['🔑', 'key'], ['🍋', 'lemon'], ['🌙', 'moon'],
  ['🦉', 'owl'], ['🐙', 'octopus'], ['🌴', 'palm'], ['👑', 'crown'],
  ['🌈', 'rainbow'], ['🐍', 'snake'], ['🌻', 'sunflower'], ['🌮', 'taco'],
  ['🦄', 'unicorn'], ['🌊', 'wave'], ['⌛', 'hourglass'], ['🦓', 'zebra'],
  ['⚓', 'anchor'], ['🎈', 'balloon'], ['🕯️', 'candle'], ['💎', 'diamond'],
  ['🥚', 'egg'], ['🎸', 'guitar'], ['🔨', 'hammer'], ['🧲', 'magnet'],
  ['🎺', 'trumpet'], ['🪐', 'saturn'], ['🧩', 'puzzle'], ['🚀', 'rocket'],
  ['✂️', 'scissors'], ['💀', 'skull'], ['🔭', 'telescope'], ['🌪️', 'tornado'],
  ['🧵', 'thread'], ['🚂', 'train'], ['☂️', 'umbrella'], ['🎻', 'violin'],
  ['⚡', 'lightning'], ['🪓', 'axe'], ['🧶', 'yarn'], ['🦴', 'bone'],
  ['🏹', 'arrow'], ['🧱', 'brick'], ['🕰️', 'clock'], ['🍩', 'donut'],
  ['🥁', 'drum'], ['🪶', 'feather'], ['🍇', 'grapes'], ['🔔', 'bell'],
  ['🪁', 'kite'], ['🍿', 'popcorn'], ['🎯', 'target'], ['🧭', 'compass'],
  ['🪞', 'mirror'], ['🧪', 'flask'], ['🌡️', 'thermometer'], ['🪄', 'wand'],
]

/**
 * 4 emoji out of 64 = 24 bits. Both peers must see the same four, in order.
 * @param {Bytes} bytes
 * @returns {{ sas: string, sasWords: string[] }}
 */
function renderSAS(bytes) {
  const picked = [0, 1, 2, 3].map(i => SAS_EMOJI[bytes[i] & 0x3f])
  return {
    sas: picked.map(([emoji]) => emoji).join(' '),
    sasWords: picked.map(([, name]) => name),
  }
}
