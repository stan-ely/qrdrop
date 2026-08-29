/**
 * Renders docs/diagrams/*.mmd to committed PNGs, one pair per diagram.
 *
 * WHY THIS IS A SEPARATE, HAND-RUN SCRIPT, and not a step in
 * scripts/build-site.mjs: the same reasoning as scripts/make-og.mjs, whose
 * header explains it at length. It needs a headless browser, `npm run build`
 * runs in CI and inside `prepublishOnly`, and neither should download
 * Chromium to redraw pictures that change about never. Run it by hand when a
 * .mmd or the palette changes:
 *
 *   node scripts/make-diagrams.mjs
 *
 * WHY PNGS AT ALL, when GitHub renders a ```mermaid fence natively and the
 * fence is obviously the tidier thing to keep in the README: npmjs.com does
 * not. The README is also the npm package page, and a reader there was being
 * shown fifteen lines of raw `sequenceDiagram` source where a diagram should
 * be. An image renders in both places.
 *
 * WHY PNG AND NOT SVG, which would be sharper and a tenth the size: npm
 * rewrites a README's relative image paths to raw.githubusercontent.com, and
 * that host serves .svg as text/plain. An <img> pointing at an SVG therefore
 * works on GitHub, where the repo serves it, and is a broken image icon on
 * npm -- the one platform this script exists to fix. site/og.png is a PNG for
 * a related reason.
 *
 * WHY THE .mmd FILES ARE THE SOURCE and the README holds only <picture>: two
 * copies of a diagram, one rendered and one in a fence, is the same drift the
 * token and connect-src comments elsewhere in this repo already argue against.
 * The fence was removed rather than kept alongside.
 *
 * Colours come from `tokensCSS(':root')` (src/web/tokens.js) read back out of
 * the page, rather than from hex values typed in here -- a diagram that has
 * quietly drifted from the palette of the thing it describes is the exact
 * failure that one-source-of-truth rule exists to prevent. The dark values
 * live behind `@media (prefers-color-scheme: dark)` in that file, so the
 * variant is produced by asking the browser for that scheme and reading the
 * computed values back, not by parsing the stylesheet here.
 *
 * mermaid is loaded from node_modules, not from a CDN. A generator that
 * reaches the internet is a generator that fails on a plane, and it is a
 * devDependency, so it ships to nobody -- the "no new runtime dependencies"
 * position in src/cli.js's header is about what a user installs.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { tokensCSS } from '../src/web/tokens.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIAGRAMS = path.join(ROOT, 'docs', 'diagrams')
const MERMAID = path.join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')

/**
 * The width the page is laid out at. GitHub renders a README image into a
 * column about 850 px wide and scales anything larger down, so a diagram
 * drawn much wider than this arrives with unreadable labels. Rendered at
 * deviceScaleFactor 2 for the same reason a favicon is: the reader may be on
 * a retina display, and an upscaled diagram looks like a screenshot of a
 * screenshot.
 */
const WIDTH = 900
const SCALE = 2

/**
 * Pulls the token values mermaid needs out of a live page, so the palette is
 * read from tokens.js rather than restated here. Runs once per colour scheme.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Record<string, string>>}
 */
async function readTokens(page) {
  return page.evaluate(() => {
    const s = getComputedStyle(document.documentElement)
    /** @type {Record<string, string>} */
    const out = {}
    for (const name of ['bg', 'surface', 'surface-raised', 'text', 'muted', 'line', 'line-strong', 'accent', 'accent-soft', 'font-sans']) {
      out[name] = s.getPropertyValue('--' + name).trim()
    }
    return out
  })
}

/**
 * @param {Record<string, string>} t
 * @returns {Record<string, string>}
 */
function themeVariables(t) {
  // Mermaid's variable names are its own and do not map cleanly onto ours, so
  // this is the one place a translation table is unavoidable. Every value on
  // the right is a token; nothing is a literal.
  return {
    background: t.bg,
    primaryColor: t['surface-raised'],
    primaryTextColor: t.text,
    primaryBorderColor: t['line-strong'],
    secondaryColor: t.surface,
    tertiaryColor: t.bg,
    lineColor: t['line-strong'],
    textColor: t.text,
    fontFamily: t['font-sans'],
    fontSize: '15px',

    // Sequence diagrams name almost everything separately from the flowchart
    // palette above, and default to a yellow note and a black actor box that
    // belong to no scheme this project uses.
    actorBkg: t['surface-raised'],
    actorBorder: t['line-strong'],
    actorTextColor: t.text,
    actorLineColor: t.line,
    signalColor: t.text,
    signalTextColor: t.text,
    labelBoxBkgColor: t.surface,
    labelBoxBorderColor: t.line,
    labelTextColor: t.text,
    loopTextColor: t.muted,
    noteBkgColor: t['accent-soft'],
    noteBorderColor: t.accent,
    noteTextColor: t.text,
    sequenceNumberColor: t.bg,
    activationBkgColor: t.accent,

    // A flowchart subgraph defaults to a fill mermaid derives by darkening,
    // which in dark mode lands blacker than --bg and reads as a hole in the
    // page rather than as a grouping.
    clusterBkg: t.surface,
    clusterBorder: t['line-strong']
  }
}

const browser = await chromium.launch()
const sources = (await readdir(DIAGRAMS)).filter(f => f.endsWith('.mmd')).sort()
if (sources.length === 0) throw new Error(`no .mmd files in ${DIAGRAMS}`)

const mermaidJS = await readFile(MERMAID, 'utf8')

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  const context = await browser.newContext({
    colorScheme: scheme,
    deviceScaleFactor: SCALE,
    viewport: { width: WIDTH, height: 600 }
  })
  const page = await context.newPage()

  // about:blank rather than a file:// URL or a served page: nothing here is
  // fetched, so there is no origin to need. The mermaid bundle is injected as
  // content for the same reason -- addScriptTag({ url }) would be a network
  // call for a file already on disk.
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
${tokensCSS(':root')}
  html, body { margin: 0; background: var(--bg); }
  #wrap { display: inline-block; padding: 24px 28px; background: var(--bg); }
  #wrap svg { display: block; }
</style><div id="wrap"></div>`)
  await page.addScriptTag({ content: mermaidJS })

  const tokens = await readTokens(page)

  for (const file of sources) {
    const name = path.basename(file, '.mmd')
    const src = await readFile(path.join(DIAGRAMS, file), 'utf8')

    const ok = await page.evaluate(async ({ src, vars }) => {
      const mermaid = /** @type {any} */ (window).mermaid
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: vars,
        securityLevel: 'strict',
        // wrap: true is doing real work, not cosmetics. A sequence note is
        // sized to the span between the actors it covers, and does NOT grow
        // to fit its text -- a line a few characters too long simply prints
        // outside the box, over the lifelines. Wrapping makes the .mmd files
        // safe to edit without measuring; the explicit <br/> in them are
        // chosen line breaks, and wrapping only ever adds more.
        // actorMargin is widened from the default 50 because wrap applies to
        // message labels too: at the default spacing a label a shade wider
        // than its own arrow broke, stranding one word on a second line. The
        // extra width costs nothing -- these render well inside the column
        // GitHub gives a README image.
        sequence: { useMaxWidth: false, wrap: true, actorMargin: 110 },
        // rankSpacing is pulled in from the default 50: edges entering the
        // subgraph from outside push the ranks inside it apart, and the
        // untightened default left a hand's width of nothing between the two
        // boxes that are meant to read as one layer.
        flowchart: { useMaxWidth: false, htmlLabels: true, rankSpacing: 36, nodeSpacing: 40 }
      })
      // parse() first so a syntax error is reported as a syntax error rather
      // than as a mermaid error card silently written out as a PNG -- the
      // whole point of generating these is that a broken one must not ship.
      await mermaid.parse(src)
      const { svg } = await mermaid.render('d' + Math.random().toString(36).slice(2), src)
      const wrap = document.querySelector('#wrap')
      if (!wrap) throw new Error('no #wrap')
      wrap.innerHTML = svg
      return true
    }, { src, vars: themeVariables(tokens) })
    if (!ok) throw new Error(`render returned nothing for ${file}`)

    const wrap = page.locator('#wrap')
    const out = path.join(DIAGRAMS, `${name}.${scheme}.png`)
    await wrap.screenshot({ path: out })
    const { width, height } = /** @type {{width: number, height: number}} */ (await wrap.boundingBox())
    console.log(`${path.relative(ROOT, out)}  ${Math.round(width)}x${Math.round(height)} css px`)
  }

  await context.close()
}

await browser.close()
