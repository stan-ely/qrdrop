/**
 * What <qr-drop> tells its host page, in the shape it tells it.
 *
 * The component dispatches two events on itself and knows nothing about who is
 * listening. `screenchange` says which screen is showing and whether a session
 * is running on it; `transferend` hands over the record of a session that has
 * ended, however it ended. The Tauri shell (app/src/shell.js) is the consumer,
 * and keeps the record as the app's History; an embedder of `qrdrop/web` may
 * use them too.
 *
 * The record is built here, away from element.js, so that the one thing that
 * matters about it can be tested in bare Node: what it leaves out. `state`
 * holds the pairing code, the digest and any received text, and this is the
 * door they could leave by -- onto the device's disk, for as long as the
 * person keeps their history. It is an explicit list of fields rather than a
 * copy with some removed, so a field added to the state later stays inside
 * until someone decides otherwise. app/src-tauri/src/history.rs refuses a
 * record with any field it does not name, which is the same list again, on
 * the other side of the IPC.
 */

/**
 * @typedef {'sent' | 'received' | 'declined' | 'failed' | 'too-large' | 'mismatch' | 'cancelled' | 'beamed'} RecordOutcome
 *   The done screen's outcomes, plus two that end on choose instead:
 *   'cancelled' (Cancel, or a second Back) and 'beamed', a beam the sender
 *   stopped, which is all a beam sender can ever know about how it went.
 *
 * @typedef {object} TransferRecord
 * @property {'file' | 'text'} kind 'text' is a typed message, recorded as
 *   that and nothing more: no name, no location, and never its content
 * @property {string | null} name null for a message, and when no file was
 *   known, as when a too-large offer was turned away before it was drawn
 * @property {number | null} size
 * @property {'sent' | 'received' | null} direction
 * @property {string | null} route how the bytes travelled: 'lan', 'quic',
 *   'beam', or the classified NetworkPath
 * @property {RecordOutcome} outcome
 * @property {string | null} location where a received file was saved, when the
 *   app chose the place itself
 * @property {string} date ISO 8601
 */

/**
 * @param {import('./view.js').State} state the state the session ended in:
 *   the done screen's, or on a landing on choose the state just before it,
 *   since the reset clears everything a record would read
 * @param {object} [options]
 * @param {import('./view.js').State} [options.prior] the state just before,
 *   read for what the ending cleared: a failure and a mismatch both drop
 *   `file`, and a failed transfer was still a transfer of something with a name
 * @param {RecordOutcome | null} [options.outcome] for an ending that is not
 *   a done screen, and so has no outcome of its own in the state
 * @param {Date} [options.now]
 * @returns {TransferRecord}
 */
export function transferRecord(state, { prior = state, outcome = state.outcome, now = new Date() } = {}) {
  const role = state.role ?? prior.role
  const direction = role === 'sender' ? 'sent' : role === 'receiver' ? 'received' : null
  // In the order the badge decides it, because this is the same question: the
  // fast paths replace the classification, which by then describes a WebRTC
  // connection the file stopped using. Not from `prior`: a mismatch clears the
  // route on purpose (_rejectVerification says why), and history must not
  // remember the connection the person was just told not to trust.
  const route = state.mode === 'beam' ? 'beam' : state.lan ? 'lan' : state.quic ? 'quic' : state.path
  const kind = state.isText || prior.isText ? 'text' : 'file'
  const subject = state.file ?? state.offer ?? prior.file ?? prior.offer
  return {
    kind,
    // A message's name is the one text.js gives every message, and saying it
    // would only dress the record up as a file. Its size is kept: it is how
    // long the message was, which is not what it said.
    name: kind === 'text' ? null : subject?.name ?? null,
    size: subject?.size ?? null,
    direction,
    route,
    outcome: outcome ?? 'cancelled',
    location: kind === 'text' ? null : state.saveLocation,
    date: now.toISOString(),
  }
}
