/**
 * Brings up the peer connection, using the rendezvous only to introduce.
 *
 * The ECDH public keys ride along inside the same sealed signalling messages as
 * the SDP. That is deliberate: it means the key agreement is authenticated by
 * the QR secret without needing a separate round trip, and there is never a
 * window in which an unauthenticated key is in play.
 *
 * Roles: 'host' generated the QR, 'guest' scanned it. The host creates the data
 * channel and the offer. Since the guest cannot know the secret until it scans,
 * the host may be waiting on the topic for some time -- so the guest announces
 * itself on arrival and the host offers in response.
 */

import { createEphemeralKeypair, exportPublicKey, establishSession } from '../crypto/session.js'
import { fromBase64url, toBase64url } from '../crypto/secret.js'

export const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
]

const CHANNEL_LABEL = 'qrbeam'
const READY_RETRY_MS = 2000
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Resolves once the data channel is open and the session keys are agreed.
 *
 * `iceServers` takes TURN entries too. Roughly 10-15% of NAT pairings cannot be
 * traversed with STUN alone and need a relay. Adding TURN costs no
 * confidentiality here -- the relay only ever carries DTLS-wrapped frames that
 * are themselves sealed under the session key -- but it does show the operator
 * both IPs and the transfer volume. Setting iceTransportPolicy to 'relay'
 * forces all traffic through TURN, which hides each peer's IP from the other at
 * the cost of requiring a TURN server to work at all.
 */
export async function connectPeers({
  signal,
  role,
  secret,
  iceServers = DEFAULT_ICE,
  iceTransportPolicy = 'all',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onState,
}) {
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy })
  const keypair = await createEphemeralKeypair()
  const myPublic = toBase64url(await exportPublicKey(keypair))

  let session = null
  let peerPublic = null
  let remoteSet = false
  const pendingCandidates = []
  let readyTimer = null

  const state = s => onState?.(s)

  // Key agreement can only happen once, and must happen before any frame is
  // exchanged. Both sides reach it at different points in the handshake, so it
  // is triggered from wherever the peer's key first arrives.
  const agree = async () => {
    if (session || !peerPublic) return
    session = await establishSession({
      keypair,
      peerPublicRaw: fromBase64url(peerPublic),
      secret,
      role,
    })
  }

  pc.addEventListener('icecandidate', ev => {
    if (!ev.candidate) return
    signal.send({ t: 'ice', candidate: ev.candidate.toJSON() }).catch(() => {
      // A dropped candidate is survivable; others usually suffice.
    })
  })

  pc.addEventListener('connectionstatechange', () => state(pc.connectionState))

  const applyCandidate = async candidate => {
    if (!remoteSet) return void pendingCandidates.push(candidate)
    try {
      await pc.addIceCandidate(candidate)
    } catch {
      // Candidates can legitimately fail to apply; ignore rather than abort.
    }
  }

  const flushCandidates = async () => {
    remoteSet = true
    while (pendingCandidates.length) await applyCandidate(pendingCandidates.shift())
  }

  const channelPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for the other device')),
      timeoutMs,
    )

    const ready = channel => {
      clearTimeout(timer)
      clearInterval(readyTimer)
      channel.binaryType = 'arraybuffer'
      if (channel.readyState === 'open') return resolve(channel)
      channel.addEventListener('open', () => resolve(channel), { once: true })
      channel.addEventListener('error', e => reject(e.error ?? new Error('Data channel failed')))
    }

    if (role === 'host') {
      ready(pc.createDataChannel(CHANNEL_LABEL, { ordered: true }))
    } else {
      pc.addEventListener('datachannel', ev => ready(ev.channel), { once: true })
    }
  })

  signal.onMessage = async msg => {
    try {
      if (msg.t === 'ready' && role === 'host') {
        // The guest has arrived. Offer exactly once; later 'ready' retries are
        // just the guest not having heard us yet, and re-offering would
        // renegotiate a connection that is already coming up.
        if (pc.signalingState !== 'stable' || pc.localDescription) return
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await signal.send({ t: 'offer', sdp: pc.localDescription.sdp, ecdh: myPublic })
        return
      }

      if (msg.t === 'offer' && role === 'guest') {
        peerPublic = msg.ecdh
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
        await flushCandidates()
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await agree()
        await signal.send({ t: 'answer', sdp: pc.localDescription.sdp, ecdh: myPublic })
        return
      }

      if (msg.t === 'answer' && role === 'host') {
        if (remoteSet) return
        peerPublic = msg.ecdh
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
        await flushCandidates()
        await agree()
        return
      }

      if (msg.t === 'ice') await applyCandidate(msg.candidate)
    } catch (error) {
      state(`signalling error: ${error.message}`)
    }
  }

  if (role === 'guest') {
    const announce = () => signal.send({ t: 'ready' }).catch(() => {})
    announce()
    // Retried because the host may still be opening its relay connections;
    // a single announcement lost to a cold WebSocket would stall the pairing.
    readyTimer = setInterval(announce, READY_RETRY_MS)
  }

  const channel = await channelPromise
  await agree()

  if (!session) throw new Error('Connected without agreeing a session key')

  return { pc, channel, session, close: () => { pc.close(); clearInterval(readyTimer) } }
}
