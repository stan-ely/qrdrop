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

export function encodeHeader({ type, fileSeq, index, last = false }) {
  const h = new Uint8Array(HEADER_BYTES)
  const view = new DataView(h.buffer)
  view.setUint8(0, type)
  view.setUint32(1, fileSeq, false)
  view.setBigUint64(5, BigInt(index), false)
  view.setUint8(13, last ? 1 : 0)
  return h
}

export function decodeHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES)
  return {
    type: view.getUint8(0),
    fileSeq: view.getUint32(1, false),
    index: Number(view.getBigUint64(5, false)),
    last: view.getUint8(13) === 1,
  }
}

function nonceFor(header) {
  return header.slice(1, 13) // fileSeq || index, exactly 12 bytes
}

/** Returns a single Uint8Array ready to hand to DataChannel.send(). */
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
 * Opens a frame, enforcing that it is the one we expected.
 *
 * `expect` is supplied by the caller from its own tracked state rather than
 * read off the wire, so a replayed or reordered frame is refused before its
 * contents are trusted. The DataChannel is ordered and reliable, so this should
 * never trip on the network path -- it is here to catch a misbehaving peer and
 * to make any framing bug fail loudly instead of producing a corrupt file.
 */
export async function open(key, frame, expect) {
  if (frame.length < HEADER_BYTES + TAG_BYTES) throw new Error('Frame too short')
  if (frame.length > MAX_FRAME_BYTES) throw new Error('Frame exceeds maximum size')

  const header = frame.slice(0, HEADER_BYTES)
  const fields = decodeHeader(header)

  if (expect) {
    if (fields.type !== expect.type) throw new Error('Unexpected frame type')
    if (fields.fileSeq !== expect.fileSeq) throw new Error('Frame from unexpected file')
    if (fields.index !== expect.index) {
      throw new Error(`Out-of-order frame: expected ${expect.index}, got ${fields.index}`)
    }
  }

  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonceFor(header), additionalData: header },
      key,
      frame.slice(HEADER_BYTES),
    ),
  )
  return { ...fields, plaintext }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function sealControl(key, index, obj) {
  return seal(key, { type: TYPE_CONTROL, fileSeq: CONTROL_SEQ, index }, enc.encode(JSON.stringify(obj)))
}

export async function openControl(key, frame, index) {
  const { plaintext } = await open(key, frame, {
    type: TYPE_CONTROL, fileSeq: CONTROL_SEQ, index,
  })
  return JSON.parse(dec.decode(plaintext))
}
