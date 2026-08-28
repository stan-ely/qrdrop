/**
 * The isomorphic entry: the protocol, and the transport that carries it.
 *
 * Nothing reachable from here touches a DOM or an `fs`. That is enforced
 * rather than asserted -- tsconfig.json checks src/core/ and src/transport/
 * with `types: []` and no Node lib, so a stray `Buffer` or `process` fails the
 * build, and tsconfig.node.json checks the same files again with Node's
 * globals. A file has to satisfy both.
 *
 * What is deliberately NOT here: sinks (where received bytes land) and sources
 * (where sent bytes come from). Both are runtime-specific by nature, so
 * createReceiver takes a `createSink` and sendFile takes a FileSource, and the
 * caller supplies whichever its runtime has. Import 'qrdrop/web' or
 * 'qrdrop/node' for those.
 */

// The secret, and everything derived from it.
export {
  generateSecret,
  encodeSecret,
  decodeSecret,
  deriveTopic,
  derivePassword,
  toBase64url,
  fromBase64url,
} from './core/secret.js'

// Ephemeral ECDH, directional keys, and the emoji SAS.
export {
  createEphemeralKeypair,
  exportPublicKey,
  establishSession,
} from './core/session.js'

// Framing and per-chunk AEAD. Exported because a transport author needs the
// size constants to size its own buffers sensibly.
export {
  CHUNK_SIZE,
  HEADER_BYTES,
  TAG_BYTES,
  MAX_FRAME_BYTES,
  TYPE_CONTROL,
  TYPE_CHUNK,
  seal,
  open,
  sealControl,
  openControl,
} from './core/frame.js'

export { createControlStream } from './core/control.js'
export { EMPTY_CHAIN, chainHash, hex, equalHex } from './core/digest.js'
export { fromBytes } from './core/source.js'
export { sendFile } from './core/sender.js'
export { createReceiver } from './core/receiver.js'

// Pairing. RELAYS and ICE_SERVERS are exported so a caller can pass a modified
// list back in -- and so scripts/build-site.mjs can generate the CSP from the
// same array the code dials, which is what keeps the two from drifting apart.
export { openRoom, RELAYS, ICE_SERVERS } from './transport/room.js'
export { createChannel } from './transport/channel.js'
