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

/**
 * How to describe a connection's route to the person using it.
 *
 * `label` is the badge text, `detail` the sentence under it. Both surfaces
 * import this for the same reason the refusals above are shared: the web and
 * the CLI describing the same route in two different ways is exactly the drift
 * this file exists to prevent.
 *
 * On the wording. 'local' says "the file's bytes" deliberately, and must not be
 * shortened to "nothing leaves this network": pairing always went out over a
 * public signalling network (nostr or a tracker), and only the file bytes stay
 * on the switch. It also never says "free" or "no data charges" -- a host
 * candidate can belong to a VPN or Tailscale interface, which is a local
 * interface that is not a local network. "Staying on this network" is the
 * strongest claim the ICE evidence actually supports.
 *
 * 'unknown' says what this device does not know, rather than dressing it up as
 * a fourth kind of connection. It is the ordinary result on Node builds.
 *
 * 'relay' says "size-capped" without naming the number on purpose. Importing
 * RELAYED_MAX_BYTES here would make core/ depend on transport/ -- and so on
 * Trystero -- to print one integer; relayCapMessage above takes the limit as an
 * argument for that same reason. The exact figure is told to the user at the
 * only moment it matters, which is when the cap actually refuses a file.
 *
 * @param {NetworkPath} path
 * @returns {{ label: string, detail: string }}
 */
export function pathDescription(path) {
  switch (path) {
    case 'local':
      return {
        label: 'Local network',
        detail: "The file's bytes are staying on this network, not crossing the internet.",
      }
    case 'direct':
      return {
        label: 'Direct, over the internet',
        detail: 'A direct connection to the other device, but the bytes cross the internet.',
      }
    case 'relay':
      return {
        label: 'Through a public relay',
        detail: 'Bytes cross the internet twice, via a third-party TURN server, and are size-capped.',
      }
    default:
      return {
        label: 'Path unknown',
        detail: "This device can't tell which route the connection took.",
      }
  }
}

/**
 * The size at which crossing the internet is worth saying out loud.
 *
 * 25 MiB, and deliberately NOT RELAYED_MAX_BYTES, though the two constants now
 * sit within sight of each other. They answer different questions:
 * RELAYED_MAX_BYTES protects free TURN infrastructure from abuse, this one
 * protects the user's data allowance. Collapsing them to one number -- which
 * looks like an obvious tidy-up -- would let a 90 MB transfer over mobile data
 * go out in silence, which is the exact case this warning was added for.
 */
export const METERED_WARN_BYTES = 25 * 1024 * 1024

/**
 * A heads-up that a transfer big enough to matter is about to cross the
 * internet, or null when there is nothing worth saying.
 *
 * Fires only for 'direct' and 'relay'. Not for 'local', which is the whole
 * point of classifying; and not for 'unknown', which would mean warning about a
 * route we just admitted we cannot identify -- and since 'unknown' is the
 * normal result on Node, that would put a warning on every large CLI send.
 * A warning that fires when we do not know becomes wallpaper, and wallpaper is
 * what stops the relay cap message above from being read.
 *
 * Says "may cost money", never "will": plenty of these run over unmetered home
 * broadband, and a warning that overclaims gets dismissed on sight.
 *
 * This is text, not a gesture. It renders beside the SAS and the Accept button
 * without adding a click to either -- see the safety-gesture note in CLAUDE.md
 * for why a second confirmation here would make the real ones weaker.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {number} args.size
 * @param {NetworkPath} args.path
 * @returns {string | null}
 */
export function meteredWarning({ name, size, path }) {
  if (path !== 'direct' && path !== 'relay') return null
  if (size <= METERED_WARN_BYTES) return null
  return `${name} is ${bytes(size)} and this connection crosses the internet. `
    + 'On a metered connection that may cost money.'
}
