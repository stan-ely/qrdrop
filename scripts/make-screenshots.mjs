/**
 * Renders docs/screenshots/*.png -- the pictures of the actual UI that the
 * README leads with.
 *
 * Hand-run, for the reasons scripts/make-og.mjs sets out at length: it needs
 * a browser, and `npm run build` runs in CI and in `prepublishOnly` where
 * downloading one is not acceptable. Rebuild the site first, then run this:
 *
 *   npm run build && node scripts/make-screenshots.mjs
 *
 * WHY THIS IS NOT A TEST, though it drives the same machinery: CLAUDE.md
 * records that driving `_setState` from Playwright across every screen is how
 * the adopted-stylesheet bug was found, because the e2e suite reads text and
 * visibility and never looks at paint. This script exists to produce
 * artefacts, but running it is also the cheapest look at every screen at
 * once -- if a screenshot comes out wrong, that is the finding, not a
 * nuisance.
 *
 * WHY THE STATE IS INJECTED rather than reached by using the app: every
 * screen worth photographing is downstream of a real peer on a real relay.
 * Photographing them for real would make an image generator depend on public
 * infrastructure and a second device. `_setState` is the same door the
 * component's own event handlers go through, so what is drawn here is what a
 * real transfer draws.
 *
 * The QR codes drawn below are real and scannable, from a constant stand-in
 * code -- see CODE, which explains why it is a constant and why a screenshot
 * of it leaks nothing.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { serveStatic } from '../src/node/serve.js'
import { SAS_EMOJI } from '../src/core/session.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'site', 'dist')
const OUT = path.join(ROOT, 'docs', 'screenshots')

// The component is a card in a 34rem column; 760 css px is that column plus
// air on both sides, and lands inside the width GitHub gives a README image.
const WIDTH = 760
const SCALE = 2

const QRCODE = path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')

// Fixed indices rather than random ones: a screenshot that changes every time
// it is regenerated makes a noisy diff out of a file nothing else touched.
const SAS = [4, 32, 35, 21].map(i => SAS_EMOJI[i])

/**
 * A stand-in pairing code: the real encoder's shape (43 base64url characters,
 * 32 bytes) but not a real secret, and deliberately a constant rather than a
 * fresh random one. A code regenerated on every run turns a file nothing else
 * touched into a noisy diff, and the picture is no more honest for it -- a
 * qrdrop secret is per-session and dead the moment the page closes, so the
 * one in a screenshot is inert either way.
 *
 * The QR drawn from it below is real and scannable. Do not swap it for a
 * decorative fake: a screenshot of a tool that asks to be trusted should show
 * the thing it actually draws, which is the same argument scripts/make-og.mjs
 * makes about the code on the social card.
 */
const CODE = 'QueCZnVwaHOHqoOYKx2i57Ws5miuBTLfG1rmjN7ysgG'

await mkdir(OUT, { recursive: true })

// 127.0.0.1 rather than a file:// URL: the component refuses to run outside a
// secure context (see connectedCallback), and loopback is one -- the same
// property `qrdrop web` relies on.
const server = await serveStatic({ root: DIST, port: 0 })
const browser = await chromium.launch()

const link = `https://share.stan-ely.com/#${CODE}`

/**
 * @typedef {object} Shot
 * @property {string} name
 * @property {Record<string, unknown>} state
 */

/** @type {Shot[]} */
const shots = [
  {
    name: 'send',
    state: {
      screen: 'send', role: 'sender', code: CODE, qrIsLink: true,
      file: { name: 'report.pdf', size: 2_384_912 },
      status: 'Waiting for the other device…', pairing: true
    }
  },
  {
    name: 'verify',
    state: {
      screen: 'verify', role: 'sender',
      // Four entries lifted from the real table rather than typed out here,
      // so a picture of the SAS cannot show a pairing the app could never
      // produce. `sas` is the emoji string the tiles decorate with; the words
      // beneath are the content, and are what a person reads aloud.
      sas: SAS.map(e => e[0]).join(' '),
      sasWords: SAS.map(e => e[1]),
      file: { name: 'report.pdf', size: 2_384_912 }
    }
  },
  {
    name: 'beam',
    state: {
      screen: 'beam-send', mode: 'beam', role: 'sender',
      file: { name: 'quarterly-notes.md', size: 184_320 },
      beam: { fps: 10, loops: 2, solved: 0, blocks: 0, eta: 31 }
    }
  }
]

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  const context = await browser.newContext({
    colorScheme: scheme,
    deviceScaleFactor: SCALE,
    viewport: { width: WIDTH, height: 1200 }
  })
  const page = await context.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => customElements.get('qr-drop') !== undefined)

  // qrcode-generator's UMD build, from node_modules. The two helpers below
  // mirror renderQR and renderQRToCanvas in src/web/qr.js rather than
  // importing them: those are ESM with a bare specifier, and the page is
  // serving a bundle that does not re-export them. The mirror is small and
  // its only job is to look right in a picture.
  //
  // It is routed in as a same-origin URL rather than injected with
  // addScriptTag({ path }), which the page's own CSP refuses -- script-src is
  // 'self' and an injected tag is inline. That refusal is the CSP working,
  // and it is worth leaving intact rather than launching the browser with it
  // disabled: these screenshots are of the page as shipped, and a script this
  // generator could inject is a script anything else could.
  await page.route('**/qrcode-generator.js', async route => {
    await route.fulfill({ path: QRCODE, contentType: 'text/javascript' })
  })
  await page.addScriptTag({ url: '/qrcode-generator.js' })

  for (const shot of shots) {
    await page.evaluate(({ state, link }) => {
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
        // is what scales one canvas pixel per module up to the stage, so a
        // canvas without it photographs at its intrinsic module size.
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
      // A beam frame in the middle of a run: opaque payload, which is what
      // one actually looks like.
      if (state.screen === 'beam-send') next.beamNode = canvasNode('qrb1:7f3a:' + 'Kx2i57Ws5miuBTLfG1rmjN7ysgGQueCZnVwaHOHqoOYK'.repeat(13))
      el._setState(next)
    }, { state: shot.state, link })

    const card = page.locator(`#screen-${shot.state.screen}`)
    const out = path.join(OUT, `${shot.name}.${scheme}.png`)
    await card.screenshot({ path: out })
    console.log(path.relative(ROOT, out))
  }

  await context.close()
}

await browser.close()
await server.close()
