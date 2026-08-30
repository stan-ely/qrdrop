/**
 * Drives one REAL send against the deployed site so a phone can complete a
 * genuine receive off the laptop screen -- the sender half of the silent
 * README/site loop, captured live rather than scripted.
 *
 *   node scripts/demo-session.mjs
 *
 * WHY REAL, not scripts/record-walkthrough.mjs's _setState drive: the loop is
 * a laptop and a phone in one shot, and the phone is filming the laptop's
 * actual screen. There is no honest way to fake that half -- the QR the phone
 * scans has to be a live pairing code, the SAS on both screens has to be the
 * one the relay produced, and the two progress bars have to be one measurement.
 * So this opens a headed browser, starts a real send, and then WAITS: for the
 * operator to scan with the phone (detected by the verify screen appearing, not
 * a clock), and for the phone's Accept (detected by the transfer completing).
 * record-walkthrough.mjs stays as the fallback for when there is no relay, no
 * second device, or no second person.
 *
 * WHAT THE OPERATOR DOES, in order:
 *   1. Start the phone's screen recorder.
 *   2. Run this script. A browser window opens on share.stan-ely.com and a QR
 *      appears on the send screen.
 *   3. Point the phone's native camera at the QR, open the link, let it join.
 *   4. Both screens land on the verify screen. This script prints the SAS words
 *      it sees and holds ~10s so both screens are on camera together. Confirm
 *      by eye that the phone shows the same words.
 *   5. This script clicks "They match" on the laptop. Tap Accept on the phone.
 *   6. The transfer runs; both screens reach "done"; this script saves the
 *      laptop recording and exits. Stop the phone recorder.
 *
 * The laptop recording is Playwright's own page capture (VP8 webm at the
 * viewport size), not an OS screen grab -- clean, no window chrome, landscape.
 * It is an INTERMEDIATE: gitignored, married to the phone take in the
 * HyperFrames compose step (docs/demo/loop/README.md).
 *
 * Hand-run, out of CI, needs a network and the public relay -- same standing as
 * the e2e suites, not `npm test`.
 */

import { mkdir, mkdtemp, copyFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'docs', 'demo', 'loop', 'laptop.webm')
const PDF_PATH = path.join(ROOT, 'docs', 'demo', 'report.pdf')

// The deployed build: the phone needs a real HTTPS origin or WebCrypto and the
// camera fail closed (see docs/demo-brief.md, "Filming origin"). Overridable for
// a dry run against a tunnelled dev build, but the default is the real thing.
const SITE = process.env.QRDROP_SITE || 'https://share.stan-ely.com'

// Landscape, laptop-ish 16:10. The headed window is this size and the recording
// matches it, so what the phone films and what Playwright captures are the same
// frame. deviceScaleFactor 2 renders the page at 2x for crisp text on screen
// (the phone is filming pixels); the webm is still downscaled to SIZE.
const SIZE = { width: 1600, height: 1000 }

// How long the verify screen is held on camera after pairing, before the match
// is confirmed. Long enough to read four words off both screens.
const HOLD_VERIFY_MS = 10_000
// A beat on the done screen before the recording is cut.
const HOLD_DONE_MS = 3_500

// How long to wait for the human steps. The scan is not on a clock -- this is
// just the ceiling before the script gives up and you retry.
const WAIT_SCAN_MS = 5 * 60_000
const WAIT_ACCEPT_MS = 5 * 60_000

/**
 * A real, valid, boring one-page PDF named report.pdf, written once. qrdrop
 * never renders it -- it moves bytes -- but the filename is on screen three
 * times and someone may open what they saved, so it is a real PDF, not a stub.
 * Built with correct xref byte offsets rather than typed out.
 */
async function ensureReportPdf() {
  try {
    await access(PDF_PATH)
    return
  } catch {
    // not there yet -- build it
  }

  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const body = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = 'BT /F1 24 Tf 72 760 Td (report.pdf) Tj '
    + '0 -32 Td /F1 12 Tf (Sample document for the qrdrop demo transfer.) Tj ET'
  body.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)

  let pdf = header
  /** @type {number[]} */
  const offsets = []
  body.forEach((obj, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })

  const xrefStart = pdf.length
  pdf += `xref\n0 ${body.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${body.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefStart}\n%%EOF\n`

  await mkdir(path.dirname(PDF_PATH), { recursive: true })
  await writeFile(PDF_PATH, Buffer.from(pdf, 'latin1'))
  console.log(`  wrote ${path.relative(ROOT, PDF_PATH)} (${(pdf.length / 1024).toFixed(1)} kB)`)
}

/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms))

await ensureReportPdf()
await mkdir(path.dirname(OUT), { recursive: true })
const recDir = await mkdtemp(path.join(tmpdir(), 'qrdrop-demo-session-'))

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({
  viewport: SIZE,
  deviceScaleFactor: 2,
  recordVideo: { dir: recDir, size: SIZE },
  colorScheme: 'light',
  permissions: [],
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)

let saved = false
async function finish() {
  if (saved) return
  saved = true
  await context.close() // flushes the video
  const raw = await page.video()?.path()
  if (raw) {
    await copyFile(raw, OUT)
    console.log(`\n  saved ${path.relative(ROOT, OUT)}`)
  } else {
    console.log('\n  no video was recorded')
  }
  await rm(recDir, { recursive: true, force: true })
  await browser.close()
}

// Ctrl+C still keeps whatever was captured.
process.on('SIGINT', async () => {
  console.log('\n  interrupted -- saving what was captured')
  try { await finish() } finally { process.exit(130) }
})

try {
  console.log(`\n  opening ${SITE}`)
  await page.goto(SITE)
  await page.waitForFunction(() => customElements.get('qr-drop') !== undefined)
  await sleep(800) // a clean head on the recording before anything moves

  console.log('  clicking "Send a file" and attaching report.pdf')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btn-send'),
  ])
  await chooser.setFiles(PDF_PATH)

  await page.waitForSelector('#screen-send:not([hidden]) #qr svg', { timeout: 60_000 })
  console.log('\n  >>> QR is up. Scan it with the phone now. <<<\n')

  await page.waitForSelector('#screen-verify:not([hidden])', { timeout: WAIT_SCAN_MS })
  const sas = (await page.textContent('#screen-verify #sas'))?.trim()
  const words = await page.$$eval('#screen-verify .sas-word', els =>
    els.map(e => (e.textContent || '').trim()))
  console.log(`  paired. SAS: ${sas}`)
  console.log(`  words:      ${words.join(', ')}`)
  console.log(`  -- confirm the phone shows the same four words --`)
  await sleep(HOLD_VERIFY_MS)

  console.log('  clicking "They match" on the laptop. Tap Accept on the phone.')
  await page.click('#verify-status button.primary')

  await page.waitForSelector('#screen-done:not([hidden])', { timeout: WAIT_ACCEPT_MS })
  const digest = (await page.textContent('#done-digest').catch(() => null))?.trim()
  console.log(`  done.${digest ? ` digest: ${digest}` : ''}`)
  await sleep(HOLD_DONE_MS)
} finally {
  await finish()
}
