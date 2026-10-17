#!/usr/bin/env node
/**
 * Records real Trystero 0.25.4 traffic between two real qrdrop peers
 * (docs/notes/rust-session.md, phase 0).
 *
 *   node scripts/record-trystero.mjs          # -> test/vectors/trystero-recording.json
 *   node scripts/record-trystero.mjs --live   # -> test/vectors/trystero-recording-live.json
 *
 * RECORD_DEBUG=1 prints each relay message as it passes, which is the quickest
 * way to see where a pairing that times out stopped.
 *
 * make-vectors.mjs pins each piece of Trystero's wire with fixed inputs. This
 * is the other half: what the pieces look like in sequence, from the real
 * library, when two peers actually pair -- the subscription and announce
 * pattern, offers and answers and their ciphertexts, trickled candidates or
 * their absence, the room frames on the data channel, the @_hsdata /
 * @_hsready handshake, qrdrop's `ecdh` and `frame` actions on top, a whole
 * small transfer, and the @_leave on the way out. The Rust `tryst` crate is
 * tested against the sequence; test/vectors.test.mjs checks the sequence
 * against Trystero's own code, so it cannot record something Trystero would
 * not have accepted.
 *
 * WHY TWO PROCESSES: Trystero's selfId and its Nostr key are per process, and
 * joining one room twice in one process hands back the same room. Each peer is
 * a child; the parent is the relay. WebSocket is replaced in each child before
 * Trystero loads, by a class that carries every frame to the parent over IPC
 * and back, so the parent sees exactly the bytes a relay would. With --live it
 * wraps the real WebSocket instead, and the parent only listens.
 *
 * WHY THE PARENT'S RELAY IS A FAKE, AND WHY THAT IS FINE: the client half of
 * every message is Trystero's, byte for byte, in both modes. The relay's half
 * is not, by default: it is the minimum a Nostr relay (REQ, EVENT, OK, EOSE,
 * CLOSE) and a WebTorrent tracker (announce, offer and answer relaying) do, so
 * the recording is offline, quick and the same shape every run. --live records
 * what real relays answer, which is what phase 4's clients need to see; it
 * depends on the public relays being up, and they are weather.
 *
 * WHY LOOPBACK: the signal ciphertexts are recorded beside the password that
 * opens them, so every SDP in this file is readable by anyone with the repo.
 * The peer connections are therefore bound to 127.0.0.1 with no STUN server:
 * the only candidates either side can gather are loopback ones, and nothing in
 * the recording names this machine's addresses. The test asserts it.
 *
 * Each strategy is recorded alone (one run with Nostr, one with torrent), since
 * qrdrop races both and the loser's half of a race is not a complete exchange.
 * Data-channel messages over 256 bytes are kept as their first 160 bytes, their
 * length and their SHA-256: enough for the room frame, the action header and
 * qrdrop's frame header, without 16 KB of ciphertext nobody can open. Nothing
 * here can open it: qrdrop's ECDH keys are generated inside room.js and are
 * non-extractable, by design, so the frame layer's vectors are in frames.json.
 */

import { fork } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const FAKE_NOSTR = 'wss://relay.vectors.invalid'
const FAKE_TRACKER = 'wss://tracker.vectors.invalid'
const FILE_SIZE = 2 * 16318 + 5
const KEEP_WHOLE = 256
const KEEP_HEAD = 160

const live = process.argv.includes('--live')
// Two files rather than one, so a live run that the relays happen to answer
// strangely never replaces the recording the test suite reads.
const OUT_NAME = live ? 'trystero-recording-live.json' : 'trystero-recording.json'
const OUT = new URL(`../test/vectors/${OUT_NAME}`, import.meta.url)
const childRole = process.argv[process.argv.indexOf('--child') + 1]

if (process.argv.includes('--child')) await child(/** @type {'host' | 'guest'} */ (childRole))
else await parent()

// --- the parent: relay, tracker and recorder ----------------------------------

async function parent() {
  const { deriveTopic, derivePassword, encodeSecret } = await import('../src/core/secret.js')
  const { TRYSTERO_VERSION } = await import('../test/helpers/trystero.mjs')

  // A fixed secret, so the topic and the password are the same every run and
  // the recording can be read against trystero.json's derivations.
  const secret = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('qrdrop vectors: recording secret')))
  const topic = await deriveTopic(secret)
  const password = await derivePassword(secret)

  const runs = []
  for (const strategy of ['nostr', 'torrent']) {
    console.log(`recording ${strategy}${live ? ' (live relays)' : ''}…`)
    runs.push(await record(strategy, { secret, topic, password }))
  }

  const recording = {
    about: `Real traffic between two qrdrop peers over Trystero ${TRYSTERO_VERSION}, one run per strategy, written by scripts/record-trystero.mjs${live ? ' --live (the public relays answered)' : ' (the relay and tracker answers are a minimal stand-in run by the script; every client message is Trystero\'s)'}. relay[] is every WebSocket message in order, from each peer's side; channel[] is every data-channel message. t_ms is milliseconds since the run started. Messages over ${KEEP_WHOLE} bytes are kept as head (the first ${KEEP_HEAD} bytes), length and sha256. Peer connections were bound to 127.0.0.1 with no ICE servers, so every candidate is a loopback one.`,
    trystero_version: TRYSTERO_VERSION,
    relays: live ? 'live' : 'stand-in',
    app_id: 'qrdrop',
    secret: hex(secret),
    code: encodeSecret(secret),
    topic,
    password,
    file: { mod251: FILE_SIZE },
    runs,
  }
  await writeFile(OUT, `${JSON.stringify(recording, null, 2)}\n`)
  console.log(`wrote test/vectors/${OUT_NAME}`)
}

/**
 * One pairing and one transfer over one strategy.
 * @param {string} strategy
 * @param {{ secret: Bytes, topic: string, password: string }} args
 */
async function record(strategy, { secret, topic, password }) {
  const started = Date.now()
  /** @type {any[]} */
  const relay = []
  /** @type {any[]} */
  const channel = []
  /** @type {Record<string, any>} */
  const peers = {}

  // The stand-in relay's state: Nostr subscriptions and tracker swarms, keyed
  // by the connection they arrived on.
  /** @type {Map<string, { send: (data: string) => void, subs: Map<string, any>, role: string }>} */
  const conns = new Map()
  /** @type {Map<string, Map<string, string>>} info_hash -> peer_id -> connection id */
  const swarms = new Map()

  /**
   * @param {string} connId
   * @param {string} data
   */
  const onClientMessage = (connId, data) => {
    const conn = conns.get(connId)
    if (!conn || live) return
    const msg = JSON.parse(data)
    if (Array.isArray(msg)) return nostrRelay(conn, msg)
    return tracker(connId, conn, msg)
  }

  /**
   * @param {{ send: (data: string) => void, subs: Map<string, any> }} conn
   * @param {any[]} msg
   */
  const nostrRelay = (conn, [type, ...rest]) => {
    if (type === 'REQ') {
      const [subId, filter] = rest
      conn.subs.set(subId, filter)
      conn.send(JSON.stringify(['EOSE', subId]))
    } else if (type === 'CLOSE') {
      conn.subs.delete(rest[0])
    } else if (type === 'EVENT') {
      const [event] = rest
      conn.send(JSON.stringify(['OK', event.id, true, '']))
      const topicTag = event.tags.find((/** @type {string[]} */ t) => t[0] === 'x')?.[1]
      for (const other of conns.values()) {
        for (const [subId, filter] of other.subs) {
          if (filter.kinds.includes(event.kind) && filter['#x'].includes(topicTag)) {
            other.send(JSON.stringify(['EVENT', subId, event]))
          }
        }
      }
    }
  }

  /**
   * @param {string} connId
   * @param {{ send: (data: string) => void }} conn
   * @param {any} msg
   */
  const tracker = (connId, conn, msg) => {
    if (msg.action !== 'announce') return
    const swarm = swarms.get(msg.info_hash) ?? new Map()
    swarms.set(msg.info_hash, swarm)
    swarm.set(msg.peer_id, connId)

    if (msg.answer) {
      const to = conns.get(swarm.get(msg.to_peer_id) ?? '')
      to?.send(JSON.stringify({ action: 'announce', info_hash: msg.info_hash, peer_id: msg.peer_id, offer_id: msg.offer_id, answer: msg.answer }))
      return
    }
    conn.send(JSON.stringify({ action: 'announce', interval: 120, info_hash: msg.info_hash, complete: 0, incomplete: swarm.size }))
    const others = [...swarm].filter(([id]) => id !== msg.peer_id).slice(0, msg.numwant ?? 0)
    for (const [i, offer] of (msg.offers ?? []).entries()) {
      const target = others[i]
      if (!target) break
      conns.get(target[1])?.send(JSON.stringify({ action: 'announce', info_hash: msg.info_hash, peer_id: msg.peer_id, offer_id: offer.offer_id, offer: offer.offer }))
    }
  }

  const script = fileURLToPath(import.meta.url)
  const config = { strategy, topic, password, secret: hex(secret), live, fileSize: FILE_SIZE }
  const children = /** @type {const} */ (['host', 'guest']).map(role => {
    const proc = fork(script, ['--child', role], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    proc.on('message', (/** @type {any} */ m) => {
      const t_ms = Date.now() - started
      // Socket ids are per child, so both children have a c0.
      const connId = `${role}:${m.conn}`
      if (m.type === 'ws-open') {
        conns.set(connId, { role, subs: new Map(), send: data => {
          const t_ms = Date.now() - started
          relay.push({ t_ms, peer: role, dir: 'in', url: m.url, data })
          if (process.env.RECORD_DEBUG) console.error(t_ms, role, 'in', data.slice(0, 300))
          proc.send({ type: 'ws-message', conn: m.conn, data })
        } })
        if (!live) proc.send({ type: 'ws-open', conn: m.conn })
      } else if (m.type === 'ws-out') {
        relay.push({ t_ms, peer: role, dir: 'out', url: m.url, data: m.data })
        if (process.env.RECORD_DEBUG) console.error(t_ms, role, 'out', m.data.slice(0, 300))
        onClientMessage(connId, m.data)
      } else if (m.type === 'ws-in') {
        // --live only: what the real relay sent this peer.
        relay.push({ t_ms, peer: role, dir: 'in', url: m.url, data: m.data })
      } else if (m.type === 'dc') {
        channel.push({ t_ms, peer: role, dir: m.dir, ...m.bytes })
      } else if (m.type === 'peer') {
        peers[role] = m.info
      }
    })
    proc.send({ type: 'start', config: { ...config, role } })
    return new Promise((resolve, reject) => {
      proc.on('exit', code => code === 0 ? resolve(undefined) : reject(new Error(`${role} exited ${code}`)))
    })
  })
  await Promise.all(children)
  relay.sort((a, b) => a.t_ms - b.t_ms)
  channel.sort((a, b) => a.t_ms - b.t_ms)
  return { strategy, peers, relay, channel }
}

// --- a child: one real qrdrop peer --------------------------------------------

/** @param {'host' | 'guest'} role */
async function child(role) {
  /** @type {any} */
  const config = await new Promise(resolve => process.once('message', (/** @type {any} */ m) => resolve(m.config)))
  /** @param {any} m */
  const tell = m => process.send?.(m)

  installWebSocket(config.live, tell)

  const [{ joinRoom: joinNostr, selfId }, { joinRoom: joinTorrent }] = await Promise.all([
    import('@trystero-p2p/nostr'), import('@trystero-p2p/torrent'),
  ])
  const { openRoom, RELAYS } = await import('../src/transport/room.js')
  const { createControlStream } = await import('../src/core/control.js')
  const { createReceiver, sendPathVerdict } = await import('../src/core/receiver.js')
  const { sendFile } = await import('../src/core/sender.js')
  const { fromBytes } = await import('../src/core/source.js')
  const { loadRTCPolyfill } = await import('../src/node/rtc.js')

  const Base = await loadRTCPolyfill()
  // Loopback only and no STUN, so the SDPs in the recording carry no address
  // of this machine's; and every data channel is tapped on the way past.
  class LoopbackRTC extends Base {
    /** @param {RTCConfiguration} [rtcConfig] */
    constructor(rtcConfig) {
      super(/** @type {any} */ ({ ...rtcConfig, iceServers: [], bindAddress: '127.0.0.1' }))
      this.addEventListener('datachannel', (/** @type {any} */ e) => tap(e.channel))
    }

    /**
     * @override
     * @param {string} label
     * @param {RTCDataChannelInit} [init]
     */
    createDataChannel(label, init) {
      return tap(super.createDataChannel(label, init))
    }
  }
  /** @param {any} dc */
  const tap = dc => {
    const send = dc.send.bind(dc)
    dc.send = (/** @type {any} */ data) => { tell({ type: 'dc', dir: 'out', bytes: keep(data) }); return send(data) }
    dc.addEventListener('message', (/** @type {any} */ e) => tell({ type: 'dc', dir: 'in', bytes: keep(e.data) }))
    return dc
  }

  const urls = config.live
    ? { nostr: RELAYS, torrent: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'] }
    : { nostr: [FAKE_NOSTR], torrent: [FAKE_TRACKER] }
  const strategy = config.strategy === 'nostr'
    ? { name: 'nostr', join: joinNostr, urls: urls.nostr }
    : { name: 'torrent', join: joinTorrent, urls: urls.torrent }

  const secret = Uint8Array.from(config.secret.match(/../g), (/** @type {string} */ b) => parseInt(b, 16))
  const room = await openRoom({
    topic: config.topic, password: config.password, secret, role,
    strategies: [strategy], iceServers: [], rtcPolyfill: /** @type {any} */ (LoopbackRTC), timeoutMs: 90_000,
  })
  tell({ type: 'peer', info: { self_id: selfId, paired_with: room.peerId, sas: room.session.sas } })

  // What src/cli.js's attachReceiver does, minus the terminal.
  const control = createControlStream()
  let controlOut = 0
  const nextControlIndex = () => controlOut++
  /** @type {(value?: unknown) => void} */
  let finished = () => {}
  const done = new Promise(r => { finished = r })
  const receiver = createReceiver({
    channel: room.channel,
    sendKey: room.session.sendKey,
    recvKey: room.session.recvKey,
    control,
    nextControlIndex,
    onOffer: ({ accept }) => { accept() },
    onFileDone: file => finished(file),
    onError: error => { console.error(`${role}:`, error); process.exit(1) },
    createSink: async () => ({ name: 'memory', streaming: true, async write() {}, async close() {}, async abort() {} }),
  })
  room.onFrame(frame => { receiver.handleFrame(frame).catch(err => { console.error(err); process.exit(1) }) })

  await sendPathVerdict({ channel: room.channel, key: room.session.sendKey, nextControlIndex, path: 'local' })

  if (role === 'host') {
    const bytes = Uint8Array.from({ length: config.fileSize }, (_, i) => i % 251)
    await sendFile({
      channel: room.channel, key: room.session.sendKey, file: fromBytes({ bytes, name: 'vectors.bin' }),
      fileSeq: 0, control, nextControlIndex,
    })
  } else {
    await done
    // The receiver's last word is its `done`; give it time to leave before
    // the sender, whose close is what ends the run.
    await new Promise(r => room.onPeerLeave(() => r(undefined)))
  }
  await room.close()
  // node-datachannel and the WebSockets do not release the event loop on
  // their own (see src/cli.js), so a child that is finished says so.
  setTimeout(() => process.exit(0), 300)
}

/**
 * @param {boolean} isLive
 * @param {(m: any) => void} tell
 */
function installWebSocket(isLive, tell) {
  let next = 0
  const Native = globalThis.WebSocket

  // Just enough of the WebSocket surface for Trystero's makeSocket: the four
  // handlers, readyState, send and close.
  class IpcWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    /** @param {string} url */
    constructor(url) {
      super()
      this.url = url
      this.conn = `c${next++}`
      this.readyState = 0
      /** @type {any} */ this.onopen = null
      /** @type {any} */ this.onmessage = null
      /** @type {any} */ this.onclose = null
      /** @type {any} */ this.onerror = null
      /** @type {any} */
      this.native = null

      if (isLive) {
        const ws = new Native(url)
        this.native = ws
        ws.onopen = () => this._open()
        ws.onmessage = e => { tell({ type: 'ws-in', conn: this.conn, url, data: String(e.data) }); this._message(String(e.data)) }
        ws.onclose = () => this._close()
        ws.onerror = () => this.onerror?.(new Event('error'))
      }
      IpcWebSocket.open.set(this.conn, this)
      tell({ type: 'ws-open', conn: this.conn, url })
    }

    /** @type {Map<string, IpcWebSocket>} */
    static open = new Map()

    _open() { this.readyState = 1; this.onopen?.(new Event('open')) }
    /** @param {string} data */
    _message(data) { this.onmessage?.({ data }) }
    _close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }

    /** @param {string} data */
    send(data) {
      tell({ type: 'ws-out', conn: this.conn, url: this.url, data })
      this.native?.send(data)
    }

    close() {
      this.native?.close()
      this._close()
    }
  }

  process.on('message', (/** @type {any} */ m) => {
    const ws = IpcWebSocket.open.get(m.conn)
    if (!ws || isLive) return
    if (m.type === 'ws-open') ws._open()
    else if (m.type === 'ws-message') setTimeout(() => ws._message(m.data), 0)
  })

  // @ts-ignore -- deliberately partial.
  globalThis.WebSocket = IpcWebSocket
}

/** @param {ArrayBuffer | ArrayBufferView | string} data */
function keep(data) {
  if (typeof data === 'string') return { text: data }
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length <= KEEP_WHOLE) return { hex: hex(bytes) }
  return { head: hex(bytes.subarray(0, KEEP_HEAD)), length: bytes.length, sha256: sha256Hex(bytes) }
}

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** @param {Uint8Array} bytes */
function sha256Hex(bytes) {
  // Synchronous, because tap() runs inside send() and must not reorder it.
  return process.getBuiltinModule('node:crypto').createHash('sha256').update(bytes).digest('hex')
}
