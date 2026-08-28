/**
 * Pairing, via Trystero.
 *
 * Replaces the hand-written Nostr transport and WebRTC negotiation. Trystero
 * handles relay connections, peer discovery, offer/answer, ICE, and the data
 * channel; what stays ours is everything above it -- the ECDH session, the SAS,
 * and the per-chunk AEAD in transfer/.
 *
 * WHY `password` IS NOT OPTIONAL HERE:
 *
 * Trystero owns the session descriptions now, so we can no longer seal the SDP
 * ourselves. `password` is what replaces that: it encrypts session descriptions
 * with AES-GCM as they cross the relays. Without it Trystero falls back to a
 * key derived from the app ID and room name -- both of which any observer of
 * the relay already has -- which would leave the DTLS fingerprint substitutable
 * in transit, the exact man-in-the-middle this design exists to prevent.
 *
 * The password is HKDF output from the QR secret, so only someone holding the
 * code can produce session descriptions either peer will accept.
 *
 * Our own ECDH still runs on top of that, and still uses the QR secret as its
 * HKDF salt. So even if Trystero's signalling encryption were broken outright,
 * file bytes stay closed: an attacker would also need the secret to derive the
 * session key. The layers fail independently, which is the point of having two.
 *
 * API NOTE: Trystero 0.25 is object-based, not tuple-based. makeAction returns
 * an object with `send()` and an assignable `onMessage`, and onPeerJoin /
 * onPeerLeave are assigned rather than called. The older
 * `const [send, receive] = room.makeAction(...)` form throws "object is not
 * iterable" against this version.
 */

import { joinRoom } from '@trystero-p2p/nostr'
import { createChannel } from './channel.js'
import { createEphemeralKeypair, exportPublicKey, establishSession } from '../core/session.js'
import { fromBase64url, toBase64url } from '../core/secret.js'

const APP_ID = 'qrdrop'
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Pinned rather than using Trystero's built-in pool of ~44 relays, so the
 * connect-src allowlist on the page can name every host it will ever contact.
 * Passing `urls` makes Trystero use exactly this list and ignore its own.
 *
 * Chosen from Trystero's pool by actually connecting to each one. The obvious
 * picks -- relay.damus.io, relay.nostr.band, relay.snort.social -- are the
 * best-known Nostr relays and were all unreachable when this list was built;
 * popularity and availability are not the same thing. Re-test before editing,
 * and re-test by PUBLISHING, not by opening a socket: relay.nostr.place was
 * dropped from this list after it started demanding proof-of-work (NIP-13) on
 * writes. It still accepts connections and still answers reads, so a
 * connectivity probe calls it healthy; Trystero cannot announce a peer on it,
 * which is the only thing we need a relay to do.
 *
 * This array is the single source of truth for the CSP: scripts/build-site.mjs
 * imports it and generates connect-src from it, so the allowlist cannot drift
 * out of step with the list the code actually dials. Editing it here is enough.
 */
export const RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.mostr.pub',
  'wss://purplerelay.com',
  'wss://nostr.data.haus',
  'wss://nostr-01.yakihonne.com',
  'wss://bucket.coracle.social',
]

/**
 * STUN only. TURN entries can be added here: a relay costs no confidentiality,
 * since it carries DTLS-wrapped frames that are themselves sealed under the
 * session key, but it does show the operator both IPs and the transfer volume.
 * Adding `iceTransportPolicy: 'relay'` to rtcConfig would additionally hide
 * each peer's IP from the other, at the cost of requiring TURN to connect.
 */
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
]

/**
 * Narrows an inbound Trystero payload to bytes.
 *
 * Anything that is not already binary is turned into an empty array rather
 * than coerced. A peer that sends a string or a number where a frame belongs
 * is misbehaving, and an empty array is refused one layer down as a runt frame
 * -- which is a clean, reported failure instead of `new Uint8Array('...')`
 * quietly producing garbage the receiver then tries to decrypt.
 *
 * @param {TrysteroPayload} data
 * @returns {Bytes}
 */
const toBytes = data => {
  if (data instanceof Uint8Array) return /** @type {Bytes} */ (data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    // Copied rather than wrapped: `buffer` here is ArrayBufferLike, which
    // includes SharedArrayBuffer, and WebCrypto refuses those. Uint8Array.from
    // gives a plainly-backed copy. Only reachable if a peer sends some other
    // view type, so the copy is not on the hot path.
    return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  return new Uint8Array(0)
}

/**
 * Joins the rendezvous and resolves once a peer is connected and session keys
 * are agreed.
 *
 * `role` is 'host' for the peer that generated the QR, 'guest' for the scanner.
 * It only decides which direction gets which key; both sides derive both.
 *
 * @param {object} args
 * @param {string} args.topic HKDF'd from the secret -- never the secret itself.
 * @param {string} args.password A string, not a CryptoKey: Trystero stretches it internally.
 * @param {Bytes} args.secret The QR secret, passed on as the ECDH HKDF salt.
 * @param {'host' | 'guest'} args.role
 * @param {number} [args.timeoutMs]
 * @param {(text: string) => void} [args.onStatus]
 * @param {readonly string[]} [args.relays] Defaults to RELAYS. A caller passing
 *   its own list is on the hook for the CSP on any page that uses it.
 * @param {readonly RTCIceServer[]} [args.iceServers] Defaults to ICE_SERVERS.
 * @param {typeof RTCPeerConnection} [args.rtcPolyfill] Node has no WebRTC.
 *   The CLI passes node-datachannel's implementation here; browsers leave it
 *   undefined and Trystero falls back to the global.
 * @returns {Promise<PairedRoom>}
 */
export async function openRoom({
  topic,
  password,
  secret,
  role,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onStatus,
  relays = RELAYS,
  iceServers = ICE_SERVERS,
  rtcPolyfill,
}) {
  // Generated BEFORE joining, deliberately. Awaiting anything between
  // joinRoom() and assigning onPeerJoin leaves a window in which the other peer
  // can join unobserved -- and that is the normal case here, not a rare one:
  // the host is already sitting in the room when the guest scans, so the
  // guest's very first discovery can land inside that gap and be lost.
  const keypair = await createEphemeralKeypair()
  const myPublic = toBase64url(await exportPublicKey(keypair))

  const room = joinRoom(
    {
      appId: APP_ID,
      password,
      relayConfig: { urls: [...relays] },
      rtcConfig: { iceServers: [...iceServers] },
      ...(rtcPolyfill ? { rtcPolyfill } : {}),
    },
    topic,
  )

  const keyAction = room.makeAction('ecdh')
  const frameAction = room.makeAction('frame')

  // Annotated rather than inferred: from the no-op initialiser alone the
  // checker reads this as a zero-argument function, and every later call
  // through it becomes an arity error at the call site instead of a type error
  // here. The placeholder exists so frames arriving before onFrame() is
  // registered are dropped rather than thrown on.
  /** @type {(bytes: Bytes) => void} */
  let frameHandler = () => {}
  frameAction.onMessage = data => frameHandler(toBytes(data))

  onStatus?.('Waiting for the other device…')

  /** @type {Promise<{ session: SessionKeys, peerId: string }>} */
  const paired = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for the other device')),
      timeoutMs,
    )
    let settled = false

    room.onPeerJoin = id => {
      onStatus?.('Found the other device, agreeing keys…')
      // Both sides fire this on connection, so both announce and both receive.
      keyAction.send(myPublic, { target: id })
    }

    keyAction.onMessage = async (peerPublic, { peerId: id }) => {
      // A third party holding the code could also join. We pair with whoever
      // arrives first and ignore the rest; the SAS is what surfaces a wrong
      // partner to the user.
      if (settled) return
      settled = true
      clearTimeout(timer)

      // Trystero delivers whatever the peer serialised, so this is a string
      // only by convention. Checked rather than assumed: without it a peer
      // sending null or a number reaches fromBase64url, which throws
      // "replace is not a function" from inside an event handler -- an
      // unhandled rejection that leaves this promise pending until the
      // timeout, reported to the user as "timed out" rather than as the
      // protocol violation it is.
      if (typeof peerPublic !== 'string') {
        return reject(new Error('Peer sent a malformed public key'))
      }

      try {
        resolve({
          peerId: id,
          session: await establishSession({
            keypair,
            peerPublicRaw: fromBase64url(peerPublic),
            secret,
            role,
          }),
        })
      } catch (error) {
        reject(error)
      }
    }
  })

  const { session, peerId } = await paired

  return {
    session,
    peerId,

    /**
     * The seam. See signal/channel.js, and the Channel contract it implements.
     *
     * send() returns Trystero's promise, which settles when local sending is
     * complete, and sender.js awaits it -- that await IS the backpressure now.
     * Trystero manages the data channel's buffer internally, so bufferedAmount
     * stays 0 and the manual high/low watermark logic in sender.js never fires
     * on this path.
     */
    channel: createChannel(frameAction, peerId),

    /**
     * Register the inbound frame handler.
     * @param {(bytes: Bytes) => void} callback
     */
    onFrame(callback) {
      frameHandler = callback
    },

    /** @param {() => void} callback */
    onPeerLeave(callback) {
      room.onPeerLeave = id => {
        if (id === peerId) callback()
      }
    },

    close() {
      try {
        room.leave()
      } catch {
        // Already gone.
      }
    },
  }
}
