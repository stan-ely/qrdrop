/**
 * What <qr-drop> tells its host page, in the shape it tells it.
 *
 * The component dispatches two events on itself and knows nothing about who is
 * listening. `screenchange` says which screen is showing and whether a session
 * is running on it; `transferend` hands over the record of a transfer that has
 * reached the done screen. The Tauri shell (app/src/shell.js) is the consumer,
 * and an embedder of `qrdrop/web` may use them too.
 *
 * The record is built here, away from element.js, so that the one thing that
 * matters about it can be tested in bare Node: what it leaves out. `state`
 * holds the pairing code, the digest and any received text, and this is the
 * door they could leave by. It is an explicit list of fields rather than a
 * copy with some removed, so a field added to the state later stays inside
 * until someone decides otherwise.
 */

/**
 * @typedef {object} TransferRecord
 * @property {string | null} name null when no file was involved or known, as
 *   on a failure, which clears it
 * @property {number | null} size
 * @property {'sent' | 'received' | null} direction
 * @property {string | null} route how the bytes travelled: 'lan', 'quic',
 *   'beam', or the classified NetworkPath
 * @property {string | null} outcome
 * @property {string | null} location where a received file was saved, when the
 *   app chose the place itself
 * @property {string} date ISO 8601
 */

/**
 * @param {import('./view.js').State} state the state as the done screen has it
 * @param {Date} [now]
 * @returns {TransferRecord}
 */
export function transferRecord(state, now = new Date()) {
  const direction = state.role === 'sender' ? 'sent' : state.role === 'receiver' ? 'received' : null
  // In the order the badge decides it, because this is the same question: the
  // fast paths replace the classification, which by then describes a WebRTC
  // connection the file stopped using.
  const route = state.mode === 'beam' ? 'beam' : state.lan ? 'lan' : state.quic ? 'quic' : state.path
  return {
    name: state.file?.name ?? null,
    size: state.file?.size ?? null,
    direction,
    route,
    outcome: state.outcome,
    location: state.saveLocation,
    date: now.toISOString(),
  }
}
