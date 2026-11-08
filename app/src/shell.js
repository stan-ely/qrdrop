/**
 * The app around <qr-drop>: which page is showing, and how Back gets out of it.
 * Renders through app-view.js, which is pure; this is the part that is not.
 *
 * HOME IS THE COMPONENT, AND IT STAYS LAID OUT. Settings, About and History are
 * an opaque box drawn over it (#app-page), with the component made `inert`
 * underneath, and never `display: none`. A <dialog> opened inside a hidden
 * subtree renders nothing and still blocks the whole document, and the
 * component can open one with nobody having touched it: a pasted message opens
 * the compose sheet from a document-level listener. Over a hidden component
 * that was a frozen Settings page with nothing on it to explain why. A modal
 * dialog escapes an ancestor's `inert`, so this way round it simply appears.
 *
 * BACK, AND THE SENTINEL IN element.js. Two things want the history stack and
 * they must not meet.
 *
 * The rule the component keeps is that its sentinel exists only during a
 * session, and that Back there is answered, never navigated with. This keeps
 * it with one entry per step away from Home, so Back only ever pops and nothing
 * is pushed in answer to it. About used to share Settings' entry, with Back
 * re-pushing it from popstate, and a push with no user activation left the next
 * press finding canGoBack() false, so it left the app. _onBackGesture has no
 * choice but to re-push, and MainActivity.onWebViewCreate is its way out.
 * Which page is showing still lives in state and not in history.
 *
 * Navigation cannot be touched while a session runs, because the bar is hidden.
 * But a session can START on a page: a deep link, a share or a tile all arrive
 * without asking, and screenchange then pulls the page down. The stack is left
 * as [base, ours, sentinel], or with two of ours over About, and nothing can
 * tidy that synchronously, because history.back() is asynchronous and the
 * component has already pushed. So two things follow, and both are in onPopState:
 *
 *  - While running, every popstate belongs to the component.
 *  - Our entries are now stale. When the session ends the component winds its
 *    sentinel off, which lands on the top one; each popstate after the session
 *    is the signal to wind off the next. Left there, an entry costs a dead press
 *    of Back on Home. Two back() calls in one task are not an alternative: a
 *    second traversal queued behind the first is not reliably honoured in a
 *    WebView, and the component's pop has to be seen to land.
 *
 * Reading the page out of history.state was the first shape, and it is wrong
 * for the same case: at session end that entry would say "settings", and the
 * done screen would be replaced by Settings the moment the transfer finished.
 */
import { patch } from '../../src/web/vdom.js'
import { bar, page as pageView } from './app-view.js'

const ENTRY = { qrdropShell: true }

/**
 * @typedef {import('./app-view.js').ShellState} ShellState
 * @typedef {import('./app-view.js').Page} Page
 */

/**
 * @param {object} options
 * @param {HTMLElement} options.el the <qr-drop>. Listened to here, before it is
 *   defined, because connectedCallback can start a session from a code in the
 *   URL on its first run.
 * @param {HTMLElement} options.barRoot
 * @param {HTMLElement} options.pageRoot
 * @param {() => Promise<string | null>} [options.changeFolder] Present on Android.
 * @param {(url: string) => unknown} options.openLink
 * @param {typeof import('./history.js')} [options.history] The store, in the
 *   app's Rust. Absent where there is no shell to keep one, and then History
 *   says nothing has been recorded, which is true.
 * @param {{ get: () => boolean, set: (on: boolean) => boolean }} [options.offline]
 *   "Pair without internet" (offline.js). Shown once main.js reports that a
 *   LanPlatform registered, through setState's `offline.available`.
 */
export function createShell({ el, barRoot, pageRoot, changeFolder, openLink, history: store, offline }) {
  const { buildLabel = '', buildHref = '', buildTitle = '' } = document.documentElement.dataset

  /** @type {ShellState} */
  let state = {
    page: 'home',
    running: false,
    version: null,
    build: { label: buildLabel, href: buildHref, title: buildTitle },
    saveLocation: null,
    canChangeFolder: Boolean(changeFolder),
    saveError: null,
    how: readCopy('how'),
    protect: readCopy('protect'),
    // On until the store says otherwise, which is its own default too. A
    // transfer that ends before the first read lands is still refused by
    // history.rs when the switch is off, so this guess cannot record past it.
    history: { enabled: true, entries: [], error: null },
    confirm: null,
    offline: { on: offline?.get() ?? false, available: false, prompts: false },
  }

  /** @type {import('../../src/web/vdom.js').VNode[] | null} */
  let barPrev = null
  /** @type {import('../../src/web/vdom.js').VNode[] | null} */
  let pagePrev = null

  // How many of our history entries outlived their page; see the header.
  let stale = 0

  const render = () => {
    barPrev = patch(barRoot, bar(state, dispatch), barPrev)
    pagePrev = patch(pageRoot, pageView(state, dispatch), pagePrev)
    barRoot.hidden = state.running
    pageRoot.hidden = state.page === 'home'
    el.toggleAttribute('inert', state.page !== 'home')
  }

  /** @param {Partial<ShellState>} partial */
  const setState = partial => {
    const from = state.page
    state = { ...state, ...partial }
    render()
    if (state.page === from) return
    // The same move element.js makes for a screen, for the same reason: the
    // button that was just pressed has gone, and focus must not go with it.
    if (state.page !== 'home') document.getElementById('page-title')?.focus()
    // Not when a session took Home over: the component is about to focus its
    // own heading, and that is the one that matters.
    else if (!state.running) document.getElementById(`nav-${from}`)?.focus()
  }

  /** @param {Page} page */
  const open = page => {
    if (state.running) return
    history.pushState(ENTRY, '')
    setState({ page, saveError: null, confirm: null })
  }

  async function changeSaveFolder() {
    if (!changeFolder) return
    try {
      const folder = await changeFolder()
      if (folder) setState({ saveLocation: folder, saveError: null })
    } catch (error) {
      setState({ saveError: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Every change to the store goes through here and comes back as the whole
   * store, so what the page shows is what history.rs holds rather than a
   * copy kept in step by hand.
   *
   * @param {() => Promise<import('./history.js').Store>} change
   * @param {Partial<ShellState>} [also]
   */
  async function updateHistory(change, also = {}) {
    try {
      const { enabled, entries } = await change()
      setState({ history: { enabled, entries, error: null }, ...also })
    } catch (error) {
      setState({ history: { ...state.history, error: error instanceof Error ? error.message : String(error) }, ...also })
    }
  }

  /**
   * Turning recording off stops the next record at once, and then asks about
   * the ones already kept rather than deciding for the person: someone
   * switching it off may want the past gone, or may only want no more.
   *
   * @param {boolean} enabled
   */
  async function setRecording(enabled) {
    if (!store) return
    await updateHistory(() => store.setEnabled(enabled), { confirm: null })
    // A store that refused leaves the state where it was, so patch() sees no
    // change and the box would go on showing the click that did not take.
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('history-enabled'))
    if (input) input.checked = state.history.enabled
    if (!enabled && state.history.enabled === false && state.history.entries.length) ask('off')
  }

  /**
   * Shows Settings' question and moves focus to its harmless answer. The row
   * it replaces may be the button just pressed, and focus must not go down
   * with it; and never to Clear, for the reason element.js never focuses
   * Accept: one stray Enter would answer for the person.
   *
   * @param {'clear' | 'off'} question
   */
  function ask(question) {
    setState({ confirm: question })
    document.getElementById('history-keep')?.focus()
  }

  /**
   * Closes the question, having cleared when `clearing` is the store doing
   * it, and puts focus back on the row the question took the place of.
   *
   * @param {Promise<import('./history.js').Store>} [clearing]
   */
  async function answered(clearing) {
    if (clearing) await updateHistory(() => clearing, { confirm: null })
    else setState({ confirm: null })
    const clear = /** @type {HTMLButtonElement | null} */ (document.getElementById('history-clear'))
    const target = clear && !clear.disabled ? clear : document.getElementById('history-enabled')
    target?.focus()
  }

  /**
   * @param {string} intent
   * @param {any} [payload]
   */
  function dispatch(intent, payload) {
    switch (intent) {
      case 'nav:open': return open(payload)
      // Through history rather than straight to a state change, so the arrow
      // and the system gesture are one path and the entry cannot be left behind.
      case 'nav:back': return history.back()
      case 'save:change-folder': return void changeSaveFolder()
      case 'history:enabled': return void setRecording(Boolean(payload))
      // Asked first, on the row, because it cannot be undone.
      case 'history:clear': return ask('clear')
      case 'history:clear-confirm': return void answered(store?.clear())
      case 'history:keep': return void answered()
      // What storage kept, which is off when it refused, so the switch never
      // shows a setting the next send will not read.
      case 'offline:enabled': {
        const on = offline ? offline.set(Boolean(payload)) : false
        setState({ offline: { ...state.offline, on } })
        const input = /** @type {HTMLInputElement | null} */ (document.getElementById('offline-enabled'))
        if (input) input.checked = on
        return
      }
      default: throw new Error(`Unknown intent: ${intent}`)
    }
  }

  function onPopState() {
    if (state.running) return
    if (stale) {
      stale--
      history.back()
      return
    }
    if (state.page === 'about') setState({ page: 'settings' })
    else if (state.page !== 'home') setState({ page: 'home' })
  }
  window.addEventListener('popstate', onPopState)

  // Escape leaves a page as the arrow does, which is what it does in a desktop
  // app's settings. Not while running, when every page is down and Escape
  // belongs to the component's sheets and beam's enlarged code. Nor when focus is
  // in the component over a page: it is inert there, so that is a sheet opened
  // by a paste, and Escape is the sheet's to close.
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || ev.defaultPrevented || state.running || state.page === 'home') return
    if (document.activeElement === el) return
    if (state.confirm) return answered()
    history.back()
  })

  el.addEventListener('screenchange', ev => {
    const { running } = /** @type {CustomEvent<{ running: boolean }>} */ (ev).detail
    if (running && state.page !== 'home') stale = state.page === 'about' ? 2 : 1
    setState({ running, page: running ? 'home' : state.page })
  })

  // The record is built in src/web/events.js, which is tested to hold no code,
  // key, digest or text; this only decides whether to keep it. After the
  // append, the whole list again, so the cap and the order are history.rs's.
  el.addEventListener('transferend', ev => {
    if (!store || !state.history.enabled) return
    const record = /** @type {CustomEvent<import('./history.js').Entry>} */ (ev).detail
    void updateHistory(async () => {
      await store.append(record)
      return store.list()
    })
  })

  // A delegated handler, because the adopted copy holds links too. A plain
  // target="_blank" does nothing useful in a webview: Android navigates the app
  // itself to the page, and there is no address bar to come back from it.
  pageRoot.addEventListener('click', ev => {
    const link = /** @type {Element} */ (ev.target).closest?.('a[href]')
    if (!link) return
    ev.preventDefault()
    openLink(/** @type {HTMLAnchorElement} */ (link).href)
  })

  render()
  if (store) void updateHistory(() => store.list())
  return { setState }
}

/**
 * One block of the copy the build placed in <template id="about-copy">.
 *
 * A clone held by the shell and handed to the view to adopt, so re-rendering
 * finds the same node and patch() leaves it alone.
 *
 * @param {string} name
 * @returns {{ title: string, node: Element | null }}
 */
function readCopy(name) {
  const template = /** @type {HTMLTemplateElement | null} */ (document.getElementById('about-copy'))
  const source = template?.content.querySelector(`[data-copy="${name}"]`)
  if (!source) return { title: '', node: null }
  return {
    title: /** @type {HTMLElement} */ (source).dataset.title ?? '',
    node: /** @type {Element} */ (source.cloneNode(true)),
  }
}
