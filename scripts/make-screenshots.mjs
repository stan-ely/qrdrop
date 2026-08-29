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

    // The card fills the viewport now -- that is the whole point of the layout
    // -- so a fixed 1200px-tall window photographs every screen with a column
    // of empty space in the middle of it, which is a picture of nothing. The
    // viewport is fitted to the shot instead: measure what this screen's
    // content actually wants, add back the chrome around the card, and resize
    // to that. Each README image then shows a card at its natural height,
    // while the app under it is still the real one, laid out by the real rules.
    //
    // Twice, because the fit changes the answer: the component tightens its
    // padding below a height threshold (the max-height query in styles.js), so
    // a size measured in the roomy regime is wrong once the resize lands in
    // the compact one, and the card stretches to fill the difference. The
    // second pass measures in the regime it will actually be photographed in.
    // Reset to the tall viewport first so the first pass always starts from
    // the same place regardless of what the previous shot left behind.
    await page.setViewportSize({ width: WIDTH, height: 1200 })
    for (let pass = 0; pass < 2; pass++) {
      await page.evaluate(() => new Promise(requestAnimationFrame))
      await page.setViewportSize({ width: WIDTH, height: await measure(page) })
    }

    const card = page.locator(`#screen-${shot.screen}`)
    const out = path.join(OUT, `${shot.name}.${scheme}.png`)
    await card.screenshot({ path: out })
    console.log(path.relative(ROOT, out))
  }

  await context.close()
}

await browser.close()
await server.close()

/**
 * The viewport height at which the live screen's card sits at its natural
 * size -- neither stretched by a window with room to spare nor compressed by
 * one without.
 *
 * @param {import('playwright').Page} page
 */
function measure(page) {
  return page.evaluate(() => {
    const el = /** @type {any} */ (document.querySelector('qr-drop'))
    const root = /** @type {ShadowRoot} */ (el.shadowRoot)
    const card = /** @type {HTMLElement} */ (
      root.querySelector('section[id^="screen-"]:not([hidden])'))
    const body = /** @type {HTMLElement} */ (card.querySelector('.card-body'))

    // Everything that is not the card: the page header, the footer, the step
    // rail, and the grid's gaps and padding. Measured before the card is
    // unpinned, while the layout is still the real one.
    const chrome = window.innerHeight - card.getBoundingClientRect().height

    // The card is measured with its stretch switched off, then switched back.
    //
    // scrollHeight was the obvious way to ask "how tall does this content want
    // to be" and it cannot answer here: scrollHeight is never less than
    // clientHeight, so on a box that has been STRETCHED to fill a tall window
    // it just reports the stretched height, and fitting the viewport to that
    // is a fixed point at whatever size the run started from. Releasing the
    // flex for one measurement is the only way to see the natural height, and
    // it is restored before the frame is ever painted.
    const cardFlex = card.style.flex
    const bodyFlex = body.style.flex
    card.style.flex = '0 0 auto'
    body.style.flex = '0 0 auto'
    const natural = card.getBoundingClientRect().height
    card.style.flex = cardFlex
    body.style.flex = bodyFlex

    return Math.ceil(natural + chrome)
  })
}
