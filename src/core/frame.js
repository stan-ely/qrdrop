/**
 * Wire framing and per-chunk authenticated encryption.
 *
 * Everything crossing the DataChannel is sealed here, on top of whatever DTLS
 * is doing underneath. That redundancy is the point: DTLS terminates at the
 * peer's browser and, when NAT traversal fails, the packets pass through a
 * third-party TURN relay. Sealing at the application layer under a key derived
 * from the QR secret means a relay operator sees ciphertext and volume, never
 * content -- and a DTLS-level weakness is not fatal on its own.
 *
 * AES-GCM is catastrophically brittle under nonce reuse, so nonces here are
 * constructed to be unique by counting rather than by chance:
 *
 *   nonce = fileSeq (uint32) || chunkIndex (uint64)      -- 12 bytes
 *
 * fileSeq is a monotonic per-session counter, chunkIndex is monotonic within a
 * file, and each direction has its own key (see crypto/session.js), so no pair
 * can repeat within a key. A random file ID would have been simpler but
 * reintroduces birthday collisions for no benefit.
 *
 * The 14-byte header travels in the clear -- the receiver needs it to route
 * the frame -- but is passed as AES-GCM additional authenticated data, so any
 * edit to it fails the tag. The `last` flag lives in there specifically so that
 * end-of-file is authenticated: without it, an attacker who simply stops
 * forwarding frames could pass off a truncated file as a complete one.
 *
 * Travelling in the clear is not the same as being trustworthy, and the rule
 * that keeps the difference straight is: AUTHENTICATE, THEN TRUST. Nothing
 * decides the fate of a transfer on the strength of a header until the tag has
 * proved that header came from the peer. open() below used to check ordering
 * first, and that inversion was a denial of service -- a stranger who could
 * get one packet into the rendezvous room could kill a live transfer with
 * fourteen bytes, without the code, without pairing, without ever holding a
 * key. See the comment on those checks for the failure it actually produced.
 */

export const CHUNK_SIZE = 16 * 1024 // SCTP-safe across browsers; 64 KiB is modern-only
export const HEADER_BYTES = 14
export const TAG_BYTES = 16
export const MAX_FRAME_BYTES = HEADER_BYTES + CHUNK_SIZE + TAG_BYTES

export const TYPE_CONTROL = 0
export const TYPE_CHUNK = 1

// Reserved fileSeq for control frames. Never assigned to a file, so control
// and data frames can share a key without ever sharing a nonce.
const CONTROL_SEQ = 0xffffffff

/**
 * @param {FrameHeader | (FrameExpectation & { last?: boolean })} fields
 * @returns {Bytes}
 */
export function encodeHeader({ type, fileSeq, index, last = false }) {
  const h = new Uint8Array(HEADER_BYTES)
  const view = new DataView(h.buffer)
  view.setUint8(0, type)
  view.setUint32(1, fileSeq, false)
  view.setBigUint64(5, BigInt(index), false)
  view.setUint8(13, last ? 1 : 0)
  return h
}

/**
 * @param {Bytes} bytes At least HEADER_BYTES long; callers check that first.
 * @returns {FrameHeader}
 */
export function decodeHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES)
  return {
    type: view.getUint8(0),
    fileSeq: view.getUint32(1, false),
    index: Number(view.getBigUint64(5, false)),
    last: view.getUint8(13) === 1,
  }
}

/**
 * @param {Bytes} header
 * @returns {Bytes}
 */
function nonceFor(header) {
  return header.slice(1, 13) // fileSeq || index, exactly 12 bytes
}

/**
 * Returns a single byte array ready to hand to Channel.send().
 *
 * @param {CryptoKey} key
 * @param {FrameHeader | (FrameExpectation & { last?: boolean })} headerFields
 * @param {Bytes} plaintext
 * @returns {Promise<Bytes>}
 */
export async function seal(key, headerFields, plaintext) {
  const header = encodeHeader(headerFields)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonceFor(header), additionalData: header },
      key,
      plaintext,
    ),
  )
  const frame = new Uint8Array(HEADER_BYTES + ct.length)
  frame.set(header, 0)
  frame.set(ct, HEADER_BYTES)
  return frame
}

/**
 * A frame that did not authenticate under our key.
 *
 * Its own class because the caller's response is completely different from
 * every other failure in this module: a bad tag means the bytes did not come
 * from the peer we paired with, so there is nothing to report and nothing to
 * abort -- the right answer is to drop it and carry on. Every other error
 * here is a statement about a frame that provably DID come from the peer, and
 * is worth failing loudly over.
 */
export class UnauthenticatedFrame extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super('Frame did not authenticate under the session key', { cause })
    this.name = 'UnauthenticatedFrame'
  }
}

/**
 * Opens a frame, enforcing that it is the one we expected.
 *
 * `expect` is supplied by the caller from its own tracked state rather than
 * read off the wire, so a replayed or reordered frame is refused before its
 * contents are trusted. The DataChannel is ordered and reliable, so this should
 * never trip on the network path -- it is here to catch a misbehaving peer and
 * to make any framing bug fail loudly instead of producing a corrupt file.
 *
 * @param {CryptoKey} key
 * @param {Bytes} frame Untrusted: this is exactly what the peer sent.
 * @param {FrameExpectation | null} [expect] null opens without ordering
 *   checks, leaving only the AEAD tag to catch tampering. Used by the tests,
 *   and by receiver.js to ask "is this our peer at all?" about a frame it has
 *   no expectation for.
 * @returns {Promise<FrameHeader & { plaintext: Bytes }>}
 * @throws {UnauthenticatedFrame} If the tag fails, i.e. the frame is not ours.
 */
export async function open(key, frame, expect) {
  // These two stay ahead of everything, and they are not provenance claims --
  // they are bounds checks. The first keeps a runt out of decodeHeader's
  // DataView, the second keeps an arbitrarily large buffer out of
  // crypto.subtle.decrypt, which is what stops the decrypt-first order below
  // from being an invitation to burn CPU on garbage.
  if (frame.length < HEADER_BYTES + TAG_BYTES) throw new Error('Frame too short')
  if (frame.length > MAX_FRAME_BYTES) throw new Error('Frame exceeds maximum size')

  const header = frame.slice(0, HEADER_BYTES)
  const fields = decodeHeader(header)

  // Decrypt BEFORE the ordering checks. This is the reverse of how the
  // function read for its first year, and the reversal is the whole fix.
  //
  // The nonce is derived from the header and the header is the AAD, so a
  // header we did not produce cannot pass the tag. The checks below therefore
  // learn nothing the tag has not already proved -- but running them first
  // meant a stranger's cleartext decided whether our transfer lived. Someone
  // whose frames reached a receiver sent a well-formed chunk header claiming
  // index 13877 at a receiver expecting 0, for a file under 1 MB that had
  // only ~64 chunks in it. The receiver threw "Out-of-order frame: expected
  // 0, got 13877" on bytes it could never have opened, aborted the sink, and
  // showed the user that sentence. Nothing was saved.
  //
  // The old order was chosen to avoid decrypting a frame we were going to
  // refuse anyway. What that saved was a few microseconds against a
  // size-bounded buffer; what it cost was letting an unauthenticated header
  // reach the state machine, which is precisely what sealing at this layer
  // exists to prevent.
  /** @type {Bytes} */
  let plaintext
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(header), additionalData: header },
        key,
        frame.slice(HEADER_BYTES),
      ),
    )
  } catch (error) {
    throw new UnauthenticatedFrame(error)
  }

  // Past this line the frame provably came from the peer holding our key, so
  // a wrong index is a real desync in one of the two state machines and still
  // fails loudly. That is the case these three checks were written for, and
  // the only case they can now see.
  if (expect) {
    if (fields.type !== expect.type) throw new Error('Unexpected frame type')
    if (fields.fileSeq !== expect.fileSeq) throw new Error('Frame from unexpected file')
    if (fields.index !== expect.index) {
      throw new Error(`Out-of-order frame: expected ${expect.index}, got ${fields.index}`)
    }
  }

  return { ...fields, plaintext }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * @param {CryptoKey} key
 * @param {number} index Monotonic per direction. Part of the nonce, so it must never repeat.
 * @param {ControlMessage} obj
 * @returns {Promise<Bytes>}
 */
export async function sealControl(key, index, obj) {
  return seal(key, { type: TYPE_CONTROL, fileSeq: CONTROL_SEQ, index }, enc.encode(JSON.stringify(obj)))
}

/**
 * Opens a control frame and parses its JSON body.
 *
 * The return type is a promise of ControlMessage, which is a claim about
 * shape that JSON.parse cannot actually make good on -- the AEAD tag proves
 * the bytes came from the peer holding the key, not that the peer sent
 * something well-formed. receiver.js is what turns an unrecognised `t` into an
 * error, and every field is still treated as hostile downstream.
 *
 * @param {CryptoKey} key
 * @param {Bytes} frame
 * @param {number} index The index we expect, tracked locally, never read off the wire.
 * @returns {Promise<ControlMessage>}
 */
export async function openControl(key, frame, index) {
  const { plaintext } = await open(key, frame, {
    type: TYPE_CONTROL, fileSeq: CONTROL_SEQ, index,
  })
  return JSON.parse(dec.decode(plaintext))
}
