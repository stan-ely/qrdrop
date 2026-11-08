/**
 * The app's LanPlatform: what src/transport/lan.js borrows from the Tauri
 * shell. Registered by app/src/main.js and by nothing else, so the deployed
 * website never has one (CLAUDE.md, "The platform seam must stay a seam").
 *
 * Dialling out is the page's own WebSocket; step 2 of the fast path's
 * Phase 0 measured Android's WebView opening ws:// to a LAN address from
 * http://tauri.localhost with no prompt (app/CAPABILITIES.md). The CSP
 * allowance is LAN_ORIGINS in scripts/build-site.mjs.
 *
 * Listening is src-tauri/src/lan.rs, reached by one WebSocket of the page's
 * own to 127.0.0.1. The page presents the token there as well, and the relay's
 * ACK means "your peer has arrived and presented it too", so the wait has no
 * timeout of its own: it lasts as long as the peer takes, and the room closing
 * ends it (close() below).
 */

import { dialWebSocket, clientHandshake } from '../../src/transport/lan.js'
import { acceptRendezvous, nextMessage } from '../../src/transport/rendezvous.js'
import { offlinePairing } from './offline.js'

// The page's side of its own relay: 127.0.0.1, on a port the relay just
// bound, so anything longer than this is not a slow network.
const LOCAL_DIAL_MS = 5000

// The relay's cue that a peer has arrived on a page socket: lan.js's ACK,
// then the peer's IPv4 address (src-tauri/src/lan.rs, `join`).
const ACK = 0x06
const CUE_BYTES = 5

/** @param {Bytes} bytes */
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

/**
 * Resolves once the shell has said whether listening is quiet on this OS
 * (src-tauri/src/lan.rs's MODE), which is why this is async and main.js
 * registers the result when it arrives rather than before defineQRDrop().
 * element.js reads getPlatform().lan per session, not at construction, so a
 * registration that lands a few milliseconds after start-up is in time for
 * any pairing.
 *
 * @returns {Promise<LanPlatform>}
 */
export async function createTauriLan() {
  const { invoke } = await import('@tauri-apps/api/core')
  /** @type {LanListenMode} */
  const listen = await invoke('lan_mode')
  const WebSocketImpl = /** @type {import('../../src/transport/lan.js').WebSocketCtor} */ (
    /** @type {unknown} */ (WebSocket))

  return {
    listen,

    async open(token, answer) {
      /** @type {{ port: number, localPort: number, addrs: string[] }} */
      const { port, localPort, addrs } = await invoke('lan_listen', { token: toHex(token), answer: toHex(answer) })
      let arrived = false
      const accepted = dialWebSocket(WebSocketImpl, `ws://127.0.0.1:${localPort}/`, LOCAL_DIAL_MS)
        .then(socket => clientHandshake(socket, token))
        .then(socket => { arrived = true; return socket })
      accepted.catch(() => {})
      return {
        port,
        addrs,
        accepted,
        // lan.js calls this once the link is up, meaning "stop listening",
        // and the relay has already stopped by then: it takes one connection
        // on each side. Aborting it at that point would cut the very link
        // just made, so only a listener nobody reached is stopped here. An
        // established link ends when the page closes its socket.
        close() {
          if (!arrived) invoke('lan_close').catch(() => {})
        },
      }
    },

    dial: (url, timeoutMs) => dialWebSocket(WebSocketImpl, url, timeoutMs),

    /**
     * The offline listener, when Settings has "Pair without internet" on
     * (offline.js), and null when it is off. The relay accepts; this side
     * proves. Each page socket presents the token, waits for the relay's cue
     * that a peer is on the other end of it, and is then one connection for
     * acceptRendezvous, which keeps the first that proves the code.
     */
    async openOffline(secret) {
      if (!offlinePairing()) return null
      const token = crypto.getRandomValues(new Uint8Array(16))
      /** @type {{ id: number, port: number, localPort: number, addrs: string[] }} */
      const { id, port, localPort, addrs } = await invoke('offline_listen', { token: toHex(token) })
      const stop = () => { invoke('offline_close', { id }).catch(() => {}) }

      const acceptor = acceptRendezvous({
        secret,
        arrivals: async () => {
          const socket = await dialWebSocket(WebSocketImpl, `ws://127.0.0.1:${localPort}/`, LOCAL_DIAL_MS)
          socket.send(token)
          // Null once the relay has stopped, which drops its waiting sockets.
          const cue = await nextMessage(socket)
          if (!cue || cue.length !== CUE_BYTES || cue[0] !== ACK) {
            socket.close()
            return null
          }
          return { socket, from: Array.from(cue.subarray(1)).join('.') }
        },
      })
      // A win stops the relay taking more; the winner's link is a task of its
      // own there and runs on.
      acceptor.accepted.then(stop, () => {})
      return {
        port,
        addrs,
        locator: addrs.length ? { port, addresses: addrs } : null,
        accepted: acceptor.accepted,
        close() {
          acceptor.close()
          stop()
        },
      }
    },
  }
}
