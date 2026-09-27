/**
 * The CLI's LanPlatform: what transport/lan.js borrows from Node.
 *
 * Dialling uses Node's global WebSocket (undici, stable from Node 22, which
 * package.json's engines already requires), so the connecting side needs no
 * code of its own. Listening is node/lan-server.js, and it is offered only
 * where it is quiet.
 *
 * WHERE LISTENING IS QUIET. Linux has no per-application prompt for an
 * inbound connection. Windows Defender Firewall asks the person the first
 * time node.exe listens on a network interface, and on macOS the
 * application firewall does the same when it is on. A CLI that popped a
 * system dialog mid-transfer would be doing something the person never
 * asked for, so on both it says 'prompt' and never listens. It still dials
 * out, which prompts nobody. So a Windows CLI takes the fast path whenever
 * the other end can listen quietly: a phone, a Linux machine.
 */

import process from 'node:process'
import { dialWebSocket } from '../transport/lan.js'
import { listenLan } from './lan-server.js'

/**
 * QRDROP_LAN_LISTEN overrides the answer, and exists for testing on one
 * machine. Two CLIs on Windows both say 'prompt', so they never exercise the
 * listener; setting it to 'quiet' on one of them does, and it is how the
 * interop e2e covers this path on any OS. It is not a way to hide a firewall
 * prompt: on a machine where node has no firewall rule yet, the prompt
 * still appears, which is the person's own choice once they have set this.
 *
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.os] Overridable for tests.
 * @param {string | undefined} [options.override] Defaults to QRDROP_LAN_LISTEN.
 * @returns {LanPlatform}
 */
export function nodeLanPlatform({ os = process.platform, override = process.env.QRDROP_LAN_LISTEN } = {}) {
  const WebSocketImpl = /** @type {import('../transport/lan.js').WebSocketCtor} */ (
    /** @type {unknown} */ (globalThis.WebSocket))
  /** @type {LanListenMode} */
  const quietHere = os === 'linux' || os === 'android' ? 'quiet' : 'prompt'
  return {
    listen: override === 'quiet' || override === 'prompt' || override === 'none' ? override : quietHere,
    open: token => listenLan({ token }),
    dial: (url, timeoutMs) => dialWebSocket(WebSocketImpl, url, timeoutMs),
  }
}
