/**
 * A peer that offers text, for app-native.e2e.mjs to receive.
 *
 * Neither CLI can be that peer: both send everything as
 * application/octet-stream, on purpose (src/node/source.js), and a browser
 * would be a second page to drive for one leg. So this is the JS core sending
 * what the web UI's compose sheet sends, a `message.txt` of type
 * text/plain;charset=utf-8, and it prints what `cliSas` and the code pattern
 * in that suite already read.
 *
 * A process of its own for the reason src/cli.js ends in process.exit:
 * node-datachannel holds the event loop open after the room has closed.
 *
 *   node e2e/send-text-peer.mjs <text>
 */

import {
  generateSecret, encodeSecret, deriveTopic, derivePassword, openRoom,
  createControlStream, createReceiver, sendFile,
} from '../src/index.js'
import { loadRTCPolyfill } from '../src/node/index.js'

const bytes = new TextEncoder().encode(process.argv[2] ?? '')

const secret = generateSecret()
console.log(`Transfer code: ${encodeSecret(secret)}`)

const [topic, password, rtcPolyfill] = await Promise.all([deriveTopic(secret), derivePassword(secret), loadRTCPolyfill()])
const room = await openRoom({ topic, password, secret, role: 'host', rtcPolyfill, onStatus: () => {} })

const words = room.session.sas.split(' ').map((emoji, i) => `${emoji} ${room.session.sasWords[i]}`).join('   ')
console.log(`Both devices should be showing:\n\n  ${words}\n`)

const control = createControlStream()
let controlOut = 0
const nextControlIndex = () => controlOut++
const receiver = createReceiver({
  channel: room.channel,
  sendKey: room.session.sendKey,
  recvKey: room.session.recvKey,
  control,
  nextControlIndex,
  onOffer: () => { throw new Error('Peer offered a file while we were sending one') },
  createSink: async () => { throw new Error('Peer tried to send us a file mid-send') },
})
room.onFrame(frame => receiver.handleFrame(frame))
room.onPeerLeave(() => {
  receiver.settled().then(() => control.fail(new Error('The other device disconnected.')))
})

const result = await sendFile({
  channel: room.channel,
  key: room.session.sendKey,
  file: {
    name: 'message.txt',
    size: bytes.length,
    mime: 'text/plain;charset=utf-8',
    slice: async (start, end) => bytes.subarray(start, end),
    close: async () => {},
  },
  fileSeq: 0,
  control,
  nextControlIndex,
})
console.log(result.declined ? 'Declined' : `Sent digest=${result.digest}`)
await room.close()
process.exit(result.declined ? 1 : 0)
