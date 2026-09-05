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
 * open(), so a peer that replays, skips, or reorders is rejected before a byte
 * of it reaches the disk.
 *
 * Rejected how, though, is the part that matters, and there are two answers
 * rather than one. A frame whose tag fails did not come from our peer at all,
 * and the only correct response is to drop it: anything louder hands whoever
 * sent it the power to end a transfer they cannot read. A frame whose tag
 * PASSES and whose index is still wrong is our peer contradicting itself, and
 * that is fatal, because it is either a bug in this protocol or an attempt to
 * make a partial file look whole. See open() in frame.js for the ordering that
 * makes those two distinguishable.
 */

import {
  HEADER_BYTES, TYPE_CHUNK, TYPE_CONTROL, UnauthenticatedFrame,
  decodeHeader, open, openControl, sealControl,
} from './frame.js'
import { EMPTY_CHAIN, chainHash, hex, equalHex } from './digest.js'

// Replies to our sender, versus offers addressed to us.
const SENDER_REPLIES = ['accept', 'decline', 'done', 'error']

// Application-level flow control. The transport hands frames to handleFrame()
// fire-and-forget, as fast as the DataChannel delivers them -- see the wiring
// in web/element.js and cli.js, `room.onFrame(f => receiver.handleFrame(f)...)`,
// whose returned promise nothing awaits. handleFrame() only appends to a
// promise chain, so when createSink()'s write() drains slower than frames
// arrive that chain fills with unresolved closures -- each pinning one frame's
// ~16 KiB -- until the whole file is resident in RAM. SCTP flow control never
// steps in, because this side never stops reading.
//
// So we tell the peer to stop. Above PAUSE_AT bytes accepted-but-not-yet-
// written we send { t: 'pause' }; once the backlog falls back below RESUME_AT
// we send { t: 'resume' }. The gap between them is hysteresis: a single
// threshold would emit a pause/resume pair on every frame at the boundary.
//
// Degrades both ways. A sender too old to know 'pause' drops it as an
// unrecognised control type and keeps sending -- today's unbounded behaviour,
// so this is never a regression. A receiver too old to send 'pause' simply
// never does, and the sender's gate stays open. The bound exists only when
// both peers run this code.
const PAUSE_AT = 4 * 1024 * 1024
const RESUME_AT = 1 * 1024 * 1024

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
 * @returns {{
 *   handleFrame: (bytes: Bytes) => Promise<void>,
 *   readonly busy: boolean,
 *   readonly dropped: number,
 *   readonly pending: number,
 * }}
 */
export function createReceiver({
  channel, sendKey, recvKey, control, nextControlIndex,
  onOffer, onProgress, onFileDone, onError, onPeerPath, createSink,
}) {
  let controlIn = 0

  // Frames that failed their tag and were dropped. Diagnosis, not a fault
  // counter: a healthy transfer sees zero, and a non-zero count beside a
  // transfer that still COMPLETED is the evidence that something else is
  // putting packets into this room. Without it, dropping silently would mean
  // the next report of this looks exactly like nothing happening.
  let dropped = 0

  // Bytes handed to handleFrame() but not yet through sink.write(): the backlog
  // the pause/resume pair bounds. Exposed as `pending` for the same reason
  // `dropped` is -- so a memory problem under a slow sink is measurable rather
  // than inferred from a heap that keeps climbing.
  let pending = 0
  let flowPaused = false

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

  // pause/resume sends are serialised through this chain rather than fired
  // straight at sendControl(). sendControl() takes its control index
  // synchronously but then awaits sealing before it reaches channel.send(), so
  // two overlapping calls could hand the channel their frames out of index
  // order -- and a control frame that arrives out of order is fatal, not merely
  // dropped (see open() in frame.js). Every other sendControl() call site here
  // is driven from the serialised frame queue and so is already ordered; these
  // two run from handleFrame() and its settle handler, which are not.
  let flowSends = Promise.resolve()
  /** @param {'pause' | 'resume'} t */
  const signalFlow = t => {
    flowSends = flowSends.then(() => sendControl({ t }).catch(() => {
      // The channel is gone. The transfer surfaces that on its next frame; a
      // rejection here must not escape the transport's unawaited handleFrame()
      // call and become an unhandledRejection.
    }))
  }

  // Re-checked after `pending` grows (considerPause) and after it shrinks
  // (considerResume). Split rather than one function because the two are called
  // from different places and the flag makes each edge fire exactly once.
  function considerPause() {
    if (flowPaused || pending < PAUSE_AT) return
    flowPaused = true
    signalFlow('pause')
  }
  function considerResume() {
    if (!flowPaused || pending > RESUME_AT) return
    flowPaused = false
    signalFlow('resume')
  }


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
    if (!active) {
      // Opened with no expectation purely to answer one question: is this our
      // peer? A frame that fails the tag here is a stranger's, and
      // processFrame's catch drops it. One that PASSES is our peer sending
      // chunks for a file we never accepted, which is a genuine protocol
      // violation and stays fatal.
      //
      // This used to throw on the cleartext type byte alone, which made those
      // two cases indistinguishable -- and since stray frames arrive as a
      // stream rather than one at a time, each one aborted an already-dead
      // transfer again and sent the peer one more error control frame for it.
      // That is the storm behind a "got N" that climbs while the user watches.
      await open(recvKey, frame, null)
      throw new Error('Chunk arrived with no accepted file')
    }

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

        // 'pause' / 'resume' is the peer's sink asking our send loop to wait or
        // carry on. Like 'path' it answers no request and nothing awaits it as
        // a reply, so it is routed straight past the control queue -- sender.js
        // consults control.flowGate() between chunks. The pure receiving side
        // never sees this (it is the side that sends it); a misbehaving peer
        // that sent one anyway would only toggle a gate no send loop reads.
        if (msg.t === 'pause' || msg.t === 'resume') return void control.setFlow(msg.t)

        if (SENDER_REPLIES.includes(msg.t)) return void control.push(msg)
        if (msg.t === 'manifest') return void await handleManifest(msg)
        if (msg.t === 'complete') return void await handleComplete(msg)

        // Ignored, not fatal. This threw until adding the 'path' message
        // proved why it must not: a peer one version ahead sent a type this
        // build had never heard of, the throw reached processFrame's catch,
        // and a working transfer died with "Unknown control message" and
        // nothing saved. Any new control message is a breaking change while
        // this line throws, which makes the protocol effectively unextendable.
        //
        // Safe because the frame is already open: only a peer holding the
        // session key can produce one, so an unrecognised type is a newer
        // build talking, never an attacker probing. Anything a transfer
        // actually depends on is awaited by name in control.next(), so
        // dropping a message that no one is waiting for cannot hide a
        // failure -- it stalls into that wait instead, which is reported.
        return
      }

      await handleChunk(bytes)
    } catch (error) {
      // A frame that failed its tag is not from the peer we paired with --
      // the header is the AAD, so nobody without the session key can produce
      // one that opens. Dropping it is the only defensible response: aborting
      // would let anyone who can get a packet into this room end a transfer
      // in progress, which is exactly the failure this arm exists to close.
      //
      // Silently is not quite silently -- it is counted, and reported beside
      // a transfer rather than instead of one.
      //
      // Nor can a real fault hide behind it. A dropped chunk resurfaces at
      // handleComplete as a chunk-count, size or digest mismatch, all three
      // of which are fatal; a dropped control frame cannot swallow anything a
      // transfer depends on, because those are awaited by name in
      // control.next() and a missing one stalls into that wait. Same argument
      // as the unrecognised control message above.
      //
      // Deliberately NOT a threshold that gives up after N drops. That reads
      // like prudence and is a two-line denial of service: a stranger who can
      // send N frames gets the abort back that this change just took away.
      if (error instanceof UnauthenticatedFrame) {
        dropped += 1
        return
      }
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
    // Counted here, synchronously, because here is where the backlog forms:
    // every call appends one closure to `queue` and returns, whether or not
    // the frame before it has been written yet. considerPause() therefore sees
    // the true depth of the chain, not the depth as of the last frame drained.
    pending += bytes.length
    considerPause()

    const next = queue.then(() => processFrame(bytes))
    // One frame failing must not break the chain for those behind it.
    queue = next.catch(() => {})

    // Decrement once this frame is through processFrame -- for a chunk that
    // means past sink.write(). .finally keeps the returned promise settling
    // exactly as `next` does, so callers that .catch() it are unaffected.
    return next.finally(() => {
      pending -= bytes.length
      considerResume()
    })
  }

  return {
    handleFrame,
    get busy() { return active !== null },
    get dropped() { return dropped },
    get pending() { return pending },
  }
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
