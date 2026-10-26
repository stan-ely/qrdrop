/**
 * Keeps Trystero's relay sockets from retiring for good.
 *
 * Trystero's `makeSocket` retries a closed relay socket with a doubling
 * backoff, and when the period reaches its 60 s cap it sets `isClosed` and
 * never dials that relay again. Its relay manager hands that same dead client
 * to every room joined afterwards, for the life of the page, so a later
 * pairing joins nothing and times out with no error that says why. Measured on
 * an Android 15 emulator: the app in the background for about a minute puts it
 * behind the platform's background firewall, every relay socket closes and
 * fails its five retries, and every receive after that times out until a
 * force-stop. `navigator.onLine` stays true throughout, so Trystero's own
 * offline pause never engages; the website on a phone has the same exposure.
 *
 * The one public lever is the reconnection lock that pause/resume drive. While
 * it is held, a closing socket queues its redial behind the lock rather than
 * spending a backoff step, so it cannot reach the cap. This module holds it at
 * all times and lets go only while a pairing is waiting for its peer, briefly,
 * on a tick: the queued sockets redial exactly when someone needs them, and the
 * lock is back before the next close. room.js joins with
 * `manualReconnection: true`, which turns off Trystero's online/offline
 * watcher -- that watcher would release the lock on an `online` event and
 * leave it released, which is the state this exists to prevent.
 *
 * Patching Trystero, or replacing the dead client in its relay manager, was the
 * alternative. Neither is reachable without forking the package: `init` and the
 * relay map are closures. Reloading the page when every socket reads closed was
 * the other, and it only helps on the choose screen and only after the damage.
 *
 * Between pairings no timer runs, so a Node process holding the lock can still
 * exit: the lock is a pending promise, which keeps nothing alive.
 *
 * Reported upstream as https://github.com/dmotz/trystero/issues/208. When a
 * release stops retiring sockets, the first test in test/reconnect.test.mjs
 * fails, and this module and the `manualReconnection` flag can go.
 */

/** How often a waiting pairing releases the lock so queued sockets redial. */
export const RELEASE_EVERY_MS = 5000

/**
 * @param {object} lock Trystero's pauseRelayReconnection and
 *   resumeRelayReconnection. Every strategy shares one lock, because they share
 *   one `@trystero-p2p/core`.
 * @param {() => void} lock.pause
 * @param {() => void} lock.resume
 * @param {number} [everyMs]
 * @param {(fn: () => void) => void} [nextTask] Runs `fn` once the microtask
 *   queue has drained. A test under mocked timers passes the real setImmediate,
 *   because a mocked tick runs a zero-delay timer before any microtask.
 */
export function createReconnectGate({ pause, resume }, everyMs = RELEASE_EVERY_MS, nextTask = fn => { setTimeout(fn, 0) }) {
  /**
   * Release, then take the lock back on the next task. Not synchronously:
   * Trystero clears its lock in a `.finally` and runs the queued redials in a
   * `.then` after it, so a pause in the same tick finds the old lock still set,
   * does nothing, and is then cleared along with it.
   */
  const release = () => {
    resume()
    nextTask(pause)
  }

  return {
    hold: pause,

    /**
     * Hold the lock, and while `waiting` is unsettled, release it now and
     * every `everyMs` so sockets that closed since the last pairing come back.
     *
     * @template T
     * @param {Promise<T>} waiting
     * @returns {Promise<T>}
     */
    async whilePairing(waiting) {
      pause()
      release()
      const timer = setInterval(release, everyMs)
      try {
        return await waiting
      } finally {
        clearInterval(timer)
      }
    },
  }
}
