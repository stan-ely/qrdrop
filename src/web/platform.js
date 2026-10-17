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
 * @property {NativeSession} [session] A transfer run outside this page --
 *   by qrdrop-session in the app's Rust (app/src/native.js) -- with
 *   element.js drawing what it reports instead of running room.js itself.
 *   Only the app registers it, and only when it should run (Linux, whose
 *   webview has no WebRTC, or an override). The page still owns both safety
 *   gestures: nothing leaves before its Confirm, nothing is written before
 *   its Accept.
 */

/**
 * A file the native session can open itself: a path, not a `File`.
 *
 * @typedef {object} NativeFile
 * @property {string} path
 * @property {string} name
 * @property {number} size
 */

/**
 * What the native session reports, in order. `t` names the event.
 *
 * @typedef {{ t: 'status', text: string }
 *   | { t: 'paired', sas: string, words: string[] }
 *   | { t: 'path', path: NetworkPath }
 *   | { t: 'offer', name: string, size: number }
 *   | { t: 'tooLarge', message: string }
 *   | { t: 'accepted' }
 *   | { t: 'progress', moved: number, total: number }
 *   | { t: 'lan' }
 *   | { t: 'sent', digest: string }
 *   | { t: 'received', name: string, size: number, digest: string, location: string }
 *   | { t: 'declined' }
 *   | { t: 'error', message: string }} NativeEvent
 */

/**
 * The person's words to a running native transfer.
 *
 * @typedef {'confirm' | 'reject' | 'accept' | 'decline' | 'cancel'} NativeWord
 */

/**
 * @typedef {object} NativeSession
 * @property {(file: NativeFile, onEvent: (e: NativeEvent) => void) =>
 *   Promise<{ code: string, control: (word: NativeWord) => void }>} send
 *   Starts a send: the secret is generated on the native side, fresh for
 *   every call, and the code comes back to be shown.
 * @property {(code: string, onEvent: (e: NativeEvent) => void) =>
 *   Promise<{ control: (word: NativeWord) => void }>} receive
 * @property {() => Promise<NativeFile | null>} [pick] A file picker that
 *   returns a path. Absent where the platform has none (Android), and a pick
 *   there keeps the page's own session.
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
