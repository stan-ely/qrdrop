/**
 * Trystero's internals, for the wire vectors and nothing else.
 *
 * The Rust session (docs/notes/rust-session.md) re-implements Trystero 0.25.4's
 * wire, so its vectors have to come from Trystero's own code rather than from a
 * reading of it: the signal cipher, the action wire and the room frame are
 * exactly the pieces where a reading goes wrong quietly (the 16-byte IV, the
 * binary flag set alongside the JSON one, the base36 "sha1"). Most of them are
 * not exported by `@trystero-p2p/core`, whose package `exports` names only
 * the index, so they are imported here by file path. One module holds every
 * such path, so a Trystero upgrade that moves a file breaks in one place.
 *
 * It also pins the version, and throws on any other. The Trystero vectors in
 * crates/tryst/vectors/ describe 0.25.4 specifically, and the Rust side is tested
 * against them; an upgrade that changed the wire and silently regenerated them
 * would hand the Rust crate a new target with nothing in any diff saying the
 * old one had moved. Bumping Trystero means re-reading "The wire, as the Rust
 * side must speak it", then changing the version below on purpose.
 */

import { readFileSync } from 'node:fs'

export const TRYSTERO_VERSION = '0.25.4'

const root = new URL('../../node_modules/@trystero-p2p/', import.meta.url)

for (const pkg of ['core', 'nostr', 'torrent']) {
  const { version } = JSON.parse(readFileSync(new URL(`${pkg}/package.json`, root), 'utf8'))
  if (version !== TRYSTERO_VERSION) {
    throw new Error(
      `@trystero-p2p/${pkg} is ${version}, but test/vectors/ describe ${TRYSTERO_VERSION}. `
      + 'Re-read the wire section of docs/notes/rust-session.md before changing TRYSTERO_VERSION.',
    )
  }
}

// None of these four is exported by the package, and crypto.mjs's declaration
// file names only two of its six functions, so the ones the vectors use are
// typed here and the rest are typed loosely: their shapes are used as data.
import * as cryptoModule from '../../node_modules/@trystero-p2p/core/dist/crypto.mjs'
// @ts-ignore -- no declaration file.
import { createActionWireManager } from '../../node_modules/@trystero-p2p/core/dist/action-wire.mjs'
// @ts-ignore -- no declaration file.
import { SharedPeerManager } from '../../node_modules/@trystero-p2p/core/dist/shared-peer.mjs'
// @ts-ignore -- no declaration file.
export { createPasswordHandshake } from '../../node_modules/@trystero-p2p/core/dist/handshake.mjs'
export { strToNum, toHex, libName } from '@trystero-p2p/core'

/**
 * @typedef {object} TrysteroCrypto
 * @property {(str: string) => Promise<string>} sha1 SHA-1, each byte as unpadded base36.
 * @property {(password: string, appId: string, roomId: string) => Promise<CryptoKey>} genKey
 * @property {(key: Promise<CryptoKey>, plaintext: string) => Promise<string>} encrypt
 * @property {(key: Promise<CryptoKey>, wire: string) => Promise<string>} decrypt
 * @property {(appId: string, roomId: string) => Promise<string>} deriveRoomNamespace
 */

/** @type {TrysteroCrypto} */
export const crypto = /** @type {any} */ (cryptoModule)
export { createEvent, subscribe } from '@trystero-p2p/nostr'

/**
 * Drives Trystero's own action wire and returns the chunks it would put on the
 * data channel for one `send()`. The peer is a fake with no channel, so no
 * backpressure wait ever runs and the chunks come out synchronously in order.
 *
 * Actions keep a nonce per action, so the manager is passed in rather than
 * created per call: sending twice on one action is how the nonce is seen to
 * advance.
 *
 * @returns {{ wire: any, sent: Bytes[] }}
 */
export function actionWire() {
  /** @type {Bytes[]} */
  const sent = []
  const peer = { channel: null, sendData: (/** @type {Bytes} */ chunk) => sent.push(chunk.slice()) }
  const wire = createActionWireManager({
    getPeer: () => peer,
    getPeerIds: () => ['peer'],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {},
  })
  return { wire, sent }
}

/**
 * Parses data-channel messages back through Trystero's own reassembly, so a
 * test can say what a recorded chunk decodes to without re-implementing the
 * wire it is checking.
 *
 * @param {string[]} actions The action names to register.
 * @returns {{ feed: (bytes: Bytes) => void, received: Array<{ action: string, payload: unknown, metadata?: unknown }> }}
 */
export function actionReader(actions) {
  /** @type {Array<{ action: string, payload: unknown, metadata?: unknown }>} */
  const received = []
  const wire = createActionWireManager({
    getPeer: () => null,
    getPeerIds: () => [],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {},
  })
  for (const action of actions) {
    wire.makeInternalAction(action).onMessage(
      (/** @type {unknown} */ payload, /** @type {string} */ _peer, /** @type {unknown} */ metadata) =>
        received.push(metadata === undefined ? { action, payload } : { action, payload, metadata }),
    )
  }
  return {
    feed: bytes => wire.handleData('peer', bytes.slice().buffer),
    received,
  }
}

/**
 * The room frame, from Trystero's SharedPeerManager rather than from the spec:
 * a fake peer is registered and bound to one room, and whatever the binding
 * hands its underlying peer is what a data channel would carry.
 *
 * @param {string} appId
 * @param {string} roomId
 * @param {string} roomToken
 */
export function roomFramer(appId, roomId, roomToken) {
  /** @type {Bytes[]} */
  const sent = []
  /** @type {Array<{ kind: 'data', payload: Bytes } | { kind: 'presence', token: string, present: boolean }>} */
  const delivered = []
  /** @type {any} */
  let handlers = {}
  const peer = {
    created: Date.now(),
    isDead: false,
    connection: { connectionState: 'connected', iceConnectionState: 'connected' },
    channel: { readyState: 'open' },
    sendData: (/** @type {Bytes} */ d) => sent.push(d.slice()),
    setHandlers: (/** @type {any} */ h) => { handlers = h },
    destroy() {},
    getOffer() {},
    signal() {},
    addStream() {}, removeStream() {}, addTrack() {}, removeTrack() {}, replaceTrack() {},
  }
  const manager = new SharedPeerManager()
  manager.setRoomPresenceHandler(appId, (/** @type {string} */ _id, /** @type {string} */ token, /** @type {boolean} */ present) =>
    delivered.push({ kind: 'presence', token, present }))
  const shared = manager.register(appId, 'peer', peer, 60_000)
  const tokenReady = Promise.resolve(roomToken)
  const { proxy } = manager.bind(roomId, tokenReady, shared, { onDetach() {} })
  proxy.setHandlers({ data: (/** @type {ArrayBuffer} */ payload) => delivered.push({ kind: 'data', payload: new Uint8Array(payload) }) })

  return {
    /** Resolves once the binding has its token and has flushed what it queued. */
    ready: tokenReady.then(() => new Promise(r => setTimeout(r, 0))),
    /** @param {Bytes} data */
    wrap: data => { proxy.sendData(data); return /** @type {Bytes} */ (sent.at(-1)) },
    /** @param {boolean} present */
    presence: present => { manager.sendRoomPresence(shared, roomToken, present); return /** @type {Bytes} */ (sent.at(-1)) },
    /** @param {Bytes} frame */
    unwrap: frame => { handlers.data(frame.slice().buffer); return delivered.at(-1) },
    delivered,
  }
}

