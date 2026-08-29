/**
 * The two live halves of a beam transfer: a player that animates frames onto a
 * canvas, and a collector that feeds a camera's decodes into the codec.
 *
 * The codec itself (src/core/beam.js) is pure and isomorphic. Everything that
 * cannot be -- a canvas, a camera, an animation clock, teardown -- is here,
 * for the same reason src/web/element.js exists next to the pure view.js.
 *
 * WHY THE CANVAS IS NOT DESCRIBED IN VNODES. src/web/view.js is a pure
 * function re-run on every state change, and patch() reconciles its output
 * against the DOM. Driving ten frames a second through that would mean ten
 * full renders a second of every screen in the tree, and the QR itself cannot
 * be described in vnodes at any sensible cost anyway. So the player owns one
 * <canvas> element for its lifetime and repaints it in place; the view adopts
 * that node exactly the way it already adopts the pairing QR's <svg> and the
 * scanner's <video>, and the diff steps aside. See vdom.js's adoptInto.
 */

import { createBeamEncoder, createBeamDecoder } from '../core/beam.js'
import { renderQRToCanvas, scanQRStream } from './qr.js'

/**
 * How fast frames are shown, and the range a person is allowed to pick.
 *
 * Ten is the default because that is roughly where the slowest receiver tops
 * out: jsQR takes 50-100ms on a 1080p frame, so a Firefox phone manages about
 * ten decodes a second and anything faster is simply not seen. A native
 * BarcodeDetector (Chromium, Safari) does far better and can take 15 or 20,
 * which is worth offering because it nearly halves the wall-clock time -- but
 * only as a choice the sender makes while watching the receiver's progress
 * bar, since with no back channel nothing here can measure the far end.
 *
 * Below about 4 the transfer stops being plausible; above 20 even a fast
 * decoder starts missing frames, and the fountain then spends more frames
 * recovering them than the extra rate saved.
 */
export const DEFAULT_FPS = 10
export const FPS_CHOICES = [5, 10, 15, 20]

/**
 * Starts animating a file as QR frames.
 *
 * Resolves once the file has been read, compressed and framed -- which for a
 * megabyte is fast but not instant, and is why this is async: the caller has a
 * manifest to show (name, size, how much the compression won) before the first
 * frame is painted.
 *
 * @param {object} args
 * @param {FileSource} args.source
 * @param {number} [args.fps]
 * @param {(tick: { position: number, loops: number }) => void} [args.onTick]
 *   Called on each painted frame. `loops` is how many times the whole file has
 *   been shown, which is the only progress signal a sender has -- there is no
 *   back channel, so a sender genuinely cannot know how the receiver is doing
 *   except by looking at the other screen.
 * @returns {Promise<{
 *   canvas: HTMLCanvasElement,
 *   manifest: import('../core/beam.js').BeamManifest,
 *   frameCount: number,
 *   setFps: (fps: number) => void,
 *   stop: () => void,
 * }>}
 */
export async function startBeamSend({ source, fps = DEFAULT_FPS, onTick }) {
  const encoder = await createBeamEncoder({ source })

  const canvas = document.createElement('canvas')
  canvas.id = 'beam-canvas'
  canvas.className = 'beam-canvas'
  // The code is meaningless to a screen reader and changes ten times a second;
  // announcing it would be a stream of noise. The surrounding copy in view.js
  // is what carries the meaning.
  canvas.setAttribute('aria-hidden', 'true')

  let position = 0
  let interval = 1000 / fps
  let last = 0
  let raf = 0
  let stopped = false

  /**
   * Driven by requestAnimationFrame with a time gate rather than by
   * setInterval.
   *
   * setInterval would keep firing while the tab is in the background, where
   * nothing is painted and every frame it "shows" is one the receiver's camera
   * never saw -- so the sender would sit through a lap that transferred
   * nothing. rAF stops when the tab is hidden, which is the honest behaviour:
   * the animation genuinely is not happening. The time gate is what turns a
   * 60Hz callback into a 10fps repaint without drifting the way a naive
   * "repaint every 6th callback" would on a 90 or 120Hz display.
   *
   * @param {number} now
   */
  const tick = now => {
    if (stopped) return
    raf = requestAnimationFrame(tick)
    if (now - last < interval) return
    last = now

    renderQRToCanvas(encoder.frameAt(position), canvas)
    position++
    onTick?.({ position, loops: Math.floor(position / encoder.cycleLength) })
  }
  raf = requestAnimationFrame(tick)

  return {
    canvas,
    manifest: encoder.manifest,
    frameCount: encoder.frameCount,

    /** @param {number} next */
    setFps(next) {
      interval = 1000 / next
      // Reset the gate rather than leaving `last` where it was: raising the
      // rate should take effect on the next callback, not after the old,
      // longer interval has finished elapsing.
      last = 0
    },

    stop() {
      stopped = true
      cancelAnimationFrame(raf)
    },
  }
}

/**
 * Starts the camera and collects frames until the file is complete.
 *
 * The manifest callback fires as soon as the sender's manifest decodes, which
 * is within a second or two of pointing the camera -- deliberately, because
 * that is when the receiving UI must ask the user to accept. See the note on
 * the accept gesture in element.js: the click is the user activation that
 * permits showSaveFilePicker, and by the time the transfer finishes minutes
 * later there is no activation left to spend.
 *
 * @param {object} args
 * @param {HTMLVideoElement} args.video
 * @param {(manifest: import('../core/beam.js').BeamManifest) => void} args.onManifest
 * @param {(progress: { solved: number, blocks: number }) => void} args.onProgress
 * @param {(assemble: () => Promise<Bytes>) => void} args.onComplete
 * @param {(error: unknown) => void} args.onError
 * @returns {{ stop: () => void }}
 */
export function startBeamReceive({ video, onManifest, onProgress, onComplete, onError }) {
  const decoder = createBeamDecoder()
  const controller = new AbortController()

  let announced = false
  let finished = false

  scanQRStream({
    video,
    signal: controller.signal,
    onCode: value => {
      if (finished) return

      // A camera pointed at a laptop sees posters, wifi codes and the sender's
      // own pairing QR from a previous run. `offer` returns false for anything
      // it cannot use, and that is not worth reporting -- the user is holding
      // a phone at a screen, not debugging a parser.
      let used = false
      try {
        used = decoder.offer(value)
      } catch (error) {
        // A manifest this receiver cannot honour -- an unknown protocol
        // version, or gzip on a browser with no DecompressionStream -- throws
        // out of offer(). That is fatal and must be said now rather than
        // after four minutes of holding a phone steady, which is the entire
        // reason core/beam.js validates the manifest on arrival instead of at
        // assembly time.
        finished = true
        controller.abort()
        onError(error)
        return
      }
      if (!used) return

      const manifest = decoder.manifest
      if (manifest && !announced) {
        announced = true
        onManifest(manifest)
      }
      if (!manifest) return

      onProgress({ solved: decoder.solved, blocks: decoder.blocks })

      if (decoder.complete) {
        finished = true
        controller.abort()
        // The bytes are handed over as a thunk rather than assembled here.
        // assemble() inflates and verifies, and the caller is the only one
        // that knows whether the user has accepted yet -- a receiver that
        // declined should never pay for a decompression it is about to throw
        // away.
        onComplete(() => decoder.assemble())
      }
    },
  }).catch(error => {
    if (finished) return
    onError(error)
  })

  return {
    stop() {
      finished = true
      controller.abort()
    },
  }
}
