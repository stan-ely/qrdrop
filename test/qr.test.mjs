/**
 * The scanner's camera release.
 *
 * `scanQRStream`'s doc comment promises the camera track is always stopped on
 * the way out, "including on error and on cancel", and for one abort timing it
 * was not: a signal that fired while `getUserMedia` was still resolving landed
 * before the abort listener existed, so the scan promise never settled, its
 * `finally` never ran, and the camera stayed on for the life of the page.
 *
 * That timing is the ordinary one, not a corner case. The hand-entered code
 * field lives on the scanner screen, and submitting it aborts this very signal
 * -- so anyone who pastes a code rather than scanning aborts mid-open. It was
 * found by a webcam light that stayed on through a whole transfer, which is
 * the only way it could have been found: nothing in a headless suite can see a
 * camera that was never released, so the release is asserted here directly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { scanQRStream } from '../src/web/qr.js'

/** A MediaStream-shaped stub whose tracks record their own release. */
function fakeCamera() {
  const track = { kind: 'video', readyState: 'live', stop() { track.readyState = 'ended' } }
  return { track, stream: { getTracks: () => [track] } }
}

/** A <video>-shaped stub. Only the four members the scanner touches. */
function fakeVideo() {
  return {
    srcObject: /** @type {unknown} */ (null),
    videoWidth: 640,
    videoHeight: 480,
    setAttribute() {},
    async play() {},
  }
}

/**
 * Installs the globals qr.js reaches for, and returns a restore function.
 * `openDelay` is what makes the timing testable: it is the window during which
 * the camera is opening and an abort has nowhere to land.
 *
 * @param {{ stream: unknown, openDelay?: number }} args
 */
function stubBrowser({ stream, openDelay = 0 }) {
  const g = /** @type {any} */ (globalThis)
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(g, 'navigator'),
    BarcodeDetector: g.BarcodeDetector,
    requestAnimationFrame: g.requestAnimationFrame,
  }

  Object.defineProperty(g, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => new Promise(resolve => setTimeout(() => resolve(stream), openDelay)),
      },
    },
  })
  // Present, so createDetector never reaches the jsQR path (which wants a real
  // document and a dynamic import). Detecting nothing is right here: these
  // tests are about the lifecycle, not the decode.
  g.BarcodeDetector = class { async detect() { return [] } }
  // The scan loop is rAF-driven; a timer keeps it turning without a browser
  // and lets an aborted loop actually stop.
  g.requestAnimationFrame = (/** @type {() => void} */ fn) => setTimeout(fn, 5)

  return () => {
    if (saved.navigator) Object.defineProperty(g, 'navigator', saved.navigator)
    else delete g.navigator
    g.BarcodeDetector = saved.BarcodeDetector
    g.requestAnimationFrame = saved.requestAnimationFrame
  }
}

test('an abort while the camera is still opening still releases it', async () => {
  const { track, stream } = fakeCamera()
  const restore = stubBrowser({ stream, openDelay: 30 })
  try {
    const controller = new AbortController()
    const scan = scanQRStream({ video: /** @type {any} */ (fakeVideo()), onCode: () => {}, signal: controller.signal })

    // Inside the open window: after the pre-flight `signal.aborted` check has
    // passed, before any abort listener exists. This is the exact timing that
    // left the camera on.
    await new Promise(r => setTimeout(r, 10))
    controller.abort()

    // It must also SETTLE. The old failure was a promise that hung forever,
    // and a test that only checked the track would have hung with it rather
    // than failing, so the timeout is part of the assertion.
    await Promise.race([
      scan,
      new Promise((_r, reject) => setTimeout(() => reject(new Error('scanQRStream never settled after abort')), 2000)),
    ])
    assert.equal(track.readyState, 'ended', 'the camera track was left running')
  } finally {
    restore()
  }
})

test('an abort once the scan loop is running releases the camera', async () => {
  const { track, stream } = fakeCamera()
  const restore = stubBrowser({ stream })
  try {
    const controller = new AbortController()
    const scan = scanQRStream({ video: /** @type {any} */ (fakeVideo()), onCode: () => {}, signal: controller.signal })
    await new Promise(r => setTimeout(r, 40))
    controller.abort()
    await scan
    assert.equal(track.readyState, 'ended', 'the camera track was left running')
  } finally {
    restore()
  }
})

test('a signal already aborted never opens the camera at all', async () => {
  const { track, stream } = fakeCamera()
  const restore = stubBrowser({ stream })
  try {
    const controller = new AbortController()
    controller.abort()
    const video = fakeVideo()
    await scanQRStream({ video: /** @type {any} */ (video), onCode: () => {}, signal: controller.signal })
    assert.equal(track.readyState, 'live', 'the camera should never have been opened')
    assert.equal(video.srcObject, null, 'no stream should have been attached')
  } finally {
    restore()
  }
})
