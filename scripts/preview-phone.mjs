/**
 * Open the UI in a browser with a phone-sized viewport (390x844).
 *
 *   mise run phone
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveStatic } from '../src/node/serve.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'site', 'dist')
const QRCODE = path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')

const server = await serveStatic({ root: DIST, port: 0 })
const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
})
const page = await context.newPage()

page.on('close', () => process.exit(0))

await page.goto(server.url)
await page.waitForFunction(() => customElements.get('qr-drop') !== undefined)

// Same routing trick as check-layout.mjs: CSP blocks inline scripts, so route
// the qrcode library through the filesystem.
await page.route('**/qrcode-generator.js', async route => {
  await route.fulfill({ path: QRCODE, contentType: 'text/javascript' })
})
await page.addScriptTag({ url: '/qrcode-generator.js' })

// Zoom out to 75% so the whole phone viewport is visible
await page.evaluate(() => {
  document.documentElement.style.zoom = '0.75'
})

console.log(`Opened at ${server.url}`)