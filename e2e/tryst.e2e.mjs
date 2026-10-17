/**
 * A Rust peer (crates/tryst) and a real Node Trystero 0.25.4 peer in one
 * room: both must fire onPeerJoin and each must hear the other on an action.
 * This is phase 4's gate in docs/notes/rust-session.md, and the one check
 * that the Rust signalling, WebRTC and handshake meet Trystero's own rather
 * than a Rust reading of it.
 *
 * Every pairing runs four ways: Nostr and the tracker, each with the Rust
 * peer as the lower ID (so it offers) and as the higher (so it answers). The
 * Rust peer picks its ID to make that so; Trystero's is random, and an ID of
 * twenty zeros or twenty z's sorts below or above any it can draw.
 *
 * TWO MODES. By default both peers go through the stand-in relay and tracker
 * the Rust integration tests use (crates/tryst/examples/standin-relay.rs),
 * on loopback with no STUN: offline, and deterministic enough to run often.
 * With --live they go through qrdrop's own public relays and trackers and
 * its STUN servers, which is the gate as the notes state it; a relay being
 * down there is weather, not a failure of this code.
 *
 * Kept out of `npm test`, like the other e2e suites: it builds a Rust
 * binary, and --live needs the goodwill of public infrastructure.
 *
 * ONLY=nostr or ONLY=torrent runs one strategy's two pairings, which is
 * what a live tracker failure wants: the tracker pairings take longest.
 */

import { execSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = process.argv.includes('--live')
const TIMEOUT = LIVE ? 120_000 : 30_000
const EXE = process.platform === 'win32' ? '.exe' : ''
const EXAMPLES = path.join(ROOT, 'target', 'debug', 'examples')

const { joinRoom: joinNostr, selfId } = await import('@trystero-p2p/nostr')
const { joinRoom: joinTorrent } = await import('@trystero-p2p/torrent')
const { RELAYS, ICE_SERVERS } = await import('../src/transport/room.js')
const { loadRTCPolyfill } = await import('../src/node/rtc.js')

const TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']

console.log('building the tryst examples...')
execSync('mise exec -- cargo build -p tryst --all-features --examples', { cwd: ROOT, stdio: 'inherit' })

const Base = await loadRTCPolyfill()
/** Loopback only offline, so the two peers meet on 127.0.0.1 as the Rust one is bound there. */
class LoopbackRTC extends Base {
  /** @param {RTCConfiguration} [rtcConfig] */
  constructor(rtcConfig) {
    super(/** @type {any} */ ({ ...rtcConfig, iceServers: [], bindAddress: '127.0.0.1' }))
  }
}

/**
 * A child process whose stdout is JSON lines, and a way to wait for one.
 *
 * @param {string} exe
 * @param {string[]} args
 */
function child(exe, args) {
  const proc = spawn(path.join(EXAMPLES, exe + EXE), args, { stdio: ['ignore', 'pipe', 'inherit'] })
  /** @type {any[]} */
  const lines = []
  /** @type {Array<() => void>} */
  const waiters = []
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    lines.push(JSON.parse(line))
    waiters.splice(0).forEach(w => w())
  })
  /**
   * @param {(line: any) => boolean} want
   * @returns {Promise<any>}
   */
  const waitFor = want => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting on ${exe}: ${JSON.stringify(lines)}`)), TIMEOUT)
    const check = () => {
      const hit = lines.find(want)
      if (hit) {
        clearTimeout(timer)
        resolve(hit)
      } else {
        waiters.push(check)
      }
    }
    check()
  })
  const exited = new Promise(resolve => proc.on('exit', code => resolve(code)))
  return { proc, waitFor, exited }
}

/**
 * One pairing: the Rust peer and a Trystero room, in one room, each saying
 * something to the other.
 *
 * @param {'nostr' | 'torrent'} strategy
 * @param {'lower' | 'higher'} rustIs
 * @param {string[]} urls
 */
async function pairing(strategy, rustIs, urls) {
  const roomId = randomBytes(12).toString('base64url')
  const password = randomBytes(16).toString('base64url')
  const rustId = (rustIs === 'lower' ? '0' : 'z').repeat(20)
  const args = ['--strategy', strategy, '--room', roomId, '--password', password, '--id', rustId, '--say', 'from rust']
  for (const u of urls) args.push('--relay', u)
  if (LIVE) {
    for (const s of ICE_SERVERS) {
      for (const u of [s.urls].flat()) if (u.startsWith('stun:')) args.push('--stun', u)
    }
  } else {
    args.push('--bind', '127.0.0.1')
  }
  const rust = child('peer', args)

  const join = strategy === 'nostr' ? joinNostr : joinTorrent
  const room = join({
    appId: 'qrdrop',
    password,
    relayConfig: { urls },
    rtcConfig: { iceServers: LIVE ? [...ICE_SERVERS] : [] },
    rtcPolyfill: LIVE ? Base : LoopbackRTC,
  }, roomId)
  // Trystero 0.25's action is an object with an assignable onMessage, as
  // src/transport/room.js notes, not the older [send, receive] pair.
  const msg = room.makeAction('msg')
  /** @type {Promise<string>} */
  const joined = new Promise(resolve => {
    room.onPeerJoin = id => {
      msg.send('from node', { target: id })
      resolve(id)
    }
  })
  /** @type {Promise<string>} */
  const heard = new Promise(resolve => { msg.onMessage = data => resolve(String(data)) })

  const label = `${strategy}, rust ${rustIs}`
  const deadline = (/** @type {Promise<any>} */ p) => Promise.race([
    p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out`)), TIMEOUT)),
  ])
  try {
    const nodeSawRust = await deadline(joined)
    if (nodeSawRust !== rustId) throw new Error(`${label}: node joined ${nodeSawRust}, not ${rustId}`)
    const rustJoined = await rust.waitFor(l => l.event === 'joined')
    if (rustJoined.peer !== selfId) throw new Error(`${label}: rust joined ${rustJoined.peer}, not ${selfId}`)
    const fromRust = await deadline(heard)
    if (fromRust !== 'from rust') throw new Error(`${label}: node heard ${fromRust}`)
    const fromNode = await rust.waitFor(l => l.event === 'message' && l.action === 'msg')
    if (fromNode.body.text !== 'from node') throw new Error(`${label}: rust heard ${JSON.stringify(fromNode)}`)
    const code = await deadline(rust.exited)
    if (code !== 0) throw new Error(`${label}: rust exited ${code}`)
    console.log(`ok - ${label}`)
  } finally {
    rust.proc.kill()
    await room.leave()
  }
}

let urls = { nostr: RELAYS, torrent: TRACKERS }
/** @type {import('node:child_process').ChildProcess | undefined} */
let standin
if (!LIVE) {
  const relay = child('standin-relay', [])
  standin = relay.proc
  const { url } = await relay.waitFor(l => typeof l.url === 'string')
  urls = { nostr: [url], torrent: [url] }
}

let failed = 0
/** @type {Array<'nostr' | 'torrent'>} */
const strategies = ['nostr', 'torrent']
for (const strategy of strategies.filter(s => !process.env.ONLY || s === process.env.ONLY)) {
  for (const rustIs of /** @type {const} */ (['lower', 'higher'])) {
    try {
      await pairing(strategy, rustIs, urls[strategy])
    } catch (error) {
      failed++
      console.error(`not ok - ${error instanceof Error ? error.message : error}`)
    }
  }
}
standin?.kill()
// node-datachannel and Trystero's sockets hold the event loop open.
setTimeout(() => process.exit(failed ? 1 : 0), 300)
