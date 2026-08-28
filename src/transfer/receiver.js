/**
 * Inbound side of a transfer.
 *
 * One demultiplexer serves both roles, because a peer is simultaneously
 * receiving files and receiving the replies to files it is sending. Control
 * frames addressed to our sender (accept / decline / done) are pushed onto the
 * shared control stream; everything else is handled here.
 *
 * The receiver never trusts the frame it was handed to tell it where the frame
 * belongs. Expected indices come from state tracked locally and are passed into
 * open(), so a peer that replays, skips, or reorders is rejected before its
 * bytes are decrypted -- let alone written to disk.
 */

import {
  HEADER_BYTES, TYPE_CHUNK, TYPE_CONTROL, decodeHeader, open, openControl, sealControl,
} from './frame.js'
import { EMPTY_CHAIN, chainHash, hex, equalHex } from './digest.js'
import { createSink as defaultCreateSink } from './sink.js'

// Replies to our sender, versus offers addressed to us.
const SENDER_REPLIES = ['accept', 'decline', 'done', 'error']

export function createReceiver({
  channel, sendKey, recvKey, control, nextControlIndex,
  onOffer, onProgress, onFileDone, onError,
  // Injectable so the transfer can be exercised without a browser.
  createSink = defaultCreateSink,
}) {
  let controlIn = 0
  let active = null

  const sendControl = async obj => channel.send(await sealControl(sendKey, nextControlIndex(), obj))

  /**
   * Tell the peer before giving up locally.
   *
   * Without this the sender waits for a reply that will never arrive: it has
   * finished transmitting and is blocked on 'done' while the receiver has
   * already torn its side down. A silent receiver is indistinguishable from a
   * slow one, so the failure has to be stated rather than implied.
   */
  async function abortActive(reason) {
    const seq = active?.manifest?.seq
    if (active?.sink) await active.sink.abort()
    active = null
    try {
      await sendControl({
        t: 'error',
        seq: seq ?? 0,
        message: String(reason?.message ?? reason).slice(0, 200),
      })
    } catch {
      // The channel itself may already be gone; the local error still reports.
    }
    onError?.(reason)
  }

  async function handleManifest(manifest) {
    if (active) throw new Error('Peer offered a file while one was already in flight')

    const decline = async () => {
      active = null
      await sendControl({ t: 'decline', seq: manifest.seq })
    }

    // accept() must run inside a user gesture: opening the destination uses
    // showSaveFilePicker, which browsers refuse outside one.
    const accept = async () => {
      let sink
      try {
        sink = await createSink(manifest)
      } catch {
        // Includes the user dismissing the save dialog.
        await decline()
        return null
      }
      active = {
        manifest,
        sink,
        expected: 0,
        digest: EMPTY_CHAIN(),
        received: 0,
      }
      await sendControl({ t: 'accept', seq: manifest.seq })
      return sink
    }

    onOffer({ manifest, accept, decline })
  }

  async function handleChunk(frame) {
    if (!active) throw new Error('Chunk arrived with no accepted file')

    const { plaintext, last } = await open(recvKey, frame, {
      type: TYPE_CHUNK,
      fileSeq: active.manifest.seq,
      index: active.expected,
    })

    await active.sink.write(plaintext)
    active.digest = await chainHash(active.digest, plaintext)
    active.expected += 1
    active.received += plaintext.length

    if (active.received > active.manifest.size) {
      throw new Error('Peer sent more data than the manifest declared')
    }
    if (last && active.expected !== active.manifest.chunks) {
      throw new Error('End-of-file flag arrived at the wrong chunk')
    }

    onProgress?.({
      received: active.received,
      total: active.manifest.size,
      chunk: active.expected,
      chunks: active.manifest.chunks,
    })
  }

  async function handleComplete(msg) {
    if (!active || msg.seq !== active.manifest.seq) throw new Error('Unexpected completion')

    // Three independent ways a short or altered file gets caught.
    if (active.expected !== msg.chunks) throw new Error('Chunk count mismatch')
    if (active.received !== active.manifest.size) throw new Error('Size mismatch')
    if (!equalHex(hex(active.digest), msg.digest)) throw new Error('Digest mismatch')

    await active.sink.close()
    const finished = { name: active.sink.name, size: active.received, digest: msg.digest }
    active = null
    await sendControl({ t: 'done', seq: msg.seq })
    onFileDone?.(finished)
  }

  async function processFrame(bytes) {
    try {
      if (bytes.length < HEADER_BYTES) throw new Error('Runt frame')

      if (decodeHeader(bytes).type === TYPE_CONTROL) {
        const msg = await openControl(recvKey, bytes, controlIn)
        controlIn += 1

        if (SENDER_REPLIES.includes(msg.t)) return void control.push(msg)
        if (msg.t === 'manifest') return void await handleManifest(msg)
        if (msg.t === 'complete') return void await handleComplete(msg)
        throw new Error(`Unknown control message: ${msg.t}`)
      }

      await handleChunk(bytes)
    } catch (error) {
      control.fail(error)
      await abortActive(error)
    }
  }

  /**
   * Feed every inbound DataChannel message here.
   *
   * Frames are processed strictly one at a time, and that serialisation is the
   * whole reason this wrapper exists.
   *
   * A real RTCDataChannel fires 'message' again without waiting for the
   * previous handler to settle, and processFrame awaits both AES-GCM
   * decryption and a disk write. Unserialised, a burst of frames runs
   * concurrently, every one of them reads the same `active.expected` before any
   * has incremented it, and the receiver rejects its own peer with something
   * like "expected 12, got 15" partway through a working transfer.
   *
   * This bit is easy to miss in testing, because a hand-written fake channel
   * naturally awaits each delivery and so hides the race. Two tabs of the same
   * browser deliver in a tight enough burst to expose it immediately.
   *
   * Serialised here rather than at the call site so that no caller can get it
   * wrong by attaching the listener in the obvious way.
   */
  let queue = Promise.resolve()

  function handleFrame(bytes) {
    const next = queue.then(() => processFrame(bytes))
    // One frame failing must not break the chain for those behind it.
    queue = next.catch(() => {})
    return next
  }

  return { handleFrame, get busy() { return active !== null } }
}
