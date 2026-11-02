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
 * re-pushing it from popstate, as _onBackGesture re-pushes its guard. Until that
 * push lands canGoBack() is false, so a second press inside the window finished
 * the activity: on an emulator, two presses from About went to the launcher.
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
 */
export function createShell({ el, barRoot, pageRoot, changeFolder, openLink }) {
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
    setState({ page, saveError: null })
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

  el.addEventListener('screenchange', ev => {
    const { running } = /** @type {CustomEvent<{ running: boolean }>} */ (ev).detail
    if (running && state.page !== 'home') stale = state.page === 'about' ? 2 : 1
    setState({ running, page: running ? 'home' : state.page })
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
