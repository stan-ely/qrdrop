/**
 * The local-network fast path: the sender's frames over a direct WebSocket
 * when both ends are native and on one network.
 *
 * WHY. A WebRTC data channel levels off at 14-17 MB/s even at LAN round-trip
 * times, and that ceiling is SCTP's congestion control, which nothing in JS can
 * reach. A WebSocket between the same two machines is OS TCP, and it measured
 * 4x that in a network namespace and about 6x on a phone over Wi-Fi. Measured
 * in full in app/CAPABILITIES.md, "The bare transport, measured".
 *
 * WHAT MOVES, AND WHAT DOES NOT. Only the sender's frames, and only from the
 * receiver's Accept onwards. Pairing, the SAS, the manifest and every frame the
 * receiver sends stay on WebRTC. The frames that do move are the same sealed
 * frames, into the same handler, so "authenticate, then trust", the ordering
 * checks and receiver.dropped all hold unchanged. The socket adds speed, not
 * trust.
 *
 * WHY ACCEPT IS THE ONE MOMENT TO MOVE. Two ordered channels are not one
 * ordered channel: a frame on the new one can overtake a frame still in flight
 * on the old, and the receiver treats an out-of-order authenticated frame as
 * fatal. So the switch waits for a moment when nothing can be in flight. When
 * the sender reads the peer's accept, every frame it has sent over WebRTC is
 * one the receiver has provably handled: the manifest (it answered it), the
 * hello before it, and the offer when the sender is the one listening (the
 * receiver used its token to connect). After the switch, every frame this side
 * sends goes over the socket, so nothing is left behind on WebRTC to be
 * overtaken. That is also why the receiver never switches: its replies stay on
 * the one channel they have always used.
 *
 * WHO LISTENS. A page cannot accept a connection, so a listening app runs a
 * relay in its own Rust process (app/src-tauri/src/lan.rs), and a listening CLI
 * runs node/lan-server.js. On Windows, and for an unsigned macOS app, listening
 * shows the person an OS firewall prompt. So each side's hello says 'quiet',
 * 'prompt' or 'none', a quiet side is chosen to listen, and when neither is
 * quiet the session stays on WebRTC. A firewall dialog in the middle of a
 * transfer, for a person who asked for nothing of the sort, costs more than the
 * speed buys.
 *
 * WHEN IT IS SAID. The sender's hello goes out only after its SAS confirm, and
 * the receiver speaks only in reply. A hello from a peer that has not been
 * verified would hand a LAN address and a listening port to whoever is at the
 * other end of an unverified key, which is exactly the party the SAS exists to
 * rule out.
 *
 * THE TOKEN. The listener's offer carries 16 random bytes, sealed like every
 * control message. The connecting side's first WebSocket message is that
 * token, and the listener answers one byte, ACK, before anything else moves.
 * The listener takes one connection that presents it and then stops
 * listening. A stranger on the network who reaches the port gets closed. Even
 * a stranger who somehow presented the token could only inject frames, and
 * those fail their tag and are dropped: the token keeps the socket for our
 * peer, and the AEAD keeps the frames ours.
 *
 * Isomorphic. No DOM, no fs, and no socket of its own: a runtime lends its
 * WebSocket constructor and its listener through a LanPlatform (node/lan.js
 * for the CLI, app/src/main.js for the app), the same pattern as rtcPolyfill.
 */

import { isPrivateAddress } from './room.js'

/** How long a sender that has seen the peer's hello waits at Accept for the link. */
export const LINK_WAIT_MS = 2000

/** Per address, for the connect and for the token handshake after it. */
export const DIAL_TIMEOUT_MS = 2000

const TOKEN_BYTES = 16

/** The listener's one-byte answer to a good token. Frames are never one byte. */
const ACK = 0x06

// More than an offer ever needs (a machine with Wi-Fi, Ethernet and a VPN has
// three), and a bound on how many sockets one offer can make this side open.
const MAX_ADDRS = 8

// Messages a LanSocket holds while nobody has assigned onmessage. A sender
// only starts sending after the handshake, and the side that adopts the socket
// assigns its handler in the same task, so a handful at most is legitimate.
// Past this the socket is closed, rather than letting a peer grow memory
// without bound.
const HELD_LIMIT = 1024

/**
 * Which side listens, from the two hellos. Both sides run this on the same
 * pair of inputs, so they agree without a further message.
 *
 * A quiet side always listens in preference to one that would prompt. When
 * both are quiet it is the receiver: arbitrary, but it has to be one of them
 * and this is the same answer on both ends. When neither is quiet the answer
 * is null, and the session stays on WebRTC (see the header).
 *
 * @param {LanListenMode} sender
 * @param {LanListenMode} receiver
 * @returns {'sender' | 'receiver' | null}
 */
export function chooseListener(sender, receiver) {
  if (receiver === 'quiet') return 'receiver'
  if (sender === 'quiet') return 'sender'
  return null
}

/**
 * @param {unknown} mode
 * @returns {LanListenMode}
 */
function listenMode(mode) {
  return mode === 'quiet' || mode === 'prompt' ? mode : 'none'
}

/**
 * Checks a peer's offer before anything dials it. The peer is authenticated,
 * but it is also a different build, possibly a buggy or a hostile one, and
 * this is the point where its words turn into outbound connections.
 *
 * Addresses must be dotted IPv4 on a private range, and not loopback. An offer
 * cannot aim this side at a host on the internet, or at a service on this
 * machine.
 *
 * @param {{ addrs?: unknown, port?: unknown, token?: unknown }} offer
 * @returns {{ addrs: string[], port: number, token: Bytes } | null}
 */
export function parseOffer(offer) {
  const { addrs, port, token } = offer
  if (!Array.isArray(addrs) || addrs.length === 0) return null
  if (!Number.isInteger(port) || /** @type {number} */ (port) < 1 || /** @type {number} */ (port) > 65535) return null
  if (typeof token !== 'string' || !new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(token)) return null
  const usable = addrs
    .slice(0, MAX_ADDRS)
    .filter(a => typeof a === 'string'
      && /^\d{1,3}(\.\d{1,3}){3}$/.test(a)
      && !a.startsWith('127.')
      && isPrivateAddress(a))
  if (usable.length === 0) return null
  return { addrs: usable, port: /** @type {number} */ (port), token: fromHex(token) }
}

/** @param {Bytes} bytes */
function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @param {string} text Already checked to be even-length lowercase hex.
 * @returns {Bytes}
 */
function fromHex(text) {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Compares without an early exit, so the time taken says nothing about how
 * much of a guessed token was right.
 *
 * @param {Bytes} a
 * @param {Bytes} b
 */
function equalBytes(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * The shared half of every LanSocket adapter: the held-message queue and the
 * close notification. An adapter supplies the raw operations and calls
 * `deliver` for each inbound message and `closed` once.
 *
 * @param {object} raw
 * @param {(bytes: Bytes) => void} raw.send
 * @param {() => number} raw.bufferedAmount
 * @param {() => boolean} raw.isOpen
 * @param {(threshold: number) => Promise<void>} raw.drained
 * @param {() => void} raw.close
 * @returns {{ socket: LanSocket, deliver: (bytes: Bytes) => void, closed: () => void }}
 */
export function createLanSocket(raw) {
  /** @type {Bytes[]} */
  const held = []
  /** @type {((bytes: Bytes) => void) | null} */
  let handler = null
  /** @type {(() => void) | null} */
  let closeHandler = null
  let isClosed = false

  /** @type {LanSocket} */
  const socket = {
    send: raw.send,
    get bufferedAmount() { return raw.bufferedAmount() },
    get open() { return !isClosed && raw.isOpen() },
    drained: raw.drained,
    close: raw.close,
    get onmessage() { return handler },
    set onmessage(fn) {
      handler = fn
      // One at a time, re-reading the handler, because the handler may be
      // replaced by a message it is handed. The handshake does exactly that:
      // it takes the first message and clears itself, and whatever arrived
      // behind the token must stay held for the room, not go to the
      // handshake.
      while (handler && held.length) handler(/** @type {Bytes} */ (held.shift()))
    },
    get onclose() { return closeHandler },
    set onclose(fn) { closeHandler = fn },
  }

  return {
    socket,
    deliver(bytes) {
      if (handler) return handler(bytes)
      if (held.length < HELD_LIMIT) held.push(bytes)
      else raw.close()
    },
    closed() {
      if (isClosed) return
      isClosed = true
      closeHandler?.()
    },
  }
}

/**
 * The part of a WebSocket this file uses, typed loosely enough that both a
 * page's WebSocket and Node's (undici) satisfy it without this module naming
 * either runtime's type.
 *
 * @typedef {{
 *   binaryType: string,
 *   readonly readyState: number,
 *   readonly bufferedAmount: number,
 *   send(data: Bytes): void,
 *   close(): void,
 *   onopen: ((ev: any) => void) | null,
 *   onmessage: ((ev: any) => void) | null,
 *   onclose: ((ev: any) => void) | null,
 *   onerror: ((ev: any) => void) | null,
 * }} WebSocketLike
 */

/** @typedef {new (url: string) => WebSocketLike} WebSocketCtor */

const OPEN = 1

/**
 * Wraps an open WebSocket client as a LanSocket.
 *
 * drained() polls, because a WebSocket has no 'bufferedamountlow' event. At a
 * millisecond per poll and the thresholds in channel.js, the queue cannot run
 * dry between polls at any rate this path has measured.
 *
 * @param {WebSocketLike} ws Already open. dialWebSocket wraps inside onopen,
 *   so no message can be dispatched in between.
 * @returns {LanSocket}
 */
export function wrapWebSocket(ws) {
  ws.binaryType = 'arraybuffer'
  const { socket, deliver, closed } = createLanSocket({
    send: bytes => ws.send(bytes),
    bufferedAmount: () => ws.bufferedAmount,
    isOpen: () => ws.readyState === OPEN,
    drained: async threshold => {
      while (ws.readyState === OPEN && ws.bufferedAmount > threshold) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    },
    close: () => ws.close(),
  })
  ws.onmessage = ev => {
    // Text is not part of this protocol, and a frame is never text.
    if (ev.data instanceof ArrayBuffer) deliver(new Uint8Array(ev.data))
  }
  ws.onclose = () => closed()
  // 'close' always follows 'error', and it is the one that is acted on.
  ws.onerror = () => {}
  return socket
}

/**
 * Opens a WebSocket and resolves with it wrapped once it is open.
 *
 * @param {WebSocketCtor} WebSocketImpl The page's WebSocket, or Node's global one.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<LanSocket>}
 */
export function dialWebSocket(WebSocketImpl, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @type {WebSocketLike} */
    let ws
    try {
      ws = new WebSocketImpl(url)
    } catch (error) {
      reject(error)
      return
    }
    ws.binaryType = 'arraybuffer'
    const timer = setTimeout(() => {
      ws.onopen = ws.onerror = ws.onclose = null
      ws.close()
      reject(new Error(`No answer from ${url}`))
    }, timeoutMs)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(wrapWebSocket(ws))
    }
    ws.onerror = ws.onclose = () => {
      clearTimeout(timer)
      reject(new Error(`Could not connect to ${url}`))
    }
  })
}

/**
 * The connecting side's handshake: present the token, wait for ACK.
 *
 * Also used by the app's page against its own Rust relay on 127.0.0.1, with
 * no timeout, since there the ACK means "your peer has arrived", which takes
 * as long as the peer takes.
 *
 * @param {LanSocket} socket
 * @param {Bytes} token
 * @param {number} [timeoutMs] Omitted, the wait is bounded only by the socket closing.
 * @returns {Promise<LanSocket>}
 */
export function clientHandshake(socket, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @param {Error | null} error */
    const finish = error => {
      clearTimeout(timer)
      socket.onmessage = null
      socket.onclose = null
      if (!error) return resolve(socket)
      socket.close()
      reject(error)
    }
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => finish(new Error('The other device did not answer on the local network')), timeoutMs)
    socket.onclose = () => finish(new Error('The local network link closed during its handshake'))
    socket.onmessage = bytes => finish(bytes.length === 1 && bytes[0] === ACK
      ? null
      : new Error('The local network link answered with something other than an acknowledgement'))
    socket.send(token)
  })
}

/**
 * The listening side's handshake: the first message must be the token.
 *
 * @param {LanSocket} socket
 * @param {Bytes} token
 * @param {number} timeoutMs
 * @returns {Promise<LanSocket>} Rejects, having closed the socket, on anything else.
 */
export function serverHandshake(socket, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @param {Error | null} error */
    const finish = error => {
      clearTimeout(timer)
      socket.onmessage = null
      socket.onclose = null
      if (!error) {
        socket.send(Uint8Array.of(ACK))
        return resolve(socket)
      }
      socket.close()
      reject(error)
    }
    const timer = setTimeout(() => finish(new Error('No token')), timeoutMs)
    socket.onclose = () => finish(new Error('Closed before presenting a token'))
    socket.onmessage = bytes => finish(equalBytes(bytes, token) ? null : new Error('Wrong token'))
  })
}

/**
 * The negotiation for one session: the hellos, the offer, and the connect.
 *
 * The caller routes the peer's 'lan-hello' and 'lan-offer' into handle() (via
 * createReceiver's onPeerLan), and a sender asks ready() at Accept. Whatever
 * link comes up is attached to the room, which closes it with everything
 * else, and room.close() closes a listener still waiting.
 *
 * @param {object} args
 * @param {'sender' | 'receiver'} args.role
 * @param {LanPlatform} args.platform
 * @param {PairedRoom} args.room
 * @param {(msg: ControlMessage) => Promise<void>} args.send Sealed and index-ordered,
 *   through core/control.js's sendControl with this side's one nextControlIndex.
 * @param {() => void} [args.onLost] Receivers only: the link closed after
 *   carrying traffic, while the room was still open. See room.attachLan.
 * @returns {{
 *   start: () => void,
 *   handle: (msg: ControlMessage) => void,
 *   ready: (waitMs?: number) => Promise<boolean>,
 *   close: () => void,
 * }}
 */
export function createLanLink({ role, platform, room, send, onLost }) {
  const mine = listenMode(platform.listen)
  /** @type {LanListenMode | null} */
  let theirs = null
  /** @type {'sender' | 'receiver' | null} */
  let listener = null
  let offerSeen = false
  let closed = false
  /** @type {LanListener | null} */
  let waiting = null

  /** @type {(socket: LanSocket | null) => void} */
  let settle = () => {}
  /** @type {Promise<LanSocket | null>} */
  const link = new Promise(resolve => { settle = resolve })

  /** @param {LanSocket | null} socket */
  const adopt = socket => {
    if (socket && closed) socket.close()
    if (socket && !closed) room.attachLan(socket, { onLost })
    settle(closed ? null : socket)
  }

  // Failures here only mean staying on WebRTC, which is where the session
  // already is. Nothing is reported: a network where the two devices cannot
  // reach each other directly is ordinary, not an error.
  const sendQuietly = /** @param {ControlMessage} msg */ msg => { send(msg).catch(() => {}) }

  async function listen() {
    const token = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
    /** @type {LanListener | null} */
    let opened = null
    try {
      if (platform.open) opened = await platform.open(token)
    } catch {
      opened = null
    }
    if (closed) {
      opened?.close()
      return adopt(null)
    }
    waiting = opened
    // Sent even with nothing to offer, so the peer stops waiting for one now
    // rather than at the end of LINK_WAIT_MS. parseOffer turns an empty list
    // into "no link" on the other side.
    sendQuietly({
      t: 'lan-offer',
      addrs: opened?.addrs ?? [],
      port: opened?.port ?? 0,
      token: toHex(token),
    })
    if (!opened) return adopt(null)
    try {
      adopt(await opened.accepted)
    } catch {
      adopt(null)
    } finally {
      opened.close()
      waiting = null
    }
  }

  /** @param {{ addrs: string[], port: number, token: Bytes }} offer */
  async function dial(offer) {
    const attempts = offer.addrs.map(addr =>
      platform.dial(`ws://${addr}:${offer.port}/`, DIAL_TIMEOUT_MS)
        .then(socket => clientHandshake(socket, offer.token, DIAL_TIMEOUT_MS)))
    try {
      const winner = await Promise.any(attempts)
      // A second address can reach the same listener. The listener takes one
      // connection and closes the rest, but close any that won here too.
      for (const attempt of attempts) {
        attempt.then(socket => { if (socket !== winner) socket.close() }, () => {})
      }
      adopt(winner)
    } catch {
      adopt(null)
    }
  }

  function decide() {
    if (theirs === null) return
    listener = role === 'sender' ? chooseListener(mine, theirs) : chooseListener(theirs, mine)
    if (listener === null) return adopt(null)
    if (listener === role) void listen()
    // Otherwise the peer listens, and its offer drives dial() from handle().
  }

  room.onClose(() => {
    closed = true
    waiting?.close()
    settle(null)
  })

  return {
    start() {
      if (role !== 'sender' || closed) return
      sendQuietly({ t: 'lan-hello', listen: mine })
    },

    handle(msg) {
      if (closed) return
      if (msg.t === 'lan-hello') {
        // One per session. A second is a confused peer, and acting on it
        // would open a second listener.
        if (theirs !== null) return
        theirs = listenMode(msg.listen)
        // The receiver's reply is queued here, synchronously, while its
        // receiver is still processing the sender's hello -- so it leaves
        // ahead of the Accept this side's person has not clicked yet, and a
        // sender reading that Accept has already read this. That ordering is
        // how ready() can tell an old peer from a slow link without waiting.
        if (role === 'receiver') sendQuietly({ t: 'lan-hello', listen: mine })
        decide()
        return
      }
      if (msg.t === 'lan-offer') {
        if (offerSeen || listener === null || listener === role) return
        offerSeen = true
        const offer = parseOffer(msg)
        if (!offer) return adopt(null)
        void dial(offer)
      }
    },

    async ready(waitMs = LINK_WAIT_MS) {
      // No hello from the peer by its Accept means a peer without this path.
      if (theirs === null || listener === null) return false
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), waitMs) })
      const socket = await Promise.race([link, late])
      clearTimeout(timer)
      return socket !== null && room.sendOverLan()
    },

    close() {
      closed = true
      waiting?.close()
      settle(null)
    },
  }
}
