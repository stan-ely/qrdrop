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
 * records that driving `_setState` from Playwright is how the
 * adopted-stylesheet bug was found, because the e2e suite reads text and
 * visibility and never looks at paint. This script exists to produce
 * artefacts.
 *
 * It does NOT look at every screen, and must not be mistaken for the thing
 * that does. It photographs the three the README leads with, at one width
 * chosen to suit a README. Whether a screen fits the device it is held on is
 * scripts/check-layout.mjs's job -- a separate script because these are
 * separate questions, and conflating them is how beam-receive went unphoto-
 * graphed at any size until a tester hit the bug by hand.
 *
 * WHY THE STATE IS INJECTED rather than reached by using the app: every
 * screen worth photographing is downstream of a real peer on a real relay.
 * Photographing them for real would make an image generator depend on public
 * infrastructure and a second device. `_setState` is the same door the
 * component's own event handlers go through, so what is drawn here is what a
 * real transfer draws. The states themselves live in scripts/screen-states.mjs,
 * shared with the layout check so the two cannot drift.
 *
 * The QR codes drawn below are real and scannable, from a constant stand-in
 * code -- see CODE in that module, which explains why it is a constant and why
 * a screenshot of it leaks nothing.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { serveStatic } from '../src/node/serve.js'
import { FIXTURES, README_SHOTS, LINK, installState } from './screen-states.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'site', 'dist')
const OUT = path.join(ROOT, 'docs', 'screenshots')

// The component is a card in a 34rem column; 760 css px is that column plus
// air on both sides, and lands inside the width GitHub gives a README image.
const WIDTH = 760
const SCALE = 2

const QRCODE = path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')

const shots = FIXTURES.filter(f => README_SHOTS.includes(f.name))

await mkdir(OUT, { recursive: true })

// 127.0.0.1 rather than a file:// URL: the component refuses to run outside a
// secure context (see connectedCallback), and loopback is one -- the same
// property `qrdrop web` relies on.
const server = await serveStatic({ root: DIST, port: 0 })
const browser = await chromium.launch()

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  const context = await browser.newContext({
    colorScheme: scheme,
    deviceScaleFactor: SCALE,
    viewport: { width: WIDTH, height: 1200 }
  })
  const page = await context.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => customElements.get('qr-drop') !== undefined)

  // qrcode-generator's UMD build, from node_modules, for the QR builders in
  // screen-states.mjs to call. It is routed in as a same-origin URL rather than injected with
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
    await page.evaluate(installState, { state: shot.state, link: LINK })

    const card = page.locator(`#screen-${shot.screen}`)
    const out = path.join(OUT, `${shot.name}.${scheme}.png`)
    await card.screenshot({ path: out })
    console.log(path.relative(ROOT, out))
  }

  await context.close()
}

await browser.close()
await server.close()
