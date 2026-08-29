/**
 * A signalling network that never leaves the process.
 *
 * Lifted out of room.test.mjs unchanged when a second suite (path.test.mjs)
 * needed a paired room to assert against. It is a fake for `openRoom`'s
 * strategy argument, and nothing more: joinVia only ever touches makeAction,
 * onPeerJoin, onPeerLeave, getPeers and leave on a Trystero room, so none of
 * this has to involve a relay or a peer connection.
 *
 * getPeers() deliberately returns nothing. That is what makes a paired room
 * here report path() === 'unknown', which is exactly the case both suites want
 * to pin: pairing must not depend on being able to read ICE stats.
 */

/**
 * One member of a fake topic. `actions` is keyed by namespace, which is how a
 * send finds the matching handler on the other side.
 *
 * @typedef {object} FakeAction
 * @property {(data: TrysteroPayload, options?: { target?: string }) => Promise<void>} send
 * @property {((data: TrysteroPayload, context: { peerId: string }) => void) | null} onMessage
 *
 * @typedef {object} FakeMember
 * @property {string} id
 * @property {Map<string, FakeAction>} actions
 * @property {{ onPeerJoin: ((id: string) => void) | null,
 *              onPeerLeave: ((id: string) => void) | null }} room
 */

/**
 * A signalling network that never leaves the process.
 *
 * Returns the strategy plus `announced`, every payload sent on the 'ecdh'
 * namespace in order. That list is the most direct statement of the invariant
 * available: it is literally the public keys this process put on the wire.
 *
 * @returns {{ strategy: SignalingStrategy, announced: string[] }}
 */
export function fakeNetwork() {
  /** @type {Map<string, FakeMember[]>} */
  const topics = new Map()
  /** @type {string[]} */
  const announced = []
  let nextId = 0

  /** @param {string} topic */
  const join = topic => {
    let members = topics.get(topic)
    if (!members) {
      members = []
      topics.set(topic, members)
    }
    const roster = members

    /** @type {Map<string, FakeAction>} */
    const actions = new Map()
    const room = {
      /** @type {((id: string) => void) | null} */
      onPeerJoin: null,
      /** @type {((id: string) => void) | null} */
      onPeerLeave: null,

      /** @param {string} namespace */
      makeAction(namespace) {
        /** @type {FakeAction} */
        const action = {
          onMessage: null,
          async send(data, options) {
            if (namespace === 'ecdh' && typeof data === 'string') announced.push(data)
            const target = options?.target
            for (const peer of roster) {
              if (peer === self) continue
              if (typeof target === 'string' && peer.id !== target) continue
              // Deferred, because a relay never calls back from inside send().
              // Delivering synchronously would run the peer's keyAction handler
              // partway through its own onPeerJoin, which is not a sequence the
              // real code can ever see and not one worth making it survive.
              queueMicrotask(() => peer.actions.get(namespace)?.onMessage?.(data, { peerId: self.id }))
            }
          },
        }
        actions.set(namespace, action)
        return action
      },

      // Never asked for a real one: openRoom's isRelayed() reads getPeers()[id]
      // and fails open when it is missing, which is exactly what we want -- the
      // TURN size cap is a courtesy to free infrastructure, not part of pairing.
      getPeers: () => ({}),

      async leave() {
        const i = roster.indexOf(self)
        if (i !== -1) roster.splice(i, 1)
        for (const peer of roster) peer.room.onPeerLeave?.(self.id)
      },
    }

    /** @type {FakeMember} */
    const self = { id: `peer-${nextId++}`, actions, room }
    roster.push(self)

    // Also deferred, and for a load-bearing reason: joinVia assigns
    // room.onPeerJoin *after* strategy.join() returns. Announcing synchronously
    // would fire into a null handler and no pairing would ever start -- the
    // same race the comment above joinVia's createEphemeralKeypair() call
    // describes, reproduced here so the fake cannot paper over it.
    queueMicrotask(() => {
      for (const peer of roster) {
        if (peer === self) continue
        peer.room.onPeerJoin?.(self.id)
        room.onPeerJoin?.(peer.id)
      }
    })

    return room
  }

  return {
    strategy: {
      name: 'fake',
      // Trystero's Room type has fifteen-odd media and RPC members the pairing
      // path never touches. Stubbing them all would be noise that hides drift
      // rather than catching it; the fake conforms to what joinVia actually
      // calls, and this cast is where that claim is made explicit.
      join: /** @type {SignalingStrategy['join']} */ (
        (_config, topic) => /** @type {import('@trystero-p2p/nostr').Room} */ (
          /** @type {unknown} */ (join(topic))
        )
      ),
      urls: [],
    },
    announced,
  }
}
