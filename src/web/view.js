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
 * 'offer:decline', 'cancel', 'restart', 'copy' (payload: 'code' | 'digest').
 * Drag-and-drop and paste are deliberately NOT among them -- element.js
 * wires those on the host element itself (see its class comment), because
 * "drop anywhere on the component" is a property of the whole custom
 * element, not of any one vnode this file describes.
 *
 * ALL SIX SCREENS ARE ALWAYS PRESENT IN THE TREE, toggled with the `hidden`
 * boolean prop rather than being added and removed. Three things depend on
 * that: e2e/transfer.e2e.mjs asserts on `#screen-X:not([hidden])`, the vdom's
 * node-reuse-by-key needs stable positions to keep `<video id="scanner">`'s
 * live MediaStream and `#manual-input`'s focus/caret across re-renders (see
 * vdom.js's canReuse), and it is what makes "only one screen visible at a
 * time" a rendering fact rather than something every call site has to
 * remember to maintain by hand.
 */

import { h } from './vdom.js'
import { bytes } from '../core/format.js'

/**
 * The shape element.js's `_state` always is -- mirrors its `_initialState()`
 * field for field. Declared here, not in element.js, because this is the
 * file a reader reaches for to know what the UI can represent at all;
 * element.js references it back via `import('./view.js').State`.
 *
 * @typedef {object} State
 * @property {'choose' | 'send' | 'receive' | 'verify' | 'transfer' | 'done'} screen
 * @property {'sender' | 'receiver' | null} role
 * @property {string} status
 * @property {string | null} error
 * @property {string} code
 * @property {Element | null} qrNode
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
 * @property {'code' | 'digest' | null} copied
 * @property {boolean} pairing
 */

/** @typedef {(intent: string, payload?: any) => void} Dispatch */

const SCREENS = /** @type {const} */ (['choose', 'send', 'receive', 'verify', 'transfer', 'done'])

// The three-step rail's labels, indexed by the screen that step covers.
// 'choose' has no entry -- the rail is hidden there, because there is
// nothing yet to show progress through.
/** @type {Record<string, number>} */
const STEP_INDEX = { send: 0, receive: 0, verify: 1, transfer: 2, done: 2 }
const STEP_LABELS = ['Connect', 'Verify', 'Transfer']

const SUCCESS_OUTCOMES = new Set(['sent', 'received'])

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
  // step rail and error banner are filtered out here rather than passed
  // through as literal `null` entries.
  return /** @type {import('./vdom.js').VNode[]} */ ([
    stepRail(state),
    ...SCREENS.map(name => screen(name, state, dispatch)),
    state.error
      ? h('p', { class: 'error', role: 'alert', 'aria-live': 'assertive' }, state.error)
      : null,
  ].filter(Boolean))
}

/** @param {State} state */
function stepRail(state) {
  if (state.screen === 'choose') return null

  const doneAll = state.screen === 'done' && SUCCESS_OUTCOMES.has(state.outcome ?? '')
  const current = STEP_INDEX[state.screen]

  return h('ul', { class: 'steps' }, STEP_LABELS.map((label, i) => {
    const status = doneAll || i < current ? 'is-done' : i === current ? 'is-active' : ''
    return h('li', { class: `step ${status}`.trim(), key: label }, label)
  }))
}

/**
 * @param {typeof SCREENS[number]} name
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function screen(name, state, dispatch) {
  const builders = { choose, send, receive, verify, transfer, done }
  return h('section', { id: `screen-${name}`, class: 'card', hidden: state.screen !== name },
    builders[name](state, dispatch))
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function choose(state, dispatch) {
  return [
    h('div', { class: `dropzone${state.dragging ? ' is-dragging' : ''}` }, [
      h('p', {}, 'Drop a file here, or choose one below.'),
      h('div', { class: 'choices' }, [
        h('button', { id: 'btn-send', class: 'btn primary', onclick: () => dispatch('send:pick') },
          'Send a file'),
        h('button', { id: 'btn-receive', class: 'btn', onclick: () => dispatch('receive:scan') },
          'Receive a file'),
      ]),
    ]),
    // Shown only when this browser cannot stream a download to disk (see
    // web/sink.js's canStreamToDisk) -- everyone else never sees this note.
    state.capabilityNote ? h('p', { class: 'note' }, state.capabilityNote) : null,
  ]
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function send(state, dispatch) {
  return [
    h('h2', { tabindex: '-1' }, 'Scan this on the other device'),
    h('div', { id: 'qr', class: 'qr', key: 'qr', adopt: state.qrNode }),
    h('div', { class: 'code-row' }, [
      h('code', { id: 'manual-code', class: 'code' }, state.code),
      h('button', {
        class: 'btn small', type: 'button', onclick: () => dispatch('copy', 'code'),
        'aria-label': 'Copy the transfer code',
      }, state.copied === 'code' ? 'Copied' : 'Copy'),
    ]),
    h('p', { class: 'note' },
      'Read this out, or let the other device scan the code above. Anyone who learns it '
      + 'can join this transfer, so treat it like a password.'),
    state.pairing
      ? h('div', {
        class: 'bar indeterminate', role: 'progressbar', 'aria-label': 'Connecting', 'aria-valuetext': state.status,
      }, [h('div', { class: 'bar-fill' })])
      : null,
    h('p', { class: 'status', 'aria-live': 'polite' }, state.status),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
  ]
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function receive(state, dispatch) {
  return [
    h('h2', { tabindex: '-1' }, "Scan the sender's code"),

    // Hidden entirely rather than shown black -- a <video> with no stream
    // used to render as a plain black square above a message saying there
    // was no camera, which reads as broken rather than as "there is no
    // camera here, use the code instead".
    state.cameraAvailable
      ? h('div', { class: 'scanner-frame' }, [
        h('video', { id: 'scanner', key: 'scanner', class: 'scanner', muted: true, playsinline: '' }),
        h('div', { class: 'viewfinder' }, [h('span', {}, [])]),
      ])
      : null,

    // A plain, always-visible label rather than a collapsed <details> --
    // manual entry is the fallback everyone needs when the camera fails or
    // is absent, so it is promoted out of hiding. It keeps the `.manual`
    // wrapper and a `<summary>` element for e2e/transfer.e2e.mjs, which
    // clicks `#screen-receive .manual summary` as part of the manual-entry
    // path; outside of a <details> a <summary> has no special behaviour of
    // its own, so the click is an inert no-op and the form stays visible
    // both before and after it -- which is the point, since this form must
    // never require an extra click to reach.
    h('div', { class: 'manual' }, [
      h('summary', {}, 'Enter the code by hand'),
      h('p', { class: 'note' }, 'Paste a qrdrop code or a shared link.'),
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
          id: 'manual-input', key: 'manual-input', type: 'text', placeholder: 'qrdrop:… or a link',
          autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Transfer code, or a shared link',
        }),
        h('button', { class: 'btn', type: 'submit' }, 'Join'),
      ]),
    ]),

    h('p', { class: 'status', 'aria-live': 'polite' }, state.status),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
  ]
}

/**
 * @param {State} state
 * @param {Dispatch} dispatch
 */
function verify(state, dispatch) {
  const emoji = state.sas ? state.sas.split(' ') : []

  return [
    h('h2', { tabindex: '-1' }, 'Check both devices show the same symbols'),

    // The exact-string element the e2e suite and CLI interop depend on --
    // see SR_ONLY_STYLE's comment above for why this is separate from the
    // tile grid rather than being the tile grid's container.
    h('span', { id: 'sas', style: SR_ONLY_STYLE, 'aria-hidden': 'true' }, state.sas),

    h('div', {
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

    h('p', { class: 'note' },
      'If these differ, someone is between you. Stop, and start over with a fresh code.'),

    h('div', { id: 'verify-status', 'aria-live': 'polite' }, verifyStatus(state, dispatch)),

    h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
  ]
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

  return [
    h('p', { class: 'status' }, `${state.offer.name} (${bytes(state.offer.size)})`),
    h('button', { class: 'btn primary', type: 'button', onclick: () => dispatch('offer:accept') }, 'Accept'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('offer:decline') }, 'Decline'),
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

  return [
    h('h2', { tabindex: '-1' }, state.role === 'receiver' ? 'Receiving' : 'Sending'),
    state.file ? h('p', { class: 'filename' }, `${state.file.name} (${bytes(state.file.size)})`) : null,
    h('div', {
      class: 'bar', role: 'progressbar',
      'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(moved),
    }, [h('div', { class: 'bar-fill', style: { '--progress': `${pct}%` } })]),
    h('p', { class: 'status', 'aria-live': 'polite' }, state.status),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => dispatch('cancel') }, 'Cancel'),
  ]
}

/**
 * Glyph, colour variant, and heading for each terminal outcome.
 * @type {Record<'sent' | 'received' | 'declined' | 'too-large' | 'failed', { variant: string, glyph: string, title: string }>}
 */
const OUTCOME_INFO = {
  sent: { variant: 'ok', glyph: '✓', title: 'Sent' },
  received: { variant: 'ok', glyph: '✓', title: 'Received' },
  declined: { variant: 'warn', glyph: '⚠', title: 'Declined' },
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

  return [
    h('h2', { tabindex: '-1' }, info.title),
    h('div', { class: `outcome ${info.variant}` }, [
      h('span', { class: 'glyph', 'aria-hidden': 'true' }, info.glyph),
      h('p', {}, outcomeMessage(state)),
    ]),
    state.file && SUCCESS_OUTCOMES.has(state.outcome ?? '')
      ? h('p', { class: 'filename' }, state.file.name)
      : null,
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
        }, state.copied === 'digest' ? 'Copied' : 'Copy'),
      ]),
      h('p', { class: 'note' }, 'Both devices computed this independently from the file contents.'),
    ]) : null,
    h('button', { class: 'btn primary', type: 'button', onclick: () => dispatch('restart') }, restartLabel(state)),
  ]
}
