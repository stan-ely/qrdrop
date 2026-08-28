/**
 * An awaitable queue for inbound control messages.
 *
 * The sender needs to block on "accept" and "done" arriving from the peer, but
 * frames are delivered by an event handler that cannot be paused. This buffers
 * messages that show up before anyone is waiting, and parks waiters that arrive
 * before their message -- so the sender can read the exchange as straight-line
 * async code instead of a state machine.
 *
 * @returns {ControlStream}
 */
export function createControlStream() {
  /** @type {ControlMessage[]} */
  const pending = []

  /**
   * @type {{
   *   types: readonly ControlType[],
   *   seq: number | undefined,
   *   resolve: (msg: ControlMessage) => void,
   *   reject: (error: unknown) => void,
   * } | null}
   */
  let waiter = null

  // 'error' matches regardless of seq: a failure means the peer's whole
  // connection state is suspect, not just one file, and the failing side may
  // not even know which file it was -- a malformed control frame has no seq.
  /** @type {(msg: ControlMessage, types: readonly ControlType[], seq?: number) => boolean} */
  const matches = (msg, types, seq) =>
    types.includes(msg.t) && (seq === undefined || msg.seq === seq || msg.t === 'error')

  return {
    push(msg) {
      if (waiter && matches(msg, waiter.types, waiter.seq)) {
        const { resolve } = waiter
        waiter = null
        resolve(msg)
        return true
      }
      pending.push(msg)
      return false
    },

    /** Resolves with the next message matching one of `types` for `seq`. */
    next(types, seq, { signal } = {}) {
      const hit = pending.findIndex(m => matches(m, types, seq))
      if (hit !== -1) return Promise.resolve(pending.splice(hit, 1)[0])
      if (waiter) return Promise.reject(new Error('Control stream already has a waiter'))

      return new Promise((resolve, reject) => {
        waiter = { types, seq, resolve, reject }
        signal?.addEventListener('abort', () => {
          waiter = null
          reject(new Error('Cancelled'))
        }, { once: true })
      })
    },

    fail(error) {
      if (waiter) {
        const { reject } = waiter
        waiter = null
        reject(error)
      }
    },
  }
}
