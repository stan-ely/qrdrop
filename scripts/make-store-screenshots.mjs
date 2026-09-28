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
 * Play accepts exactly 16:9 or 9:16 and nothing between. This used to shoot
 * 360x720 on the belief that 2:1 was the limit; the form refused it. So a
 * phone is 360x640 css px at 3x, 1080x1920 -- 360 wide for the reason
 * check-layout.mjs's VIEWPORTS gives, and a height check-layout.mjs measures
 * too. (This header once warned that beam-send broke at 360x640; that did not
 * reproduce, and the viewport joined check-layout's list instead.)
 *
 * The two tablet sets are landscape, since that is how a tablet on a stand is
 * held: 960x540 at 2x (1920x1080) for Play's 7-inch slot and 1280x720 at 2x
 * (2560x1440) for its 10-inch one, whose shorter side must be at least 1080.
 * Both land in the wide layout, and both are touch. fastlane names the
 * directories, so F-Droid shows them without being told. `hasTouch` for the reason
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
const IMAGES = path.join(ROOT, 'fastlane', 'metadata', 'android', 'en-US', 'images')

const DEVICES = [
  { dir: 'phoneScreenshots', width: 360, height: 640, scale: 3 },
  { dir: 'sevenInchScreenshots', width: 960, height: 540, scale: 2 },
  { dir: 'tenInchScreenshots', width: 1280, height: 720, scale: 2 },
]

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

const server = await serveStatic({ root: DIST, port: 0 })
const browser = await chromium.launch()

for (const device of DEVICES) {
  const outDir = path.join(IMAGES, device.dir)
  // Emptied first: a shot dropped from SHOTS must not linger in the listing.
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const context = await browser.newContext({
    colorScheme: 'light',
    deviceScaleFactor: device.scale,
    hasTouch: true,
    viewport: { width: device.width, height: device.height }
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
    const out = path.join(outDir, `${i + 1}-${shot.name}.png`)
    await page.screenshot({ path: out })
    console.log(path.relative(ROOT, out))
  }
  await context.close()
}

await browser.close()
await server.close()
