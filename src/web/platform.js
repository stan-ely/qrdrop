/**
 * The platform seam: what element.js asks for instead of importing sink.js
 * directly.
 *
 * Every consumer of `qrdrop/web` -- the deployed site, an embedder's own
 * page, and the Tauri app -- shares this exact file. sink.js's
 * showSaveFilePicker/Blob pair is the right answer on a plain browser and the
 * wrong one inside Tauri's webview, which has neither API on Windows, Linux
 * or macOS (see app/CAPABILITIES.md). Grafting that choice into sink.js
 * itself would mean the website carries a Tauri-only code path it can never
 * take; putting it here instead means sink.js stays exactly what it always
 * was, and only an entry point that KNOWS it is not a plain browser ever
 * calls registerPlatform().
 *
 * This is a runtime seam, not a build-time one: site/main.js and app/'s own
 * entry (app/src/main.js) bundle the same src/web/*, and the two diverge only
 * by which of them calls registerPlatform() before defineQRDrop() runs. Left
 * uncalled, this is just sink.js under a different name.
 *
 * No imports beyond sink.js. This file ships in the npm package's `./web`
 * export, so -- like everything else in this directory -- it must build and
 * run with nothing installed beyond what a browser already provides.
 */
import { createSink as webCreateSink, canStreamToDisk as webCanStreamToDisk } from './sink.js'

/**
 * @typedef {object} Platform
 * @property {typeof webCreateSink} createSink
 * @property {() => boolean} canStreamToDisk
 */

/** @type {Platform} */
let current = { createSink: webCreateSink, canStreamToDisk: webCanStreamToDisk }

/**
 * Overrides one or both entries. Called at most once, at startup, by an
 * entry point that is not a plain browser -- never by site/main.js, so the
 * deployed website's behaviour cannot regress from a change made for the app
 * shell.
 *
 * @param {Partial<Platform>} overrides
 */
export function registerPlatform(overrides) {
  current = { ...current, ...overrides }
}

/** @returns {Platform} */
export function getPlatform() {
  return current
}
