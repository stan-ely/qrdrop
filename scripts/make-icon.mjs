/**
 * Renders the app mark: app/src-tauri/icons/source.png (1024x1024, the input
 * `tauri icon` fans out from) and site/favicon.png (512x512, which the site
 * had none of at all).
 *
 * WHY THIS IS A SEPARATE, HAND-RUN SCRIPT, same as scripts/make-og.mjs beside
 * it: it needs a headless browser, and `npm run build` runs in CI, in the
 * Pages deploy and inside `prepublishOnly`, none of which should download
 * Chromium. The output is committed. Run it when the palette or the mark
 * changes:
 *
 *   node scripts/make-icon.mjs        # or: mise run img:icon
 *
 * Rendering it and then running `npx tauri icon app/src-tauri/icons/source.png`
 * are two steps on purpose -- the second one writes into app/src-tauri/gen/,
 * which is committed source, so it wants a diff read by a person rather than
 * a chained command.
 *
 * THE MARK is the three finder patterns of a QR code: the big squares in the
 * corners a scanner uses to locate and orient a code. Two reasons it is that
 * and not the wordmark. The wordmark is pure CSS type (see make-og.mjs) with
 * no logo file behind it, and type at the 48px an Android launcher actually
 * draws is mud. And the finder patterns are the one part of a QR code that
 * survives being shrunk -- they are three shapes, not a field of modules,
 * which is exactly why a scanner looks for them first.
 *
 * It is deliberately NOT a real, scannable code. make-og.mjs puts a genuine
 * one on the social card and says why a decorative fake would be a small lie;
 * that reasoning is about something *claiming* to be scannable. Three finder
 * eyes claim nothing, and a real code at icon size is a grey square.
 *
 * Colours come from tokensCSS(':root') in src/web/tokens.js rather than hex
 * typed in here, for the reason the whole repo keeps repeating: the icon this
 * replaces was an indigo placeholder that had drifted from a terracotta brand
 * with nobody noticing, because an app icon is only ever seen away from the
 * site it belongs to. Accent GROUND with quiet-zone marks, not the reverse: a
 * launcher icon supplies its own background against an unknown wallpaper, and
 * a near-white tile disappears into a light one.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { tokensCSS } from '../src/web/tokens.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// 1024 is what `tauri icon` wants as a source: it downsamples to every
// platform size from here, and asking it to upsample instead produces soft
// edges on exactly the large macOS and Play-listing sizes nobody checks.
const SIZE = 1024

// The mark occupies the middle 47% and no more, and that number is arithmetic
// rather than taste. Full bleed would be fine for the legacy square icons,
// but `tauri icon` also emits this image as the Android adaptive-icon
// FOREGROUND, which the launcher masks to a shape it chooses -- a circle on
// most devices, keeping the central 72 of 108 dp, i.e. 66.7% of the width.
// The largest square that fits inside that circle is 0.667 / sqrt(2) = 47.1%
// of the canvas, and the mark is a square grid whose corners are the eyes
// themselves. 64% looked right and put the top-left eye's corner outside the
// circle on every round-icon launcher; the crop is invisible here and obvious
// on a phone.
const SAFE = 0.47

/**
 * The whole mark, at a given pixel size.
 *
 * Parameterised rather than rendered once at 1024 and downsampled, because
 * the favicon below is drawn at its own size. A border and two nested radii
 * resolve differently when the layout engine rounds them at 512 than when a
 * resampler averages them down from 1024, and the small one is the one people
 * see in a tab.
 *
 * A QR finder pattern is a 7x7 module block: a one-module ring, a one-module
 * gap, and a 3x3 solid centre. Drawing it from those ratios rather than from
 * numbers that look right keeps it recognisably the real shape at any size.
 *
 * @param {number} size
 * @returns {string}
 */
function markup(size) {
  const gap = Math.round(size * 0.072)
  const eye = Math.round((size * SAFE - gap) / 2)
  const ring = eye / 7
  const core = (eye * 3) / 7

  return `
<!doctype html>
<meta charset="utf-8">
<style>
  ${tokensCSS(':root')}
  /* Light, forced, for the same reason make-og.mjs forces it: tokensCSS puts
   * the dark palette behind a prefers-color-scheme query, and a headless
   * Chromium that reports dark would silently render a different icon. The
   * scheme is pinned here rather than by editing the tokens. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${size}px;
    height: ${size}px;
    display: grid;
    place-items: center;
    background: var(--accent);
  }
  .mark {
    display: grid;
    grid-template-columns: repeat(2, ${eye}px);
    grid-template-rows: repeat(2, ${eye}px);
    gap: ${gap}px;
  }
  /* Top-left, top-right, bottom-left: the three corners a QR code puts them
   * in. The empty fourth cell is the point -- an eye there would read as a
   * generic grid of squares, and the asymmetry is what says "QR". */
  .eye {
    border: ${ring}px solid var(--qr-quiet-zone);
    border-radius: ${eye * 0.24}px;
    display: grid;
    place-items: center;
  }
  .eye:nth-child(3) { grid-column: 1; grid-row: 2; }
  .eye::after {
    content: '';
    width: ${core}px;
    height: ${core}px;
    border-radius: ${core * 0.24}px;
    background: var(--qr-quiet-zone);
  }
</style>
<div class="mark">
  <div class="eye"></div>
  <div class="eye"></div>
  <div class="eye"></div>
</div>
`
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  await page.setContent(markup(SIZE), { waitUntil: 'load' })

  const source = path.join(ROOT, 'app', 'src-tauri', 'icons', 'source.png')
  const full = await page.screenshot({ type: 'png' })
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, full)
  console.log(`Wrote ${path.relative(ROOT, source)} (${SIZE}x${SIZE}, ${(full.length / 1024).toFixed(1)} kB)`)

  // Drawn at its own size rather than downsampled -- see markup() above.
  const FAV = 512
  await page.setViewportSize({ width: FAV, height: FAV })
  await page.setContent(markup(FAV), { waitUntil: 'load' })
  const favicon = path.join(ROOT, 'site', 'favicon.png')
  const small = await page.screenshot({ type: 'png' })
  await writeFile(favicon, small)
  console.log(`Wrote ${path.relative(ROOT, favicon)} (${FAV}x${FAV}, ${(small.length / 1024).toFixed(1)} kB)`)

  /*
   * The web manifest's small icon. 512 is already covered by favicon.png
   * above -- the manifest points at that same file rather than at a second
   * copy of the same pixels, so only the size that does not exist yet is
   * drawn here.
   *
   * NO SEPARATE MASKABLE RENDER, and that is the SAFE constant's doing
   * rather than an omission. A maskable icon has to keep its content inside
   * a circle of 80% diameter, because the launcher may crop to any shape
   * within that; this mark already occupies the middle 47% for the stricter
   * Android adaptive-icon reason documented at the top of this file.
   * Anything that survives a 66.7% mask survives an 80% one with room to
   * spare, so both PNGs are declared "any maskable" in the manifest and one
   * image serves both purposes.
   *
   * If SAFE is ever raised past ~0.8 that stops being true and the manifest
   * has to go back to declaring a separate maskable variant. The adaptive
   * icon would have broken first, which is the louder failure.
   */
  const SMALL = 192
  await page.setViewportSize({ width: SMALL, height: SMALL })
  await page.setContent(markup(SMALL), { waitUntil: 'load' })
  const icon192 = path.join(ROOT, 'site', 'icon-192.png')
  const tiny = await page.screenshot({ type: 'png' })
  await writeFile(icon192, tiny)
  console.log(`Wrote ${path.relative(ROOT, icon192)} (${SMALL}x${SMALL}, ${(tiny.length / 1024).toFixed(1)} kB)`)

  console.log('\nNext: npx tauri icon app/src-tauri/icons/source.png -- and READ the diff.')
  console.log('It writes into app/src-tauri/gen/, which is committed source.')
} finally {
  await browser.close()
}
