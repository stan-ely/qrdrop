/**
 * Signalling transport: encrypted ephemeral events over public Nostr relays.
 *
 * This is the "P2P network for the initial sync". Nostr is a good fit for a
 * static site because relays are plain WebSockets reachable from a browser with
 * no account, no API key, and no server of our own.
 *
 * What a relay operator can see:
 *   - a 16-byte topic tag, which is HKDF output and reveals nothing
 *   - two throwaway public keys, freshly generated and never reused
 *   - ciphertext, timing, and the IP addresses of both peers
 *
 * What they cannot see or do:
 *   - the SDP, the ICE candidates, or the ECDH public keys inside
 *   - substitute their own key material, since the payload is authenticated
 *     under a key derived from the QR secret
 *
 * That last point is the whole reason the payload is encrypted rather than
 * sent in the clear. The textbook attack on WebRTC signalling is swapping the
 * DTLS fingerprint in transit to become an invisible man in the middle. Sealing
 * the SDP under the QR-derived key means an attacker without the QR cannot
 * produce a payload either peer will accept.
 *
 * Identity keys here are per-session throwaways. Nostr events must be signed,
 * but nothing requires the signing key to mean anything, and a stable one would
 * let relays link every transfer a user ever makes.
 */

import { schnorr } from '@noble/secp256k1'

// Kind 20000-29999 is the ephemeral range: relays forward these to live
// subscribers and are not supposed to store them, which is exactly the
// retention policy wanted for signalling traffic.
const KIND = 20042

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
]

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const enc = new TextEncoder()
const dec = new TextDecoder()

const b64 = bytes => btoa(String.fromCharCode(...bytes))
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

async function sha256Hex(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

async function signEvent(event, secretKey) {
  // Nostr's canonical serialisation for computing the event id.
  const serialised = JSON.stringify([
    0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
  ])
  const id = await sha256Hex(enc.encode(serialised))
  const sig = await schnorr.signAsync(
    Uint8Array.from(id.match(/.{2}/g).map(h => parseInt(h, 16))),
    secretKey,
  )
  return { ...event, id, sig: hex(sig) }
}

/**
 * A random 96-bit IV per message is safe here because signalling is a handful
 * of messages per session, nowhere near the ~2^32 birthday bound for AES-GCM.
 * The bulk file path does not rely on randomness for its nonces -- see
 * transfer/frame.js, where the volume is high enough that it would matter.
 */
async function sealPayload(signalKey, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, signalKey, enc.encode(JSON.stringify(obj))),
  )
  const joined = new Uint8Array(12 + ct.length)
  joined.set(iv, 0)
  joined.set(ct, 12)
  return b64(joined)
}

async function openPayload(signalKey, content) {
  const raw = unb64(content)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12) },
    signalKey,
    raw.slice(12),
  )
  return JSON.parse(dec.decode(plain))
}

/**
 * Opens the rendezvous. Publishes to every relay and reads from all of them,
 * because individual public relays rate-limit, drop connections, and go down;
 * the redundancy is what makes this usable without infrastructure of our own.
 */
export function joinRendezvous({
  topic,
  signalKey,
  relays = DEFAULT_RELAYS,
  onMessage,
  onStatus,
}) {
  const secretKey = crypto.getRandomValues(new Uint8Array(32))
  const pubkey = hex(schnorr.getPublicKey(secretKey))
  const subId = hex(crypto.getRandomValues(new Uint8Array(8)))
  const seen = new Set()
  const sockets = []
  let closed = false

  const connected = () => sockets.filter(s => s.readyState === WebSocket.OPEN).length
  const report = () => onStatus?.({ connected: connected(), total: relays.length })

  for (const url of relays) {
    let socket
    try {
      socket = new WebSocket(url)
    } catch {
      continue
    }
    sockets.push(socket)

    socket.addEventListener('open', () => {
      if (closed) return socket.close()
      socket.send(JSON.stringify(['REQ', subId, {
        kinds: [KIND],
        '#d': [topic],
        // Ephemeral events are not stored, but a `since` bound keeps a
        // misbehaving relay from replaying anything stale at us.
        since: Math.floor(Date.now() / 1000) - 120,
      }]))
      report()
    })

    socket.addEventListener('close', report)
    socket.addEventListener('error', report)

    socket.addEventListener('message', async ev => {
      let frame
      try {
        frame = JSON.parse(ev.data)
      } catch {
        return
      }
      if (frame[0] !== 'EVENT' || frame[1] !== subId) return

      const event = frame[2]
      if (!event?.id || seen.has(event.id)) return   // relays duplicate freely
      if (event.pubkey === pubkey) return            // our own event echoed back
      seen.add(event.id)

      try {
        // Decryption failing IS the authentication check: without the QR
        // secret, nobody can produce a payload that opens here. Anyone may
        // publish to this topic; only a holder of the secret can be heard.
        api.onMessage(await openPayload(signalKey, event.content))
      } catch {
        // Not addressed to us, or a spoof. Ignore it silently.
      }
    })
  }

  // `onMessage` is a mutable property rather than a fixed callback: the
  // rendezvous has to be open and listening before the WebRTC layer exists to
  // handle anything, or the peer's first message races the subscription.
  const api = {
    onMessage: onMessage ?? (() => {}),

    async send(obj) {
      const event = await signEvent({
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND,
        tags: [['d', topic]],
        content: await sealPayload(signalKey, obj),
      }, secretKey)

      const message = JSON.stringify(['EVENT', event])
      let delivered = 0
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.OPEN) continue
        try {
          socket.send(message)
          delivered += 1
        } catch {
          // A relay dropping out mid-send is expected; others carry it.
        }
      }
      if (delivered === 0) throw new Error('No relay is currently reachable')
      return delivered
    },

    close() {
      closed = true
      for (const socket of sockets) {
        try {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subId]))
          socket.close()
        } catch {
          // Already gone.
        }
      }
    },

    get status() {
      return { connected: connected(), total: relays.length }
    },
  }

  return api
}

export const _internals = { sealPayload, openPayload, signEvent, KIND }
