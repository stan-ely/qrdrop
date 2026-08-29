/**
 * Walks every screen at phone, tablet and laptop size and fails if anything
 * the user has to reach ends up outside the viewport.
 *
 *   npm run build && node scripts/check-layout.mjs
 *
 * WHY THIS EXISTS. A tester scanned a beam QR on a phone, saw the camera fill
 * the screen, and concluded the scan had failed. It had not: Accept was
 * several hundred pixels below the fold. Nothing in the repo could have caught
 * that. `npm test` has no coverage of src/web/view.js or vdom.js at all; the
 * e2e suite reads text and visibility, and an element pushed off the bottom of
 * a scrolling page is still visible by every definition Playwright uses;
 * make-screenshots.mjs photographed three of the eight screens at one 760x1200
 * viewport, and beam-receive was not one of them.
 *
 * So this asserts the two things a person actually experiences, at sizes a
 * person actually holds:
 *
 *   1. The page does not scroll. The app is meant to occupy exactly the
 *      viewport, with overflow living inside dialogs.
 *   2. Every button is inside the viewport. This is the one that matters. A
 *      primary action below the fold reads as a broken app, not as a page to
 *      scroll -- which is precisely how the bug above was experienced.
 *
 * It writes a picture of every failing combination next to the report, because
 * a rectangle is a far better bug report than a number, and CLAUDE.md's
 * standing note applies: if a screenshot comes out wrong, that is the finding.
 *
 * Hand-run and out of CI, for the same reason make-screenshots.mjs is:
 * downloading a browser is not acceptable in `npm run build` or
 * `prepublishOnly`.
 */

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { serveStatic } from '../src/node/serve.js'
import { FIXTURES, LINK, installState } from './screen-states.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'site', 'dist')
const OUT = path.join(ROOT, 'docs', 'screenshots', 'layout')

const QRCODE = path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')

/**
 * Three real devices rather than three round numbers.
 *
 * The phone is an iPhone 14/15 in CSS pixels, minus nothing: 844 is the tall
 * figure, and a real browser gives the page less than that once the URL bar is
 * drawn. If a screen only fits at 844 it does not fit. The laptop is
 * deliberately short rather than wide -- 1440x900 minus browser chrome is the
 * wide-and-short case that a design tuned on a phone forgets, and the one the
 * beam screen's two-column layout exists for.
 */
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'laptop', width: 1440, height: 900 },
]

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

// 127.0.0.1 rather than a file:// URL: the component refuses to run outside a
// secure context (see connectedCallback), and loopback is one -- the same
// property `qrdrop web` relies on.
const server = await serveStatic({ root: DIST, port: 0 })
const browser = await chromium.launch()

/** @type {string[]} */
const failures = []

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  })
  const page = await context.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => customElements.get('qr-drop') !== undefined)

  // Same routing trick as make-screenshots.mjs, and for the same reason: the
  // page's own CSP is script-src 'self', so an injected inline tag is refused.
  // That refusal is the CSP working and is worth leaving intact.
  await page.route('**/qrcode-generator.js', async route => {
    await route.fulfill({ path: QRCODE, contentType: 'text/javascript' })
  })
  await page.addScriptTag({ url: '/qrcode-generator.js' })

  for (const fixture of FIXTURES) {
    await page.evaluate(installState, { state: fixture.state, link: LINK })

    // One frame, so layout has settled before anything is measured. The
    // component renders synchronously inside _setState, but style and layout
    // are the browser's business and have not necessarily run yet.
    await page.evaluate(() => new Promise(requestAnimationFrame))

    const report = await page.evaluate(() => {
      const el = /** @type {any} */ (document.querySelector('qr-drop'))
      const root = /** @type {ShadowRoot} */ (el.shadowRoot)
      const screen = root.querySelector('section[id^="screen-"]:not([hidden])')

      // Buttons only, and only the ones on the live screen. The hidden
      // screens are still in the DOM -- `screen()` renders all eight and
      // hides seven -- and a hidden section's buttons have no useful box.
      const buttons = screen ? [...screen.querySelectorAll('button')] : []

      return {
        pageOverflow: document.documentElement.scrollHeight - window.innerHeight,
        offscreen: buttons
          .map(b => ({ label: (b.textContent || '').trim().slice(0, 40), box: b.getBoundingClientRect() }))
          // A tolerance of 1px, not 0: subpixel layout routinely puts an
          // element's bottom edge a fraction past the viewport, and failing on
          // that would make this report noise rather than signal.
          .filter(b => b.box.bottom > window.innerHeight + 1 || b.box.top < -1)
          .map(b => `${b.label} (bottom ${Math.round(b.box.bottom)} > ${window.innerHeight})`),
      }
    })

    const id = `${fixture.name}.${vp.name}`
    const problems = []
    if (report.pageOverflow > 1) problems.push(`page scrolls by ${report.pageOverflow}px`)
    for (const b of report.offscreen) problems.push(`button out of view: ${b}`)

    if (problems.length === 0) {
      console.log(`  ok    ${id}`)
      continue
    }

    // The picture is of the viewport, not the full page: the point is to show
    // what the person holding the device can actually see, which is exactly
    // what a full-page capture would hide by stretching to fit the content.
    const shot = path.join(OUT, `${id}.png`)
    await page.screenshot({ path: shot })
    console.log(`  FAIL  ${id}`)
    for (const p of problems) console.log(`          ${p}`)
    failures.push(`${id}: ${problems.join('; ')}`)
  }

  await context.close()
}

await browser.close()
await server.close()

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} failing combination(s); pictures in ${path.relative(ROOT, OUT)}`)
  process.exitCode = 1
} else {
  console.log('every screen fits its viewport at every size.')
}
