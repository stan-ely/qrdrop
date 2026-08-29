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

// Replies to our sender, versus offers addressed to us.
const SENDER_REPLIES = ['accept', 'decline', 'done', 'error']

/**
 * @param {object} args
 * @param {Channel} args.channel
 * @param {CryptoKey} args.sendKey Used only for the replies this side originates.
 * @param {CryptoKey} args.recvKey Used to open everything the peer sends.
 * @param {ControlStream} args.control
 * @param {() => number} args.nextControlIndex
 * @param {(offer: { manifest: Manifest, accept: () => Promise<Sink | null>, decline: () => Promise<void> }) => void} args.onOffer
 * @param {(p: ReceiveProgress) => void} [args.onProgress]
 * @param {(file: { name: string, size: number, digest: string }) => void} [args.onFileDone]
 * @param {(error: unknown) => void} [args.onError]
 * @param {(path: NetworkPath) => void} [args.onPeerPath] The peer's own view of
 *   the network route. Advisory: nothing waits for it, and a peer that never
 *   sends one is not an error.
 * @param {(manifest: Manifest) => Promise<Sink>} args.createSink Where received
 *   bytes land. Required, and deliberately not defaulted: this module is the
 *   runtime-agnostic core, and a default would have to name either the browser
 *   sink (File System Access) or the Node one (fs), dragging one runtime's
 *   globals into a file that must run in both. src/web/ and src/node/ each
 *   supply their own; the tests supply a third.
 * @returns {{ handleFrame: (bytes: Bytes) => Promise<void>, readonly busy: boolean }}
 */
export function createReceiver({
  channel, sendKey, recvKey, control, nextControlIndex,
  onOffer, onProgress, onFileDone, onError, onPeerPath, createSink,
}) {
  let controlIn = 0

  /**
   * @type {{
   *   manifest: Manifest,
   *   sink: Sink,
   *   expected: number,
   *   digest: Bytes,
   *   received: number,
   * } | null}
   */
  let active = null

  /** @type {(obj: ControlMessage) => Promise<void>} */
  const sendControl = async obj => channel.send(await sealControl(sendKey, nextControlIndex(), obj))


  /**
   * Tell the peer before giving up locally.
   *
   * Without this the sender waits for a reply that will never arrive: it has
   * finished transmitting and is blocked on 'done' while the receiver has
   * already torn its side down. A silent receiver is indistinguishable from a
   * slow one, so the failure has to be stated rather than implied.
   *
   * @param {unknown} reason
   */
  async function abortActive(reason) {
    const seq = active?.manifest?.seq
    if (active?.sink) await active.sink.abort()
    active = null
    try {
      await sendControl({
        t: 'error',
        seq: seq ?? 0,
        message: String(
          reason instanceof Error ? reason.message : reason,
        ).slice(0, 200),
      })
    } catch {
      // The channel itself may already be gone; the local error still reports.
    }
    onError?.(reason)
  }

  /** @param {Manifest} manifest */
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

  /** @param {Bytes} frame */
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

  /** @param {Extract<ControlMessage, { t: 'complete' }>} msg */
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

  /** @param {Bytes} bytes */
  async function processFrame(bytes) {
    try {
      if (bytes.length < HEADER_BYTES) throw new Error('Runt frame')

      if (decodeHeader(bytes).type === TYPE_CONTROL) {
        const msg = await openControl(recvKey, bytes, controlIn)
        controlIn += 1

        // Handled before the reply queue and entirely outside the transfer
        // state machine: 'path' is one peer telling the other what kind of
        // network route it observed, it is not part of any request/response
        // pair, and nothing ever waits for it. Pushing it into the control
        // queue would leave sendFile's control.next() holding a message it
        // did not ask for.
        if (msg.t === 'path') return void onPeerPath?.(msg.path)

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

  /** @param {Bytes} bytes */
  function handleFrame(bytes) {
    const next = queue.then(() => processFrame(bytes))
    // One frame failing must not break the chain for those behind it.
    queue = next.catch(() => {})
    return next
  }

  return { handleFrame, get busy() { return active !== null } }
}

/**
 * Tells the peer which network route this side observed.
 *
 * Sealed and index-counted like every other control message rather than sent
 * beside them in the clear. The verdict is not a secret -- a TURN operator
 * carrying the packets can already see the path -- but an unauthenticated one
 * could be forged, and a forged 'local' suppresses the warning that a transfer
 * is about to cost someone money. Cheap to authenticate, so authenticate it.
 *
 * Fire-and-forget by contract: the peer may never send one back, may be an
 * older build that has never heard of this message, or may answer after the
 * transfer is over. Nothing waits on it, and a failure here must never fail a
 * transfer -- callers swallow the rejection.
 *
 * @param {object} args
 * @param {Channel} args.channel
 * @param {CryptoKey} args.key This side's send key.
 * @param {() => number} args.nextControlIndex
 * @param {NetworkPath} args.path
 * @returns {Promise<void>}
 */
export async function sendPathVerdict({ channel, key, nextControlIndex, path }) {
  await channel.send(await sealControl(key, nextControlIndex(), { t: 'path', path }))
}
