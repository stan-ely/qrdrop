import test from 'node:test'
import assert from 'node:assert/strict'

import { generateSecret } from '../src/core/secret.js'
import { createEphemeralKeypair, exportPublicKey, establishSession } from '../src/core/session.js'
import { createControlStream } from '../src/core/control.js'
import { createReceiver } from '../src/core/receiver.js'
import { sendFile } from '../src/core/sender.js'
import { fromBytes } from '../src/core/source.js'
import { CHUNK_SIZE, TYPE_CHUNK, seal } from '../src/core/frame.js'
import { safeFilename } from '../src/web/sink.js'

/**
 * A DataChannel stand-in.
 *
 * `serialize` decides whether delivery waits for the previous handler to
 * finish. A real RTCDataChannel does NOT: addEventListener fires the next
 * 'message' regardless of whether the last async handler has settled. The
 * serialized mode is the polite fiction; `serialize: false` is what browsers
 * actually do, and is the mode that caught the reentrancy bug.
 *
 * The declared type is the point: this must satisfy Channel, the same contract
 * signal/room.js implements against Trystero. If the two ever drift, the fake
 * stops typechecking here rather than passing a suite that no longer resembles
 * what ships. test/channel.test.mjs asserts the same thing at runtime.
 *
 * @typedef {Channel & {
 *   sent: number,
 *   tail: Promise<unknown>,
 *   twin: FakeChannel,
 *   onFrame: (bytes: Bytes) => Promise<void>,
 * }} FakeChannel
 *
 * @param {{ serialize?: boolean }} [options]
 * @returns {[FakeChannel, FakeChannel]}
 */
function channelPair({ serialize = true } = {}) {
  const mk = () => {
    /** @type {FakeChannel} */
    const ch = {
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      sent: 0,
      addEventListener() {},
      removeEventListener() {},
      send(bytes) {
        ch.sent += bytes.length
        if (serialize) {
          ch.tail = ch.tail.then(() => ch.twin.onFrame(bytes))
        } else {
          // Fire and forget, exactly like an event listener.
          ch.tail = Promise.all([ch.tail, ch.twin.onFrame(bytes)])
        }
      },
      tail: Promise.resolve(),
      onFrame: async () => {},
      // Assigned immediately below; the pair is circular, so neither half can
      // be constructed already holding the other.
      twin: /** @type {FakeChannel} */ (/** @type {unknown} */ (null)),
    }
    return ch
  }
  const a = mk()
  const b = mk()
  a.twin = b
  b.twin = a
  return [a, b]
}

/**
 * @typedef {Sink & {
 *   parts: Bytes[],
 *   closed: boolean,
 *   aborted: boolean,
 *   bytes: () => Buffer,
 * }} MemorySink
 *
 * @returns {MemorySink}
 */
function memorySink() {
  /** @type {Bytes[]} */
  const parts = []
  return {
    parts,
    closed: false,
    aborted: false,
    streaming: true,
    name: 'memory',
    async write(c) { parts.push(Uint8Array.from(c)) },
    async close() { this.closed = true },
    async abort() { this.aborted = true },
    bytes() { return Buffer.concat(parts.map(Buffer.from)) },
  }
}

async function pairedSessions() {
  const secret = generateSecret()
  const hk = await createEphemeralKeypair()
  const gk = await createEphemeralKeypair()
  return {
    host: await establishSession({ keypair: hk, peerPublicRaw: await exportPublicKey(gk), secret, role: 'host' }),
    guest: await establishSession({ keypair: gk, peerPublicRaw: await exportPublicKey(hk), secret, role: 'guest' }),
  }
}

/**
 * Wires a full sender to a receiver over the fake channel.
 * `decide` chooses whether the receiver accepts the incoming offer.
 *
 * @param {import('../src/core/source.js').FileSource} file
 * @param {{
 *   decide?: 'accept' | 'decline',
 *   sink?: MemorySink,
 *   onProgress?: (p: TransferProgress) => void,
 *   serialize?: boolean,
 *   inject?: () => Promise<Bytes> | Bytes,
 * }} [options] `inject`, when given, is called before every frame the guest
 *   receives and its result is fed to the guest first -- the stand-in for
 *   someone else's bytes arriving mid-transfer.
 */
async function transfer(file, {
  decide = 'accept', sink = memorySink(), onProgress, serialize = true, inject,
} = {}) {
  const { host, guest } = await pairedSessions()
  const [hostCh, guestCh] = channelPair({ serialize })

  /**
   * @type {{
   *   offers: Manifest[],
   *   done: { name: string, size: number, digest: string }[],
   *   errors: unknown[],
   * }}
   */
  const events = { offers: [], done: [], errors: [] }

  // The sending peer also runs a receiver, to pick up accept/done replies.
  const hostControl = createControlStream()
  let hostCtl = 0
  const hostRx = createReceiver({
    channel: hostCh,
    sendKey: host.sendKey,
    recvKey: host.recvKey,
    control: hostControl,
    nextControlIndex: () => hostCtl++,
    onOffer: () => {},
    onError: e => events.errors.push(e),
    createSink: async () => sink,
  })
  hostCh.onFrame = hostRx.handleFrame

  const guestControl = createControlStream()
  let guestCtl = 0
  const guestRx = createReceiver({
    channel: guestCh,
    sendKey: guest.sendKey,
    recvKey: guest.recvKey,
    control: guestControl,
    nextControlIndex: () => guestCtl++,
    createSink: async () => sink,
    onOffer: async o => {
      events.offers.push(o.manifest)
      await (decide === 'accept' ? o.accept() : o.decline())
    },
    onProgress,
    onFileDone: f => events.done.push(f),
    onError: e => events.errors.push(e),
  })
  guestCh.onFrame = inject
    ? async bytes => {
      await guestRx.handleFrame(await inject())
      await guestRx.handleFrame(bytes)
    }
    : guestRx.handleFrame

  const result = await sendFile({
    channel: hostCh,
    key: host.sendKey,
    file,
    fileSeq: 0,
    control: hostControl,
    nextControlIndex: () => hostCtl++,
    onProgress,
  })

  return { result, events, sink, hostCh, guestCh, guestRx }
}

/**
 * sendFile takes a FileSource, not a File -- that indirection is what lets the
 * transfer core run in Node at all, so the tests exercise the same path the
 * CLI does rather than a browser-shaped one.
 *
 * @param {Bytes} bytes
 * @param {string} [name]
 * @returns {import('../src/core/source.js').FileSource}
 */
const fileOf = (bytes, name = 'payload.bin') =>
  fromBytes({ bytes, name, mime: 'application/octet-stream' })

/**
 * @param {number} n
 * @returns {Bytes}
 */
const randomBytes = n => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(i + 65536, n)))
  return b
}

/**
 * A key nobody in the session holds, for sealing frames a stranger might send.
 *
 * Generated rather than derived from a second pairing, because what matters is
 * only that it is not ours: the frames it produces are well-formed qrdrop
 * frames with plausible headers that can never open under the session key,
 * which is exactly the shape of the thing that killed a transfer in the field.
 *
 * @returns {Promise<CryptoKey>}
 */
const foreignKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

test('a small file arrives byte-identical', async () => {
  const data = randomBytes(1000)
  const { result, events, sink } = await transfer(fileOf(data))

  assert.equal(result.declined, false)
  assert.deepEqual(events.errors, [])
  assert.ok(sink.closed)
  assert.deepEqual([...sink.bytes()], [...data])
  assert.equal(events.done[0].size, 1000)
  assert.equal(events.done[0].digest, result.digest, 'both ends agree on the digest')
})

test('files spanning exact and partial chunk boundaries arrive intact', async () => {
  for (const size of [CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 3 + 77]) {
    const data = randomBytes(size)
    const { events, sink } = await transfer(fileOf(data))
    assert.deepEqual(events.errors, [], `size ${size} produced errors`)
    assert.deepEqual([...sink.bytes()], [...data], `size ${size} round-trips`)
  }
})

test('frames delivered concurrently are still reassembled in order', async () => {
  // Regression: a real RTCDataChannel fires 'message' again without waiting for
  // the previous async handler to settle. Several handleFrame calls then run at
  // once, all reading the same stale expected-index before any increments it,
  // and the receiver rejects its own peer with "expected 12, got 15".
  //
  // Big enough to guarantee a burst rather than a lucky interleaving.
  const data = randomBytes(CHUNK_SIZE * 20 + 513)
  const { events, sink, result } = await transfer(fileOf(data), { serialize: false })

  assert.deepEqual(events.errors, [])
  assert.equal(result.declined, false)
  assert.deepEqual([...sink.bytes()], [...data])
  assert.ok(sink.closed)
})

test('an empty file still transfers and terminates', async () => {
  const { events, sink } = await transfer(fileOf(new Uint8Array(0)))
  assert.deepEqual(events.errors, [])
  assert.equal(sink.bytes().length, 0)
  assert.ok(sink.closed)
})

test('declining means no file bytes are ever sent', async () => {
  const data = randomBytes(CHUNK_SIZE * 2)
  const { result, events, sink, hostCh } = await transfer(fileOf(data), { decide: 'decline' })

  assert.equal(result.declined, true)
  assert.equal(events.offers.length, 1, 'the offer was still surfaced to the user')
  assert.equal(sink.parts.length, 0)
  assert.ok(hostCh.sent < 1000, `only the manifest should cross the wire, saw ${hostCh.sent} bytes`)
})

test('progress is reported monotonically and reaches the full size', async () => {
  const size = CHUNK_SIZE * 4 + 10
  /** @type {TransferProgress[]} */
  const seen = []
  await transfer(fileOf(randomBytes(size)), { onProgress: p => seen.push(p) })

  // Both peers report here, so the send and receive shapes are mixed together;
  // this picks out the sending half.
  const sent = seen.flatMap(p => ('sent' in p ? [p.sent] : []))
  assert.ok(sent.length >= 5)
  assert.deepEqual(sent, [...sent].sort((a, b) => a - b), 'progress never goes backwards')
  assert.equal(sent.at(-1), size)
})

test('the manifest survives the trip intact', async () => {
  const { events } = await transfer(fileOf(randomBytes(50), 'report q3.pdf'))
  assert.equal(events.offers[0].name, 'report q3.pdf')
  assert.equal(events.offers[0].size, 50)
  assert.equal(events.offers[0].chunks, 1)
})

test('a corrupted chunk is rejected and the partial file is abandoned', async () => {
  const { host, guest } = await pairedSessions()
  const [hostCh, guestCh] = channelPair()
  const sink = memorySink()
  /** @type {unknown[]} */
  const errors = []

  const control = createControlStream()
  let ctl = 0
  const rx = createReceiver({
    channel: guestCh,
    sendKey: guest.sendKey,
    recvKey: guest.recvKey,
    control,
    nextControlIndex: () => ctl++,
    createSink: async () => sink,
    onOffer: async o => { await o.accept() },
    onError: e => errors.push(e),
  })

  // Flip a bit inside every chunk frame, leaving control frames untouched.
  guestCh.onFrame = async bytes => {
    if (bytes[0] !== 1) return rx.handleFrame(bytes)
    const t = bytes.slice()
    t[20] ^= 0xff
    return rx.handleFrame(t)
  }

  const hostControl = createControlStream()
  let hostCtl = 0
  const hostRx = createReceiver({
    channel: hostCh,
    sendKey: host.sendKey,
    recvKey: host.recvKey,
    control: hostControl,
    nextControlIndex: () => hostCtl++,
    onOffer: () => {},
    onError: () => {},
    createSink: async () => memorySink(),
  })
  hostCh.onFrame = hostRx.handleFrame

  await assert.rejects(() => sendFile({
    channel: hostCh,
    key: host.sendKey,
    file: fileOf(randomBytes(100)),
    fileSeq: 0,
    control: hostControl,
    nextControlIndex: () => hostCtl++,
  }))

  // Caught one step later than it used to be, and deliberately. The flipped
  // byte is ciphertext, so the frame now fails its tag and is DROPPED rather
  // than treated as a fault in the transfer -- on a reliable, DTLS-protected
  // channel a bad tag means "not our peer", not "our peer's bytes rotted",
  // and the alternative is letting anyone who can reach the room end a
  // transfer they cannot read. The missing chunk still cannot be hidden: it
  // resurfaces as a count mismatch the moment the sender claims completion,
  // which is the assertion below and the reason dropping is safe.
  assert.ok(errors.length > 0, 'the receiver should report the tampering')
  assert.match(String(errors[0]), /Chunk count mismatch/)
  assert.equal(rx.dropped, 1, 'the tampered frame was dropped, and counted')
  assert.ok(sink.aborted, 'the partial file should be abandoned')
  assert.equal(sink.closed, false, 'a corrupt file must never be presented as complete')
})

test('a foreign frame injected mid-transfer does not kill it', async () => {
  // The field report this exists for: a receiver 0 chunks into a sub-1 MB
  // file -- 64 chunks at most -- was shown "Out-of-order frame: expected 0,
  // got 13877" and lost the transfer. Nothing this sender could produce has
  // an index of 13877, and the frame could never have been decrypted; it was
  // refused on its CLEARTEXT header, before the tag was ever checked, which
  // made fourteen bytes from a stranger enough to end a transfer.
  const foreign = await foreignKey()
  const inject = () => seal(foreign, { type: TYPE_CHUNK, fileSeq: 0, index: 13877 }, randomBytes(64))

  const payload = randomBytes(CHUNK_SIZE * 3)
  const { events, sink, guestRx } = await transfer(fileOf(payload, 'wanted.bin'), { inject })

  assert.deepEqual(events.errors, [], 'a stranger must not be able to fail the transfer')
  assert.deepEqual([...sink.bytes()], [...payload], 'the file arrives byte-identical')
  assert.equal(sink.closed, true)
  assert.equal(sink.aborted, false, 'nothing was thrown away')
  assert.ok(guestRx.dropped >= 4, 'every injected frame was dropped, and counted')
})

test('a foreign chunk arriving with no accepted file is dropped, not fatal', async () => {
  // The error storm. This used to throw on the cleartext type byte alone, so
  // each stray frame aborted an already-dead transfer again and sent the peer
  // one more error control frame -- which is what a "got N" climbing while
  // the user watches actually looks like from the inside.
  const { guest } = await pairedSessions()
  const [, guestCh] = channelPair()
  /** @type {unknown[]} */
  const errors = []

  const rx = createReceiver({
    channel: guestCh,
    sendKey: guest.sendKey,
    recvKey: guest.recvKey,
    control: createControlStream(),
    nextControlIndex: () => 0,
    createSink: async () => memorySink(),
    onOffer: () => {},
    onError: e => errors.push(e),
  })

  const foreign = await foreignKey()
  for (let index = 13877; index < 13887; index++) {
    await rx.handleFrame(await seal(foreign, { type: TYPE_CHUNK, fileSeq: 0, index }, randomBytes(64)))
  }

  assert.deepEqual(errors, [], 'a stranger must not be able to raise an error')
  assert.equal(guestCh.sent, 0, 'nor to make us send them anything back')
  assert.equal(rx.dropped, 10)
})

test('our own peer contradicting itself is still fatal', async () => {
  // The other half of the same change: once the tag has proved a frame came
  // from the peer holding our key, a wrong index is a real desync and must
  // still fail loudly. Dropping THIS would be how a truncated file gets
  // presented as a whole one.
  const { guest } = await pairedSessions()
  const [, guestCh] = channelPair()
  /** @type {unknown[]} */
  const errors = []

  const rx = createReceiver({
    channel: guestCh,
    sendKey: guest.sendKey,
    recvKey: guest.recvKey,
    control: createControlStream(),
    nextControlIndex: () => 0,
    createSink: async () => memorySink(),
    onOffer: () => {},
    onError: e => errors.push(e),
  })

  // guest.recvKey is what the host seals with, so this frame is genuinely ours.
  await rx.handleFrame(await seal(guest.recvKey, { type: TYPE_CHUNK, fileSeq: 0, index: 7 }, randomBytes(64)))

  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /Chunk arrived with no accepted file/)
  assert.equal(rx.dropped, 0, 'an authenticated frame is never a drop')
})

test('filenames from the peer are sanitised before reaching a save dialog', () => {
  assert.equal(safeFilename('../../.bashrc'), 'bashrc')
  assert.equal(safeFilename('a/b/c.txt'), 'c.txt', 'reduces to the basename')
  assert.equal(safeFilename(String.raw`C:\Windows\System32\evil.dll`), 'evil.dll')
  assert.equal(safeFilename('NUL'), 'received.bin', 'Windows device name')
  assert.equal(safeFilename('a:b.txt'), 'a_b.txt', 'no alternate data streams')
  assert.equal(safeFilename('..'), 'received.bin')
  assert.equal(safeFilename(''), 'received.bin')
  assert.equal(safeFilename(null), 'received.bin')
  assert.equal(safeFilename('ok name.pdf'), 'ok name.pdf')
  assert.ok(safeFilename('x'.repeat(500)).length <= 180)
})
