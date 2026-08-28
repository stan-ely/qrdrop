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

import { generateSecret, encodeSecret, decodeSecret, deriveTopic, deriveSignalKey } from './crypto/secret.js'
import { joinRendezvous } from './signal/nostr.js'
import { connectPeers } from './signal/webrtc.js'
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

const $ = id => document.getElementById(id)

const SCREENS = ['choose', 'send', 'receive', 'verify', 'transfer', 'done']
const show = name => {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name
  $('error').hidden = true
}

const fail = error => {
  console.error(error)
  const el = $('error')
  // textContent, never innerHTML: some of these strings originate from the peer.
  el.textContent = error?.message ?? String(error)
  el.hidden = false
}

/**
 * A failed transfer must look failed.
 *
 * Showing only the error banner left the progress bar frozen mid-transfer,
 * which reads as a hang rather than a fault -- the user sees "Received 80 KB of
 * 300 KB" and waits for a transfer that has already been abandoned. show()
 * clears the banner, so it has to run before fail().
 */
const failTransfer = error => {
  show('done')
  $('done-title').textContent = 'Transfer failed'
  $('done-file').textContent = 'Nothing was saved. Start over with a fresh code.'
  $('done-digest').textContent = ''
  fail(error)
}

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
let teardown = null

function reset() {
  try { teardown?.() } catch { /* already gone */ }
  teardown = null
  show('choose')
}

/** Everything both roles need once the channel is up. */
function attachReceiver({ channel, session, onOffer, onProgress, onFileDone }) {
  const control = createControlStream()
  let controlOut = 0
  const nextControlIndex = () => controlOut++

  const receiver = createReceiver({
    channel,
    sendKey: session.sendKey,
    recvKey: session.recvKey,
    control,
    nextControlIndex,
    onOffer,
    onProgress,
    onFileDone,
    onError: failTransfer,
  })

  channel.addEventListener('message', ev => {
    receiver.handleFrame(new Uint8Array(ev.data)).catch(fail)
  })

  return { control, nextControlIndex }
}

function trackProgress({ statusEl, verb }) {
  return p => {
    const moved = p.sent ?? p.received
    $('progress-fill').style.setProperty('--progress', `${(moved / (p.total || 1)) * 100}%`)
    statusEl.textContent = `${verb} ${bytes(moved)} of ${bytes(p.total)}`
  }
}

/** Opens the rendezvous and brings up the peer connection. Shared by both roles. */
async function establish({ secret, role, statusEl }) {
  const [topic, signalKey] = await Promise.all([deriveTopic(secret), deriveSignalKey(secret)])

  const signal = joinRendezvous({
    topic,
    signalKey,
    onStatus: ({ connected, total }) => {
      if (!connected) statusEl.textContent = 'Connecting to relays…'
      else statusEl.textContent = `Waiting for the other device… (${connected}/${total} relays)`
    },
  })

  const controller = new AbortController()
  teardown = () => { controller.abort(); signal.close() }

  const peer = await connectPeers({
    signal,
    role,
    secret,
    onState: s => { if (s === 'connected') statusEl.textContent = 'Connected' },
  })

  // The rendezvous is not closed the moment the channel opens. ICE keeps
  // trickling after that, and a better route discovered a second later still
  // needs a path to reach the peer. Holding the relays briefly costs a few
  // idle sockets; closing too early costs a connection that cannot recover.
  const relayLinger = setTimeout(() => signal.close(), 15_000)

  teardown = () => {
    clearTimeout(relayLinger)
    controller.abort()
    signal.close()
    peer.close()
  }

  return peer
}

async function startSend(file) {
  const secret = generateSecret()
  const code = encodeSecret(secret)

  $('qr').innerHTML = renderQR(code)
  $('manual-code').textContent = code
  show('send')

  const peer = await establish({ secret, role: 'host', statusEl: $('send-status') })
  const { control, nextControlIndex } = attachReceiver({
    channel: peer.channel,
    session: peer.session,
  })

  // Verify before anything about the file leaves this device -- the manifest
  // alone would disclose its name and size.
  show('verify')
  $('sas').textContent = peer.session.sas

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
        channel: peer.channel,
        key: peer.session.sendKey,
        file,
        fileSeq: 0,
        control,
        nextControlIndex,
        onProgress: trackProgress({ statusEl: $('transfer-status'), verb: 'Sent' }),
      })

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
      peer.close()
    }
  }, { once: true })
}

async function startReceive(secret) {
  const peer = await establish({ secret, role: 'guest', statusEl: $('receive-status') })

  // Handlers go on before anything is drawn. A DataChannel drops messages that
  // arrive with no listener attached, and the sender is free to offer the
  // moment its side is up.
  attachReceiver({
    channel: peer.channel,
    session: peer.session,

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
      show('done')
      $('done-title').textContent = 'Received'
      $('done-file').textContent = file.name
      $('done-digest').textContent = file.digest
      peer.close()
    },
  })

  show('verify')
  $('sas').textContent = peer.session.sas
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
    const value = await scanQR({ video: $('scanner'), signal: controller.signal })
    startReceive(decodeSecret(value)).catch(fail)
  } catch (error) {
    if (error.name !== 'AbortError') fail(error)
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
    const secret = decodeSecret($('manual-input').value)
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
