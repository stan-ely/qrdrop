import { sealControl } from './frame.js'

/**
 * Per-direction send queues, keyed on the nextControlIndex function itself
 * rather than on a channel or a key -- because that function IS the direction:
 * every control message one side originates (the manifest and completion from
 * sender.js, every reply from receiver.js, the path verdict) takes its nonce
 * index from it.
 *
 * @type {WeakMap<() => number, Promise<void>>}
 */
const outbound = new WeakMap()

/**
 * The outbound half of the control stream: seals one message at the next
 * control index and hands it to the channel, strictly in index order.
 *
 * Taking the index, sealing and sending are one queued step, and that is the
 * point of this function. They used to be three steps at every call site: take
 * the index synchronously, await the seal, then send. Two messages started
 * together could therefore reach the wire in whichever order WebCrypto
 * finished encrypting them, and a control frame that arrives out of index order
 * is fatal by design -- open() in frame.js reads it as our own peer
 * contradicting itself. It surfaced on a device as "Out-of-order frame:
 * expected 0, got 1" on a phone receiving from the CLI, whose path verdict and
 * manifest go out back to back, and reproduced deterministically once the
 * first seal was merely slower than the second. receiver.js had already
 * serialised pause/resume for exactly this reason, believing every other send
 * was ordered by the inbound frame queue; the path verdict and the Accept click
 * never were. One queue per direction fixes all of them, including senders
 * added later that nobody thinks to serialise.
 *
 * The contract this puts on callers: pass the SAME nextControlIndex function
 * to every sender in one direction, never several closures over one counter.
 * Order is queued per function, so copies would each get a queue of their own
 * and race each other exactly as before.
 *
 * A failed send does not stall the messages behind it -- the queue carries on
 * past a rejection -- and the rejection still reaches this call's own caller.
 *
 * @param {object} args
 * @param {Channel} args.channel
 * @param {CryptoKey} args.key This side's send key. Never the receive key.
 * @param {() => number} args.nextControlIndex One function per direction; see above.
 * @param {ControlMessage} msg
 * @returns {Promise<void>}
 */
export function sendControl({ channel, key, nextControlIndex }, msg) {
  const tail = outbound.get(nextControlIndex) ?? Promise.resolve()
  const sent = tail.then(async () => {
    // Inside the queued step, so the index is taken only once every message
    // queued before this one has been handed to the channel.
    await channel.send(await sealControl(key, nextControlIndex(), msg))
  })
  outbound.set(nextControlIndex, sent.catch(() => {}))
  return sent
}

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

  // Application-level flow control, kept apart from the pending[] queue above.
  //
  // The peer sends { t: 'pause' } when its sink has fallen behind the chunks we
  // are producing and { t: 'resume' } once it has caught up. This is not a
  // reply the sender asked for -- routed through push()/next() like an accept
  // or a done, it would sit in `pending` for some later next(['done']) to match
  // by accident -- so it toggles a gate the send loop consults directly. Same
  // treatment, same reason, as the 'path' message, which also never touches
  // this queue.
  let flowPaused = false
  /** @type {(() => void) | null} Resolves the gate promise handed out below. */
  let releaseFlow = null

  // 'error' matches regardless of seq: a failure means the peer's whole
  // connection state is suspect, not just one file, and the failing side may
  // not even know which file it was -- a malformed control frame has no seq.
  /** @type {(msg: ControlMessage, types: readonly ControlType[], seq?: number) => boolean} */
  const matches = (msg, types, seq) =>
    // 'path', 'pause' and 'resume' carry no seq -- they describe the connection,
    // not a file -- and are routed straight past this queue (to their callback
    // or to setFlow) before ever reaching it. The `'seq' in msg` guard is here
    // so the type of msg.seq stays honest rather than to catch a message that
    // can actually arrive.
    types.includes(msg.t) && (seq === undefined || msg.t === 'error'
      || ('seq' in msg && msg.seq === seq))

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

    /** @param {'pause' | 'resume'} kind */
    setFlow(kind) {
      if (kind === 'pause') {
        flowPaused = true
        return
      }
      flowPaused = false
      // A 'resume' that arrives while the sender is parked on the gate promise
      // releases it. One that arrives with nobody waiting just clears the flag,
      // and the next flowGate() call returns null.
      releaseFlow?.()
      releaseFlow = null
    },

    flowGate() {
      if (!flowPaused) return null
      // The executor runs synchronously, so releaseFlow is set before this
      // returns -- a 'resume' racing in on the next tick cannot miss it.
      return new Promise(resolve => { releaseFlow = resolve })
    },
  }
}
