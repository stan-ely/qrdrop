/**
 * The stand-in states every screen is photographed from, and the in-page
 * function that installs one.
 *
 * Two scripts drive the component this way and they must not drift apart:
 * scripts/make-screenshots.mjs photographs three of these for the README, and
 * scripts/check-layout.mjs walks all of them at three viewport sizes looking
 * for content pushed out of sight. When those kept private copies of the
 * fixtures, the README shots were the only ones anyone maintained -- which is
 * how `beam-receive` came to be the screen with a below-the-fold Accept button
 * and no picture of it anywhere. Same argument as src/web/tokens.js: one home,
 * because the second copy is the one that rots.
 *
 * The states are deltas, not whole states. `_setState` merges into the
 * component's own initial state (see element.js `_initialState`), so each
 * fixture names only what makes its screen the screen it is.
 */

import { SAS_EMOJI } from '../src/core/session.js'

/**
 * A stand-in pairing code: the real encoder's shape (43 base64url characters,
 * 32 bytes) but not a real secret, and deliberately a constant rather than a
 * fresh random one. A code regenerated on every run turns a file nothing else
 * touched into a noisy diff, and the picture is no more honest for it -- a
 * qrdrop secret is per-session and dead the moment the page closes, so the
 * one in a screenshot is inert either way.
 *
 * The QR drawn from it is real and scannable. Do not swap it for a decorative
 * fake: a screenshot of a tool that asks to be trusted should show the thing
 * it actually draws, which is the same argument scripts/make-og.mjs makes
 * about the code on the social card.
 */
export const CODE = 'QueCZnVwaHOHqoOYKx2i57Ws5miuBTLfG1rmjN7ysgG'

export const LINK = `https://share.stan-ely.com/#${CODE}`

// Fixed indices rather than random ones: a screenshot that changes every time
// it is regenerated makes a noisy diff out of a file nothing else touched.
const SAS = [4, 32, 35, 21].map(i => SAS_EMOJI[i])

const PDF = { name: 'report.pdf', size: 2_384_912 }
const NOTES = { name: 'quarterly-notes.md', size: 184_320 }

const DIGEST = 'b1946ac92492d2347c6235b4d2611184'

/**
 * `cameraAvailable` is forced true on every scanner screen rather than left to
 * the browser. Headless Chromium reports no camera, so the real value renders
 * the "no camera" fallback -- and the scanner frame, which is the single
 * tallest element in the app and the direct cause of the overflow these
 * pictures exist to catch, would never appear in one.
 *
 * @typedef {object} Fixture
 * @property {string} name
 * @property {string} screen         the `#screen-` id this fixture lands on
 * @property {Record<string, unknown>} state
 */

/** @type {Fixture[]} */
export const FIXTURES = [
  {
    name: 'choose',
    screen: 'choose',
    state: { screen: 'choose' },
  },
  {
    name: 'send',
    screen: 'send',
    state: {
      screen: 'send', role: 'sender', code: CODE, qrIsLink: true,
      file: PDF,
      status: 'Waiting for the other device…', pairing: true,
    },
  },
  {
    name: 'receive',
    screen: 'receive',
    state: {
      screen: 'receive', role: 'receiver', cameraAvailable: true,
      status: 'Point the camera at the code on the other device…',
    },
  },
  {
    name: 'verify',
    screen: 'verify',
    state: {
      screen: 'verify', role: 'sender',
      // Four entries lifted from the real table rather than typed out here,
      // so a picture of the SAS cannot show a pairing the app could never
      // produce. `sas` is the emoji string the tiles decorate with; the words
      // beneath are the content, and are what a person reads aloud.
      sas: SAS.map(e => e[0]).join(' '),
      sasWords: SAS.map(e => e[1]),
      file: PDF,
      // The path badge is part of this screen now, so the picture of it shows
      // one. 'local' rather than a metered path because the warning that comes
      // with those is size-triggered, and report.pdf is under the threshold --
      // a shot pairing a 2 MB file with a data-cost warning would be showing a
      // combination the app never produces.
      path: 'local',
    },
  },
  {
    // The receiver's half of verify, which the sender-side shot above never
    // reaches: this is the branch that renders Accept/Decline, and it is one
    // of only two screens in the app where a safety gesture can be pushed out
    // of view.
    name: 'verify-accept',
    screen: 'verify',
    state: {
      screen: 'verify', role: 'receiver',
      sas: SAS.map(e => e[0]).join(' '),
      sasWords: SAS.map(e => e[1]),
      offer: PDF,
      path: 'local',
    },
  },
  {
    name: 'transfer',
    screen: 'transfer',
    state: {
      screen: 'transfer', role: 'receiver',
      file: PDF, path: 'local',
      progress: { moved: 1_310_720, total: PDF.size },
      status: 'Receiving…',
    },
  },
  {
    name: 'done',
    screen: 'done',
    state: {
      screen: 'done', role: 'receiver', outcome: 'received',
      file: PDF, path: 'local', digest: DIGEST,
    },
  },
  {
    name: 'beam',
    screen: 'beam-send',
    state: {
      screen: 'beam-send', mode: 'beam', role: 'sender',
      file: NOTES,
      beam: { fps: 10, loops: 2, solved: 0, blocks: 0, eta: 31 },
    },
  },
  {
    // The screen this whole sweep was written for. `offer` set is what puts it
    // on the Accept branch -- the manifest has decoded, the camera is still
    // running, and the button whose click is the user activation
    // showSaveFilePicker will spend is on screen. If it is not visible in this
    // picture, that is the bug.
    name: 'beam-receive',
    screen: 'beam-receive',
    state: {
      screen: 'beam-receive', mode: 'beam', role: 'receiver',
      cameraAvailable: true,
      offer: NOTES,
      beam: { fps: 10, loops: 1, solved: 41, blocks: 190, eta: 74 },
    },
  },
]

/** The three fixtures the README leads with, by name. */
export const README_SHOTS = ['send', 'verify', 'beam']

/**
 * Installs one fixture, running **inside the page**.
 *
 * Passed to `page.evaluate`, which serialises it, so it must close over
 * nothing from this module -- everything it needs arrives as its argument or
 * off `window`. The two QR builders mirror renderQR and renderQRToCanvas in
 * src/web/qr.js rather than importing them: those are ESM with a bare
 * specifier, and the page is serving a bundle that does not re-export them.
 * The mirror is small and its only job is to look right in a picture.
 *
 * @param {{ state: Record<string, unknown>, link: string }} arg
 */
export function installState({ state, link }) {
  const el = /** @type {any} */ (document.querySelector('qr-drop'))
  if (!el) throw new Error('no <qr-drop> on the page')
  const qrcode = /** @type {any} */ (window).qrcode

  /** @param {string} text */
  const svgNode = (text) => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const t = document.createElement('template')
    t.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true })
    return t.content.firstElementChild
  }

  /** @param {string} text */
  const canvasNode = (text) => {
    const qr = qrcode(0, 'L')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    const margin = 2
    const size = count + margin * 2
    const canvas = document.createElement('canvas')
    // The id and class the real player sets (src/web/beam.js): .beam-canvas
    // is what scales one canvas pixel per module up to the stage, so a canvas
    // without it photographs at its intrinsic module size.
    canvas.id = 'beam-canvas'
    canvas.className = 'beam-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#000'
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) ctx.fillRect(col + margin, row + margin, 1, 1)
      }
    }
    return canvas
  }

  const next = { ...state }
  if (state.screen === 'send') next.qrNode = svgNode(link)
  // A beam frame in the middle of a run: opaque payload, which is what one
  // actually looks like.
  if (state.screen === 'beam-send') {
    next.beamNode = canvasNode('qrb1:7f3a:' + 'Kx2i57Ws5miuBTLfG1rmjN7ysgGQueCZnVwaHOHqoOYK'.repeat(13))
  }
  el._setState(next)
}
