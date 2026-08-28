/**
 * The `qrdrop/web` entry: everything that needs a DOM.
 *
 * Mirrors src/index.js's split -- that entry is the isomorphic protocol, this
 * one is the browser-specific half it deliberately left out: where received
 * bytes land (Sink), where sent bytes come from (FileSource), QR rendering
 * and scanning, and the `<qr-drop>` custom element that wires all of it
 * together into a UI.
 *
 * Must not be imported from Node: sink.js and element.js reach for `window`,
 * `document`, and `customElements` at module scope in places, and
 * tsconfig.json checks this directory with `types: []` and the DOM lib only,
 * so a stray Node global here fails the build the same way it would in
 * src/core/.
 */

export { createSink, canStreamToDisk, safeFilename } from './sink.js'
export { renderQR, scanQR, cameraAvailable } from './qr.js'
export { fromFile } from './source.js'
export { QRDropElement, defineQRDrop } from './element.js'
