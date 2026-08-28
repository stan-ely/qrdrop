/**
 * User-facing copy shared by every surface that can refuse or lose a
 * transfer -- currently the web component and the CLI.
 *
 * Both used to carry their own copy of these strings, and the two copies
 * drifted apart in small, easy-to-miss ways (a word order swapped, "for" vs
 * "over the") each time one surface got edited without the other. Neither
 * divergence was ever intentional -- there is no reason a sender should read
 * a differently-worded refusal on the web than on the CLI -- so one copy,
 * imported by both, makes the drift impossible instead of just unlikely.
 */

import { bytes } from './format.js'

/**
 * Refusing to even start a send once the connection is known to be relayed
 * and the file is over the cap. Used by the sender, before the manifest goes
 * out -- see RELAYED_MAX_BYTES in transport/room.js for why the cap exists.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {number} args.size
 * @param {number} args.limit
 * @returns {string}
 */
export function relayCapMessage({ name, size, limit }) {
  return `This connection is going through a public relay, capped at ${bytes(limit)}. `
    + `${name} is ${bytes(size)}. Try again on a network where a direct connection is possible.`
}

/**
 * The receiver's side of the same refusal: an incoming offer is declined
 * because it is over the cap on a relayed connection. Deliberately a
 * different sentence from `relayCapMessage` above, not a smaller variant of
 * it -- the sender is being told to try again, the receiver is being told why
 * the offer it just saw got declined -- but it names the same numbers the
 * same way, which is the part that used to drift.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {number} args.size
 * @param {number} args.limit
 * @returns {string}
 */
export function relayCapDeclineMessage({ name, size, limit }) {
  return `${name} (${bytes(size)}) is over the ${bytes(limit)} limit for a transfer going through a public relay.`
}

/**
 * The peer vanished mid-session -- socket closed, tab closed, network drop --
 * with no more specific error available. Both surfaces use this exact
 * sentence today by coincidence; keeping it a shared constant is what keeps
 * that a guarantee. e2e/interop.e2e.mjs matches on this text from the CLI
 * side, so it cannot change without checking there first.
 */
export const PEER_DISCONNECTED = 'The other device disconnected.'
