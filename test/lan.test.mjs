/**
 * The local-network fast path (src/transport/lan.js).
 *
 * The negotiation tests pair two real rooms over the in-memory Trystero fake
 * from room.test.mjs and give each side a LanPlatform whose sockets are an
 * in-memory pair built on lan.js's own createLanSocket. What that leaves real
 * is everything this change is about: the hellos, the listener choice, the
 * token handshake, the flip at Accept, and a whole sealed transfer through
 * core/ with the chunks arriving over the socket. Counting what crossed each
 * socket is how the tests tell "fast path" from "stayed on WebRTC", since
 * both deliver the same file.
 *
 * node/lan-server.js is exercised against Node's own WebSocket client over
 * loopback. parseOffer refuses loopback addresses, which is right for an
 * offer and is why the server tests dial it directly rather than through
 * the negotiation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { openRoom } from '../src/transport/room.js'
import {
  chooseListener, parseOffer, createLanLink, createLanSocket,
  serverHandshake, clientHandshake, dialWebSocket, LINK_WAIT_MS,
} from '../src/transport/lan.js'
import { createSwitchableChannel } from '../src/transport/channel.js'
import { listenLan } from '../src/node/lan-server.js'
import { createControlStream, sendControl } from '../src/core/control.js'
import { createReceiver } from '../src/core/receiver.js'
import { sendFile } from '../src/core/sender.js'
import { fromBytes } from '../src/core/source.js'
import { CHUNK_SIZE } from '../src/core/frame.js'
import { generateSecret, deriveTopic, derivePassword } from '../src/core/secret.js'
import { fakeNetwork } from './helpers/fake-network.mjs'

test('the listener is a quiet side, the receiver when both are, and nobody when neither is', () => {
  assert.equal(chooseListener('quiet', 'quiet'), 'receiver')
  assert.equal(chooseListener('prompt', 'quiet'), 'receiver')
  assert.equal(chooseListener('none', 'quiet'), 'receiver')
  assert.equal(chooseListener('quiet', 'prompt'), 'sender')
  assert.equal(chooseListener('quiet', 'none'), 'sender')
  // Two Windows machines: listening would put a firewall dialog in front of
  // one of them, so the session stays on WebRTC.
  assert.equal(chooseListener('prompt', 'prompt'), null)
  assert.equal(chooseListener('prompt', 'none'), null)
  assert.equal(chooseListener('none', 'none'), null)
})

test('parseOffer keeps private IPv4 addresses and refuses everything it would be unwise to dial', () => {
  const token = 'ab'.repeat(16)
  assert.deepEqual(
    parseOffer({ addrs: ['192.168.1.7', '10.0.0.2', '172.20.1.1'], port: 4000, token })?.addrs,
    ['192.168.1.7', '10.0.0.2', '172.20.1.1'])
  // A public address, loopback, a name, IPv6: none of them.
  assert.deepEqual(
    parseOffer({ addrs: ['8.8.8.8', '127.0.0.1', 'evil.example', 'fe80::1', '192.168.1.7'], port: 4000, token })?.addrs,
    ['192.168.1.7'])
  assert.equal(parseOffer({ addrs: ['8.8.8.8'], port: 4000, token }), null)
  assert.equal(parseOffer({ addrs: [], port: 4000, token }), null)
  assert.equal(parseOffer({ addrs: ['192.168.1.7'], port: 0, token }), null)
  assert.equal(parseOffer({ addrs: ['192.168.1.7'], port: 70000, token }), null)
  assert.equal(parseOffer({ addrs: ['192.168.1.7'], port: 4000, token: 'short' }), null)
  assert.equal(parseOffer({ addrs: '192.168.1.7', port: 4000, token }), null)
})

test('the switchable channel sends through whichever target is current', async () => {
  /** @type {string[]} */
  const log = []
  /** @param {string} name @returns {Channel} */
  const target = name => ({
    send: () => { log.push(name) },
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener() {},
    removeEventListener() {},
  })
  const channel = createSwitchableChannel(target('webrtc'))
  channel.bufferedAmountLowThreshold = 1234
  await channel.send(new Uint8Array(1))
  const lan = target('lan')
  channel.switchTo(lan)
  await channel.send(new Uint8Array(1))
  assert.deepEqual(log, ['webrtc', 'lan'])
  assert.equal(lan.bufferedAmountLowThreshold, 1234, 'the threshold sender.js wrote carries across')
})

// ---------------------------------------------------------------------------
// An in-memory network of LAN sockets
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   platform: (listen: LanListenMode) => LanPlatform & { opened: number },
 *   frames: { toListener: number, toDialler: number },
 *   sockets: LanSocket[],
 * }}
 */
function memoryLan() {
  /** @type {Map<string, (socket: LanSocket) => void>} */
  const listeners = new Map()
  const frames = { toListener: 0, toDialler: 0 }
  /** @type {LanSocket[]} */
  const sockets = []
  let nextPort = 40000

  /** One connection: two LanSockets whose sends arrive at the other, in order. */
  const connect = () => {
    let open = true
    /** @type {ReturnType<typeof createLanSocket>} */ let dialler
    /** @type {ReturnType<typeof createLanSocket>} */ let listener
    /** @param {() => ReturnType<typeof createLanSocket>} peer @param {'toListener' | 'toDialler'} dir */
    const end = (peer, dir) => createLanSocket({
      send: bytes => {
        if (!open) return
        // Frames only: the one-byte ACK and the token are the handshake.
        if (bytes.length > 16) frames[dir] += 1
        const copy = bytes.slice()
        setImmediate(() => { if (open) peer().deliver(copy) })
      },
      bufferedAmount: () => 0,
      isOpen: () => open,
      drained: async () => {},
      close: () => {
        if (!open) return
        open = false
        setImmediate(() => { dialler.closed(); listener.closed() })
      },
    })
    dialler = end(() => listener, 'toListener')
    listener = end(() => dialler, 'toDialler')
    sockets.push(dialler.socket, listener.socket)
    return { dialler: dialler.socket, listener: listener.socket }
  }

  return {
    frames,
    sockets,
    platform(listen) {
      const p = {
        listen,
        opened: 0,
        /** @param {Bytes} token */
        async open(token) {
          p.opened += 1
          const port = nextPort++
          /** @type {(s: LanSocket) => void} */ let resolve = () => {}
          /** @type {Promise<LanSocket>} */
          const accepted = new Promise(r => { resolve = r })
          listeners.set(`10.0.0.1:${port}`, sock => {
            serverHandshake(sock, token, 2000).then(resolve, () => {})
          })
          return { port, addrs: ['10.0.0.1'], accepted, close: () => { listeners.delete(`10.0.0.1:${port}`) } }
        },
        /** @param {string} url */
        async dial(url) {
          const accept = listeners.get(new URL(url).host)
          if (!accept) throw new Error('nothing listening at ' + url)
          const { dialler, listener } = connect()
          accept(listener)
          return dialler
        },
      }
      return p
    },
  }
}

// ---------------------------------------------------------------------------
// Two paired sides, wired the way cli.js wires them
// ---------------------------------------------------------------------------

async function pairRooms() {
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()
  const open = (/** @type {'host' | 'guest'} */ role) =>
    openRoom({ topic, password, secret, role, strategies: [strategy], iceServers: [], timeoutMs: 5000 })
  const [host, guest] = await Promise.all([open('host'), open('guest')])
  return { host, guest }
}

/**
 * @param {object} args
 * @param {PairedRoom} args.room
 * @param {'sender' | 'receiver'} args.role
 * @param {LanPlatform | null} args.platform null is a build without the fast path.
 * @param {Parameters<typeof createReceiver>[0]['onOffer']} [args.onOffer]
 * @param {(file: { name: string, size: number, digest: string }) => void} [args.onFileDone]
 * @param {Bytes[]} [args.written]
 * @param {() => void} [args.onLost]
 * @param {() => void} [args.onCarrying]
 */
function side({ room, role, platform, onOffer, onFileDone, written = [], onLost, onCarrying }) {
  const control = createControlStream()
  let n = 0
  const nextControlIndex = () => n++
  /** @type {ReturnType<typeof createLanLink> | null} */
  let lan = null
  const receiver = createReceiver({
    channel: room.channel,
    sendKey: room.session.sendKey,
    recvKey: room.session.recvKey,
    control,
    nextControlIndex,
    onOffer: onOffer ?? (() => { throw new Error('unexpected offer') }),
    onFileDone,
    onPeerLan: platform ? msg => lan?.handle(msg) : undefined,
    createSink: async () => ({
      streaming: true,
      name: 'out.bin',
      write: async chunk => { written.push(chunk.slice()) },
      close: async () => {},
      abort: async () => {},
    }),
  })
  if (platform) {
    lan = createLanLink({
      role, platform, room, onLost, onCarrying,
      send: msg => sendControl({ channel: room.channel, key: room.session.sendKey, nextControlIndex }, msg),
    })
  }
  room.onFrame(frame => { receiver.handleFrame(frame).catch(() => {}) })
  return { control, nextControlIndex, receiver, lan }
}

/**
 * One whole transfer: the sender's hello after its (implied) SAS confirm,
 * the receiver accepting at once, the flip at accept.
 *
 * @param {{ sender: LanPlatform | null, receiver: LanPlatform | null, size?: number }} platforms
 */
async function transfer({ sender, receiver, size = CHUNK_SIZE * 5 + 123 }) {
  const { host, guest } = await pairRooms()
  const bytes = new Uint8Array(size)
  // getRandomValues takes at most 64 KiB a call.
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536))
  /** @type {Bytes[]} */
  const written = []
  let carrying = 0
  /** @type {Promise<{ name: string, size: number, digest: string }>} */
  const received = new Promise(resolve => {
    side({
      room: guest, role: 'receiver', platform: receiver, written, onCarrying: () => { carrying += 1 },
      onOffer: ({ accept }) => { void accept() },
      onFileDone: resolve,
    })
  })
  const s = side({ room: host, role: 'sender', platform: sender })
  s.lan?.start()
  let flipped = false
  let waited = 0
  try {
    const result = await sendFile({
      channel: host.channel,
      key: host.session.sendKey,
      file: fromBytes({ bytes, name: 'f.bin' }),
      fileSeq: 0,
      control: s.control,
      nextControlIndex: s.nextControlIndex,
      onAccept: async () => {
        const t0 = performance.now()
        flipped = s.lan ? await s.lan.ready() : false
        waited = performance.now() - t0
      },
    })
    const done = await received
    const got = new Uint8Array(written.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of written) { got.set(c, at); at += c.length }
    assert.deepEqual(got, bytes, 'the file arrived whole')
    assert.equal(done.digest, result.declined ? '' : result.digest)
    return { flipped, waited, carrying, chunks: Math.ceil(size / CHUNK_SIZE) }
  } finally {
    await Promise.all([host.close(), guest.close()])
  }
}

test('two quiet peers move the chunks and the completion onto the LAN, and nothing else', async () => {
  const net = memoryLan()
  const receiverPlatform = net.platform('quiet')
  const r = await transfer({ sender: net.platform('quiet'), receiver: receiverPlatform })
  assert.equal(r.flipped, true)
  assert.equal(r.carrying, 1, "the receiver hears once that the sender switched: the app's badge")
  assert.equal(receiverPlatform.opened, 1, 'both quiet, so the receiver listens')
  // The listener is the receiver, so the sender is the dialler: every chunk
  // plus 'complete' went dialler -> listener, and the receiver's replies
  // (accept, done) never touched the socket.
  assert.equal(net.frames.toListener, r.chunks + 1)
  assert.equal(net.frames.toDialler, 0)
})

test('a sender that listens gets its peer dialling in, and still sends over the socket', async () => {
  const net = memoryLan()
  const senderPlatform = net.platform('quiet')
  const r = await transfer({ sender: senderPlatform, receiver: net.platform('prompt') })
  assert.equal(r.flipped, true)
  assert.equal(senderPlatform.opened, 1)
  assert.equal(net.frames.toDialler, r.chunks + 1, 'listener (sender) -> dialler (receiver)')
  assert.equal(net.frames.toListener, 0)
})

test('two peers that would both prompt stay on WebRTC without waiting', async () => {
  const net = memoryLan()
  const a = net.platform('prompt')
  const b = net.platform('prompt')
  const r = await transfer({ sender: a, receiver: b })
  assert.equal(r.flipped, false)
  assert.equal(a.opened + b.opened, 0, 'nobody listened')
  assert.equal(net.sockets.length, 0)
  assert.ok(r.waited < LINK_WAIT_MS / 4, `waited ${r.waited} ms`)
})

test('a peer without the fast path is recognised at Accept, not after a timeout', async () => {
  // The receiver predates lan-hello: its demux drops the message, sends no
  // reply, and the sender must read that from the missing hello rather than
  // sitting out LINK_WAIT_MS on every transfer to an older build.
  const net = memoryLan()
  const r = await transfer({ sender: net.platform('quiet'), receiver: null })
  assert.equal(r.flipped, false)
  assert.ok(r.waited < LINK_WAIT_MS / 4, `waited ${r.waited} ms`)
})

test('a receiver with the fast path and a sender without it never announce anything', async () => {
  const net = memoryLan()
  const receiverPlatform = net.platform('quiet')
  const r = await transfer({ sender: null, receiver: receiverPlatform })
  assert.equal(r.flipped, false)
  assert.equal(receiverPlatform.opened, 0, 'the receiver speaks only in reply to a hello')
})

test('an unreachable listener leaves the transfer on WebRTC', async () => {
  const net = memoryLan()
  /** @type {LanPlatform} */
  const cannotDial = {
    listen: 'prompt',
    dial: async () => { throw new Error('no route') },
  }
  const r = await transfer({ sender: cannotDial, receiver: net.platform('quiet') })
  assert.equal(r.flipped, false)
  assert.equal(r.carrying, 0, 'a receiver still on WebRTC never shows the fast-path badge')
  assert.equal(net.frames.toListener + net.frames.toDialler, 0)
})

test('a receiver hears about a link lost mid-file, and not about one closed at the end', async () => {
  const net = memoryLan()
  const { host, guest } = await pairRooms()
  let lost = 0
  side({ room: guest, role: 'receiver', platform: net.platform('quiet'), onLost: () => { lost += 1 },
    onOffer: ({ accept }) => { void accept() } })
  const s = side({ room: host, role: 'sender', platform: net.platform('quiet') })
  s.lan?.start()
  // A file big enough to still be moving when the socket is cut.
  const bytes = new Uint8Array(CHUNK_SIZE * 200)
  const sending = sendFile({
    channel: host.channel, key: host.session.sendKey,
    file: fromBytes({ bytes, name: 'big.bin' }), fileSeq: 0,
    control: s.control, nextControlIndex: s.nextControlIndex,
    onAccept: async () => { assert.equal(await s.lan?.ready(), true) },
  })
  while (net.frames.toListener < 10) await new Promise(r => setImmediate(r))
  net.sockets[0].close()
  await assert.rejects(sending, /on the local network closed/)
  await new Promise(r => setImmediate(r))
  assert.equal(lost, 1)
  await Promise.all([host.close(), guest.close()])
  await new Promise(r => setImmediate(r))
  assert.equal(lost, 1, 'closing the room is not a loss')
})

// ---------------------------------------------------------------------------
// node/lan-server.js, against Node's WebSocket client
// ---------------------------------------------------------------------------

const WS = /** @type {import('../src/transport/lan.js').WebSocketCtor} */ (/** @type {unknown} */ (globalThis.WebSocket))

test('the Node listener takes the one connection with the token, and refuses a stranger first', async () => {
  const token = crypto.getRandomValues(new Uint8Array(16))
  const listener = await listenLan({ token, host: '127.0.0.1', addresses: () => ['127.0.0.1'] })
  const url = `ws://127.0.0.1:${listener.port}/`
  try {
    const stranger = await dialWebSocket(WS, url, 2000)
    await assert.rejects(clientHandshake(stranger, new Uint8Array(16), 2000))

    const client = await clientHandshake(await dialWebSocket(WS, url, 2000), token, 2000)
    const server = await listener.accepted

    // Sizes either side of each length encoding, up to the largest sealed
    // frame and past it, both ways, in order.
    const sizes = [14, 125, 126, 1000, 16414, 65535, 65536]
    /** @type {Bytes[]} */ const atServer = []
    /** @type {Bytes[]} */ const atClient = []
    server.onmessage = b => { atServer.push(b) }
    client.onmessage = b => { atClient.push(b) }
    for (const n of sizes) {
      client.send(new Uint8Array(n).fill(n & 0xff))
      server.send(new Uint8Array(n).fill((n + 1) & 0xff))
    }
    const until = async (/** @type {() => boolean} */ f) => {
      for (let i = 0; i < 400 && !f(); i++) await new Promise(r => setTimeout(r, 5))
    }
    await until(() => atServer.length === sizes.length && atClient.length === sizes.length)
    assert.deepEqual(atServer.map(b => b.length), sizes)
    assert.deepEqual(atClient.map(b => b.length), sizes)
    assert.ok(atServer.every((b, i) => b.every(x => x === (sizes[i] & 0xff))))
    assert.ok(atClient.every((b, i) => b.every(x => x === ((sizes[i] + 1) & 0xff))))

    // It stopped listening once it had its peer.
    await assert.rejects(dialWebSocket(WS, url, 1000))

    let closed = false
    server.onclose = () => { closed = true }
    client.close()
    await until(() => closed)
    assert.equal(closed, true)
  } finally {
    listener.close()
  }
})

test('the Node listener closes a message larger than any frame instead of buffering it', async () => {
  const token = crypto.getRandomValues(new Uint8Array(16))
  const listener = await listenLan({ token, host: '127.0.0.1', addresses: () => ['127.0.0.1'] })
  try {
    const client = await clientHandshake(
      await dialWebSocket(WS, `ws://127.0.0.1:${listener.port}/`, 2000), token, 2000)
    await listener.accepted
    let closed = false
    client.onclose = () => { closed = true }
    client.send(new Uint8Array(64 * 1024 + 1))
    for (let i = 0; i < 200 && !closed; i++) await new Promise(r => setTimeout(r, 5))
    assert.equal(closed, true)
  } finally {
    listener.close()
  }
})

test('closing a listener nobody reached settles its accepted promise', async () => {
  const listener = await listenLan({ token: new Uint8Array(16), host: '127.0.0.1', addresses: () => [] })
  listener.close()
  await assert.rejects(listener.accepted, /Stopped listening/)
})
