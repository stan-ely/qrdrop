/**
 * Type declarations for the one CDN import that `paths` in tsconfig.json
 * cannot map on its own.
 *
 * qrcode-generator ships an accurate .d.ts, but it is an old-style global
 * script that ends in `declare module 'qrcode-generator' { export = qrcode }`.
 * Pointing `paths` at the package resolves to that file directly, and TS
 * rightly objects that a global script is not a module. The reference below
 * pulls its declarations in as globals, and the block re-exposes them under
 * the jsDelivr URL that static/js/deps.js actually imports.
 *
 * Note this is the *bundled* declaration, not @types/qrcode-generator. The
 * DefinitelyTyped one is stale: it types createSvgTag as positional only, so
 * the `createSvgTag({ cellSize, margin, scalable })` call in ui/qr.js -- which
 * is what makes the QR scale to its container instead of being a fixed bitmap
 * -- would be reported as an error against a signature the library has.
 */

/// <reference types="qrcode-generator" />

declare module 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm' {
  const qrcode: QRCodeFactory
  export default qrcode
}
