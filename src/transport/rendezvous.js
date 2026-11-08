/**
 * Pairing with no relay: the dialler and listener ends of the offline
 * rendezvous (core/rendezvous.js has the four messages and why each is
 * there), and the PairedRoom a socket becomes once they have run.
 *
 * WHY A SECOND PAIREDROOM. On the relay path the room carries everything
 * after pairing -- the path verdict, the manifest, Accept and every frame --
 * and the LAN socket takes over only the sender's frames, at Accept. An
 * offline pairing has no room, so the socket carries the whole session from
 * the first frame. Nothing in core/ can tell: it is handed a PairedRoom and
 * a channel, which is the transport seam doing its job.
 *
 * ONE ROLL PER SECRET. The dialler counts itself paired once it has sent
 * `ok`; the listener only once it has checked one. Before that point either
 * may give up and go to the relays, and nothing was shown to anyone. After
 * it, a failure is terminal like a mismatch, because a SAS may be on a
 * screen. That is why the dialler races only the connect and the nonce and
 * keys a single connection: keying every address that answered would give
 * each its own keypair, and a listener reachable at two addresses could
 * finish on one while the dialler kept the other -- two SASes that disagree
 * with nobody attacking (docs/notes/pairing-race.md).
 *
 * Isomorphic. No DOM, no fs, no socket of its own: the dial is a
 * LanPlatform's, and a listener is node/lan-server.js's, which runs
 * answerRendezvous on each connection it takes, or the app's, which runs
 * acceptRendezvous over the connections its shell's relay hands the page.
 */

import { createEphemeralKeypair, exportPublicKey, establishSession } from '../core/session.js'
import {
  NONCE_BYTES, createNonce, rendezvousKey,
  sealDial, openDial, sealListen, openListen, sealOk, openOk,
} from '../core/rendezvous.js'
import { createLanChannel } from './channel.js'
import { isPrivateAddress } from './room.js'

/** @typedef {import('../core/secret.js').Locator} Locator */

/**
 * How long a scanner tries the locator before going to the relays, from the
 * first connect to the listener's key. Longer than lan.js's per-address
 * dial, because here there is nothing else to fall back on yet: every second
 * of it is a second the person on an offline network waits, and every second
 * cut is a phone on a slow Wi-Fi sent to relays it cannot reach.
 * The Rust session's DIAL_TIMEOUT, and the two move together.
 */
export const DIAL_TIMEOUT_MS = 3000

/** Per connection on the listener, from the upgrade to a checked `ok`. */
export const HANDSHAKE_TIMEOUT_MS = 5000

/**
 * Connections a listener runs the handshake on at once. A stranger costs a
 * slot for at most HANDSHAKE_TIMEOUT_MS and never a key, and past this they
 * are turned away at the door rather than queued.
 */
export const MAX_HANDSHAKES = 32

/** What a locator carries, and so what a listener offers. */
export const LOCATOR_ADDRESSES = 4

/**
 * How many arrivals acceptRendezvous keeps asked for ahead of need. One is
 * not enough, and that was measured: the app's page answers each ask by
 * opening a WebSocket to its own relay, and on an Android emulator mid-pairing
 * that open took 1.6 to 2.2 s. With one ask outstanding, the replacement for
 * a socket just handed a connection was still opening when the next one
 * arrived, so every connection after the first waited out a whole open
 * before it heard a nonce, and a dialler's DIAL_TIMEOUT_MS ran out on it --
 * three of four runs, with a stranger connecting first. Two keeps one ready
 * while the other is replaced.
 */
export const SPARE_ARRIVALS = 2

// Messages a socket room holds for a caller that has not registered onFrame
// yet, as room.js's EARLY_FRAME_LIMIT and for its reason: the peer does not
// wait for this side's SAS prompt, and its path verdict is control index 0.
const EARLY_FRAME_LIMIT = 16

/**
 * The next message on a socket, or null once it has closed.
 *
 * Takes exactly one and clears its handler, so whatever arrived behind it
 * stays held in the socket (createLanSocket) for the next reader.
 *
 * @param {LanSocket} socket
 * @returns {Promise<Bytes | null>}
 */
export function nextMessage(socket) {
  return new Promise(resolve => {
    let done = false
    /** @param {Bytes | null} bytes */
    const finish = bytes => {
      if (done) return
      done = true
      socket.onmessage = null
      socket.onclose = null
      resolve(bytes)
    }
    socket.onclose = () => finish(null)
    // Assigning the handler hands over a held message synchronously, so the
    // closed check after it cannot miss one that arrived before the close.
    socket.onmessage = finish
    if (!done && !socket.open) finish(null)
  })
}

/**
 * The listener's end, on one connection. Resolves with the session once the
 * dialler's `ok` has checked, and with null for anything else: a stranger,
 * a wrong code, a dialler that went away before its `ok`. The caller closes
 * the socket on null, and keeps listening.
 *
 * The keypair is generated only after the dial message verifies, and per
 * connection: a stranger never costs a key, and no two sessions share one,
 * which is the forward-secrecy rule room.js's joinVia states.
 *
 * @param {LanSocket} socket
 * @param {Bytes} secret
 * @param {CryptoKey} key rendezvousKey(secret), derived once per listener.
 * @returns {Promise<SessionKeys | null>}
 */
export async function answerRendezvous(socket, secret, key) {
  const nonce = createNonce()
  socket.send(nonce)
  const dialMessage = await nextMessage(socket)
  if (!dialMessage) return null
  const dialPublic = await openDial(key, nonce, dialMessage)
  if (!dialPublic) return null

  const keypair = await createEphemeralKeypair()
  const listenPublic = await exportPublicKey(keypair)
  socket.send(await sealListen(key, nonce, dialPublic, listenPublic))
  const ok = await nextMessage(socket)
  if (!ok || !await openOk(key, nonce, dialPublic, listenPublic, ok)) return null

  return establishSession({ keypair, peerPublicRaw: dialPublic, secret, role: 'host' })
}

/**
 * The addresses in a locator this side will dial: private ones that are not
 * this machine. The QR is untrusted input, and a locator naming loopback or
 * a public address is either damaged or aimed at something other than the
 * other device; dialling it would make a scanned picture choose where this
 * device connects.
 *
 * @param {Locator} locator
 * @returns {string[]}
 */
export function dialableAddresses(locator) {
  return locator.addresses.filter(a => !a.startsWith('127.') && isPrivateAddress(a))
}

/**
 * The dialler's end: every address in the locator at once for the nonce, then
 * the handshake on the first to answer. Resolves with a room once `ok` has
 * gone out, or null within DIAL_TIMEOUT_MS when nobody holding the code
 * answered -- the cue to try the relays.
 *
 * @param {object} args
 * @param {Locator} args.locator
 * @param {Bytes} args.secret
 * @param {(url: string, timeoutMs: number) => Promise<LanSocket>} args.dial
 *   A LanPlatform's dial.
 * @param {number} [args.timeoutMs]
 * @param {string[]} [args.addresses] What to dial in place of the locator's
 *   filtered list. For tests on loopback, which dialableAddresses refuses.
 * @returns {Promise<PairedRoom | null>}
 */
export async function dialRendezvous({ locator, secret, dial, timeoutMs = DIAL_TIMEOUT_MS, addresses }) {
  const addrs = addresses ?? dialableAddresses(locator)
  if (!addrs.length) return null
  const key = await rendezvousKey(secret)

  /** @type {Set<LanSocket>} */
  const open = new Set()
  let expired = false
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const late = new Promise(resolve => {
    timer = setTimeout(() => {
      expired = true
      for (const s of open) s.close()
      resolve(null)
    }, timeoutMs)
  })

  const keyed = (async () => {
    const hellos = addrs.map(async addr => {
      const socket = await dial(`ws://${addr}:${locator.port}/`, timeoutMs)
      if (expired) {
        socket.close()
        throw new Error('late')
      }
      open.add(socket)
      const nonce = await nextMessage(socket)
      if (!nonce || nonce.length !== NONCE_BYTES) {
        socket.close()
        throw new Error('not a rendezvous')
      }
      return { socket, nonce, addr }
    })
    /** @type {{ socket: LanSocket, nonce: Bytes, addr: string }} */
    let won
    try {
      won = await Promise.any(hellos)
    } catch {
      return null
    }
    const winner = won.socket
    // Every other connection is closed, whether it answered already or does
    // later: one keypair, on one connection (the header).
    for (const h of hellos) {
      h.then(({ socket }) => { if (socket !== winner) socket.close() }, () => {})
    }
    const { socket, nonce, addr } = won
    const keypair = await createEphemeralKeypair()
    const dialPublic = await exportPublicKey(keypair)
    socket.send(await sealDial(key, nonce, dialPublic))
    const reply = await nextMessage(socket)
    const listenPublic = reply && await openListen(key, nonce, dialPublic, reply)
    if (!listenPublic || expired) {
      socket.close()
      return null
    }
    return { socket, nonce, addr, keypair, dialPublic, listenPublic }
  })()

  const met = await Promise.race([keyed, late])
  clearTimeout(timer)
  if (!met) return null
  const { socket, nonce, addr, keypair, dialPublic, listenPublic } = met
  open.clear()

  // Past this send the dialler is paired, and a failure is terminal: the
  // listener may already hold the `ok` and be showing its SAS. A WebSocket
  // send queues the whole message or nothing, so there is no half-sent `ok`
  // for a timeout to cut, which is why it stays outside the timer.
  socket.send(await sealOk(key, nonce, dialPublic, listenPublic))
  const session = await establishSession({ keypair, peerPublicRaw: listenPublic, secret, role: 'guest' })
  return createSocketRoom({ session, socket, peer: addr })
}

/**
 * A listener that does not own its socket server: it pulls arrived
 * connections from `arrivals` and runs answerRendezvous on each, keeping the
 * first that proves the code. The app's page is the caller
 * (app/src/lan.js), because a webview cannot accept a connection and its
 * shell's relay (src-tauri/src/lan.rs, `offline_listen`) can, but has no
 * secret: the relay hands the page every connection, and the page decides.
 *
 * node/lan-server.js's listenOffline keeps the same rules with a server
 * that pushes: at most `limit` handshakes at once, each cut at `timeoutMs`,
 * and one win. Here the bound is kept by asking: up to `spare` calls to
 * `arrivals()` are outstanding, and handshakes running plus asks outstanding
 * never pass `limit`, so the relay holds the rest, and drops them past its
 * own cap.
 *
 * `arrivals` resolves null once the source has ended, which ends the
 * listener as a failure unless it already won.
 *
 * @param {object} args
 * @param {Bytes} args.secret
 * @param {() => Promise<{ socket: LanSocket, from: string } | null>} args.arrivals
 * @param {number} [args.limit]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.spare] Arrivals asked for ahead of need (SPARE_ARRIVALS).
 * @returns {{ accepted: Promise<PairedRoom>, close: () => void }}
 */
export function acceptRendezvous({
  secret, arrivals, limit = MAX_HANDSHAKES, timeoutMs = HANDSHAKE_TIMEOUT_MS, spare = SPARE_ARRIVALS,
}) {
  const keyed = rendezvousKey(secret)
  /** @type {Set<LanSocket>} */
  const running = new Set()
  let asking = 0
  let done = false

  /** @type {(room: PairedRoom) => void} */
  let resolveAccepted = () => {}
  /** @type {(error: Error) => void} */
  let rejectAccepted = () => {}
  /** @type {Promise<PairedRoom>} */
  const accepted = new Promise((resolve, reject) => {
    resolveAccepted = resolve
    rejectAccepted = reject
  })
  accepted.catch(() => {})

  /** @param {Error} error */
  const end = error => {
    if (done) return
    done = true
    for (const socket of running) socket.close()
    running.clear()
    rejectAccepted(error)
  }

  /**
   * @param {LanSocket} socket
   * @param {string} from
   */
  const handshake = async (socket, from) => {
    running.add(socket)
    const timer = setTimeout(() => socket.close(), timeoutMs)
    /** @type {SessionKeys | null} */
    let session = null
    try {
      session = await answerRendezvous(socket, secret, await keyed)
    } catch { /* a malformed message is a stranger, like a wrong MAC */ }
    clearTimeout(timer)
    running.delete(socket)
    // Open is checked as well: the timeout can land during the last await
    // of a handshake that then succeeds, on a socket it has already closed.
    if (!session || done || !socket.open) {
      socket.close()
      return ask()
    }
    done = true
    for (const other of running) other.close()
    running.clear()
    resolveAccepted(createSocketRoom({ session, socket, peer: from }))
  }

  const ask = () => {
    while (!done && asking < spare && running.size + asking < limit) {
      asking++
      arrivals().then(arrived => {
        asking--
        if (!arrived) return end(new Error('Stopped listening'))
        if (done) return arrived.socket.close()
        handshake(arrived.socket, arrived.from)
        ask()
      }, error => {
        asking--
        end(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }
  ask()

  return {
    accepted,
    close: () => end(new Error('Stopped listening')),
  }
}

/**
 * A PairedRoom whose every frame, both ways, rides one authenticated socket.
 *
 * - `channel` is the socket's from the start, and never switches.
 * - The peer leaving is the socket closing; leaving is closing it.
 * - `path()` is 'local': the rendezvous dials only private addresses.
 * - `direct` is what tells a caller not to negotiate a LAN or QUIC upgrade,
 *   since it is already on the link either would offer. A sender that sent
 *   a lan-hello anyway would be answered, and would open a second socket to
 *   the peer it is already talking to.
 *
 * @param {object} args
 * @param {SessionKeys} args.session
 * @param {LanSocket} args.socket
 * @param {string} args.peer The peer's address, as peerId: there is no
 *   Trystero id, and nothing else in the room to tell it apart from.
 * @returns {PairedRoom}
 */
export function createSocketRoom({ session, socket, peer }) {
  /** @type {((bytes: Bytes) => unknown) | null} */
  let frameHandler = null
  /** @type {Bytes[]} */
  const early = []
  /** @type {(() => void) | null} */
  let peerLeft = null
  let closing = false
  /** @type {Array<() => void>} */
  const closers = []

  /** @type {() => void} */
  let markClosed = () => {}
  /** @type {Promise<void>} */
  const closed = new Promise(resolve => { markClosed = resolve })

  socket.onmessage = bytes => {
    if (frameHandler) return frameHandler(bytes)
    if (early.length < EARLY_FRAME_LIMIT) early.push(bytes)
  }
  socket.onclose = () => {
    markClosed()
    if (!closing) peerLeft?.()
  }
  // Closed during the handshake's last await, with no close event left to see.
  if (!socket.open) markClosed()

  return {
    session,
    peerId: peer,
    channel: createLanChannel(socket),
    direct: true,

    onFrame(callback) {
      frameHandler = callback
      for (const bytes of early.splice(0)) callback(bytes)
    },

    onPeerLeave(callback) {
      peerLeft = callback
    },

    path: async () => 'local',
    pathEvidence: async () => null,
    isRelayed: async () => false,

    // Nothing to adopt: a second socket to the same peer can only be slower
    // than this one, and frames split across two would race each other.
    attachLan(other) {
      other.close()
    },

    // Already there, which is the answer a sender at Accept wants.
    sendOverLan: () => !closing && socket.open,

    onClose(fn) {
      closers.push(fn)
    },

    /**
     * Settles when the socket has closed, or after a second, so a process
     * about to exit gives the close frame its chance to go out, which is what
     * tells the other device, and is never held hostage by a peer that does
     * not answer it.
     */
    close() {
      if (!closing) {
        closing = true
        for (const fn of closers.splice(0)) {
          try { fn() } catch { /* a closer failing must not keep the socket open */ }
        }
        socket.close()
      }
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      const bound = new Promise(resolve => { timer = setTimeout(resolve, 1000) })
      return Promise.race([closed, bound]).then(() => clearTimeout(timer))
    },
  }
}
