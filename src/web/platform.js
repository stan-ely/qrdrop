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
 * @property {LanPlatform} [lan] The local-network fast path
 *   (transport/lan.js). Absent here and on the deployed website, which
 *   never takes that path -- a page has no listener, and the site's CSP
 *   names no ws: origin. Only app/src/main.js registers one.
 * @property {() => Promise<boolean>} [prepareReceive] Settles where a
 *   received file will go, BEFORE a receive pairs or opens the camera, and
 *   resolves false when the person declined to say. Only the app registers
 *   it: its sink saves without asking at Accept, and on the Android versions
 *   that need a folder chosen first, choosing it mid-session is what let the
 *   OS freeze the app and lose the sender. A browser has nothing to prepare
 *   -- showSaveFilePicker asks at Accept, and must.
 * @property {() => Promise<string | null>} [changeSaveLocation] Asks for a
 *   new folder to save into and resolves to its name, or null when nothing
 *   changed. Its presence is what puts "Change folder" on the done screen, so
 *   only a platform with a folder to change (the Android app) registers it.
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
