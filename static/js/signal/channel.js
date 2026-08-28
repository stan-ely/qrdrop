/**
 * The Channel adapter, kept in its own module and free of third-party imports.
 *
 * Two reasons it does not live in room.js. First, this is the seam: everything
 * in transfer/ is written against the Channel contract in types/qrbeam.d.ts and
 * nothing else, and a transport swap is a rewrite of room.js plus a rewrite of
 * this function. Naming it makes the boundary something you can point at.
 *
 * Second, testability. room.js imports deps.js, which imports third-party
 * modules by absolute jsDelivr URL -- a specifier Node will not resolve. So
 * nothing that imports room.js can be exercised under `node --test`, and the
 * one part worth exercising there is exactly this adapter. Here, it is
 * importable. See test/channel.test.mjs.
 */

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
