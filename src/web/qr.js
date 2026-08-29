/**
 * QR generation and scanning.
 *
 * Two renderers, for two different jobs:
 *
 *  - `renderQR` draws an <svg>, so the pairing code stays sharp on any
 *    display and at any size -- a blurry QR is a QR that takes three
 *    attempts to scan, and it renders exactly once.
 *  - `renderQRToCanvas` draws onto a reused <canvas> the caller keeps
 *    across calls, for the "beam" file-transfer path, which repaints a new
 *    code up to ten times a second. See its doc comment for why that rules
 *    out SVG.
 *
 * Both are always drawn dark-on-light regardless of page theme. Scanners
 * cope poorly with inverted codes, and this is the one kind of element on
 * the page whose job is to be read by a camera rather than a person.
 *
 * Two scan modes, built one on top of the other:
 *
 *  - `scanQR` resolves once, with the first code seen -- the pairing path.
 *  - `scanQRStream` keeps decoding for as long as the caller wants and
 *    calls back on every value -- the beam receive path.
 */

import qrcode from 'qrcode-generator'

/**
 * Loaded on demand: 130 kB, and only needed on browsers without a native
 * BarcodeDetector. A static import would put it in every bundle for the
 * benefit of Firefox alone.
 */
const loadJsQR = async () => (await import('jsqr')).default

/**
 * Returns an <svg> element, so callers never have to touch innerHTML.
 *
 * @param {string} text
 * @param {{ cellSize?: number, margin?: number }} [options]
 * @returns {Element}
 */
export function renderQR(text, { cellSize = 6, margin = 3 } = {}) {
  // Type 0 auto-sizes to the data; 'M' correction tolerates ~15% damage, which
  // is ample for a screen and keeps the modules large enough to scan easily.
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()

  const template = document.createElement('template')
  template.innerHTML = qr.createSvgTag({ cellSize, margin, scalable: true })
  // Non-null: createSvgTag always returns one <svg> root, and the only input
  // to it is the code we generated ourselves.
  return /** @type {Element} */ (template.content.firstElementChild)
}

/**
 * Draws a QR code onto a caller-supplied, reused <canvas>, one canvas pixel
 * per module rather than per on-screen pixel.
 *
 * WHY A SECOND RENDERER: `renderQR` above is right for the pairing code,
 * which renders once and must stay sharp at whatever size the CSS asks for.
 * The beam player redraws a new code up to ten times a second, and rebuilding
 * (or, per `patch()` in src/web/vdom.js, re-adopting) several hundred <rect>
 * elements at that rate is not viable -- filling a canvas with plain
 * `fillRect` calls is. Sizing the canvas to the module count and leaving the
 * upscale to CSS (`image-rendering: pixelated` on the caller's side) is also
 * far cheaper than scaling in JS: the canvas never holds more pixels than
 * there are modules to draw.
 *
 * Beam frames default to error correction L rather than the pairing code's M:
 * a beam frame is one chunk of a sequence that just loops back and repeats a
 * missed frame, so there is no lasting harm in a frame that fails to scan,
 * and L's lower redundancy buys back capacity -- fewer frames per file, and
 * more headroom before the payload needs a second QR "page" per chunk.
 *
 * Always dark-on-light, same reasoning as `renderQR`: this is drawn for a
 * camera, not a person, and scanners cope poorly with inverted codes.
 *
 * @param {string} text
 * @param {HTMLCanvasElement} canvas
 * @param {{ ec?: 'L' | 'M' | 'Q' | 'H', margin?: number }} [options]
 * @returns {void}
 */
export function renderQRToCanvas(text, canvas, { ec = 'L', margin = 2 } = {}) {
  const qr = qrcode(0, ec)
  qr.addData(text)
  qr.make()

  const count = qr.getModuleCount()
  const size = count + margin * 2
  canvas.width = size
  canvas.height = size

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not open a 2D canvas to draw the code')

  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#000'
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect(col + margin, row + margin, 1, 1)
    }
  }
}

/**
 * Detection strategy, best first:
 *
 *  1. BarcodeDetector -- native, hardware-accelerated, no bundle cost. Chromium
 *     and Safari have it.
 *  2. jsQR -- pure JS over canvas pixels. Slower, but it is the only option on
 *     Firefox, and a scanner that works everywhere matters more here than one
 *     that is fast in two browsers.
 *
 * @returns {Promise<(video: HTMLVideoElement) => Promise<string | null>>}
 */
async function createDetector() {
  if ('BarcodeDetector' in globalThis) {
    try {
      // Not in lib.dom: BarcodeDetector is Chromium and Safari only, and is
      // feature-detected on the line above precisely because of that.
      const Detector = /** @type {any} */ (globalThis).BarcodeDetector
      const detector = new Detector({ formats: ['qr_code'] })
      return async source => {
        const [hit] = await detector.detect(source)
        return hit?.rawValue ?? null
      }
    } catch {
      // Present but refusing qr_code; fall through to the JS decoder.
    }
  }

  const jsQR = await loadJsQR()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not open a 2D canvas to decode the code')

  return async video => {
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    canvas.width = w
    canvas.height = h
    ctx.drawImage(video, 0, 0, w, h)
    const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })
    return hit?.data ?? null
  }
}

/**
 * Starts the camera and calls `onCode` for every decoded QR value, for as
 * long as `signal` stays unaborted.
 *
 * Always stops the camera track on the way out, including on error and on
 * cancel. A page that quietly holds the camera open after the user has moved on
 * is both a privacy problem and, on a phone, a battery one.
 *
 * Unlike the one-shot `scanQR` below, ending via `signal` is the ordinary
 * way this resolves, not a failure -- there is no "the stream got cancelled"
 * error to report, so this resolves rather than rejecting on abort.
 *
 * @param {object} args
 * @param {HTMLVideoElement} args.video
 * @param {(value: string) => void} args.onCode
 * @param {AbortSignal} args.signal
 * @returns {Promise<void>}
 */
export async function scanQRStream({ video, onCode, signal }) {
  // Checked before the camera is opened, not after. An AbortSignal that has
  // already fired never emits the event again, so a listener registered below
  // would never hear it -- and this would light up the camera and loop on it
  // forever for a caller that had already given up. The pre-aborted case is
  // ordinary here: element.js's teardown can fire between a user's tap and
  // this function getting its turn.
  if (signal.aborted) return

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  })

  video.srcObject = stream
  video.setAttribute('playsinline', '')  // iOS otherwise takes the video fullscreen
  await video.play()

  const detect = await createDetector()
  const stop = () => {
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }

  try {
    await new Promise(resolve => {
      let stopped = false
      // The beam plays codes at roughly 10 fps against a camera sampling at
      // roughly 30 fps, so the same displayed frame is decoded two or three
      // times running before the next code appears. Without this guard every
      // one of those repeats would reach onCode as if it were a new chunk,
      // and the beam decoder would have to re-derive this same dedup logic
      // downstream. Comparing only against the immediately-previous value
      // (not a history set) is deliberate: a sequence that legitimately
      // repeats a value later on is a new frame arriving late, not a repeat
      // of this one, and must still be delivered.
      let last = /** @type {string | null} */ (null)

      signal.addEventListener('abort', () => {
        stopped = true
        resolve(undefined)
      }, { once: true })

      const tick = async () => {
        if (stopped) return
        try {
          const value = await detect(video)
          if (value && value !== last) {
            last = value
            onCode(value)
          }
        } catch {
          // A single bad frame is not fatal; keep looking.
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  } finally {
    stop()
  }
}

/**
 * Starts the camera and resolves with the first decoded QR value.
 *
 * A thin one-shot wrapper over `scanQRStream`: it derives its own
 * `AbortController` chained to the caller's `signal`, resolves with the
 * first value `scanQRStream` reports and aborts the internal loop, but --
 * unlike `scanQRStream` itself -- rejects with `AbortError` when the
 * caller's own `signal` fires, since here cancellation before a code is
 * found is the failure case the caller (the live pairing screen) needs to
 * distinguish from a successful scan.
 *
 * @param {object} args
 * @param {HTMLVideoElement} args.video
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<string>}
 */
export async function scanQR({ video, signal }) {
  const internal = new AbortController()
  const relay = () => internal.abort()
  if (signal?.aborted) internal.abort()
  else signal?.addEventListener('abort', relay, { once: true })

  /** @type {string | null} */
  let found = null

  try {
    // Awaited rather than raced against a second promise that resolves on the
    // first code. scanQRStream only settles after its own `finally` has
    // stopped the camera track, so awaiting it is what preserves this
    // function's original guarantee: by the time a caller has the value, the
    // hardware is already released. Resolving from inside onCode would hand
    // the caller a code while the camera was still running for another tick,
    // and the pairing screen navigates away on exactly that resolution.
    await scanQRStream({
      video,
      signal: internal.signal,
      onCode: value => {
        if (found !== null) return
        found = value
        internal.abort()
      },
    })
  } finally {
    signal?.removeEventListener('abort', relay)
  }

  if (found === null) throw new DOMException('Scan cancelled', 'AbortError')
  return found
}

export const cameraAvailable = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
