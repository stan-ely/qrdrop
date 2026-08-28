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

export async function createEphemeralKeypair() {
  // Non-extractable: the private key cannot be read back out by any later code
  // on the page. WebCrypto always leaves the public half exportable.
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}

export async function exportPublicKey(keypair) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey))
}

async function importPeerKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

/**
 * Both sides must hash the two public keys in the same order. Sorting them
 * bytewise gets that without either side needing to agree on who is who, and
 * pins the derived key to this exact pair of keys -- an attacker who replays a
 * public key from another session lands on a different transcript and derives
 * a different, useless key.
 */
async function transcriptHash(a, b) {
  const [x, y] = compare(a, b) <= 0 ? [a, b] : [b, a]
  const joined = new Uint8Array(x.length + y.length)
  joined.set(x, 0)
  joined.set(y, x.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', joined))
}

function compare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

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

  return {
    sendKey: role === 'host' ? hostKey : guestKey,
    recvKey: role === 'host' ? guestKey : hostKey,
    sas: renderSAS(sasBytes),
  }
}

// Visually distinct, describable out loud, no near-duplicate pairs.
const SAS_EMOJI = [
  '🍎', '🐝', '🌵', '🐬', '🐘', '🔥', '👻', '🍄', '🧊', '🔑', '🍋', '🌙',
  '🦉', '🐙', '🌴', '👑', '🌈', '🐍', '🌻', '🌮', '🦄', '🌊', '⌛', '🦓',
  '⚓', '🎈', '🕯️', '💎', '🥚', '🎸', '🔨', '🧲', '🎺', '🪐', '🧩', '🚀',
  '✂️', '💀', '🔭', '🌪️', '🧵', '🚂', '☂️', '🎻', '⚡', '🪓', '🧶', '🦴',
  '🏹', '🧱', '🕰️', '🍩', '🥁', '🪶', '🍇', '🔔', '🪁', '🍿', '🎯', '🧭',
  '🪞', '🧪', '🌡️', '🪄',
]

/** 4 emoji out of 64 = 24 bits. Both peers must see the same four, in order. */
function renderSAS(bytes) {
  return [0, 1, 2, 3].map(i => SAS_EMOJI[bytes[i] & 0x3f]).join(' ')
}
