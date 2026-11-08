/**
 * Settings' "Pair without internet": whether a send from this app listens on
 * the local network and puts this device's address in the code
 * (docs/notes/offline-pairing.md). Read by both sessions at the moment a
 * send starts -- lan.js's openOffline for the page's, native.js for the
 * Rust one -- so a change takes effect on the next send and never reaches
 * one already showing its code.
 *
 * OFF UNTIL SWITCHED ON, for two reasons. A code with an address in it says
 * "Not a qrdrop code" to a receiver older than npm 0.7.0 or app-v1.4.0,
 * which is why nothing emits one by default until a release cycle after
 * those. And on Windows and macOS listening raises the OS's firewall prompt,
 * which should be the price of a choice the person made rather than a
 * surprise on their first send.
 *
 * localStorage and not history.rs's store, because the failure is the
 * harmless one: storage that is cleared or blocked reads as off, which is
 * how every send behaved before this existed. History is in Rust precisely
 * because its switch must not come back on by itself; this one coming back
 * off costs a person one tap.
 */

const KEY = 'qrdrop:offline-pairing'

/** @returns {boolean} */
export function offlinePairing() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/**
 * @param {boolean} on
 * @returns {boolean} What is now stored, which is off when storage refused.
 */
export function setOfflinePairing(on) {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch { /* blocked: reads as off, below */ }
  return offlinePairing()
}
