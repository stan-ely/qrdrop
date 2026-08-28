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
