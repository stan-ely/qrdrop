/**
 * The `<qr-drop>` custom element: session wiring, teardown, and the DOM the
 * pure `render()` cannot own.
 *
 * Both peers run a receiver, always. A sending peer still has to read the
 * accept/done/error replies coming back, and those arrive as control frames on
 * the same channel as an inbound file would.
 *
 * Two user gestures gate every transfer, and neither is decorative:
 *   - the sender confirms the SAS matches before a manifest goes out
 *   - the receiver accepts, which is also the click that lets the browser open
 *     a save destination (see web/sink.js)
 *
 * WHY A CUSTOM ELEMENT: this used to be a script that grabbed elements off
 * `document` by id and assumed it owned the whole page. That is unusable as a
 * package export -- a consumer embedding qrdrop into their own site would
 * collide on every id the moment they had two of anything on the page, or
 * even one <qr-drop> twice. A shadow root gives this component its own
 * element scope: ids in the rendered markup are only unique within one
 * instance, the way ids in a component are supposed to work.
 *
 * The frame-refusal check that used to live at the top of this file (refusing
 * to run inside an iframe) is NOT here any more -- see site/main.js. A page
 * that deliberately embeds <qr-drop> is a legitimate consumer of the package,
 * and it is not this element's place to refuse to render itself just because
 * some *other*, unrelated page decided to frame the specific deployment at
 * share.stan-ely.com. That refusal is a property of the hosted site, not of
 * the component, so it moved to the site's own entry point.
 *
 * WHY THIS FILE IS SMALL NOW: src/web/view.js is a pure function from a plain
 * state object to a vnode tree, and src/web/vdom.js turns that into real DOM.
 * What is left here is exactly what a pure function cannot hold: the
 * session/room objects, the receiver wiring, teardown, the `_sessionEnded`
 * flag, and the handful of native browser events (drag, drop, paste,
 * `location.hash`) that happen to the whole component rather than to any one
 * rendered element.
 */

import {
  generateSecret, encodeSecret, encodeSecretURL, decodeSecret, deriveTopic, derivePassword,
} from '../core/secret.js'
import { openRoom, RELAYED_MAX_BYTES } from '../transport/room.js'
import { createControlStream } from '../core/control.js'
import { createReceiver } from '../core/receiver.js'
import { sendFile } from '../core/sender.js'
import { relayCapMessage, relayCapDeclineMessage, PEER_DISCONNECTED } from '../core/messages.js'
import { bytes } from '../core/format.js'
import { createSink, canStreamToDisk } from './sink.js'
import { renderQR, scanQR, cameraAvailable } from './qr.js'
import { fromFile } from './source.js'
import { patch } from './vdom.js'
import { render } from './view.js'
import { copyText } from './copy.js'
import { STYLES } from './styles.js'

/**
 * Shown on the choose screen only when this browser cannot stream a
 * download straight to disk (see web/sink.js's canStreamToDisk). Computed
 * once per instance -- the capability does not change mid-session.
 */
const CAPABILITY_NOTE =
  'This browser cannot stream downloads to disk, so received files are held in '
  + 'memory until complete. Expect trouble much above a gigabyte.'

/**
 * One CSSStyleSheet for every instance on the page. Null on browsers without
 * constructable stylesheets, which fall back to a <style> child; see the
 * constructor.
 * @type {CSSStyleSheet | null}
 */
const SHEET = (() => {
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(STYLES)
    return sheet
  } catch {
    return null
  }
})()

/**
 * A self-contained P2P encrypted file transfer widget.
 *
 * Usage: `<qr-drop></qr-drop>` after calling `defineQRDrop()`. Everything the
 * component needs -- markup, styles, behaviour -- lives inside its shadow
 * root; the host page supplies nothing but the tag, and optionally a
 * `base-url` attribute (see `attributeChangedCallback`).
 */
export class QRDropElement extends HTMLElement {
  static get observedAttributes() { return ['base-url'] }

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    this._root = root

    // The stylesheet is adopted rather than appended as a <style> child, and
    // that is load-bearing rather than a modernisation. patch() owns every
    // child of this root: anything the view did not describe gets removed as
    // stale. A <style> element sitting at childNodes[0] is therefore
    // overwritten by the first screen vnode on the very first render, which
    // silently strips the component back to unstyled browser defaults --
    // buttons as grey chrome, the step rail as a bulleted list -- while every
    // test still passes, because the e2e reads text and visibility, not
    // paint. An adopted sheet is not a child node at all, so it is genuinely
    // outside the patched region in the way a <style> child only looked.
    //
    // It is also constructed once at module scope and shared by every
    // instance: two <qr-drop>s on a page then parse this CSS once between
    // them rather than once each.
    if (SHEET) root.adoptedStyleSheets = [SHEET]
    else {
      // No constructable stylesheets. Re-appended after each patch instead --
      // see _render.
      this._styleEl = document.createElement('style')
      this._styleEl.textContent = STYLES
    }

    /** @type {HTMLStyleElement | null} Fallback only; see above and _render. */
    this._styleEl = null

    /** @type {string | null} Set via the `base-url` attribute; see below. */
    this._baseURL = this.getAttribute('base-url') || null

    /**
     * The document-level paste listener, kept so disconnectedCallback can
     * take it off again. See connectedCallback for why it is not on `this`.
     * @type {((ev: ClipboardEvent) => void) | null}
     */
    this._onPaste = null

    /**
     * Whether the exchange has reached a terminal state.
     *
     * Both peers call room.close() once a transfer finishes, so each one sees
     * the other disappear. Without this flag that normal ending is reported
     * as "The other device disconnected" on a screen that has just said the
     * transfer succeeded. A disconnect still needs reporting while a transfer
     * is live -- that is what rescues a sender otherwise blocked forever
     * waiting for a 'done' that is never coming -- so the signal is
     * suppressed rather than removed.
     */
    this._sessionEnded = false

    // A live session's teardown, so cancelling never leaves a camera on, a
    // relay socket open, or a half-built peer connection lingering.
    /** @type {(() => void) | null} */
    this._teardown = null

    // One-shot closures for the two safety gestures. Set when the relevant
    // offer/SAS becomes available, cleared the instant they fire (mirroring
    // the old `{ once: true }` listeners) so a slow double-click cannot
    // re-enter `showSaveFilePicker` or send a manifest twice.
    /** @type {(() => void) | null} */
    this._onVerifyConfirm = null
    /** @type {(() => void) | null} */
    this._onOfferAccept = null
    /** @type {(() => void) | null} */
    this._onOfferDecline = null

    /** @type {number | undefined} */
    this._copyTimer = undefined

    this._dispatch = this._dispatch.bind(this)

    this._state = this._initialState()
    /** @type {import('./vdom.js').VNode[] | null} */
    this._prev = null
  }

  /** @returns {import('./view.js').State} */
  _initialState() {
    return {
      screen: 'choose',
      role: /** @type {'sender' | 'receiver' | null} */ (null),
      status: '',
      error: /** @type {string | null} */ (null),
      code: '',
      qrNode: /** @type {Element | null} */ (null),
      cameraAvailable: cameraAvailable(),
      capabilityNote: canStreamToDisk() ? null : CAPABILITY_NOTE,
      sas: '',
      sasWords: /** @type {string[]} */ ([]),
      offer: /** @type {{ name: string, size: number } | null} */ (null),
      file: /** @type {{ name: string, size: number } | null} */ (null),
      progress: /** @type {{ moved: number, total: number } | null} */ (null),
      outcome: /** @type {'sent' | 'received' | 'declined' | 'failed' | 'too-large' | null} */ (null),
      message: /** @type {string | null} */ (null),
      digest: '',
      dragging: false,
      copied: /** @type {'code' | 'digest' | null} */ (null),
      pairing: false,
    }
  }

  /**
   * @param {string} name
   * @param {string | null} _old
   * @param {string | null} value
   */
  attributeChangedCallback(name, _old, value) {
    if (name === 'base-url') this._baseURL = value || null
  }

  connectedCallback() {
    if (!window.isSecureContext) {
      this._fail(new Error('This page must be served over HTTPS: WebCrypto and the camera are unavailable otherwise.'))
    }

    // Render once before wiring anything else, so the ids referenced below
    // (and by drag/drop/paste guards) actually exist.
    this._render()

    // Drop/paste apply to the whole component, not to any one rendered
    // element -- "drop a file anywhere on qrdrop" is a property of the host,
    // which is why these listeners live here instead of as vnode props in
    // view.js. Guarded to the choose screen so a file cannot be dropped or
    // pasted mid-transfer, clobbering a session already in flight.
    //
    // The drag highlight is driven by a depth counter rather than by
    // dragenter/dragleave directly. Those two fire again on every crossing
    // between child elements, so a pointer moved from the dropzone onto the
    // button inside it emits a leave immediately followed by an enter --
    // clearing and re-setting the highlight, which reads as a flicker for
    // exactly as long as the user is deciding where to let go. Counting
    // enters against leaves means the highlight only clears when the pointer
    // has actually left the component.
    let dragDepth = 0
    const setDragging = (/** @type {boolean} */ on) => {
      if (this._state.dragging !== on) this._setState({ dragging: on })
    }

    this.addEventListener('dragenter', ev => {
      if (this._state.screen !== 'choose') return
      ev.preventDefault()
      dragDepth++
      setDragging(true)
    })
    this.addEventListener('dragover', ev => {
      if (this._state.screen !== 'choose') return
      ev.preventDefault() // otherwise the browser navigates to the dropped file
    })
    this.addEventListener('dragleave', () => {
      if (this._state.screen !== 'choose') return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setDragging(false)
    })
    this.addEventListener('drop', ev => {
      if (this._state.screen !== 'choose') return
      ev.preventDefault()
      dragDepth = 0
      setDragging(false)
      const file = ev.dataTransfer?.files?.[0]
      if (file) this._startSend(file).catch(e => this._fail(e))
    })

    // Paste is bound to the document, not to this element, and that is not an
    // oversight. A paste event targets whatever has focus; on a freshly
    // loaded page that is <body>, and events do not travel *down* into
    // children, so a listener on this host would simply never hear the one
    // keystroke it exists to catch. Binding the document is the only way
    // "press Ctrl-V to send what you copied" actually works.
    //
    // The cost is that this component then hears pastes meant for the rest of
    // an embedder's page, so it declines any that landed in somewhere a
    // person was plainly typing, and -- as with drop -- any that arrive when
    // this is not the choose screen. It is removed again on disconnect.
    this._onPaste = ev => {
      if (this._state.screen !== 'choose') return
      const target = ev.composedPath()[0]
      if (target instanceof HTMLElement
        && (target.isContentEditable || target.closest('input, textarea'))) return
      const file = [...(ev.clipboardData?.files ?? [])][0]
      if (file) this._startSend(file).catch(e => this._fail(e))
    }
    document.addEventListener('paste', this._onPaste)

    // Auto-join: a code carried in the URL fragment (see core/secret.js's
    // encodeSecretURL) skips the "tap Receive" click, but not the SAS screen
    // -- _startReceive below still stops there like every other path, so
    // this never bypasses either safety gesture, only the click that gets a
    // user to the same waiting room a scan or a pasted code would.
    //
    // The hash is cleared immediately, before the code inside it is even
    // decoded, via replaceState rather than a normal navigation (which would
    // add a history entry). A decryption key sitting in the address bar can
    // be copied, bookmarked, or synced to another device's history without
    // anyone realising it is sensitive -- the bare `qrdrop:` code never had
    // that problem because it never went in a URL at all.
    const hash = location.hash.slice(1)
    if (hash) {
      history.replaceState(null, '', location.pathname + location.search)
      try {
        this._startReceive(decodeSecret(hash)).catch(e => this._fail(e))
      } catch {
        // Not a qrdrop code -- an ordinary in-page anchor, most likely.
        // Nothing to do; this element does not own the rest of the page's hashes.
      }
    }
  }

  /**
   * Tears down any live session on the way out, for the same reason reset()
   * does -- an element that gets removed from the page mid-transfer must not
   * leave a camera or a peer connection behind it.
   */
  disconnectedCallback() {
    // The document-level paste listener above outlives this element unless it
    // is taken off by hand; left behind, it would keep a detached component
    // (and the session it may still be holding) alive for the page's lifetime.
    if (this._onPaste) document.removeEventListener('paste', this._onPaste)
    this._onPaste = null

    try { this._teardown?.() } catch { /* already gone */ }
    this._teardown = null
    clearTimeout(this._copyTimer)
  }

  /**
   * @param {string} intent
   * @param {any} [payload]
   */
  _dispatch(intent, payload) {
    switch (intent) {
      case 'send:pick': return this._pickFile()
      case 'receive:scan': return void this._beginScan().catch(e => this._fail(e))
      case 'manual:submit': return this._submitManualCode(payload)
      case 'verify:confirm': return this._onVerifyConfirm?.()
      case 'offer:accept': return this._onOfferAccept?.()
      case 'offer:decline': return this._onOfferDecline?.()
      case 'cancel': return this._reset()
      case 'restart': return this._reset()
      case 'copy': return void this._copy(payload)
      default: throw new Error(`Unknown intent: ${intent}`)
    }
  }

  /**
   * Applies a partial state update and re-renders synchronously.
   *
   * Two behaviours are folded in here rather than left for every call site
   * to remember:
   *
   *  - A screen change clears any stale error banner unless the same update
   *    sets a new one. The old version's error banner was a sibling of every
   *    section, cleared only by the imperative `_show()`, so it could linger
   *    across a transition; here it is simply a fact about `state.error`.
   *  - Reaching 'done' sets `_sessionEnded`, same as the old `_show('done')`
   *    did -- see the flag's own comment in the constructor for why it
   *    exists at all.
   *
   * @param {Partial<ReturnType<QRDropElement['_initialState']>>} partial
   */
  _setState(partial) {
    const prevScreen = this._state.screen
    if ('screen' in partial && partial.screen !== prevScreen) {
      partial = { error: null, ...partial }
    }
    if (partial.screen === 'done') this._sessionEnded = true

    this._state = { ...this._state, ...partial }
    this._render()

    if (this._state.screen !== prevScreen) this._focusScreenHeading()
  }

  _render() {
    this._prev = patch(this._root, render(this._state, this._dispatch), this._prev)
    // Only reached on browsers without constructable stylesheets, where the
    // sheet has to be a real child and patch() has just discarded it.
    if (this._styleEl) this._root.append(this._styleEl)
  }

  /**
   * Moves focus to the new screen's <h2> so assistive tech announces the
   * transition instead of leaving focus stranded on a button that just went
   * `hidden`. Deliberately never called for the SAS-confirm or Accept
   * buttons specifically -- those are safety gestures (see the class
   * comment) and must not be dismissible by a stray Enter keypress, which is
   * exactly what auto-focusing a primary button would invite.
   */
  _focusScreenHeading() {
    const heading = this._root.getElementById(`screen-${this._state.screen}`)?.querySelector('h2')
    if (heading instanceof HTMLElement) heading.focus()
  }

  /** @param {unknown} error */
  _fail(error) {
    console.error(error)
    // textContent, never innerHTML: some of these strings originate from the peer.
    this._setState({ error: error instanceof Error ? error.message : String(error) })
  }

  /**
   * A failed transfer must look failed.
   *
   * Landing on 'done' with outcome 'failed' clears the frozen progress bar
   * that a plain error banner would leave behind -- without this, "Received
   * 80 KB of 300 KB" would just sit there looking like a hang rather than a
   * fault the transfer has already given up on.
   *
   * @param {unknown} error
   */
  _failTransfer(error) {
    this._setState({ screen: 'done', outcome: 'failed', file: null, digest: '', message: null })
    this._fail(error)
  }

  _reset() {
    try { this._teardown?.() } catch { /* already gone */ }
    this._teardown = null
    this._onVerifyConfirm = null
    this._onOfferAccept = null
    this._onOfferDecline = null
    clearTimeout(this._copyTimer)
    this._setState({
      screen: 'choose', role: null, status: '', code: '', qrNode: null,
      sas: '', sasWords: [], offer: null, file: null, progress: null,
      outcome: null, message: null, digest: '', pairing: false, copied: null, dragging: false,
    })
  }

  /**
   * @param {'code' | 'digest'} target
   */
  async _copy(target) {
    const text = target === 'code' ? this._state.code : this._state.digest
    if (!text) return
    const ok = await copyText(text)
    if (!ok) return
    clearTimeout(this._copyTimer)
    this._setState({ copied: target })
    // Transient confirmation, not a permanent state -- it reverts on its own
    // rather than waiting for the next unrelated re-render to clear it.
    this._copyTimer = setTimeout(() => this._setState({ copied: null }), 1500)
  }

  /** @param {string} raw */
  _submitManualCode(raw) {
    try {
      const secret = decodeSecret(raw)
      this._teardown?.()
      this._startReceive(secret).catch(e => this._fail(e))
    } catch (error) {
      this._fail(error)
    }
  }

  /**
   * Everything both roles need once the room is up.
   *
   * @param {object} args
   * @param {PairedRoom} args.room
   * @param {Parameters<typeof createReceiver>[0]['onOffer']} [args.onOffer]
   * @param {(p: ReceiveProgress) => void} [args.onProgress]
   * @param {(file: { name: string, size: number, digest: string }) => void} [args.onFileDone]
   */
  _attachReceiver({
    room,
    onProgress,
    onFileDone,
    // A sending peer runs a receiver too, but only to read its own replies --
    // it has no screen for an inbound file. Throwing lands in processFrame's
    // catch, which tells the peer and surfaces the fault locally; that is
    // what happened before this argument was optional, and it stays the
    // right answer. Silently dropping the manifest would leave the offering
    // peer waiting on a reply that is never coming.
    onOffer = () => { throw new Error('Peer offered a file while we were sending one') },
  }) {
    const control = createControlStream()
    let controlOut = 0
    const nextControlIndex = () => controlOut++

    const receiver = createReceiver({
      channel: room.channel,
      sendKey: room.session.sendKey,
      recvKey: room.session.recvKey,
      control,
      nextControlIndex,
      onOffer,
      onProgress,
      onFileDone,
      onError: e => this._failTransfer(e),
      createSink,
    })

    // handleFrame serialises internally, so a burst of frames cannot race.
    room.onFrame(frame => { receiver.handleFrame(frame).catch(e => this._fail(e)) })

    return { control, nextControlIndex }
  }

  /**
   * One progress renderer for both directions, which is why it reads the
   * union `TransferProgress`.
   *
   * @param {string} verb 'Sent' or 'Received'.
   * @returns {(p: TransferProgress) => void}
   */
  _trackProgress(verb) {
    return p => {
      const moved = 'sent' in p ? p.sent : p.received
      this._setState({
        progress: { moved, total: p.total },
        status: `${verb} ${bytes(moved)} of ${bytes(p.total)}`,
      })
    }
  }

  /**
   * Opens the rendezvous and pairs. Shared by both roles.
   *
   * @param {object} args
   * @param {Bytes} args.secret
   * @param {'host' | 'guest'} args.role
   * @returns {Promise<PairedRoom>}
   */
  async _establish({ secret, role }) {
    const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])

    const room = await openRoom({
      topic,
      password,
      secret,
      role,
      onStatus: text => this._setState({ status: text }),
    })

    this._sessionEnded = false
    this._teardown = () => room.close()
    room.onPeerLeave(() => {
      if (!this._sessionEnded) this._fail(new Error(PEER_DISCONNECTED))
    })

    return room
  }

  /** @param {File} file */
  async _startSend(file) {
    const secret = generateSecret()

    // The QR and #manual-code deliberately encode different strings when
    // base-url is set. The QR is for a phone's own camera app -- it needs
    // the URL form, since a bare `qrdrop:` string is not something that app
    // knows how to open (see core/secret.js's encodeSecretURL). The manual
    // code exists for the opposite case: a human reading it aloud or typing
    // it in by hand, for whom the bare form is strictly better -- shorter,
    // and with no scheme/host noise to transcribe. `decodeSecret` accepts
    // both forms on the way back in, so nothing is lost by keeping the two
    // independent; a receiver typing the bare code in gets exactly the same
    // session as one who scanned the URL.
    const qrText = this._baseURL ? encodeSecretURL(secret, this._baseURL) : encodeSecret(secret)
    const code = encodeSecret(secret)

    this._setState({
      screen: 'send', role: 'sender', code, qrNode: renderQR(qrText),
      status: 'Starting…', pairing: true, file: { name: file.name, size: file.size },
    })

    const room = await this._establish({ secret, role: 'host' })
    this._setState({ pairing: false })

    // Free TURN is metered; refuse a large file before the manifest goes out
    // rather than have it throttled or cut partway. Only bites on a relayed
    // path -- a direct connection has no such limit.
    if (file.size > RELAYED_MAX_BYTES && await room.isRelayed()) {
      room.close()
      throw new Error(relayCapMessage({ name: file.name, size: file.size, limit: RELAYED_MAX_BYTES }))
    }

    const { control, nextControlIndex } = this._attachReceiver({ room })

    // Verify before anything about the file leaves this device -- the
    // manifest alone would disclose its name and size.
    this._setState({ screen: 'verify', sas: room.session.sas, sasWords: room.session.sasWords })

    const source = fromFile(file)

    this._onVerifyConfirm = async () => {
      // One-shot, mirroring the old button's `{ once: true }` listener: this
      // is the sender's half of the two safety gestures, and it must not be
      // re-triggerable while the send it just started is in flight.
      this._onVerifyConfirm = null

      this._setState({ screen: 'transfer', status: '', progress: { moved: 0, total: file.size } })

      try {
        const result = await sendFile({
          channel: room.channel,
          key: room.session.sendKey,
          file: source,
          fileSeq: 0,
          control,
          nextControlIndex,
          onProgress: this._trackProgress('Sent'),
        })

        this._sessionEnded = true

        if (result.declined) {
          this._setState({ screen: 'done', outcome: 'declined' })
          return
        }

        this._setState({ screen: 'done', outcome: 'sent', digest: result.digest })
      } catch (error) {
        this._failTransfer(error)
      } finally {
        room.close()
      }
    }
  }

  /** @param {Bytes} secret */
  async _startReceive(secret) {
    this._setState({ screen: 'receive', role: 'receiver', status: 'Starting…', pairing: true })

    const room = await this._establish({ secret, role: 'guest' })
    this._setState({ pairing: false })

    // Handlers go on before anything is drawn, so a manifest arriving the
    // instant the sender is ready has somewhere to land.
    this._attachReceiver({
      room,

      onOffer: ({ manifest, accept, decline }) => {
        // onOffer itself is synchronous (see receiver.js); the relay check is
        // not, so it runs in a detached async step before the prompt is drawn.
        void (async () => {
          if (manifest.size > RELAYED_MAX_BYTES && await room.isRelayed()) {
            await decline()
            this._setState({
              screen: 'done', outcome: 'too-large',
              message: relayCapDeclineMessage({ name: manifest.name, size: manifest.size, limit: RELAYED_MAX_BYTES }),
            })
            return
          }

          this._onOfferDecline = async () => {
            this._onOfferDecline = null
            this._onOfferAccept = null
            try { await decline() } catch (e) { this._fail(e) }
            this._reset()
          }

          // This is the receiver's half of the two safety gestures: this
          // click is what permits showSaveFilePicker to open (see
          // web/sink.js), so it has to stay a real, synchronous-enough user
          // gesture -- one-shot for the same reason the sender's confirm is.
          this._onOfferAccept = async () => {
            this._onOfferAccept = null
            this._onOfferDecline = null

            const sink = await accept()
            if (!sink) return this._reset() // the save dialog was dismissed

            this._setState({
              screen: 'transfer',
              file: { name: manifest.name, size: manifest.size },
              status: sink.streaming ? '' : 'This browser buffers the file in memory before saving it.',
              progress: { moved: 0, total: manifest.size },
            })
          }

          this._setState({ offer: { name: manifest.name, size: manifest.size } })
        })().catch(e => this._fail(e))
      },

      onProgress: this._trackProgress('Received'),

      onFileDone: file => {
        this._sessionEnded = true
        this._setState({
          screen: 'done', outcome: 'received',
          file: { name: file.name, size: file.size }, digest: file.digest,
        })
        room.close()
      },
    })

    this._setState({ screen: 'verify', sas: room.session.sas, sasWords: room.session.sasWords })
  }

  _pickFile() {
    const input = Object.assign(document.createElement('input'), { type: 'file' })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) this._startSend(file).catch(e => this._fail(e))
    }, { once: true })
    input.click()
  }

  async _beginScan() {
    this._setState({
      screen: 'receive', role: 'receiver',
      status: cameraAvailable()
        ? 'Point the camera at the code.'
        : 'No camera available — enter the code by hand.',
    })

    if (!cameraAvailable()) return

    const controller = new AbortController()
    this._teardown = () => controller.abort()

    try {
      const video = /** @type {HTMLVideoElement} */ (this._root.getElementById('scanner'))
      const value = await scanQR({ video, signal: controller.signal })
      this._startReceive(decodeSecret(value)).catch(e => this._fail(e))
    } catch (error) {
      // Cancelling is the ordinary way out of this screen, not a fault.
      if (!(error instanceof Error) || error.name !== 'AbortError') this._fail(error)
    }
  }
}

/**
 * Registers the element, guarded against double-registration.
 *
 * `customElements.define` throws if the tag name is already taken, and a
 * consumer's bundler can easily end up evaluating this module twice (once
 * directly, once through a duplicate dependency graph). Checking first turns
 * that from a page-breaking exception into a harmless no-op -- the tag is
 * already defined, which is exactly what the caller wanted.
 *
 * @param {string} [tagName]
 */
export function defineQRDrop(tagName = 'qr-drop') {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, QRDropElement)
  }
}
