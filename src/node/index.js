/**
 * The `qrdrop/node` entry: everything that needs Node, not a DOM.
 *
 * Mirrors src/web/index.js's role for the other runtime -- src/index.js is
 * the isomorphic protocol, and each of these two entries supplies the one
 * half it deliberately left out: where received bytes land (Sink) and where
 * sent bytes come from (FileSource) are runtime-specific by construction,
 * since "land" means a save dialog in a browser and a file descriptor here,
 * and "come from" means File.slice() there and fs.read() here. QR rendering
 * and the WebRTC polyfill are runtime-specific for the more obvious reason
 * that a terminal cannot draw an <svg> and Node has no RTCPeerConnection.
 */

export { createFileSink } from './sink.js'
export { fromPath } from './source.js'
export { renderQRToTerminal } from './qr.js'
export { loadRTCPolyfill } from './rtc.js'
