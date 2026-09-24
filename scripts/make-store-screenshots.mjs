/**
 * Renders the phone screenshots for the Android store listings, into
 * fastlane/metadata/android/en-US/images/phoneScreenshots/ -- the one place
 * Google Play, f-droid.org and this project's own F-Droid repository all read
 * them from (see the header of fdroid/config.yml, and CLAUDE.md "Google Play").
 *
 * Hand-run, for the reason every image generator here is: it needs a browser.
 * Build the app channel first, since that is what the listing is selling:
 *
 *   mise run app:build-site && node scripts/make-store-screenshots.mjs
 *
 * A separate script from make-screenshots.mjs rather than a flag on it,
 * because that one's header is a promise -- the README's three pictures and
 * only those -- and the two answer different questions at different sizes. A
 * README picture is a card cropped to its content; a store screenshot is the
 * whole phone screen, page chrome and all, because that is what someone who
 * installs it will be holding. Both install their states from the same
 * fixtures in scripts/screen-states.mjs, so a screen changed once is changed
 * in both.
 *
 * 360x720 css px at 3x is 1080x2160: exactly the 2:1 Play allows on the long
 * side -- the more familiar 412x915 of a modern phone is 2.22:1 and would be
 * refused at upload. 360 wide for the reason check-layout.mjs's VIEWPORTS
 * gives. Not 360x640: at that height beam-send's QR is laid out above the
 * card, over the page header -- a real layout failure on a 16:9 phone that
 * check-layout.mjs does not yet measure, and not something to sell in a
 * listing. `hasTouch` for the reason
 * check-layout.mjs gives: without it the `pointer: coarse` rules are never
 * laid out, and this would photograph the mouse layout on a phone-shaped page.
 * Light mode only, deliberately, whatever the OS is set to.
 */

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { serveStatic } from '../src/node/serve.js'
import { FIXTURES, LINK, installState } from './screen-states.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, process.argv[2] ?? path.join('app', 'dist'))
const OUT = path.join(ROOT, 'fastlane', 'metadata', 'android', 'en-US', 'images', 'phoneScreenshots')

const QRCODE = path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')

// In the order a listing should tell it: what you see, pairing, the check that
// makes it safe, the file arriving, and the mode that needs no network. The
// number prefix is the order -- Play and F-Droid both sort by filename.
const SHOTS = ['choose', 'send', 'verify', 'done', 'beam']

const shots = SHOTS.map(name => {
  const fixture = FIXTURES.find(f => f.name === name)
  if (!fixture) throw new Error(`no fixture named ${name} in scripts/screen-states.mjs`)
  return fixture
})

// Emptied first: a shot dropped from SHOTS must not linger in the listing.
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const server = await serveStatic({ root: DIST, port: 0 })
const browser = await chromium.launch()
const context = await browser.newContext({
  colorScheme: 'light',
  deviceScaleFactor: 3,
  hasTouch: true,
  viewport: { width: 360, height: 720 }
})
const page = await context.newPage()
await page.goto(server.url)
await page.waitForFunction(() => customElements.get('qr-drop') !== undefined)

// Same-origin rather than injected inline, for the CSP reason make-screenshots.mjs gives.
await page.route('**/qrcode-generator.js', async route => {
  await route.fulfill({ path: QRCODE, contentType: 'text/javascript' })
})
await page.addScriptTag({ url: '/qrcode-generator.js' })

for (const [i, shot] of shots.entries()) {
  await page.evaluate(installState, { state: shot.state, link: LINK })
  // Wait out the screen transition. make-screenshots.mjs never had to, because
  // its two measure-and-resize passes happen to take longer than the
  // animation; photographed straight after the state lands, every screen came
  // out half-faded with the previous one's QR still sliding over the header.
  // The animations are in the shadow root, which document.getAnimations()
  // does not reach, so each root is asked for its own. Infinite ones -- a
  // spinner, a pulsing scanner frame -- are skipped: their `finished` never
  // settles, and waiting on it hung the first run of this script for good.
  await page.evaluate(async () => {
    const el = /** @type {any} */ (document.querySelector('qr-drop'))
    const roots = [document, el.shadowRoot]
    await new Promise(requestAnimationFrame)
    const finite = roots.flatMap(r => r.getAnimations())
      .filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
    await Promise.all(finite.map(a => a.finished.catch(() => {})))
  })
  const out = path.join(OUT, `${i + 1}-${shot.name}.png`)
  await page.screenshot({ path: out })
  console.log(path.relative(ROOT, out))
}

await browser.close()
await server.close()
