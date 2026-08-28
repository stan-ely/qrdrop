/**
 * QR generation and scanning.
 *
 * Rendered as SVG rather than a canvas bitmap so it stays sharp on any display
 * and at any size -- a blurry QR is a QR that takes three attempts to scan.
 *
 * The code is always drawn dark-on-light regardless of page theme. Scanners
 * cope poorly with inverted codes, and this is the one element on the page
 * whose job is to be read by a camera rather than a person.
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
 * Starts the camera and resolves with the first decoded QR value.
 *
 * Always stops the camera track on the way out, including on error and on
 * cancel. A page that quietly holds the camera open after the user has moved on
 * is both a privacy problem and, on a phone, a battery one.
 *
 * @param {object} args
 * @param {HTMLVideoElement} args.video
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<string>}
 */
export async function scanQR({ video, signal }) {
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
    return await new Promise((resolve, reject) => {
      let stopped = false

      signal?.addEventListener('abort', () => {
        stopped = true
        reject(new DOMException('Scan cancelled', 'AbortError'))
      }, { once: true })

      const tick = async () => {
        if (stopped) return
        try {
          const value = await detect(video)
          if (value) {
            stopped = true
            return resolve(value)
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

export const cameraAvailable = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
