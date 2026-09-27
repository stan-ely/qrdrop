/**
 * The Channel adapter, kept in its own module and free of third-party imports.
 *
 * Two reasons it does not live in room.js. First, this is the seam: everything
 * in core/ is written against the Channel contract in types/qrdrop.d.ts and
 * nothing else, and a transport swap is a rewrite of room.js plus a rewrite of
 * this function. Naming it makes the boundary something you can point at.
 *
 * Second, testability. Importing room.js opens a relay connection's worth of
 * machinery and drags Trystero in with it; this adapter is the part actually
 * worth exercising under `node --test`, and here it can be imported on its
 * own. See test/channel.test.mjs, which runs a full sealed transfer over a
 * channel with exactly the five contract members and nothing else.
 */

import { LAN_CLOSED } from '../core/messages.js'

/**
 * Wraps one Trystero action as a Channel aimed at a single peer.
 *
 * `bufferedAmount` is pinned at 0 and the listener pair are no-ops because
 * Trystero manages the data channel's buffer itself and never surfaces
 * 'bufferedamountlow'. That is not a stub standing in for something missing:
 * this transport backpressures through the promise `send` returns, which is
 * the other half of the contract, and sender.js awaits it.
 *
 * @param {{ send: (data: Bytes, options?: { target?: string }) => Promise<void> }} action
 * @param {string} peerId The peer we paired with. Frames go to that one peer,
 *   never broadcast -- a third party holding the code can be in the room.
 * @returns {Channel}
 */
export function createChannel(action, peerId) {
  return {
    send: bytes => action.send(bytes, { target: peerId }),
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() {},
    removeEventListener() {},
  }
}

/**
 * A Channel whose target can be replaced mid-session, for the LAN fast path.
 *
 * core/ captures a channel once -- sendFile and createReceiver each keep the
 * object they were handed -- so moving a session's frames onto another socket
 * cannot mean handing out a new channel. It means handing out this one from
 * the start and changing what it points at. room.js does that at exactly one
 * moment (see sendOverLan there and lan.js for why that moment).
 *
 * Every member reads the current target at the call, not at construction.
 * The listener pair forwards to whichever target is current when it is
 * called, which is only sound because both targets on this path are inert
 * there: Trystero's pins bufferedAmount at 0 and lan.js's backpressures
 * through send()'s promise, so sender.js's drain() never registers a
 * listener on either. A target that did fire 'bufferedamountlow' would need
 * the switch to carry listeners across, and does not exist.
 *
 * @param {Channel} initial
 * @returns {Channel & { switchTo: (next: Channel) => void }}
 */
export function createSwitchableChannel(initial) {
  let current = initial
  return {
    send: bytes => current.send(bytes),
    get bufferedAmount() { return current.bufferedAmount },
    get bufferedAmountLowThreshold() { return current.bufferedAmountLowThreshold },
    set bufferedAmountLowThreshold(value) {
      current.bufferedAmountLowThreshold = value
    },
    addEventListener(type, listener) { current.addEventListener(type, listener) },
    removeEventListener(type, listener) { current.removeEventListener(type, listener) },
    switchTo(next) {
      next.bufferedAmountLowThreshold = current.bufferedAmountLowThreshold
      current = next
    },
  }
}

// Frames queued into a LAN socket before send() starts waiting, and the level
// it waits down to. A frame is ~16 KiB, so the high mark is ~64 in flight:
// enough to keep a Wi-Fi link busy between polls, and small enough that a
// socket which has died silently strands at most a megabyte. These are the
// figures app/CAPABILITIES.md measured the path with.
const LAN_HIGH_WATER = 1024 * 1024
const LAN_LOW_WATER = 256 * 1024


/**
 * Wraps an authenticated LAN socket as a Channel, for room.js's sendOverLan.
 *
 * Backpressure goes through send()'s promise, as it does for Trystero, so
 * bufferedAmount reads 0 and the listener pair is inert -- which is what
 * lets createSwitchableChannel swap the two without carrying listeners
 * across. The socket's own bufferedAmount is the real figure, and send()
 * waits on it.
 *
 * send() refuses a closed socket rather than writing into it. A browser
 * WebSocket accepts a send after close and discards it with no error, so
 * without the check a link that died mid-file would have the rest of the
 * file and its completion vanish, and the sender would sit on a 'done' that
 * never comes. Refusing turns that into a failed transfer at the next chunk.
 *
 * @param {LanSocket} socket
 * @returns {Channel}
 */
export function createLanChannel(socket) {
  return {
    async send(bytes) {
      if (!socket.open) throw new Error(LAN_CLOSED)
      socket.send(bytes)
      if (socket.bufferedAmount > LAN_HIGH_WATER) await socket.drained(LAN_LOW_WATER)
    },
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() {},
    removeEventListener() {},
  }
}
