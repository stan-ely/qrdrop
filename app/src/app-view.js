/**
 * The app's own pages, as a pure function of the shell's state: the top bar,
 * Settings, About and History. app/src/shell.js owns everything that is not
 * pure, and src/web/view.js still owns every screen of a transfer.
 *
 * Same rules as view.js, and for the same reasons. No DOM APIs, no promises, no
 * `innerHTML`: text children become text nodes, so nothing here can turn a
 * string into markup. This file exists because these pages are app-only, and
 * keeping them out of src/web/ keeps them out of the website and the npm
 * tarball; it is the one exception to "all user-facing copy lives in view.js".
 *
 * The words under About's two headings are not written here. They are adopted
 * nodes the build copied out of site/index.html (see infoCopy in
 * scripts/build-site.mjs), so the disclosure has one home.
 */
import { h } from '../../src/web/vdom.js'
import { bytes } from '../../src/core/format.js'
import { pathDescription, LAN_PATH, QUIC_PATH } from '../../src/core/messages.js'

/**
 * @typedef {'home' | 'settings' | 'about' | 'history'} Page
 *
 * @typedef {object} ShellState
 * @property {Page} page
 * @property {boolean} running whether the component has a session running
 * @property {string | null} version the app's version, once the shell has said
 * @property {{ label: string, href: string, title: string }} build
 * @property {string | null} saveLocation the folder received files go to, or
 *   null when Android has not been given one yet
 * @property {boolean} canChangeFolder
 * @property {string | null} saveError
 * @property {{ title: string, node: Element | null }} how
 * @property {{ title: string, node: Element | null }} protect
 * @property {{ enabled: boolean, entries: Entry[], error: string | null }} history
 *   what src-tauri/src/history.rs holds, newest first
 * @property {'clear' | 'off' | null} confirm the question Settings is asking
 *   about the history: whether to clear it, or, having just been switched
 *   off, whether to clear what it already holds
 *
 * @typedef {import('../../src/web/events.js').TransferRecord} Entry
 */

/** @typedef {(intent: string, payload?: any) => void} Dispatch */

const SOURCE = 'https://github.com/stan-ely/qrdrop'
const FEEDBACK = `${SOURCE}/issues`

/** @type {Record<Exclude<Page, 'home'>, string>} */
const TITLES = { settings: 'Settings', about: 'About', history: 'History' }

/**
 * Icons are aria-hidden, and the button around each carries the name: a bar of
 * bare glyphs with no accessible name is the bug the site's build stamp shipped
 * with once.
 *
 * @param {any[]} children
 */
const icon = children => h('svg', {
  viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true',
}, children)

const HISTORY_ICON = () => icon([
  h('circle', { cx: 12, cy: 12, r: 9 }),
  h('polyline', { points: '12 7 12 12 15.5 14' }),
])

const SETTINGS_ICON = () => icon([
  h('circle', { cx: 12, cy: 12, r: 3 }),
  h('path', {
    d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  }),
])

const BACK_ICON = () => icon([
  h('line', { x1: 19, y1: 12, x2: 5, y2: 12 }),
  h('polyline', { points: '12 19 5 12 12 5' }),
])

const CHEVRON_ICON = () => icon([h('polyline', { points: '9 18 15 12 9 6' })])

/**
 * The top bar. On Home the wordmark and the two ways out of it; on a page, the
 * way back and the page's name. shell.js hides its root while a session runs,
 * so nothing here can be reached from a session's screens.
 *
 * @param {ShellState} state
 * @param {Dispatch} dispatch
 * @returns {import('../../src/web/vdom.js').VNode[]}
 */
export function bar(state, dispatch) {
  if (state.page === 'home') {
    return [h('header', { class: 'app-bar' }, [
      h('h1', { class: 'wordmark' }, 'qrdrop'),
      h('nav', { class: 'app-nav', 'aria-label': 'qrdrop' }, [
        h('button', {
          id: 'nav-history', class: 'icon-btn', type: 'button', 'aria-label': 'History',
          onclick: () => dispatch('nav:open', 'history'),
        }, HISTORY_ICON()),
        h('button', {
          id: 'nav-settings', class: 'icon-btn', type: 'button', 'aria-label': 'Settings',
          onclick: () => dispatch('nav:open', 'settings'),
        }, SETTINGS_ICON()),
      ]),
    ])]
  }
  return [h('header', { class: 'app-bar' }, [
    h('button', {
      id: 'nav-back', class: 'icon-btn', type: 'button', 'aria-label': 'Back',
      onclick: () => dispatch('nav:back'),
    }, BACK_ICON()),
    h('h1', { id: 'page-title', class: 'page-title', tabindex: '-1' }, TITLES[state.page]),
  ])]
}

/**
 * @param {string} href
 * @param {string} label
 */
const external = (href, label) => h('a', { class: 'row', href, target: '_blank', rel: 'noopener noreferrer' }, [
  h('span', { class: 'row-label' }, label),
  CHEVRON_ICON(),
])

/**
 * @param {ShellState} state
 * @param {Dispatch} dispatch
 */
function settings(state, dispatch) {
  return [
    h('section', { class: 'group', 'aria-labelledby': 'save-heading' }, [
      h('h2', { id: 'save-heading' }, 'Saving files'),
      h('div', { class: 'row static' }, [
        h('div', { class: 'row-text' }, [
          h('span', { class: 'row-label' }, 'Received files go to'),
          h('span', { id: 'save-location', class: 'row-value' },
            state.saveLocation ?? 'You will be asked the first time you receive'),
        ]),
        state.canChangeFolder
          ? h('button', {
            id: 'change-folder', class: 'text-btn', type: 'button',
            onclick: () => dispatch('save:change-folder'),
          }, 'Change folder')
          : null,
      ]),
      state.saveError ? h('p', { class: 'note', role: 'alert' }, state.saveError) : null,
    ]),
    historySettings(state, dispatch),
    h('section', { class: 'group' }, [
      h('button', {
        id: 'settings-about', class: 'row', type: 'button',
        onclick: () => dispatch('nav:open', 'about'),
      }, [h('span', { class: 'row-label' }, 'About qrdrop'), CHEVRON_ICON()]),
    ]),
  ]
}

/**
 * The switch and Clear history. A real checkbox with role="switch" inside its
 * label, so the whole row is the target and assistive tech says on or off.
 *
 * The question under it is a row of two buttons rather than a dialog: it
 * belongs to the control just pressed, and a sheet over a page with one
 * decision on it would only be a second thing to dismiss.
 *
 * @param {ShellState} state
 * @param {Dispatch} dispatch
 */
function historySettings(state, dispatch) {
  const { enabled, entries } = state.history
  const count = entries.length === 1 ? '1 transfer' : `${entries.length} transfers`
  const question = state.confirm === 'off'
    ? `History is off. Clear the ${count} already saved?`
    : state.confirm === 'clear' ? `Clear ${count} from this device?` : null
  return h('section', { class: 'group', 'aria-labelledby': 'history-heading' }, [
    h('h2', { id: 'history-heading' }, 'History'),
    h('label', { class: 'row', for: 'history-enabled' }, [
      h('span', { class: 'row-text' }, [
        h('span', { class: 'row-label' }, 'Keep a history'),
        h('span', { class: 'row-value' },
          'File names, sizes and where they were saved, on this device only. Never codes or messages.'),
      ]),
      h('input', {
        id: 'history-enabled', class: 'switch', type: 'checkbox', role: 'switch', checked: enabled,
        onchange: (/** @type {Event} */ ev) =>
          dispatch('history:enabled', /** @type {HTMLInputElement} */ (ev.target).checked),
      }),
    ]),
    question
      ? h('div', { class: 'row static confirm', role: 'group', 'aria-labelledby': 'history-question' }, [
        h('span', { id: 'history-question', class: 'row-label' }, question),
        h('div', { class: 'confirm-actions' }, [
          h('button', {
            id: 'history-keep', class: 'text-btn quiet', type: 'button', onclick: () => dispatch('history:keep'),
          }, state.confirm === 'off' ? 'Keep' : 'Cancel'),
          h('button', {
            id: 'history-clear-confirm', class: 'text-btn danger', type: 'button',
            onclick: () => dispatch('history:clear-confirm'),
          }, 'Clear'),
        ]),
      ])
      : h('button', {
        id: 'history-clear', class: 'row', type: 'button', disabled: entries.length === 0,
        onclick: () => dispatch('history:clear'),
      }, [h('span', { class: 'row-label' }, 'Clear history')]),
    state.history.error ? h('p', { class: 'note', role: 'alert' }, state.history.error) : null,
  ])
}

/**
 * @param {string} key
 * @param {{ title: string, node: Element | null }} copy
 */
const disclosure = (key, copy) => h('details', { class: 'row-details', key }, [
  h('summary', {}, [h('span', { class: 'row-label' }, copy.title), CHEVRON_ICON()]),
  // Keyed and adopted: a rebuilt wrapper would lose whichever <details> a
  // person had open, on a render caused by the version arriving.
  h('div', { class: 'about-copy', key: `${key}-copy`, adopt: copy.node }),
])

/** @param {ShellState} state */
function about(state) {
  return [
    h('section', { class: 'group' }, [
      disclosure('how', state.how),
      disclosure('protect', state.protect),
    ]),
    h('section', { class: 'group' }, [
      h('div', { class: 'row static' }, [
        h('span', { class: 'row-label' }, 'Version'),
        h('span', { id: 'app-version', class: 'row-value', title: state.build.title }, [
          state.version ? `${state.version} (${state.build.label})` : state.build.label,
        ]),
      ]),
      external(SOURCE, 'Source'),
      external(FEEDBACK, 'Feedback'),
    ]),
  ]
}

/** @type {Record<Entry['outcome'], string>} */
const OUTCOMES = {
  sent: 'Sent',
  received: 'Received',
  declined: 'Declined',
  failed: 'Failed',
  'too-large': 'Too large for a relay',
  mismatch: 'Stopped: the symbols did not match',
  cancelled: 'Cancelled',
  beamed: 'Beamed',
}

/** @param {Entry['route']} route */
function routeLabel(route) {
  if (route === 'lan') return LAN_PATH.label
  if (route === 'quic') return QUIC_PATH.label
  if (route === 'beam') return 'Beam'
  // No route says nothing rather than "Path unknown": a record without one
  // ended before there was a route to classify.
  return route ? pathDescription(/** @type {any} */ (route)).label : null
}

/** @param {string} date */
function when(date) {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The folder, when the location is that folder and the name above it, so a
 * long name is not printed twice. The whole location when the file was saved
 * under another name, as when Android settles a duplicate on `report (1).pdf`:
 * that is the name to look for.
 *
 * @param {Entry} entry
 */
function savedIn({ location, name }) {
  if (!location || !name) return location
  const suffix = `/${name}`
  return location.endsWith(suffix) ? location.slice(0, -suffix.length) : location
}

/**
 * One past transfer. The name is a text child, like every filename in this
 * project: a peer chose it, and here it is read back from a file on disk,
 * which is a second reason it must never become markup.
 *
 * @param {Entry} entry
 */
function historyEntry(entry) {
  const ok = entry.outcome === 'sent' || entry.outcome === 'received' || entry.outcome === 'beamed'
  const title = entry.kind === 'text' ? 'Message' : entry.name ?? 'Unknown file'
  const facts = [
    entry.direction === 'sent' ? 'Sent' : entry.direction === 'received' ? 'Received' : null,
    entry.size === null ? null : bytes(entry.size),
    routeLabel(entry.route),
    when(entry.date),
  ].filter(Boolean)
  return h('li', { class: 'entry' }, [
    h('span', { class: `entry-mark ${entry.direction ?? ''}`, 'aria-hidden': 'true' },
      entry.direction === 'received' ? '↓' : '↑'),
    h('div', { class: 'row-text' }, [
      h('span', { class: entry.kind === 'text' ? 'entry-name message' : 'entry-name' }, title),
      h('span', { class: 'row-value' }, facts.join(' · ')),
      ok ? null : h('span', { class: `entry-outcome ${entry.outcome}` }, OUTCOMES[entry.outcome]),
      entry.location ? h('span', { class: 'row-value' }, `Saved to ${savedIn(entry)}`) : null,
    ]),
  ])
}

/** @param {ShellState} state */
function history(state) {
  const { enabled, entries, error } = state.history
  if (error) {
    return [h('section', { class: 'group empty' }, [
      h('h2', {}, 'History could not be read'),
      h('p', { class: 'note', role: 'alert' }, error),
    ])]
  }
  if (!entries.length) {
    return [h('section', { class: 'group empty' }, [
      h('h2', {}, 'No transfers yet'),
      h('p', { class: 'note' }, enabled
        ? 'Files you send and receive are listed here, on this device only.'
        : 'History is off. Turn it on in Settings to keep a list here.'),
    ])]
  }
  return [
    enabled ? null : h('p', { class: 'note' }, 'History is off, so new transfers are not being added.'),
    h('ol', { class: 'group entries', 'aria-label': 'Past transfers, newest first' }, entries.map(historyEntry)),
  ]
}

/**
 * The page over Home, or nothing on Home itself. An empty list rather than an
 * empty box, so patch() has nothing left behind when a page closes.
 *
 * @param {ShellState} state
 * @param {Dispatch} dispatch
 * @returns {import('../../src/web/vdom.js').VNode[]}
 */
export function page(state, dispatch) {
  if (state.page === 'home') return []
  const body = state.page === 'settings' ? settings(state, dispatch)
    : state.page === 'about' ? about(state)
      : history(state)
  return [h('div', { class: 'page-body', key: state.page }, body)]
}
