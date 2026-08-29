/**
 * Renders site/og.png, the 1200x630 social-preview card.
 *
 * WHY THIS IS A SEPARATE, HAND-RUN SCRIPT and not a step in
 * scripts/build-site.mjs: it needs a headless browser. `npm run build` runs
 * in CI, in the Pages deploy, and inside `prepublishOnly`, and none of those
 * should have to download Chromium to produce an image whose content changes
 * about never. The output is committed instead, and build-site.mjs simply
 * copies it into site/dist/. Run this by hand when the wordmark, palette, or
 * card copy changes:
 *
 *   node scripts/make-og.mjs
 *
 * playwright is already a devDependency (the e2e suites drive real browsers
 * with it), so this adds nothing to the install.
 *
 * The card is drawn from the same design tokens as the site and the
 * component -- `tokensCSS(':root')` from src/web/tokens.js -- rather than
 * from hex values typed in here. A preview card that has quietly drifted
 * away from the palette of the page it previews is the exact failure that
 * one-source-of-truth rule exists to prevent, and it is a failure nobody
 * notices, because the card is only ever seen somewhere else.
 *
 * The QR on the card is a real, scannable code for the site's own URL, made
 * with the same qrcode-generator the app itself uses. A decorative fake would
 * have been easier and is a small lie in a preview for a tool that asks to be
 * trusted; this one actually goes where it says it goes. It is generated at
 * the highest error correction ('H') rather than the app's 'M', because a
 * social card gets cropped, overlaid and rescaled by a dozen clients that
 * were never asked, and the redundancy is free here -- there is no frame rate
 * to hold and no capacity to save.
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import qrcode from 'qrcode-generator'
import { chromium } from 'playwright'

import { tokensCSS } from '../src/web/tokens.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'site', 'og.png')

const ORIGIN = 'https://share.stan-ely.com'
const WIDTH = 1200
const HEIGHT = 630

/**
 * @param {string} text
 * @returns {string}
 */
function qrSVG(text) {
  const qr = qrcode(0, 'H')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true })
}

// Light theme only, and forced: tokensCSS emits its dark palette inside a
// `prefers-color-scheme: dark` query, and a headless Chromium that happens to
// report dark would otherwise produce a card that does not match what the
// overwhelming majority of link previews are rendered against. The colour
// scheme is pinned on the page below rather than by deleting the dark block,
// so the tokens stay the single unedited source they are everywhere else.
const html = `
<!doctype html>
<meta charset="utf-8">
<style>
  ${tokensCSS(':root')}
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    display: flex;
    align-items: center;
    gap: 72px;
    padding: 0 88px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
  .copy { flex: 1 1 auto; }
  h1 {
    font-size: 104px;
    line-height: var(--lh-tight);
    letter-spacing: -0.04em;
    font-weight: 700;
  }
  h1 span { color: var(--accent); }
  p {
    margin-top: 28px;
    max-width: 20ch;
    font-size: 38px;
    line-height: 1.35;
    color: var(--muted);
  }
  .rule {
    margin-top: 40px;
    width: 220px;
    height: 6px;
    border-radius: var(--r-full);
    background: var(--accent);
  }
  /* The QR sits on --qr-quiet-zone, not --surface: that token exists
   * precisely because a scanner needs a white quiet zone whatever the page
   * around it is doing, and this code is meant to be scannable off someone
   * else's screen. */
  .qr {
    flex: none;
    width: 340px;
    height: 340px;
    padding: 22px;
    border-radius: var(--r-lg);
    background: var(--qr-quiet-zone);
    box-shadow: var(--shadow-2);
  }
  .qr svg { display: block; width: 100%; height: 100%; }
</style>
<div class="copy">
  <h1>qr<span>drop</span></h1>
  <p>Scan a code, send a file, device to device.</p>
  <div class="rule"></div>
</div>
<div class="qr">${qrSVG(ORIGIN)}</div>
`

const browser = await chromium.launch()
try {
  // deviceScaleFactor 1 with the viewport already at the card's true pixel
  // size: OG images are specified in real pixels, and rendering at 2x then
  // letting a crawler downscale is both larger on the wire and softer than
  // rendering at the size the tags declare.
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  await page.setContent(html, { waitUntil: 'load' })
  const png = await page.screenshot({ type: 'png' })
  await writeFile(OUT, png)
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${WIDTH}x${HEIGHT}, ${(png.length / 1024).toFixed(1)} kB)`)
} finally {
  await browser.close()
}
