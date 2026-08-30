/**
 * The pure `state -> vnode tree` function for `<qr-drop>`.
 *
 * This is the file to read to understand the UI: every screen, every piece
 * of user-facing copy, and every id the e2e suite depends on lives here in
 * one place, instead of scattered across forty-odd imperative DOM pokes the
 * way it used to be (see the note at the top of the old element.js).
 *
 * HARD RULE: `render` takes a plain state object and a `dispatch` function
 * and returns vnodes. It never touches `document`, `window`, a room, a
 * socket, a camera, or a promise. Two calls with the same `state` produce
 * the same tree, full stop -- that is what makes this file legible without
 * running the app, and it is what element.js's `_setState` leans on: a
 * screen that cannot be reached cannot be rendered, and a screen that is
 * reached renders identically no matter what came before it.
 *
 * `dispatch(intent, payload)` is the only way a rendered element talks back.
 * The intents are: 'send:pick', 'receive:scan', 'manual:submit' (payload:
 * the raw text typed or pasted), 'verify:confirm', 'offer:accept',
 * 'offer:decline', 'cancel', 'restart', 'copy' (payload: 'code' | 'digest'),
 * 'beam:pick', 'beam:scan', 'beam:fps' (payload: the chosen number). The
 * beam intents are the no-network path's equivalents of 'send:pick' /
 * 'receive:scan' -- a separate pair rather than overloading the originals,
 * because element.js needs to know at the moment of the click which of two
 * entirely different subsystems (WebRTC pairing vs. web/beam.js's player or
 * camera collector) to spin up. Drag-and-drop and paste are deliberately NOT
 * among them -- element.js wires those on the host element itself (see its
 * class comment), because "drop anywhere on the component" is a property of
 * the whole custom element, not of any one vnode this file describes.
 *
 * ALL EIGHT SCREENS ARE ALWAYS PRESENT IN THE TREE, toggled with the `hidden`
 * boolean prop rather than being added and removed. Three things depend on
 * that: e2e/transfer.e2e.mjs asserts on `#screen-X:not([hidden])`, the vdom's
 * node-reuse-by-key needs stable positions to keep `<video id="scanner">`'s
 * live MediaStream and `#manual-input`'s focus/caret across re-renders (see
 * vdom.js's canReuse), and it is what makes "only one screen visible at a
 * time" a rendering fact rather than something every call site has to
 * remember to maintain by hand.
 *
 * The same rule now governs the step rail INSIDE each card, for the sharper
 * version of the second reason: it is rendered hidden on the beam screens
 * rather than omitted, because omitting it would shift .card-body up a
 * position and canReuse would rebuild the subtree holding the adopted canvas.
 * See stepRail below.
 */

import { h } from './vdom.js'
import { bytes, duration } from '../core/format.js'
import { pathDescription, meteredWarning } from '../core/messages.js'
// A value import, not just a type -- checked once against beam.js's own
// module top level before relying on it here: it defines constants and
// exported functions and touches neither `document` nor a camera at import
// time (the DOM work only happens inside startBeamSend/startBeamReceive,
// which this file never calls). That makes it safe for a PURE file to import
// without smuggling a side effect in behind it. FPS_CHOICES is also exactly
// the "one source of truth" src/web/tokens.js already models for the design
// tokens -- duplicating the array here would drift the day someone tunes the
// range in beam.js and forgets this copy.
import { FPS_CHOICES, DEFAULT_FPS } from './beam.js'

/**
 * The shape element.js's `_state` always is -- mirrors its `_initialState()`
 * field for field. Declared here, not in element.js, because this is the
 * file a reader reaches for to know what the UI can represent at all;
 * element.js references it back via `import('./view.js').State`.
 *
 * @typedef {object} State
 * @property {'choose' | 'send' | 'receive' | 'verify' | 'transfer' | 'done' | 'beam-send' | 'beam-receive'} screen
 * @property {'sender' | 'receiver' | null} role
 * @property {'p2p' | 'beam'} mode
 * @property {string} status
 * @property {string | null} error
 * @property {string | null} manualError a rejected hand-entered code, shown
 *   against the input rather than in the page-level banner
 * @property {string} code
 * @property {Element | null} qrNode
 * @property {boolean} qrIsLink whether the QR on the send screen carries a
 *   link (the deployed site, which sets base-url) or the bare `qrdrop:`
 *   code (an embedder that did not). It changes what the other device has
 *   to do, so the send screen has to say which one it drew.
 * @property {NetworkPath | null} path which route
 *   the connection took, or null before classification resolves -- and always
 *   null in beam mode, which has no connection to classify.
 * @property {string | null} pathDebug TEMPORARY: the raw candidate-pair dump,
 *   populated only under `?debug=path`. Remove with collectPathEvidence.
 * @property {boolean} cameraAvailable
 * @property {string | null} capabilityNote
 * @property {string} sas
 * @property {string[]} sasWords
 * @property {{ name: string, size: number } | null} offer
 * @property {{ name: string, size: number } | null} file
 * @property {{ moved: number, total: number } | null} progress
 * @property {'sent' | 'received' | 'declined' | 'failed' | 'too-large' | null} outcome
 * @property {string | null} message
 * @property {string} digest
 * @property {boolean} dragging
 * @property {'code' | 'digest' | 'code-failed' | 'digest-failed' | null} copied
 * @property {boolean} pairing
 * @property {boolean} busy true between the receiver's Accept click and the
 *   save destination coming back -- see element.js's onOfferAccept handlers
 * @property {Element | null} dialogNode the adopted <dialog> element.js owns.
 *   Its contents are patched separately -- see dialogContent below.
 * @property {string | null} toast a transient announcement, cleared on a timer
 *   by element.js. For things that HAPPENED rather than things that are true:
 *   a state a screen can go on describing belongs in `status`, which is always
 *   on screen, not in something that disappears.
 * @property {'beam-offer' | 'error' | 'info' | null} modal which sheet is open, if any.
 *   The sheet is the only box on a non-scrolling page allowed to scroll
 *   inside itself, so it is where long copy and anything unplanned goes.
 * @property {Element | null} beamNode the adopted <canvas> the player owns
 * @property {{ fps: number, loops: number, solved: number, blocks: number, eta: number | null } | null} beam
 *   `eta` is seconds: one full pass on the sending screen, and the measured
 *   time remaining on the receiving one. Null while there is not yet enough
 *   evidence to estimate honestly.
 */

/** @typedef {(intent: string, payload?: any) => void} Dispatch */

const SCREENS = /** @type {const} */ ([
  'choose', 'send', 'receive', 'verify', 'transfer', 'done', 'beam-send', 'beam-receive',
])

// The three-step rail's labels, indexed by the screen that step covers.
// 'choose' has no entry -- the rail is hidden there, because there is
// nothing yet to show progress through.
/** @type {Record<string, number>} */
const STEP_INDEX = { send: 0, receive: 0, verify: 1, transfer: 2, done: 2 }
const STEP_LABELS = ['Connect', 'Verify', 'Transfer']

const SUCCESS_OUTCOMES = new Set(['sent', 'received'])

// Every screen's builder, keyed by screen name. Module scope rather than a
// local inside screen() because dialogContent() needs it too: the `info` sheet
// reads its copy straight back off the builder for state.screen rather than
// keeping a second copy of it (the same reasoning tokens.js applies to the
// palette). The functions are declarations, so referencing them from a
// module-scope const above their definitions is safe -- they are hoisted and
// initialised before this runs.
/** @type {Record<typeof SCREENS[number], (state: State, dispatch: Dispatch) => { media?: any, body: any[], actions: any[], info?: { title: string, content: import('./vdom.js').VNode[], label?: string } | null }>} */
const builders = {
  choose, send, receive, verify, transfer, done,
  'beam-send': beamSend, 'beam-receive': beamReceive,
}

/**
 * The network-path badge, plus the metered warning when there is one.
 *
 * Returns null rather than a placeholder while `path` is still null: the
 * classification resolves a beat after pairing, and a badge that reads "Path
 * unknown" for two seconds before correcting itself to "Local network" is worse
 * than one that simply arrives. Also null in beam mode -- beam has no peer
 * connection, and a badge there would be describing nothing.
 *
 * `aria-live="polite"` because it does arrive late: without it a screen-reader
 * user is never told the path at all, having already been read the screen.
 *
 * Passive text by construction -- no button, no dismiss, nothing focusable.
 * The two safety gestures are the SAS confirm and Accept, and this renders
 * beside them without becoming a third thing to click past.
 *
 * @param {State} state
 */
function pathBadge(state) {
  if (!state.path || state.mode === 'beam') return null

  const { label, detail } = pathDescription(state.path)
  // The sender knows the file, the receiver knows the offer; whichever this
  // side has is the size the warning should be about.
  const subject = state.file ?? state.offer
  const warning = subject
    ? meteredWarning({ name: subject.name, size: subject.size, path: state.path })
    : null

  return h('div', { class: 'path-info', 'aria-live': 'polite' }, [
    h('p', { class: `path-badge ${state.path}` }, label),
    h('p', { class: 'note' }, detail),
    warning ? h('p', { class: 'callout warn' }, warning) : null,
    // TEMPORARY, `?debug=path` only. Text content via h(), never innerHTML --
    // this is peer-influenced data (addresses the other device chose to send)
    // and the no-innerHTML rule is what keeps it inert.
    state.pathDebug ? h('pre', { class: 'path-debug' }, state.pathDebug) : null,
  ])
}

/**
 * The label for one of the two Copy buttons.
 *
 * Three states, not two. copyText can genuinely fail -- no clipboard API, a
 * denied permission, a sandboxed frame -- and until now that failure was
 * swallowed: the button went on saying "Copy" exactly as it had before the
 * click, which is the same thing it says when nothing has happened at all.
 * Someone in that position has no way to tell a failed copy from a missed
 * click, and pastes whatever was on the clipboard already.
 *
 * @param {State} state
 * @param {'code' | 'digest'} target
 */
function copyLabel(state, target) {
  if (state.copied === target) return 'Copied'
  if (state.copied === `${target}-failed`) return 'Couldn’t copy'
  return 'Copy'
}

/**
 * Visually hides an element while keeping it in the accessibility tree and
 * fully readable via `.textContent` -- the classic "sr-only" clip technique,
 * inlined as a style object rather than a class because src/web/styles.js is
 * a fixed, already-written contract this file does not touch.
 *
 * WHY #sas IS HIDDEN RATHER THAN STYLED: `session.sas` is a plain
 * space-joined emoji string (test/crypto.test.mjs pins that exact format),
 * and e2e/transfer.e2e.mjs reads `#sas`'s `.textContent` from both peers and
 * compares them for equality. The *visual* SAS below -- four `.sas-tile`s,
 * each an emoji stacked over its word so the pair can be read aloud over a
 * phone call -- is markup the plain string cannot be, and concatenating that
 * markup's text nodes would not reliably reproduce `session.sas` verbatim
 * (no guaranteed separators between tiles). Two peers running the same
 * concatenation would still agree with each other, so the e2e's equality
 * check would not actually break either way -- but pinning `#sas` to the
 * exact, already-tested string is the honest fix: one element holds the
 * value every other test already depends on, and the pretty tiles are free
 * to be whatever markup reads best without that value being a side effect
 * WHICH OF THE TWO ASSISTIVE TECH READS is deliberate, and it is the tiles,
 * not this string. A screen reader announcing the raw emoji would use its
 * own dictionary -- "honeybee", "red apple" -- and the whole point of the
 * SAS is that two people read it aloud to each other and agree. If one of
 * them hears "honeybee" while the other is looking at a tile captioned
 * "bee", the check fails for a reason that has nothing to do with an
 * attacker. So the words are the accessible name and this element is hidden
 * from the accessibility tree entirely; it exists only as the exact,
 * machine-readable value the tests and any programmatic reader depend on.
 * @type {Record<string, string>}
 */
const SR_ONLY_STYLE = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  'white-space': 'nowrap',
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 * @returns {import('./vdom.js').VNode[]}
 */
export function render(state, dispatch) {
  // patch() (see vdom.js) takes a plain VNode[] with no gaps -- unlike an
  // h() children array, it is not run through flatten(), so the optional
  // toast is filtered out here rather than passed through as a literal
  // `null` entry.
  return /** @type {import('./vdom.js').VNode[]} */ ([
    // The step rail used to be here, as a sibling of the screens. It is now
    // rendered inside each .card by screen() -- see stepRail's own comment for
    // why a conditional element in this list was moving the whole layout every
    // time the flow touched a beam screen.
    ...SCREENS.map(name => screen(name, state, dispatch)),

    // The <dialog> is adopted, not described -- see the `adopt` prop in
    // vdom.js, and the same technique on the QR <svg> and the beam <canvas>.
    // `key` is required rather than decorative: it pins this wrapper's
    // position so canReuse never rebuilds it, and a rebuilt wrapper would
    // orphan the dialog element.js is holding a reference to and calling
    // showModal() on.
    //
    // patch() stops at an adopted node and never descends into it, so nothing
    // inside the dialog is rendered by this pass. dialogContent() below is
    // patched separately, against its own prev-tree. Two patch roots, one
    // owner each.
    h('div', { class: 'dialog-host', key: 'dialog-host', adopt: state.dialogNode }),

    // A change the user did not cause should still be a change the user
    // notices. The step rail and the status line both describe what is true
    // now, and neither draws the eye when what is true changes -- a peer
    // arriving or the route turning out to be relayed used to alter a word in
    // a paragraph and nothing else. This says it happened, once, and goes.
    //
    // role="status" rather than "alert": these are informational, and an alert
    // interrupts a screen reader mid-sentence, which is the wrong weight for
    // news that the connection is direct. Real failures go to the error sheet.
    state.toast
      ? h('div', { class: 'toast', role: 'status', key: 'toast' }, state.toast)
      : null,
  ].filter(Boolean))
}

/**
 * The contents of the adopted <dialog>, patched as its own root.
 *
 * Lives here rather than in element.js because this file is where all
 * user-facing copy lives, and a sheet is where the longest copy in the app now
 * goes -- putting it in element.js would move the most-read prose in the
 * component into a behaviour file.
 *
 * The heading carries `autofocus` and `tabindex="-1"`, and that is the whole
 * reason it exists. showModal() focuses the dialog's first focusable
 * descendant unless something claims it, which on the beam sheet would be
 * Accept: a person still lifting their finger off the Enter that opened the
 * sheet would accept a file. element.js's _focusScreenHeading has the same
 * rule for the same reason, and the safety gestures must not be dismissible by
 * a stray keypress.
 *
 * @param {State} state
 * @param {Dispatch} dispatch
 * @returns {import('./vdom.js').VNode[]}
 */
export function dialogContent(state, dispatch) {
  // The per-screen info sheet. Its copy is not stored here -- it is read back
  // off the same builder that draws the screen, so the words in the sheet and
  // the screen that owns them cannot drift apart. A builder that declares no
  // `info` for the current screen has no sheet to show; return nothing rather
  // than an empty dialog frame.
  if (state.modal === 'info') {
    const info = builders[state.screen](state, dispatch).info
    if (!info) return []
    return [
      h('h2', { class: 'sheet-title', tabindex: '-1', autofocus: true }, info.title),
      h('div', { class: 'sheet-body' }, info.content),
      h('div', { class: 'sheet-actions' }, [
        h('button', {
          class: 'btn', type: 'button', onclick: () => dispatch('modal:close'),
        }, 'Close'),
      ]),
    ]
  }

  if (state.modal === 'beam-offer' && state.offer) {
    return [
      h('h2', { class: 'sheet-title', tabindex: '-1', autofocus: true }, 'Before you accept'),
      h('div', { class: 'sheet-body' }, [
        h('p', { class: 'filename' }, `${state.offer.name} (${bytes(state.offer.size)})`),

        // Said BEFORE the click, not after, because both of these are things a
        // person would have chosen differently had they known. Accepting opens
        // a save dialog, and the browser creates that file the instant a
        // location is picked -- minutes before there are any bytes to write
        // into it. A transfer abandoned in between therefore leaves a real,
        // zero-byte file sitting in Downloads, which is indistinguishable from
        // a corrupted download and is exactly how the first tester read it.
        // Nothing can delete it from here: the File System Access handle
        // grants writing to that file and nothing else.
        h('p', {},
          'This saves a file straight away and fills it in at the end, so both screens have to stay '
          + 'as they are until it finishes. Stopping early leaves an empty file you can delete.'),
        h('p', {}, BEAM_KEEP_GOING),
      ]),

      // The notice and the gesture in one box. These used to be two paragraphs
      // above an Accept button that a phone could not show, which is the worst
      // of both: the warning was unread and the button was unreachable.
      // Nothing is awaited between this click and createSink -- the click is
      // the user activation showSaveFilePicker spends, and an await here would
      // spend it on nothing.
      h('div', { class: 'sheet-actions' }, [
        h('button', {
          class: 'btn primary', type: 'button', disabled: state.busy,
          onclick: () => dispatch('offer:accept'),
        }, 'Accept'),
        h('button', {
          class: 'btn ghost', type: 'button', disabled: state.busy,
          onclick: () => dispatch('offer:decline'),
        }, 'Decline'),
      ]),
    ]
  }

  if (state.modal === 'error' && state.error) {
    return [
      h('h2', { class: 'sheet-title', tabindex: '-1', autofocus: true }, 'Something went wrong'),
      // role="alert" so this is announced even though focus went to the
      // heading rather than to the message.
      h('div', { class: 'sheet-body' }, [
        h('p', { role: 'alert' }, errorCopy(state.error)),
        // Closed by default, so it costs no height on a layout that must not
        // scroll, and the raw sentence is one tap away for a bug report.
        // Rendered through h() like everything else -- some of these strings
        // originate from the peer, and there is no innerHTML path to reach
        // for even if one wanted it.
        errorCopy(state.error) === state.error ? null : h('details', { class: 'error-detail' }, [
          h('summary', {}, 'Details'),
          h('p', {}, state.error),
        ]),
      ]),
      h('div', { class: 'sheet-actions' }, [
        h('button', {
          class: 'btn', type: 'button', onclick: () => dispatch('modal:close'),
        }, 'Close'),
      ]),
    ]
  }

  return []
}

/**
 * Connect · Verify · Transfer, as three segments of a hairline along the top
 * edge of the card.
 *
 * Rendered as the card's first child rather than as a sibling of the screens,
 * and that is the point of the whole change. It was a row of labelled pills
 * above the card, hidden on `choose` and on both beam screens, so it appeared
 * and disappeared during ordinary use and took ~50px of layout with it each
 * way -- most visibly entering beam, where the card and everything in it
 * jumped as the sheet closed. Absolutely positioned inside the card (see
 * .rail in styles.js) it occupies no height at all, so being conditional
 * costs nothing.
 *
 * That is also what lets the honest-UI argument below survive unchanged: beam
 * can simply have no rail, rather than needing some representation invented
 * for it to avoid moving the page.
 *
 * @param {State} state
 */
function stepRail(state) {
  // Beam has no Connect/Verify handshake to show progress through -- it is a
  // single unbroken "camera pointed at screen" step, and there is no SAS to
  // land the rail's "Verify" label on. Folding it into STEP_INDEX would mean
  // inventing a fake middle step for a mode whose entire point is that it has
  // none, which is exactly the kind of dishonesty core/beam.js's header warns
  // against for the encryption claim -- the same principle applies to the UI
  // implying a verification step that cannot happen.
  //
  // HIDDEN, NOT ABSENT, and `key` is not decorative either. Returning null
  // here would drop a child from the top of every card on every beam screen,
  // and this element's siblings are .card-body -- which contains the `adopt`ed
  // <svg>, <video> and <canvas> that vdom.js's canReuse keeps alive by
  // POSITION. A rail that comes and goes shifts .card-body's index, canReuse
  // sees an <ol> where a <div> was, and the whole subtree is rebuilt, orphaning
  // the canvas web/beam.js is still painting into. The same reasoning the
  // dialog-host wrapper's key comment in render() spells out.
  //
  // `hidden` needs .rail[hidden] { display: none } in styles.js, because this
  // element sets an author `display` and an author display beats the UA
  // stylesheet's [hidden] rule. That is the trap .card[hidden] and .sheet[open]
  // both already exist to close, said a third time.
  //
  // `choose` is hidden for a plainer reason, and the original one: there is
  // nothing yet to show progress through. Rendering it there was tried --
  // three neutral segments as a preview of the flow's shape, which costs no
  // height -- and it reads as a misaligned border along the top of the card
  // rather than as anything meaningful. Three grey dashes are not a picture of
  // a journey not yet begun; they are a rendering artefact.
  const isBeam = state.screen === 'beam-send' || state.screen === 'beam-receive'
  const hidden = isBeam || state.screen === 'choose'

  const doneAll = state.screen === 'done' && SUCCESS_OUTCOMES.has(state.outcome ?? '')
  const current = STEP_INDEX[state.screen]

  return h('ol', {
    class: 'rail', key: 'rail', hidden, 'aria-label': 'Progress',
  }, STEP_LABELS.map((label, i) => {
    const status = doneAll || i < current ? 'is-done' : i === current ? 'is-active' : ''
    // The label is the segment's only content and it is clipped, not shrunk.
    // The short-height stylesheet used to compact this rail to bare dots with
    // `font-size: 0` under a comment claiming that was the sr-only clip
    // technique "preserving them for assistive tech". It is not -- there is no
    // clip and no overflow, and text at zero size is announced by nothing --
    // so on the viewport where the rail was least legible it was also least
    // accessible. SR_ONLY_STYLE is the real technique, it is already in this
    // file for #sas, and applying it here means the labels read identically at
    // every size instead of only above 46rem of height.
    //
    // aria-current stays exactly as it was: colour alone says which of a set
    // is current to nobody.
    return h('li', {
      class: `rail-seg ${status}`.trim(), key: label,
      'aria-current': status === 'is-active' ? 'step' : undefined,
    }, [h('span', { style: SR_ONLY_STYLE }, label)])
  }))
}

/**
 * @param {typeof SCREENS[number]} name
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function screen(name, state, dispatch) {
  // Every builder returns { body, actions } rather than one flat array, and
  // the two halves land in different boxes: `.card-body` may give up space and
  // scroll as a last resort, `.card-actions` never does. See the .card comment
  // in styles.js for the bug that shape exists to make unspeakable -- in
  // short, a button rendered after content can be pushed off a phone, and one
  // of these buttons is the user activation showSaveFilePicker spends.
  //
  // The split is enforced here rather than left as a convention, so a new
  // screen cannot accidentally opt out of it: there is nowhere else for a
  // button to go.
  // `media` is the screen's one visual thing -- the QR, the camera, the SAS
  // tiles. It is a slot of its own rather than the first entry in `body`
  // because on a wide, short window the card lays out in two columns with the
  // media beside the words, and "beside" is not something CSS can express
  // about one child among many siblings. Grid spanning was tried first and is
  // the wrong tool: an item spanning an unknown number of rows has to name a
  // count, and every row it names past the real ones still contributes a gap.
  // A span of 99 added 1584px of empty gaps to the send screen.
  const { media, body, actions, info } = builders[name](state, dispatch)

  // The Details button is appended here, by the frame, when a builder declares
  // `info` -- never rendered by the builder itself. It is the exact same
  // enforced-shape argument as the body/actions split above: a screen that
  // carries an info sheet should not also have to remember to draw, label, and
  // wire the button that opens it, and two screens hand-rolling that button
  // would drift in copy and placement the first time one of them was edited.
  // The frame owns the button; a builder owns only whether there is one, what
  // it opens onto, and -- via `info.label` -- what it is called when 'Details'
  // is the wrong word. `choose` names its sheet 'No network?'.
  const cardActions = info
    ? [
      ...actions,
      h('button', {
        class: 'btn ghost', type: 'button', onclick: () => dispatch('modal:open', 'info'),
      }, info.label ?? 'Details'),
    ]
    : actions

  return h('section', { id: `screen-${name}`, class: 'card', hidden: state.screen !== name }, [
    // Built from `state`, not from `name`: all eight sections are rendered on
    // every pass and seven are hidden, so this is the rail for the screen
    // currently showing, drawn into each card. Only one of them is ever
    // visible, which is the same trick the screens themselves use.
    stepRail(state),
    h('div', { class: `card-body${media ? ' has-media' : ''}` }, [
      media ? h('div', { class: 'card-media' }, media) : null,
      h('div', { class: 'card-copy' }, body),
    ].filter(Boolean)),
    h('div', { class: 'card-actions' }, cardActions),
  ])
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function choose(state, dispatch) {
  return {
    // The dropzone keeps the prose and the drag target; the two buttons that
    // used to sit inside it moved to the action bar. They read no differently
    // -- they are still the first thing the eye lands on, because the bar is
    // where every screen's primary action now is -- and the box goes back to
    // being what its name says it is. As this screen's one visual block it
    // also takes the left column on a wide, short window.
    media: h('div', { class: `dropzone${state.dragging ? ' is-dragging' : ''}` }, [
      h('p', {}, 'Drop a file here, or choose one below.'),
    ]),
    body: [
      h('h2', { tabindex: '-1' }, 'Send or receive a file'),

      // Shown only when this browser cannot stream a download to disk (see
      // web/sink.js's canStreamToDisk) -- everyone else never sees this note.
      state.capabilityNote ? h('p', { class: 'note' }, state.capabilityNote) : null,
    ],
    actions: [
      h('button', { id: 'btn-send', class: 'btn primary', onclick: () => dispatch('send:pick') },
        'Send a file'),
      h('button', { id: 'btn-receive', class: 'btn', onclick: () => dispatch('receive:scan') },
        'Receive a file'),
    ],

    // Beam is not an equal option, and now nothing on the screen implies it is:
    // it has no button here at all, only the frame's generic details button
    // (relabelled 'No network?' via `info.label`) opening onto this sheet. The
    // network path is better in every measurable way when a network exists --
    // encrypted, faster, no camera needed -- so beam is an escape hatch for
    // when there genuinely is no network, not a third choice competing with
    // "Send a file" / "Receive a file" for the eye. The two beam buttons, with
    // their ids, classes and dispatches unchanged, live inside the sheet.
    info: {
      label: 'No network?',
      title: 'No network?',
      content: [
        h('p', { class: 'note' },
          'No network needed: the file plays as an animated QR code and is read back by a camera, at '
          + 'about 6 kB/s. Not encrypted, and capped at 1 MiB compressed — text and code, rarely photos.'),
        // "No network?" was said three times inside one interaction: on the
        // ghost button that opens this sheet, as the sheet's own title
        // directly above these buttons, and again at the start of the first
        // button's label. By the time the question is being asked for the
        // third time it has already been answered twice -- the reader opened
        // the sheet, so they have no network. What the buttons have to say is
        // which of the two ends of a beam this device is.
        h('div', { class: 'choices secondary' }, [
          h('button', { id: 'btn-beam', class: 'btn ghost', onclick: () => dispatch('beam:pick') },
            'Show it as a QR code'),
          h('button', { id: 'btn-beam-receive', class: 'btn ghost', onclick: () => dispatch('beam:scan') },
            'Scan a beamed file'),
        ]),
      ],
    },
  }
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function send(state, dispatch) {
  return {
    media: h('div', { id: 'qr', class: 'qr', key: 'qr', adopt: state.qrNode }),
    body: [
    h('h2', { tabindex: '-1' }, 'Scan this on the other device'),

    // The one thing the send screen never said, and the thing a first-time
    // sender is actually stuck on: who scans this, and with what. "Scan this
    // on the other device" reads as an instruction to find a scanner, which
    // sent people hunting for an app to install -- when on the deployed site
    // the QR is a URL (core/secret.js's encodeSecretURL) and the ordinary
    // camera app already does the whole job, landing on this page with the
    // key in the fragment and the receive flow started.
    //
    // Conditional on qrIsLink rather than stated unconditionally, because an
    // embedder without base-url gets the bare `qrdrop:` form, which no camera
    // app knows how to open. Telling those users "any camera app will do"
    // would be advice that cannot work, which is worse than the silence this
    // replaces.
    h('p', { class: 'note' }, state.qrIsLink
      ? 'Any camera app will do — this code is a link that opens qrdrop, ready to receive.'
      : 'On the other device, open qrdrop, tap “Receive a file”, and point it at this code.'),

    // The code and the one sentence that qualifies it, grouped: at the copy
    // column's gap they read as two unrelated blocks, and "anyone who learns
    // it can join" is not a statement about the screen, it is a caption on the
    // string directly above it.
    h('div', { class: 'stack' }, [
      h('div', { class: 'code-row' }, [
        h('code', { id: 'manual-code', class: 'code' }, state.code),
        h('button', {
          class: 'btn small', type: 'button', onclick: () => dispatch('copy', 'code'),
          'aria-label': 'Copy the transfer code',
        }, copyLabel(state, 'code')),
      ]),
      h('p', { class: 'note' }, 'Anyone who learns it can join.'),
    ]),
    // The bar and the line that says what it is waiting for, as one block.
    // Separated by the column gap they were a bar and, some distance below, a
    // sentence; the sentence is the bar's label.
    h('div', { class: 'stack' }, [
      state.pairing
        ? h('div', {
          class: 'bar indeterminate', role: 'progressbar', 'aria-label': 'Connecting', 'aria-valuetext': state.status,
        }, [h('div', { class: 'bar-fill' })])
        : null,
      h('p', { class: 'status', 'aria-live': 'polite' }, state.status),
    ]),
    ],
    actions: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
    ],

    // The read-it-aloud fallback and the password warning are both true and
    // neither is what a sender is looking at this screen to find out, so they
    // move off it. The inline note keeps only the one sentence that changes
    // what a person does next -- "anyone who learns it can join" -- and the
    // rest waits behind the frame's Details button.
    info: {
      title: 'About this code',
      content: [
        h('p', { class: 'note' }, 'Read it out if scanning fails.'),
        h('p', { class: 'note' }, 'Treat it like a password.'),
      ],
    },
  }
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function receive(state, dispatch) {
  return {
    // The manual-entry form below is the real fallback when there is no camera,
    // but the media slot still has to be filled or this screen alone would drop
    // out of the two-column wide-and-short layout that verify, transfer, done
    // and receive-with-camera all use -- the card would reflow every time the
    // flow passed through here. A dashed, empty scanner-frame carrying the same
    // "no camera" line holds the slot at the size and shape the <video> would
    // have taken, and puts the message where a person is already looking for
    // the picture.
    media: state.cameraAvailable
      ? h('div', { class: 'scanner-frame' }, [
        h('video', { id: 'scanner', key: 'scanner', class: 'scanner', muted: true, playsinline: '' }),
        h('div', { class: 'viewfinder' }, [h('span', {}, [])]),
      ])
      : h('div', { class: 'scanner-frame is-empty' }, [
        h('p', { class: 'note' }, NO_CAMERA_SCAN),
      ]),
    body: [
    h('h2', { tabindex: '-1' }, "Scan the sender's code"),


    // A plain, always-visible label rather than a collapsed <details> --
    // manual entry is the fallback everyone needs when the camera fails or is
    // absent, so it is promoted out of hiding.
    //
    // This was a bare <summary> until now, kept only because
    // e2e/transfer.e2e.mjs clicked `#screen-receive .manual summary` on its
    // way to the form. Outside a <details> a <summary> has no behaviour, so
    // the click was already a no-op and the form was already visible before
    // and after it -- but it was still styled `cursor: pointer` in a muted
    // colour, which is to say it looked exactly like a disclosure control and
    // did nothing when pressed. Something that invites a click and then
    // ignores it is worse than no affordance at all, and it was also invalid
    // placement. A <label> is what the thing actually is: it names the field
    // below it, and clicking it now focuses that field, which is the
    // behaviour the shape was promising all along. The e2e's click is dropped
    // in the same change rather than re-targeted, since it never did anything.
    h('div', { class: 'manual' }, [
      h('label', { class: 'manual-label', for: 'manual-input' }, 'Enter the code by hand'),
      h('form', {
        id: 'manual-form',
        onsubmit: /** @param {SubmitEvent} ev */ ev => {
          ev.preventDefault()
          const input = /** @type {HTMLInputElement} */ (
            /** @type {HTMLFormElement} */ (ev.currentTarget).elements.namedItem('manual-input')
          )
          dispatch('manual:submit', input.value)
        },
      }, [
        h('input', {
          // No aria-label any more: the <label for="manual-input"> above is
          // now the accessible name, and an aria-label would override it with
          // different words. A visible label whose text is not in the
          // accessible name is the thing WCAG's "label in name" exists to
          // stop -- someone using voice control says what they can see. The
          // "or a link" half it used to carry is in the placeholder.
          id: 'manual-input', key: 'manual-input', type: 'text', placeholder: 'qrdrop:… or a link',
          autocomplete: 'off', spellcheck: 'false',
          'aria-invalid': state.manualError ? 'true' : undefined,
          'aria-describedby': state.manualError ? 'manual-error' : undefined,
        }),
        h('button', { class: 'btn', type: 'submit' }, 'Join'),
      ]),

      // The one error with somewhere better to be than the page-level banner
      // at the bottom of the card. Everything else that fails here -- a peer
      // vanishing, a relay refusing -- is about the session, and the banner
      // is the right home for it. A rejected code is about the twenty
      // characters still sitting in the field a few pixels above this line,
      // and an error that far from the thing it is describing is one the
      // reader has to go looking for. aria-invalid/aria-describedby on the
      // input are the same statement made to assistive tech, which otherwise
      // had no way at all to connect the two.
      state.manualError
        ? h('p', { id: 'manual-error', class: 'callout danger', role: 'alert' }, state.manualError)
        : null,
    ]),

    h('p', { class: 'status', 'aria-live': 'polite' }, state.status),
    ],
    actions: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
    ],
  }
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function verify(state, dispatch) {
  const emoji = state.sas ? state.sas.split(' ') : []

  return {
    media: h('div', {
      class: 'sas-grid',
      role: 'group',
      'aria-label': `Verification code: ${state.sasWords.join(', ')}`,
    }, state.sasWords.map(
      /** @param {string} word @param {number} i */
      // The emoji is decoration here and the word is the content: the word is
      // what the user says out loud, so it is what a screen reader must say.
      (word, i) => h('div', { class: 'sas-tile', key: word }, [
        h('span', { class: 'sas-emoji', 'aria-hidden': 'true' }, emoji[i] ?? ''),
        h('span', { class: 'sas-word' }, word),
      ]))),
    body: [
      h('h2', { tabindex: '-1' }, 'Check both devices show the same symbols'),

      // The exact-string element the e2e suite and CLI interop depend on --
      // see SR_ONLY_STYLE's comment above for why this is separate from the
      // tile grid rather than being the tile grid's container.
      h('span', { id: 'sas', style: SR_ONLY_STYLE, 'aria-hidden': 'true' }, state.sas),

      h('p', { class: 'note' },
        'If these differ, someone is between you. Stop, and start over with a fresh code.'),

      // Filename, then badge, then -- down in the action bar -- the gesture.
      // That is the order the receiver reads them in, and the reason the
      // filename comes first: the badge can warn that "holiday-video.mov is
      // 900 MB", and it must not do so above the only line that has told the
      // reader a holiday-video.mov exists. Both of these used to live inside
      // #verify-status, which put a filename and a path badge -- neither of
      // them a control -- in the action bar, where "the bar is where the
      // actions are" is the one thing that has to stay true. They render for
      // both roles now: the sender has no `offer`, so its filename line is
      // just absent rather than special-cased, and pathBadge already returns
      // null when there is no path to show.
      // Grouped, because the badge is a statement ABOUT the file named above
      // it -- "holiday-video.mov is 900 MB" and "this connection crosses the
      // internet" are one thought, and at the column gap they were two.
      h('div', { class: 'stack' }, [
        state.offer ? h('p', { class: 'filename' }, `${state.offer.name} (${bytes(state.offer.size)})`) : null,
        pathBadge(state),
      ]),
    ],
    actions: [
      // #verify-status stays one element -- e2e/transfer.e2e.mjs clicks
      // `#verify-status button.primary` and it is this screen's aria-live
      // region -- but it now holds only controls and the waiting-state
      // indeterminate bar. The filename and the path badge it used to carry
      // moved up into the body above.
      h('div', { id: 'verify-status', class: 'verify-actions', 'aria-live': 'polite' },
        verifyStatus(state, dispatch)),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
    ],
  }
}

/**
 * The role-dependent contents of `#verify-status`: this is the screen's only
 * dead end in the pre-restyle version (no Cancel existed at all), so this
 * function -- along with the Cancel button above -- is the fix for it.
 *
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function verifyStatus(state, dispatch) {
  if (state.role === 'sender') {
    return [
      h('button', { class: 'btn primary', type: 'button', onclick: () => dispatch('verify:confirm') },
        `They match — send ${state.file?.name ?? 'the file'}`),
    ]
  }

  // Receiver, no offer yet: waiting on the sender, not hung -- the
  // indeterminate bar is what tells those two states apart at a glance.
  if (!state.offer) {
    return [
      h('div', { class: 'bar indeterminate', role: 'progressbar', 'aria-label': 'Waiting for an offer' },
        [h('div', { class: 'bar-fill' })]),
      h('p', { class: 'status' }, 'Waiting for the sender to offer a file…'),
    ]
  }

  // `disabled` while busy, which is the window between the click and the
  // native save dialog handing a destination back. That dialog is a separate
  // OS window and can sit there for seconds, during which this screen used to
  // look exactly as it did before the click -- so the click read as having
  // missed, and the natural response was to click again. The button is not
  // being made safer here (the one-shot closure above already guarantees it
  // fires once); it is being made to admit that it heard.
  return [
    h('button', {
      class: 'btn primary', type: 'button', disabled: state.busy,
      onclick: () => dispatch('offer:accept'),
    }, 'Accept'),
    h('button', {
      class: 'btn ghost', type: 'button', disabled: state.busy,
      onclick: () => dispatch('offer:decline'),
    }, 'Decline'),
  ]
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function transfer(state, dispatch) {
  const moved = state.progress?.moved ?? 0
  const total = state.progress?.total ?? 0
  const pct = total > 0 ? Math.min(100, (moved / total) * 100) : 0

  return {
    // The progress bar is this screen's visual block -- the slot the QR, the
    // camera, and the outcome banner fill on the screens either side of this
    // one. transfer used to pass `media: null` on the grounds that a
    // percentage is part of the prose, and that made it the one screen in the
    // verify -> transfer -> done run without a media column: the wide-and-short
    // layout collapsed to one column here and sprang back on the next screen,
    // so the whole card visibly reflowed twice mid-transfer. The bar is a
    // picture of how far along things are, not a sentence about it, so it
    // belongs beside the words rather than among them. Every aria attribute is
    // exactly as it was when it sat in `body`.
    // The percentage above the bar, and the pair is the media block.
    //
    // The bar on its own was eight pixels of content in the slot that held a
    // 256px QR one screen earlier and holds the outcome banner on the next --
    // the emptiest moment in the app, placed at its longest wait. Now that
    // .card-media reserves a floor so the heading stops jumping between
    // screens (see its comment in styles.js), the choice was between
    // reserving that space for nothing and giving the screen a subject.
    //
    // The number is not new information: it is the same `pct` the bar's width
    // is already set from, and the status line below already says "Sent 1.2 MB
    // of 2.3 MB". Both stay, because they answer different questions -- the
    // readout answers "how far along", the status line answers "how far in
    // bytes", and those stop being the same question the moment the file is
    // 40 KB and the percentage jumps in tens.
    //
    // aria-hidden, and every aria attribute stays on the bar exactly where it
    // was. The progressbar role already exposes valuenow/valuemax, so a
    // screen reader announcing this would be reading the same number twice.
    media: h('div', { class: 'transfer-meter' }, [
      h('p', { class: 'transfer-pct', 'aria-hidden': 'true' }, `${Math.floor(pct)}%`),
      h('div', {
        class: 'bar', role: 'progressbar',
        'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(moved),
      }, [h('div', { class: 'bar-fill', style: { '--progress': `${pct}%` } })]),
    ]),
    body: [
    h('h2', { tabindex: '-1' }, state.role === 'receiver' ? 'Receiving' : 'Sending'),
    h('div', { class: 'stack' }, [
      state.file ? h('p', { class: 'filename' }, `${state.file.name} (${bytes(state.file.size)})`) : null,
      pathBadge(state),
    ]),
    h('p', { class: 'status', 'aria-live': 'polite' }, state.status),
    ],
    actions: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
    ],
  }
}

/**
 * Glyph, colour variant, and heading for each terminal outcome.
 * @type {Record<'sent' | 'received' | 'declined' | 'too-large' | 'failed', { variant: string, glyph: string, title: string }>}
 */
const OUTCOME_INFO = {
  // All five are noun phrases naming what happened to the file. They used to
  // be three bare participles and two phrases, which read as two different
  // screens depending on the outcome -- and the two phrases are the ones that
  // cannot shorten without losing their meaning, so the short ones grew.
  sent: { variant: 'ok', glyph: '✓', title: 'File sent' },
  received: { variant: 'ok', glyph: '✓', title: 'File received' },
  declined: { variant: 'warn', glyph: '⚠', title: 'File declined' },
  'too-large': { variant: 'warn', glyph: '⚠', title: 'Too large for this connection' },
  failed: { variant: 'bad', glyph: '✕', title: 'Transfer failed' },
}

/** @param {State} state */
function outcomeMessage(state) {
  // Set explicitly by element.js when the generic per-outcome line below
  // needs real numbers in it (the relay-cap decline, which names the file,
  // its size, and the limit -- see core/messages.js's relayCapDeclineMessage).
  if (state.message) return state.message
  switch (state.outcome) {
    case 'sent': return 'Your file was delivered.'
    case 'received': return 'The file was saved to your device.'
    case 'declined': return 'The other device turned down the file.'
    case 'failed': return 'Nothing was saved. Start over with a fresh code.'
    default: return ''
  }
}

/**
 * A receiver who just received a file was, until now, offered "Send another".
 * @param {State} state
 */
function restartLabel(state) {
  if (state.role === 'receiver') return 'Receive another file'
  if (state.role === 'sender') return 'Send another file'
  return 'Start over'
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function done(state, dispatch) {
  const info = (state.outcome && OUTCOME_INFO[state.outcome]) || OUTCOME_INFO.failed

  return {
    // The outcome banner is this screen's visual block, so it takes the left
    // column on a wide, short window the way the QR and the camera do.
    media: h('div', { class: `outcome ${info.variant}` }, [
      h('span', { class: 'glyph', 'aria-hidden': 'true' }, info.glyph),
      h('p', {}, outcomeMessage(state)),
    ]),
    body: [
    h('h2', { tabindex: '-1' }, info.title),
    h('div', { class: 'stack' }, [
      state.file && SUCCESS_OUTCOMES.has(state.outcome ?? '')
        ? h('p', { class: 'filename' }, state.file.name)
        : null,
      pathBadge(state),
    ]),
    // Only when there is one. A failed or declined transfer never computes a
    // digest, and an outcome screen offering to reveal "Verification digest"
    // that opens onto nothing reads as a second, smaller failure.
    state.digest ? h('details', {}, [
      h('summary', {}, 'Verification digest'),
      h('div', { class: 'code-row' }, [
        h('code', { id: 'done-digest', class: 'code' }, state.digest),
        h('button', {
          class: 'btn small', type: 'button', onclick: () => dispatch('copy', 'digest'),
          'aria-label': 'Copy the verification digest',
        }, copyLabel(state, 'digest')),
      ]),
      h('p', { class: 'note' }, 'Both devices computed this independently from the file contents.'),
    ]) : null,
    ],
    actions: [
      h('button', { class: 'btn primary', type: 'button', onclick: () => dispatch('restart') }, restartLabel(state)),
    ],
  }
}

/**
 * Internal failure text, said the way a person would say it.
 *
 * The strings on the left are written for whoever is reading a stack trace,
 * and as diagnostics they are good ones: "Out-of-order frame: expected 0, got
 * 13877" names the exact fault. It was also, verbatim, the whole of what a
 * user standing in a room with a phone was told about why their file had
 * vanished.
 *
 * Unmatched messages pass through UNCHANGED, and that default is the point.
 * Most of what reaches here is already user copy -- PEER_DISCONNECTED, both
 * relay-cap sentences in core/messages.js, the insecure-context line -- and a
 * catch-all "Something went wrong" would trade several good sentences for one
 * worse one in order to improve a handful of bad ones. The sheet's heading
 * already says that much.
 *
 * Nothing is thrown away: anything translated here is still shown raw under a
 * Details disclosure, because "the transfer failed" is not a bug report
 * anyone can act on.
 *
 * @param {string} message
 * @returns {string}
 */
export function errorCopy(message) {
  // sender.js prefixes the peer's own message before it ever gets here, so
  // one underlying failure arrives in two shapes depending which end is
  // reading it. Peeled once rather than duplicated down the table.
  const peerPrefix = /^Peer (?:refused|could not complete) the transfer: /
  if (peerPrefix.test(message)) return errorCopy(message.replace(peerPrefix, ''))

  if (/^Out-of-order frame/.test(message)
    || message === 'Unexpected frame type'
    || message === 'Frame from unexpected file'
    || message === 'Chunk arrived with no accepted file'
    || message === 'Unexpected completion'
    || message === 'Peer offered a file while one was already in flight') {
    return 'The two devices lost track of each other mid-transfer, so nothing was saved. '
      + 'Start again with a fresh code.'
  }

  if (message === 'Digest mismatch' || message === 'Size mismatch'
    || message === 'Chunk count mismatch'
    || message === 'Peer sent more data than the manifest declared'
    || message === 'End-of-file flag arrived at the wrong chunk') {
    return 'What arrived does not match what the other device said it was sending, '
      + 'so it was thrown away rather than saved.'
  }

  if (message === 'Frame too short' || message === 'Frame exceeds maximum size'
    || message === 'Runt frame') {
    return 'The other device sent something this one could not read, so the transfer stopped.'
  }

  return message
}

/**
 * The two ways to say "this device has no camera", each said once.
 *
 * There used to be three sentences for this one fact -- two typed into
 * element.js and one here -- and they had already drifted into three
 * different registers. They live here, next to the rest of the copy, and
 * element.js imports the string rather than retyping it.
 *
 * They are two constants and not one because the two screens are in
 * genuinely different situations, and flattening them would make one of them
 * a lie. receive() has the manual-entry form sitting directly below, so a
 * missing camera is an inconvenience and the sentence points at the way
 * round it. beamReceive() has no fallback at all and cannot have one -- a
 * beam code is thousands of frames, not a string a person could type -- so
 * there the sentence has to say the mode is simply unavailable here.
 */
export const NO_CAMERA_SCAN = 'No camera available — enter the code by hand.'
export const NO_CAMERA_BEAM = 'This device has no usable camera, so it cannot receive a beamed file.'

/**
 * The one warning both beam screens must carry, word for word. A single
 * source rather than two hand-written copies for the same reason
 * src/web/tokens.js gives the palette exactly one home: two copies of a
 * safety-critical sentence drift the first time someone edits one of them,
 * and this particular sentence is the entire reason a receiver is allowed to
 * skip the SAS screen at all. See core/beam.js's header for why beam cannot
 * be encrypted (no handshake, so no ECDH, no forward secrecy, no SAS) --
 * this is that fact's UI half, and it must never be softened into something
 * that reads as "still somewhat protected."
 */
const BEAM_WARNING = 'This is not encrypted, and cannot be — there is no handshake, so nothing here to '
  + 'verify. Anyone who can see this screen while it plays can read the file.'

/**
 * The other instruction that must not drift, for a duller but more frequent
 * reason than BEAM_WARNING's.
 *
 * Beam is the only transfer here where accepting does NOT mean the bytes now
 * move on their own -- the camera has to keep watching a screen that has to
 * keep playing, for minutes. Every other transfer anyone has used, including
 * this app's own WebRTC path, works the other way round, so "Accept means I
 * can put the phone down" is the assumption a new user arrives with rather
 * than one they could be talked out of by a status line. It is said before as
 * well as after the click, because the first person to try it stopped showing
 * the code the instant they had tapped Accept, and got an empty file for it.
 *
 * TWO CONSTANTS, ONE PER END, and this is a deduplication rather than a
 * softening -- every screen still carries exactly one prominent statement of
 * it, in the same .callout warn it was in before. What is gone is the drift:
 * there were FOUR phrasings of this one instruction in this file, one typed
 * inline on beam-send, BEAM_KEEP_GOING on beam-receive, BEAM_KEEP_GOING again
 * in the offer sheet, and a fourth in beam-send's info sheet ("Nothing comes
 * back here, so stop only when the other device says so"). Four wordings of a
 * safety instruction is exactly the state this constant existed to prevent,
 * arrived at by adding screens around it.
 *
 * They are two and not one because the two ends are told genuinely different
 * things -- one person must not stop showing, the other must not stop looking
 * -- and collapsing them would make one of the two vague about which screen it
 * meant. The same reasoning, for the same reason, as NO_CAMERA_SCAN and
 * NO_CAMERA_BEAM above.
 */
// One line, not two. The first version of this ran to a second sentence and
// cost the beam screen 40px of copy it did not have on a 390x844 phone --
// check-layout.mjs failed it. A safety instruction that pushes the rest of the
// screen out of view is not a safer screen, which is the whole lesson of the
// Accept button that started this layout.
const BEAM_KEEP_SHOWING = 'Keep this code on screen until the other device says it is done. '
  + 'Nothing comes back here.'
const BEAM_KEEP_GOING = 'Keep the camera on the other screen, and leave that screen playing, '
  + 'until this one says it is done.'

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function beamSend(state, dispatch) {
  const fps = state.beam?.fps ?? DEFAULT_FPS
  const loops = state.beam?.loops ?? 0
  const eta = state.beam?.eta ?? 0

  return {
    media: h('div', { id: 'beam-stage', class: 'beam-stage', key: 'beam-stage', adopt: state.beamNode }),
    body: [
    h('h2', { tabindex: '-1' }, 'Show this to the other device'),
    h('p', { class: 'callout danger', role: 'note' }, BEAM_WARNING),
    state.file ? h('p', { class: 'filename' }, `${state.file.name} (${bytes(state.file.size)})`) : null,

    // `adopt` and `key` are both load-bearing, not stylistic. The canvas is a
    // real DOM node web/beam.js's player repaints in place up to ten times a
    // second (see its header comment on why the QR is not described in
    // vnodes at all) -- describing its pixels here would mean a full render
    // of every screen on every repaint, and reconciling several hundred
    // <rect>s the vdom did not draw is not a thing it can do anyway. `key`
    // pins this <div>'s position across re-renders so vdom.js's canReuse
    // never decides to rebuild it: a rebuilt element would call adoptInto
    // again, which is a harmless no-op for the *same* node, but the player
    // holds no other reference to its canvas than the one this prop hands
    // back, so any path that let the wrapper be thrown away and recreated
    // would silently orphan the canvas the player is still painting to.
    // The speed control and the line reporting what that speed is producing,
    // grouped -- changing the select changes the number in the status below
    // it, so they are one control and its readout rather than two rows.
    h('div', { class: 'stack' }, [
      h('div', { class: 'beam-controls' }, [
        h('label', { for: 'beam-fps' }, 'Speed'),
        h('select', {
          id: 'beam-fps',
          value: String(fps),
          onchange: /** @param {Event} ev */ ev =>
            dispatch('beam:fps', Number(/** @type {HTMLSelectElement} */ (ev.target).value)),
        }, FPS_CHOICES.map(choice => h('option', { key: String(choice), value: String(choice) }, `${choice} fps`))),
      ]),

      // Loops, not percent: a sender has no back channel at all (see
      // core/beam.js's header), so "how far along is the other device" is a
      // question this screen structurally cannot answer. The one honest signal
      // is how many times the whole file has already gone by, and how long a
      // single pass takes -- which at least turns "keep it up indefinitely" into
      // a number someone can plan around.
      h('p', { class: 'status', 'aria-live': 'polite' },
        `Shown in full ${loops} time${loops === 1 ? '' : 's'}, ${duration(eta)} per pass.`),
    ]),

    // The single most important instruction on the screen, and it is styled as
    // one rather than as a status line. The first person to use this stopped
    // showing the code as soon as the other device said "Accept", because in
    // every other transfer UI -- including this app's own WebRTC path -- Accept
    // means the bytes now move on their own. Here it means the opposite: the
    // work has not started yet. That misreading is the default, so it is worth
    // spending the most prominent element on the page to prevent.
    //
    // Last in the column rather than mid-way up it, which is where a typed
    // copy of it used to sit: this is the sentence the sender has to still be
    // acting on in four minutes' time, so it belongs against the action bar
    // where the eye returns, not above the status line it outranks.
    h('p', { class: 'callout warn' }, BEAM_KEEP_SHOWING),
    ],
    actions: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
    ],

    // The warning and the keep-it-on-screen instruction stay inline -- they are
    // the whole reason this screen is careful. What moves is the reassurance
    // around them: that many passes are expected. True, but not what the status
    // line is for.
    //
    // "Nothing comes back here, so stop only when the other device says so"
    // used to be a second paragraph here. It is the fourth phrasing of
    // BEAM_KEEP_SHOWING, which is now on the screen itself and says the same
    // thing in its second sentence -- and a safety instruction that is only
    // complete once you have opened a details sheet is not one the screen can
    // rely on having been read.
    info: {
      title: 'About beaming',
      content: [
        h('p', { class: 'note' }, 'Several passes are normal.'),
      ],
    },
  }
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function beamReceive(state, dispatch) {
  const solved = state.beam?.solved ?? 0
  const blocks = state.beam?.blocks ?? 0
  const pct = blocks > 0 ? Math.min(100, (solved / blocks) * 100) : 0

  return {
    // Camera present: the live viewfinder. Absent: an empty frame the same size
    // carrying NO_CAMERA_BEAM, so the media slot is filled either way and this
    // screen stops dropping out of the two-column wide-and-short layout whenever
    // the device has no camera. See the body comment below for why the message
    // belongs here rather than in a note further down.
    media: state.cameraAvailable
      ? h('div', { class: 'scanner-frame' }, [
        h('video', { id: 'beam-scanner', key: 'beam-scanner', class: 'scanner', muted: true, playsinline: '' }),
        h('div', { class: 'viewfinder' }, [h('span', {}, [])]),
      ])
      : h('div', { class: 'scanner-frame is-empty' }, [
        h('p', { class: 'note' }, NO_CAMERA_BEAM),
      ]),
    body: [
      h('h2', { tabindex: '-1' }, 'Point the camera at the other screen'),
      h('p', { class: 'callout danger', role: 'note' }, BEAM_WARNING),

      // Unlike receive()'s scanner there is no manual-entry fallback here -- a
      // beam code is thousands of frames, not one string a person could read
      // aloud or paste -- so a missing camera has to be said outright rather
      // than left to a form that does not exist. It is said in the media slot
      // itself now (the is-empty scanner-frame above), landing in the space the
      // camera would have filled instead of as a note stranded below the
      // warning, where it read as one more thing gone wrong.

      state.offer
        ? h('p', { class: 'filename' }, `${state.offer.name} (${bytes(state.offer.size)})`)
        : null,

      // Post-Accept. This is the state the first tester was in when they put
      // the sending laptop down, so the instruction is promoted to the loudest
      // thing on the screen rather than left as the quiet status line it was.
      !state.offer && state.beam && state.beam.blocks > 0
        ? h('p', { class: 'callout warn' }, BEAM_KEEP_GOING)
        : null,
      !state.offer
        ? h('p', { class: 'status', 'aria-live': 'polite' }, state.status)
        : null,

      // Solving proceeds from the moment frames arrive, whether or not Accept
      // has been clicked yet (core/beam.js absorbs blocks eagerly; only the
      // final decompress-and-verify waits on the user's decision) -- so this
      // can and does progress while the Accept/Decline buttons are still
      // sitting there unanswered. `state.beam` is null until the first block
      // arrives, which is what keeps this from claiming 0% before there is
      // anything to report at all.
      // The bar and its readout, grouped -- the line is the bar's caption, and
      // at the column gap it was a paragraph that happened to follow a bar.
      // This is the block a person stares at for minutes while holding a phone
      // steady, so it is the one that most wants to read as a single object.
      h('div', { class: 'stack' }, [
        state.beam ? h('div', {
          id: 'beam-progress', class: 'bar', role: 'progressbar',
          'aria-valuemin': '0', 'aria-valuemax': String(blocks), 'aria-valuenow': String(solved),
        }, [h('div', { class: 'bar-fill', style: { '--progress': `${pct}%` } })]) : null,

        // A bare bar answers "is it moving?" only if you stare at it. These are
        // the two questions actually being asked -- how far, and how much longer
        // do I have to hold this phone up -- and neither was answerable before.
        // The remaining time is measured from the rate this camera is really
        // achieving rather than from the sender's chosen fps, which this device
        // has no way to learn; it stays absent for the first few seconds because
        // an estimate extrapolated from two blocks reads as broken.
        state.beam && blocks > 0
          ? h('p', { class: 'status', 'aria-live': 'polite' },
            `${Math.floor(pct)}% — ${solved} of ${blocks} pieces`
            + (state.beam.eta ? `, ${duration(state.beam.eta)} left` : ''))
          : null,
      ]),
    ],

    // The offer is answered on the sheet, never here. Accept and Decline used
    // to be duplicated into this bar as well, so the same gesture appeared
    // twice -- and the bar copy had none of the warning the gesture exists to
    // follow. The sheet (dialogContent's 'beam-offer' branch) is now the only
    // place Accept and Decline live.
    //
    // The activation rule is untouched. The sheet opens itself the instant the
    // manifest decodes (element.js's onManifest), a second or two into pointing
    // the camera; the click that reaches 'offer:accept' is still the one on the
    // sheet's Accept, and nothing is awaited before createSink. See web/beam.js's
    // startBeamReceive doc comment for the beam-specific version of that rule.
    actions: state.offer
      ? [
        // Not the way in to the offer -- the sheet opened on its own when the
        // manifest decoded. This is the way BACK to it after someone presses
        // Escape. It only sets modal: 'beam-offer'; it carries no user
        // activation, and the activation-bearing click is still Accept inside
        // the sheet.
        h('button', {
          class: 'btn primary', type: 'button', disabled: state.busy,
          onclick: () => dispatch('modal:open', 'beam-offer'),
        }, 'Review file'),
      ]
      : [
        h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
      ],
  }
}
