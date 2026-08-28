/**
 * The one import that resolves to something tsc will not accept as a module.
 *
 * qrcode-generator ships an accurate .d.ts, but it is an old-style global
 * script that ends in `declare module 'qrcode-generator' { export = qrcode }`.
 * Resolving the package points at that file directly, and TS rightly objects
 * that a global script is not an ES module. The reference below pulls its
 * declarations in as globals; the block re-declares the specifier as a real
 * module with a default export, which is how src/web/qr.js imports it.
 *
 * Note this is the *bundled* declaration, not @types/qrcode-generator. The
 * DefinitelyTyped one is stale: it types createSvgTag as positional only, so
 * the `createSvgTag({ cellSize, margin, scalable })` call in src/web/qr.js --
 * which is what makes the QR scale to its container instead of being a fixed
 * bitmap -- would be reported as an error against a signature the library has.
 *
 * createASCII, which src/node/qr.js uses to draw a scannable code in a
 * terminal, comes from the same declaration.
 */

/// <reference types="qrcode-generator" />

declare module 'qrcode-generator' {
  const qrcode: QRCodeFactory
  export default qrcode
}

/**
 * node-datachannel is an optionalDependency, so it may legitimately be absent.
 * src/node/rtc.js imports it dynamically inside a try/catch and reports a
 * missing native module as an install instruction rather than a stack trace.
 * Declared loosely because the checker must not require it to be installed.
 */
declare module 'node-datachannel/polyfill' {
  export const RTCPeerConnection: typeof globalThis.RTCPeerConnection
}
