/**
 * Shared type vocabulary for qrdrop.
 *
 * Deliberately a global (script-scope) declaration file: it has no top-level
 * import or export, so every name below is visible from JSDoc in src/ without
 * an import line. Nothing here executes -- it is erased at publish time into
 * the .d.ts that ships alongside the sources.
 *
 * The point of this file is the Channel type. Everything else is convenience.
 */

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/**
 * A byte array backed by a plain ArrayBuffer, never a SharedArrayBuffer.
 *
 * Use this rather than a bare `Uint8Array` anywhere the value reaches
 * WebCrypto. Bare `Uint8Array` means `Uint8Array<ArrayBufferLike>`, which
 * includes the shared case, and every `crypto.subtle` parameter is a
 * `BufferSource` that excludes it -- so an honest annotation of a value that
 * is in fact ArrayBuffer-backed still fails to typecheck.
 *
 * The narrowing is true rather than convenient: nothing here allocates a
 * SharedArrayBuffer, the page is not cross-origin isolated so the constructor
 * is not even exposed, and WebCrypto rejects shared buffers at runtime.
 */
type Bytes = Uint8Array<ArrayBuffer>

/**
 * What a Trystero action hands us on the way in.
 *
 * Widen, not narrow: this is `JsonValue | Blob | ArrayBuffer | ArrayBufferView`,
 * so it includes null, numbers, and objects. Trystero will happily deliver
 * whatever the peer serialised, and at the point this arrives the peer is
 * authenticated only in the sense that it knew the room password -- which is
 * derived from the QR secret, so a peer that got this far is holding the code,
 * but a *buggy or hostile* one can still send the wrong shape.
 *
 * transport/room.js narrows it at the boundary. Nothing downstream sees this type.
 *
 * A bare specifier now, resolved from node_modules like any other import. It
 * used to be a pinned jsDelivr URL that tsconfig `paths` mapped back onto the
 * installed package -- three places that had to be kept in step by hand. The
 * package is the single source of the version now.
 */
type TrysteroPayload = import('@trystero-p2p/nostr').DataPayload

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/**
 * THE CONTRACT EVERY TRANSPORT MUST MEET.
 *
 * core/sender.js and core/receiver.js are written against this and
 * nothing else. That is what let the entire signalling layer be replaced --
 * hand-rolled Nostr + WebRTC for Trystero -- without touching a line of
 * transfer/. Whatever comes next only has to satisfy these five members.
 *
 * Three implementations exist today and all three must keep conforming:
 *
 *   1. transport/room.js -- wraps a Trystero action. send() returns a promise
 *      that settles when the frame is actually out; Trystero manages the data
 *      channel's buffer itself, so bufferedAmount is pinned at 0 and the
 *      listener pair is inert.
 *   2. A raw RTCDataChannel -- send() returns undefined, bufferedAmount is
 *      real, and 'bufferedamountlow' is what actually fires. Not on the
 *      current path, but the type is kept honest for it because this is what
 *      a direct-WebRTC transport would hand over.
 *   3. The fake in test/transfer.test.mjs.
 *
 * BACKPRESSURE IS EXPRESSED AS A UNION, NOT A CHOICE. `send` returning
 * `void | Promise<void>` is the whole reason sender.js awaits it: awaiting
 * undefined costs nothing on a raw channel, and on Trystero that await IS the
 * backpressure. A transport may signal saturation either way -- by deferring
 * the promise, or by reporting bufferedAmount and firing 'bufferedamountlow'
 * -- but it must do one of them, or a large file will queue the whole thing
 * into memory and take the tab down.
 */
interface Channel {
  /**
   * Hands one framed, already-sealed message to the peer.
   *
   * Must preserve order, must deliver reliably, and must not fragment: the
   * receiver re-reads a 14-byte header off the front of whatever arrives.
   * Return a promise if sending is backpressured; return nothing if not.
   */
  send(bytes: Bytes): void | Promise<void>

  /**
   * Bytes queued and not yet on the wire. A transport that does its own
   * buffering reports 0 here and backpressures through `send` instead.
   */
  readonly bufferedAmount: number

  /**
   * Written by sender.js before the first chunk. A transport that ignores
   * bufferedAmount may accept and ignore this, but the property must be
   * assignable or the assignment throws in strict mode.
   */
  bufferedAmountLowThreshold: number

  /** Only ever called with 'bufferedamountlow'. May be a no-op. */
  addEventListener(type: 'bufferedamountlow', listener: () => void): void

  /** Must remove a listener added above; sender.js unsubscribes every drain. */
  removeEventListener(type: 'bufferedamountlow', listener: () => void): void
}

// ---------------------------------------------------------------------------
// Key agreement
// ---------------------------------------------------------------------------

/** Output of crypto/session.js: directional keys plus the emoji SAS. */
interface SessionKeys {
  /** AES-GCM key for frames we originate. */
  sendKey: CryptoKey
  /** AES-GCM key for frames the peer originates. Never the same as sendKey. */
  recvKey: CryptoKey
  /** Four emoji, space-separated. Both peers must see the same four, in order. */
  sas: string
  /**
   * The word name for each emoji in `sas`, same order, same four. Lets two
   * people read the SAS aloud over a phone call instead of describing emoji.
   */
  sasWords: string[]
}

/** What transport/room.js resolves with once a peer is paired. */
interface PairedRoom {
  session: SessionKeys
  peerId: string
  channel: Channel
  /** Registers the single inbound-frame handler. Replaces any previous one. */
  onFrame(callback: (bytes: Bytes) => void): void
  /** Fires only for the paired peer, not for anyone else in the room. */
  onPeerLeave(callback: () => void): void
  /**
   * Whether the connection runs through a TURN relay rather than a direct
   * path. Fails open (resolves false) when it cannot tell -- see
   * RELAYED_MAX_BYTES, which callers gate on this.
   */
  isRelayed(): Promise<boolean>
  close(): void
}

/**
 * One signalling network openRoom can pair over: a Trystero strategy's
 * `joinRoom` paired with the exact URL list it may dial. Every strategy
 * package (`@trystero-p2p/nostr`, `/torrent`, ...) exposes the identical
 * `joinRoom` type, so one shape covers all of them.
 */
interface SignalingStrategy {
  name: string
  join: typeof import('@trystero-p2p/nostr').joinRoom
  urls: readonly string[]
}

/** What joinVia resolves with; openRoom keeps the winner and drops the rest. */
interface ResolvedAttempt {
  strategy: string
  room: import('@trystero-p2p/nostr').Room
  frameAction: import('@trystero-p2p/nostr').MessageAction
  setFrameHandler: (fn: (bytes: Bytes) => void) => void
  session: SessionKeys
  peerId: string
}

// ---------------------------------------------------------------------------
// The control protocol
// ---------------------------------------------------------------------------

/** A file offer. Every field is attacker-controlled: it comes from the peer. */
interface Manifest {
  t: 'manifest'
  /** Per-session file counter, and the AEAD nonce prefix for its chunks. */
  seq: number
  /** Untrusted. Pass through web/sink.js safeFilename() before use. */
  name: string
  size: number
  mime: string
  chunks: number
}

type ControlMessage =
  | Manifest
  | { t: 'accept'; seq: number }
  | { t: 'decline'; seq: number }
  | { t: 'complete'; seq: number; chunks: number; digest: string }
  | { t: 'done'; seq: number }
  /** Truncated to 200 chars by the sender. Still untrusted; never innerHTML. */
  | { t: 'error'; seq: number; message: string }

type ControlType = ControlMessage['t']

/**
 * The awaitable inbound-control queue from core/control.js.
 *
 * Exists because frames arrive on an event handler that cannot be paused,
 * while the sender wants to read the exchange as straight-line async code.
 */
interface ControlStream {
  /** Returns true if the message was handed straight to a parked waiter. */
  push(msg: ControlMessage): boolean
  /**
   * Resolves with the next message matching one of `types` for `seq`.
   * An 'error' matches regardless of seq -- a failure means the peer's whole
   * connection state is suspect, not just one file.
   */
  next(
    types: readonly ControlType[],
    seq?: number,
    options?: { signal?: AbortSignal },
  ): Promise<ControlMessage>
  /** Rejects the parked waiter, if any. */
  fail(error: unknown): void
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

interface FrameHeader {
  /** TYPE_CONTROL (0) or TYPE_CHUNK (1). */
  type: number
  /** uint32. 0xffffffff is reserved for control frames. */
  fileSeq: number
  /** uint64 on the wire, narrowed to a JS number on the way in. */
  index: number
  /** Authenticated end-of-file marker -- this is what makes truncation fail. */
  last: boolean
}

/**
 * What the caller expects the next frame to be, supplied from locally tracked
 * state rather than read off the wire. This is the replay and reorder check.
 */
type FrameExpectation = Pick<FrameHeader, 'type' | 'fileSeq' | 'index'>

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/**
 * Where sent bytes come from. Defined in src/core/source.js, which also holds
 * the reasoning; re-exported here so JSDoc can name it without an import.
 */
type FileSource = import('../src/core/source.js').FileSource

/** Where received bytes land. See web/sink.js for the two implementations. */
interface Sink {
  /** False when the whole file must accumulate in memory before it can be saved. */
  streaming: boolean
  /** The sanitised filename actually used, not the one the peer asked for. */
  name: string
  write(chunk: Bytes): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

interface SendProgress {
  sent: number
  total: number
  chunk: number
  chunks: number
}

interface ReceiveProgress {
  received: number
  total: number
  chunk: number
  chunks: number
}

/** The UI renders either direction with one function, so it sees the union. */
type TransferProgress = SendProgress | ReceiveProgress
