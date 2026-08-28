/**
 * The `<qr-drop>` custom element: screen flow and wiring.
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
 * element scope: `$()` below is a shadow-scoped querySelector, so the ids are
 * only unique within one instance, the way ids in a component are supposed to
 * work.
 *
 * The frame-refusal check that used to live at the top of this file (refusing
 * to run inside an iframe) is NOT here any more -- see site/main.js. A page
 * that deliberately embeds <qr-drop> is a legitimate consumer of the package,
 * and it is not this element's place to refuse to render itself just because
 * some *other*, unrelated page decided to frame the specific deployment at
 * share.stan-ely.com. That refusal is a property of the hosted site, not of
 * the component, so it moved to the site's own entry point.
 */

import { generateSecret, encodeSecret, decodeSecret, deriveTopic, derivePassword } from '../core/secret.js'
import { openRoom } from '../transport/room.js'
import { createControlStream } from '../core/control.js'
import { createReceiver } from '../core/receiver.js'
import { sendFile } from '../core/sender.js'
import { createSink, canStreamToDisk } from './sink.js'
import { renderQR, scanQR, cameraAvailable } from './qr.js'
import { fromFile } from './source.js'

const SCREENS = ['choose', 'send', 'receive', 'verify', 'transfer', 'done']

/**
 * The component's markup and styling, built once per instance into the shadow
 * root. Shadow DOM does not inherit page stylesheets -- that isolation is the
 * whole point of using one -- so the page's styles.css is inlined here as a
 * <style> block rather than linked. That is also what makes the element
 * self-contained: drop it into any page and it looks right without that page
 * remembering to also load a stylesheet.
 *
 * The CSS below is the former site/styles.css verbatim; only its selectors'
 * meaning changed (they now resolve inside the shadow tree instead of the
 * document). See site/index.html for the light-DOM page chrome (h1, tagline,
 * footer disclosure) that intentionally stays outside this element, since it
 * is content about the *page*, not about the component.
 */
const TEMPLATE = document.createElement('template')
TEMPLATE.innerHTML = `
<style>
:host {
  all: initial;
  display: block;
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  color: var(--text);
}

:host {
  --bg: #fbfbfa;
  --surface: #ffffff;
  --text: #1a1a19;
  --muted: #6b6b66;
  --line: #e3e3df;
  --accent: #b8563a;
  --accent-text: #ffffff;
  --ok: #2f6f4e;
  --bad: #a33328;
  --radius: 10px;
}

@media (prefers-color-scheme: dark) {
  :host {
    --bg: #16161a;
    --surface: #1f1f24;
    --text: #ecebe8;
    --muted: #9d9d98;
    --line: #33333a;
    --accent: #d4735a;
    --accent-text: #17171a;
    --ok: #7fc39b;
    --bad: #e08b7f;
  }
}

* { box-sizing: border-box; }

h2 {
  margin: 0 0 1rem;
  font-size: 1.05rem;
  font-weight: 600;
}

section {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.5rem;
}

button {
  font: inherit;
  font-weight: 500;
  padding: 0.6rem 1.1rem;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

button:hover { border-color: var(--muted); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: default; }

button.primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

button.ghost {
  border: none;
  background: none;
  color: var(--muted);
  padding-left: 0;
  margin-top: 0.75rem;
}

.choices { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.choices button { flex: 1 1 12rem; }

/* Always light, whatever the page theme: scanners read dark-on-light best. */
.qr {
  background: #ffffff;
  border-radius: 8px;
  padding: 0.75rem;
  width: min(16rem, 100%);
  margin: 0 auto 1.25rem;
}
.qr svg { display: block; width: 100%; height: auto; }

.scanner {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  background: #000;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.sas {
  font-size: 2.4rem;
  letter-spacing: 0.3em;
  text-align: center;
  margin: 1.25rem 0;
  /* Emoji fonts vary; give the glyphs room so they cannot be mistaken. */
  line-height: 1.4;
}

.code {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  word-break: break-all;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.6rem;
  margin-top: 0.5rem;
}

.bar {
  height: 6px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
  margin: 1rem 0 0.75rem;
}

.bar-fill {
  height: 100%;
  width: var(--progress, 0%);
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.2s ease-out;
}

.status { color: var(--muted); font-size: 0.875rem; margin: 0.5rem 0 0; }
.note { color: var(--muted); font-size: 0.8rem; }
.filename { font-weight: 600; margin: 0; word-break: break-all; }

.error {
  margin-top: 1rem;
  padding: 0.85rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--bad);
  color: var(--bad);
  font-size: 0.875rem;
}

.manual { margin-top: 1rem; }

summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.85rem;
}

#manual-form { display: flex; gap: 0.5rem; margin-top: 0.6rem; }

input[type="text"] {
  flex: 1;
  font: inherit;
  font-size: 0.875rem;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text);
  min-width: 0;
}

section + section { margin-top: 1.5rem; }

@media (max-width: 30rem) {
  section { padding: 1.15rem; }
  .sas { font-size: 1.9rem; letter-spacing: 0.2em; }
}
</style>

<section id="screen-choose">
  <div class="choices">
    <button id="btn-send" class="primary">Send a file</button>
    <button id="btn-receive">Receive a file</button>
  </div>
  <p class="note" id="capability-note" hidden></p>
</section>

<section id="screen-send" hidden>
  <h2>Scan this on the other device</h2>
  <div id="qr" class="qr"></div>

  <details class="manual">
    <summary>Can't scan? Use the code instead</summary>
    <p class="note">Read this out or paste it into the other device. Anyone who
      learns it can join this transfer, so treat it like a password.</p>
    <code id="manual-code" class="code"></code>
  </details>

  <p class="status" id="send-status">Starting…</p>
  <button id="send-cancel" class="ghost">Cancel</button>
</section>

<section id="screen-receive" hidden>
  <h2>Scan the sender's code</h2>
  <video id="scanner" class="scanner" muted playsinline></video>

  <details class="manual">
    <summary>Enter the code by hand</summary>
    <form id="manual-form">
      <input id="manual-input" type="text" placeholder="qrdrop:…" autocomplete="off"
             spellcheck="false" aria-label="Transfer code">
      <button type="submit">Join</button>
    </form>
  </details>

  <p class="status" id="receive-status"></p>
  <button id="receive-cancel" class="ghost">Cancel</button>
</section>

<section id="screen-verify" hidden>
  <h2>Check both devices show the same symbols</h2>
  <p class="sas" id="sas"></p>
  <p class="note">
    If these differ, someone is between you. Stop, and start over with a fresh code.
  </p>
  <p class="status" id="verify-status"></p>
</section>

<section id="screen-transfer" hidden>
  <h2 id="transfer-title">Transferring</h2>
  <p class="filename" id="transfer-file"></p>
  <div class="bar"><div class="bar-fill" id="progress-fill"></div></div>
  <p class="status" id="transfer-status"></p>
  <button id="transfer-cancel" class="ghost">Cancel</button>
</section>

<section id="screen-done" hidden>
  <h2 id="done-title">Done</h2>
  <p class="filename" id="done-file"></p>
  <details>
    <summary>Verification digest</summary>
    <code id="done-digest" class="code"></code>
    <p class="note">Both devices computed this independently from the file contents.</p>
  </details>
  <button id="done-again" class="primary">Send another</button>
</section>

<p class="error" id="error" hidden></p>
`

/**
 * A self-contained P2P encrypted file transfer widget.
 *
 * Usage: `<qr-drop></qr-drop>` after calling `defineQRDrop()`. Everything the
 * component needs -- markup, styles, behaviour -- lives inside its shadow
 * root; the host page supplies nothing but the tag.
 */
export class QRDropElement extends HTMLElement {
  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.append(TEMPLATE.content.cloneNode(true))
    this._root = root

    /**
     * Every id below is one this component's own template defines, so a miss
     * means the template and this file have drifted apart.
     *
     * It throws rather than returning null. That is not a behaviour change
     * worth arguing about -- every call site immediately dereferences the
     * result, so the status quo was a TypeError one line later with no clue
     * which id was missing -- and it is what lets the return type be
     * HTMLElement instead of `HTMLElement | null`, which otherwise needs a
     * null check at all forty-odd call sites to say nothing useful.
     *
     * @param {string} id
     * @returns {HTMLElement}
     */
    this._$ = id => {
      const el = root.getElementById(id)
      if (!el) throw new Error(`Template is missing #${id}`)
      return el
    }

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
  }

  connectedCallback() {
    const $ = this._$

    if (!canStreamToDisk()) {
      const note = $('capability-note')
      note.textContent =
        'This browser cannot stream downloads to disk, so received files are held in '
        + 'memory until complete. Expect trouble much above a gigabyte.'
      note.hidden = false
    }

    if (!window.isSecureContext) {
      this._fail(new Error('This page must be served over HTTPS: WebCrypto and the camera are unavailable otherwise.'))
    }

    $('btn-send').addEventListener('click', () => this._pickFile())
    $('btn-receive').addEventListener('click', () => this._beginScan().catch(e => this._fail(e)))
    $('send-cancel').addEventListener('click', () => this._reset())
    $('receive-cancel').addEventListener('click', () => this._reset())
    $('transfer-cancel').addEventListener('click', () => this._reset())
    $('done-again').addEventListener('click', () => this._reset())

    $('manual-form').addEventListener('submit', ev => {
      ev.preventDefault()
      try {
        const input = /** @type {HTMLInputElement} */ ($('manual-input'))
        const secret = decodeSecret(input.value)
        this._teardown?.()
        this._startReceive(secret).catch(e => this._fail(e))
      } catch (error) {
        this._fail(error)
      }
    })
  }

  /**
   * Tears down any live session on the way out, for the same reason reset()
   * does -- an element that gets removed from the page mid-transfer must not
   * leave a camera or a peer connection behind it.
   */
  disconnectedCallback() {
    try { this._teardown?.() } catch { /* already gone */ }
    this._teardown = null
  }

  /** @param {typeof SCREENS[number]} name */
  _show(name) {
    const $ = this._$
    for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name
    $('error').hidden = true
    if (name === 'done') this._sessionEnded = true
  }

  /** @param {unknown} error */
  _fail(error) {
    console.error(error)
    const el = this._$('error')
    // textContent, never innerHTML: some of these strings originate from the peer.
    el.textContent = error instanceof Error ? error.message : String(error)
    el.hidden = false
  }

  /**
   * A failed transfer must look failed.
   *
   * Showing only the error banner left the progress bar frozen mid-transfer,
   * which reads as a hang rather than a fault -- the user sees "Received 80 KB
   * of 300 KB" and waits for a transfer that has already been abandoned.
   * _show() clears the banner, so it has to run before _fail().
   *
   * @param {unknown} error
   */
  _failTransfer(error) {
    const $ = this._$
    this._show('done')
    $('done-title').textContent = 'Transfer failed'
    $('done-file').textContent = 'Nothing was saved. Start over with a fresh code.'
    $('done-digest').textContent = ''
    this._fail(error)
  }

  _reset() {
    try { this._teardown?.() } catch { /* already gone */ }
    this._teardown = null
    this._show('choose')
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
   * One progress renderer for both directions, which is why it reads the union.
   *
   * @param {object} args
   * @param {HTMLElement} args.statusEl
   * @param {string} args.verb
   * @returns {(p: TransferProgress) => void}
   */
  _trackProgress({ statusEl, verb }) {
    const $ = this._$
    return p => {
      const moved = 'sent' in p ? p.sent : p.received
      $('progress-fill').style.setProperty('--progress', `${(moved / (p.total || 1)) * 100}%`)
      statusEl.textContent = `${verb} ${bytes(moved)} of ${bytes(p.total)}`
    }
  }

  /**
   * Opens the rendezvous and pairs. Shared by both roles.
   *
   * @param {object} args
   * @param {Bytes} args.secret
   * @param {'host' | 'guest'} args.role
   * @param {HTMLElement} args.statusEl
   * @returns {Promise<PairedRoom>}
   */
  async _establish({ secret, role, statusEl }) {
    const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])

    const room = await openRoom({
      topic,
      password,
      secret,
      role,
      onStatus: text => { statusEl.textContent = text },
    })

    this._sessionEnded = false
    this._teardown = () => room.close()
    room.onPeerLeave(() => {
      if (!this._sessionEnded) this._fail(new Error('The other device disconnected.'))
    })

    return room
  }

  /** @param {File} file */
  async _startSend(file) {
    const $ = this._$
    const secret = generateSecret()
    const code = encodeSecret(secret)

    $('qr').replaceChildren(renderQR(code))
    $('manual-code').textContent = code
    this._show('send')

    const room = await this._establish({ secret, role: 'host', statusEl: $('send-status') })
    const { control, nextControlIndex } = this._attachReceiver({ room })

    // Verify before anything about the file leaves this device -- the
    // manifest alone would disclose its name and size.
    this._show('verify')
    $('sas').textContent = room.session.sas

    const go = document.createElement('button')
    go.className = 'primary'
    go.textContent = `They match — send ${file.name}`
    $('verify-status').replaceChildren(go)

    const source = fromFile(file)

    go.addEventListener('click', async () => {
      go.disabled = true
      this._show('transfer')
      $('transfer-title').textContent = 'Sending'
      $('transfer-file').textContent = `${file.name} (${bytes(file.size)})`

      try {
        const result = await sendFile({
          channel: room.channel,
          key: room.session.sendKey,
          file: source,
          fileSeq: 0,
          control,
          nextControlIndex,
          onProgress: this._trackProgress({ statusEl: $('transfer-status'), verb: 'Sent' }),
        })

        this._sessionEnded = true

        if (result.declined) {
          this._show('done')
          $('done-title').textContent = 'Declined'
          $('done-file').textContent = 'The other device turned down the file.'
          $('done-digest').textContent = ''
          return
        }

        this._show('done')
        $('done-title').textContent = 'Sent'
        $('done-file').textContent = file.name
        $('done-digest').textContent = result.digest
      } catch (error) {
        this._failTransfer(error)
      } finally {
        room.close()
      }
    }, { once: true })
  }

  /** @param {Bytes} secret */
  async _startReceive(secret) {
    const $ = this._$
    const room = await this._establish({ secret, role: 'guest', statusEl: $('receive-status') })

    // Handlers go on before anything is drawn, so a manifest arriving the
    // instant the sender is ready has somewhere to land.
    this._attachReceiver({
      room,

      onOffer: ({ manifest, accept, decline }) => {
        const name = document.createTextNode(`${manifest.name} (${bytes(manifest.size)}) `)
        const yes = Object.assign(document.createElement('button'), {
          className: 'primary', textContent: 'Accept',
        })
        const no = Object.assign(document.createElement('button'), {
          className: 'ghost', textContent: 'Decline',
        })
        // Names come from the peer, so they are inserted as text nodes only.
        $('verify-status').replaceChildren(name, yes, no)

        no.addEventListener('click', () => { decline().catch(e => this._fail(e)); this._reset() }, { once: true })

        // This click is what permits showSaveFilePicker to open.
        yes.addEventListener('click', async () => {
          yes.disabled = true
          no.disabled = true
          const sink = await accept()
          if (!sink) return this._reset()   // the save dialog was dismissed

          this._show('transfer')
          $('transfer-title').textContent = 'Receiving'
          $('transfer-file').textContent = `${manifest.name} (${bytes(manifest.size)})`
          if (!sink.streaming) {
            $('transfer-status').textContent =
              'This browser buffers the file in memory before saving it.'
          }
        }, { once: true })
      },

      onProgress: this._trackProgress({ statusEl: $('transfer-status'), verb: 'Received' }),

      onFileDone: file => {
        this._sessionEnded = true
        this._show('done')
        $('done-title').textContent = 'Received'
        $('done-file').textContent = file.name
        $('done-digest').textContent = file.digest
        room.close()
      },
    })

    this._show('verify')
    $('sas').textContent = room.session.sas
    $('verify-status').textContent = 'Waiting for the sender to offer a file…'
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
    const $ = this._$
    this._show('receive')
    $('receive-status').textContent = cameraAvailable()
      ? 'Point the camera at the code.'
      : 'No camera available — enter the code by hand.'

    if (!cameraAvailable()) return

    const controller = new AbortController()
    this._teardown = () => controller.abort()

    try {
      const video = /** @type {HTMLVideoElement} */ ($('scanner'))
      const value = await scanQR({ video, signal: controller.signal })
      this._startReceive(decodeSecret(value)).catch(e => this._fail(e))
    } catch (error) {
      // Cancelling is the ordinary way out of this screen, not a fault.
      if (!(error instanceof Error) || error.name !== 'AbortError') this._fail(error)
    }
  }
}

/** @param {number} n */
function bytes(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
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
