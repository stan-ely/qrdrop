/**
 * Screen flow and wiring.
 *
 * Both peers run a receiver, always. A sending peer still has to read the
 * accept/done/error replies coming back, and those arrive as control frames on
 * the same channel as an inbound file would.
 *
 * Two user gestures gate every transfer, and neither is decorative:
 *   - the sender confirms the SAS matches before a manifest goes out
 *   - the receiver accepts, which is also the click that lets the browser open
 *     a save destination (see transfer/sink.js)
 */

import { generateSecret, encodeSecret, decodeSecret, deriveTopic, derivePassword } from './crypto/secret.js'
import { openRoom } from './signal/room.js'
import { createControlStream } from './transfer/control.js'
import { createReceiver } from './transfer/receiver.js'
import { sendFile } from './transfer/sender.js'
import { canStreamToDisk } from './transfer/sink.js'
import { renderQR, scanQR, cameraAvailable } from './ui/qr.js'

// Refuse to run framed. A page that can be embedded can be overlaid, and the
// two clicks this design relies on -- confirming the SAS, accepting a file --
// are exactly what clickjacking targets. frame-ancestors would cover this, but
// browsers ignore it in a <meta> tag and a static site cannot set headers, so
// the check lives here where it does not depend on the host's cooperation.
if (window.top !== window.self) {
  document.body.textContent = 'qrbeam will not run inside a frame.'
  throw new Error('Refusing to run in a frame')
}

/**
 * Every id below is one this page's own layout defines, so a miss means the
 * markup and this file have drifted apart.
 *
 * It throws rather than returning null. That is not a behaviour change worth
 * arguing about -- every call site immediately dereferences the result, so the
 * status quo was a TypeError one line later with no clue which id was missing
 * -- and it is what lets the return type be HTMLElement instead of
 * `HTMLElement | null`, which otherwise needs a null check at all forty-odd
 * call sites to say nothing useful.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = id => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Layout is missing #${id}`)
  return el
}

const SCREENS = ['choose', 'send', 'receive', 'verify', 'transfer', 'done']

/**
 * Whether the exchange has reached a terminal state.
 *
 * Both peers call room.close() once a transfer finishes, so each one sees the
 * other disappear. Without this flag that normal ending is reported as "The
 * other device disconnected" on a screen that has just said the transfer
 * succeeded. A disconnect still needs reporting while a transfer is live --
 * that is what rescues a sender otherwise blocked forever waiting for a 'done'
 * that is never coming -- so the signal is suppressed rather than removed.
 */
let sessionEnded = false

/** @param {typeof SCREENS[number]} name */
const show = name => {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name
  $('error').hidden = true
  if (name === 'done') sessionEnded = true
}

/** @param {unknown} error */
const fail = error => {
  console.error(error)
  const el = $('error')
  // textContent, never innerHTML: some of these strings originate from the peer.
  el.textContent = error instanceof Error ? error.message : String(error)
  el.hidden = false
}

/**
 * A failed transfer must look failed.
 *
 * Showing only the error banner left the progress bar frozen mid-transfer,
 * which reads as a hang rather than a fault -- the user sees "Received 80 KB of
 * 300 KB" and waits for a transfer that has already been abandoned. show()
 * clears the banner, so it has to run before fail().
 *
 * @param {unknown} error
 */
const failTransfer = error => {
  show('done')
  $('done-title').textContent = 'Transfer failed'
  $('done-file').textContent = 'Nothing was saved. Start over with a fresh code.'
  $('done-digest').textContent = ''
  fail(error)
}

/** @param {number} n */
const bytes = n => {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// A live session's teardown, so cancelling never leaves a camera on, a relay
// socket open, or a half-built peer connection lingering.
/** @type {(() => void) | null} */
let teardown = null

function reset() {
  try { teardown?.() } catch { /* already gone */ }
  teardown = null
  show('choose')
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
function attachReceiver({
  room,
  onProgress,
  onFileDone,
  // A sending peer runs a receiver too, but only to read its own replies -- it
  // has no screen for an inbound file. Throwing lands in processFrame's catch,
  // which tells the peer and surfaces the fault locally; that is what happened
  // before this argument was optional, and it stays the right answer. Silently
  // dropping the manifest would leave the offering peer waiting on a reply
  // that is never coming.
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
    onError: failTransfer,
  })

  // handleFrame serialises internally, so a burst of frames cannot race.
  room.onFrame(frame => { receiver.handleFrame(frame).catch(fail) })

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
function trackProgress({ statusEl, verb }) {
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
async function establish({ secret, role, statusEl }) {
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])

  const room = await openRoom({
    topic,
    password,
    secret,
    role,
    onStatus: text => { statusEl.textContent = text },
  })

  sessionEnded = false
  teardown = () => room.close()
  room.onPeerLeave(() => {
    if (!sessionEnded) fail(new Error('The other device disconnected.'))
  })

  return room
}

/** @param {File} file */
async function startSend(file) {
  const secret = generateSecret()
  const code = encodeSecret(secret)

  $('qr').replaceChildren(renderQR(code))
  $('manual-code').textContent = code
  show('send')

  const room = await establish({ secret, role: 'host', statusEl: $('send-status') })
  const { control, nextControlIndex } = attachReceiver({ room })

  // Verify before anything about the file leaves this device -- the manifest
  // alone would disclose its name and size.
  show('verify')
  $('sas').textContent = room.session.sas

  const go = document.createElement('button')
  go.className = 'primary'
  go.textContent = `They match — send ${file.name}`
  $('verify-status').replaceChildren(go)

  go.addEventListener('click', async () => {
    go.disabled = true
    show('transfer')
    $('transfer-title').textContent = 'Sending'
    $('transfer-file').textContent = `${file.name} (${bytes(file.size)})`

    try {
      const result = await sendFile({
        channel: room.channel,
        key: room.session.sendKey,
        file,
        fileSeq: 0,
        control,
        nextControlIndex,
        onProgress: trackProgress({ statusEl: $('transfer-status'), verb: 'Sent' }),
      })

      sessionEnded = true

      if (result.declined) {
        show('done')
        $('done-title').textContent = 'Declined'
        $('done-file').textContent = 'The other device turned down the file.'
        $('done-digest').textContent = ''
        return
      }

      show('done')
      $('done-title').textContent = 'Sent'
      $('done-file').textContent = file.name
      $('done-digest').textContent = result.digest
    } catch (error) {
      failTransfer(error)
    } finally {
      room.close()
    }
  }, { once: true })
}

/** @param {Bytes} secret */
async function startReceive(secret) {
  const room = await establish({ secret, role: 'guest', statusEl: $('receive-status') })

  // Handlers go on before anything is drawn, so a manifest arriving the instant
  // the sender is ready has somewhere to land.
  attachReceiver({
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

      no.addEventListener('click', () => { decline().catch(fail); reset() }, { once: true })

      // This click is what permits showSaveFilePicker to open.
      yes.addEventListener('click', async () => {
        yes.disabled = true
        no.disabled = true
        const sink = await accept()
        if (!sink) return reset()   // the save dialog was dismissed

        show('transfer')
        $('transfer-title').textContent = 'Receiving'
        $('transfer-file').textContent = `${manifest.name} (${bytes(manifest.size)})`
        if (!sink.streaming) {
          $('transfer-status').textContent =
            'This browser buffers the file in memory before saving it.'
        }
      }, { once: true })
    },

    onProgress: trackProgress({ statusEl: $('transfer-status'), verb: 'Received' }),

    onFileDone: file => {
      sessionEnded = true
      show('done')
      $('done-title').textContent = 'Received'
      $('done-file').textContent = file.name
      $('done-digest').textContent = file.digest
      room.close()
    },
  })

  show('verify')
  $('sas').textContent = room.session.sas
  $('verify-status').textContent = 'Waiting for the sender to offer a file…'
}

function pickFile() {
  const input = Object.assign(document.createElement('input'), { type: 'file' })
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) startSend(file).catch(fail)
  }, { once: true })
  input.click()
}

async function beginScan() {
  show('receive')
  $('receive-status').textContent = cameraAvailable()
    ? 'Point the camera at the code.'
    : 'No camera available — enter the code by hand.'

  if (!cameraAvailable()) return

  const controller = new AbortController()
  teardown = () => controller.abort()

  try {
    const video = /** @type {HTMLVideoElement} */ ($('scanner'))
    const value = await scanQR({ video, signal: controller.signal })
    startReceive(decodeSecret(value)).catch(fail)
  } catch (error) {
    // Cancelling is the ordinary way out of this screen, not a fault.
    if (!(error instanceof Error) || error.name !== 'AbortError') fail(error)
  }
}

$('btn-send').addEventListener('click', pickFile)
$('btn-receive').addEventListener('click', () => beginScan().catch(fail))
$('send-cancel').addEventListener('click', reset)
$('receive-cancel').addEventListener('click', reset)
$('transfer-cancel').addEventListener('click', reset)
$('done-again').addEventListener('click', reset)

$('manual-form').addEventListener('submit', ev => {
  ev.preventDefault()
  try {
    const input = /** @type {HTMLInputElement} */ ($('manual-input'))
    const secret = decodeSecret(input.value)
    teardown?.()
    startReceive(secret).catch(fail)
  } catch (error) {
    fail(error)
  }
})

if (!canStreamToDisk()) {
  const note = $('capability-note')
  note.textContent =
    'This browser cannot stream downloads to disk, so received files are held in '
    + 'memory until complete. Expect trouble much above a gigabyte.'
  note.hidden = false
}

if (!window.isSecureContext) {
  fail(new Error('This page must be served over HTTPS: WebCrypto and the camera are unavailable otherwise.'))
}
