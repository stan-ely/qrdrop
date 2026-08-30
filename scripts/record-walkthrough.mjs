/**
 * Records docs/demo/loop/walkthrough.webm -- the sender half of the silent
 * README/site loop, as a scripted drive of the real <qr-drop> through
 * choose -> send -> verify -> transfer -> done.
 *
 *   npm run build && node scripts/record-walkthrough.mjs
 *
 * WHY SCRIPTED, not a capture of a real transfer: every screen past `choose`
 * is downstream of a real peer on a real relay, so a real capture depends on
 * public infrastructure, a second device, and pairing luck, and cannot be
 * retaken to the same timing twice. `_setState` is the same door the
 * component's own handlers go through (see src/web/view.js's header), so what
 * this records is what a real transfer draws -- just on a clock this script
 * controls. The receiver half of the loop IS a real capture, off a phone; the
 * two are married in the edit. See docs/demo/loop-kit.md.
 *
 * WHY THE STATES ARE NOT scripts/screen-states.mjs's FIXTURES replayed
 * verbatim: those are independent snapshots for a still camera and leak into
 * each other when applied in sequence (a `pairing: true` from `send` is still
 * true on `verify`). The SEQUENCE below is purpose-built and clears what each
 * step must not carry. It still SOURCES the SAS and the digest from that
 * module, so the emoji, the words and the hash cannot drift from the ones the
 * screenshots and the layout check use.
 *
 * Hand-run and out of CI, exactly like make-screenshots.mjs and
 * check-layout.mjs: `npm run build` and `prepublishOnly` must not download a
 * browser. Its output is an INTERMEDIATE -- gitignored, fed to the HyperFrames
 * compose step in docs/demo/loop/README.md, not embedded anywhere directly.
 *
 * FRAME RATE: Playwright's recorder is ~25fps VP8. The screen-entrance and
 * step-rail animations read slightly less fluid than a 60fps capture would.
 * That is acceptable for a loop that is re-encoded downstream; if it ever
 * reads as juddery, the fallback is a headed run plus an OS screen recorder,
 * which is not built here.
 */

import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { serveStatic } from '../src/node/serve.js'
import { FIXTURES, LINK, installState } from './screen-states.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'site', 'dist')
const OUT = path.join(ROOT, 'docs', 'demo', 'loop', 'walkthrough.webm')

const QRCODE = path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')

// A full site page rather than a bare component viewport: the loop is meant to
// look like someone using share.stan-ely.com, so the header and footer chrome
// stay in frame. 1600x1000 is a laptop-ish 16:10 that frames the card with air
// around it; the video is recorded at the same size (Playwright upscales a
// mismatched recordVideo.size and the result is soft), and downscaled by the
// compose step, so there is no gain in going larger here.
const SIZE = { width: 1600, height: 1000 }

// Every hold is how long that screen is on camera, in ms. Tuned so the whole
// thing runs ~13s -- long enough to read the SAS tiles, short enough for a
// loop. Adjust here, not in the sequence.
const HOLD = {
  choose: 1400,
  send: 2800,
  verify: 2800,
  toast: 1300,
  done: 2200,
}

// The transfer bar is animated by stepping `progress` rather than by holding a
// single mid-transfer frame: a static bar in the emptiest screen of the app,
// placed at its longest beat, reads as a stall. ~30 steps over 2.6s is smooth
// at the recorder's frame rate without being busy work.
const RAMP = { ms: 2600, steps: 30 }

// Small and boring, per docs/demo-brief.md: the filename is on screen twice and
// a 2 MB file would make the ramp the longest beat in the loop. This is content,
// not a screen state, so it is defined here rather than in screen-states.mjs
// (whose PDF is sized for a still of the transfer bar, not for timing).
const FILE = { name: 'report.pdf', size: 245_760 }

// Sourced, not retyped: the send code, the SAS a person reads aloud, and the
// digest all come from the one table screen-states.mjs already owns, so a
// picture of the loop cannot show a pairing the app could never produce.
const VERIFY = /** @type {any} */ (FIXTURES.find(f => f.name === 'verify')).state
const SEND_CODE = /** @type {any} */ (FIXTURES.find(f => f.name === 'send')).state.code
const DIGEST = /** @type {any} */ (FIXTURES.find(f => f.name === 'done')).state.digest

/**
 * Each step is a COMPLETE set of the fields its screen needs, plus explicit
 * nulls for anything a previous step set that this one must not show. `_setState`
 * merges, so a field left unmentioned keeps its old value -- which is the bug
 * the FIXTURES have when chained.
 *
 * @type {{ label: string, hold: number, state: Record<string, unknown> }[]}
 */
const SEQUENCE = [
  {
    label: 'choose',
    hold: HOLD.choose,
    state: {
      screen: 'choose', role: null, mode: 'p2p',
      file: null, offer: null, progress: null, path: null,
      pairing: false, toast: null, modal: null, error: null,
    },
  },
  {
    label: 'send',
    hold: HOLD.send,
    state: {
      screen: 'send', role: 'sender', code: SEND_CODE, qrIsLink: true,
      file: FILE, status: 'Waiting for the other device…', pairing: true,
      toast: null, modal: null,
    },
  },
  {
    label: 'verify',
    hold: HOLD.verify,
    state: {
      screen: 'verify', role: 'sender',
      sas: VERIFY.sas, sasWords: VERIFY.sasWords,
      file: FILE, path: 'local',
      pairing: false, status: '', toast: null, modal: null,
    },
  },
  {
    label: 'verify + toast',
    hold: HOLD.toast,
    state: {
      screen: 'verify', role: 'sender',
      sas: VERIFY.sas, sasWords: VERIFY.sasWords,
      file: FILE, path: 'local',
      toast: 'Local network',
    },
  },
  {
    label: 'transfer',
    hold: 0, // the ramp below is this screen's dwell
    state: {
      screen: 'transfer', role: 'sender',
      file: FILE, path: 'local',
      progress: { moved: 0, total: FILE.size },
      status: 'Sending…', toast: null, modal: null,
    },
  },
  {
    label: 'done',
    hold: HOLD.done,
    // Sender, so the outcome is 'sent' ("File sent"), not 'received' -- the
    // phone track carries the "it arrived" beat. The digest still shows: both
    // ends compute it.
    state: {
      screen: 'done', role: 'sender', outcome: 'sent',
      file: FILE, path: 'local', digest: DIGEST,
      progress: null, toast: null, modal: null,
    },
  },
]

await mkdir(path.dirname(OUT), { recursive: true })
const recDir = await mkdtemp(path.join(tmpdir(), 'qrdrop-walkthrough-'))

const server = await serveStatic({ root: DIST, port: 0 })
const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: SIZE,
  recordVideo: { dir: recDir, size: SIZE },
  colorScheme: 'light',
})
const page = await context.newPage()

await page.goto(server.url)
await page.waitForFunction(() => customElements.get('qr-drop') !== undefined)

// Same routing trick as make-screenshots.mjs: the page's CSP is script-src
// 'self', so an injected inline tag is refused. qrcode-generator's UMD build is
// only needed for the send screen's QR, but it is loaded once up front.
await page.route('**/qrcode-generator.js', async route => {
  await route.fulfill({ path: QRCODE, contentType: 'text/javascript' })
})
await page.addScriptTag({ url: '/qrcode-generator.js' })

// A beat on the untouched first paint before the drive starts, so the loop has
// a clean head to cut back to.
await page.waitForTimeout(600)

for (const step of SEQUENCE) {
  // installState adds the real QR node on the send screen and passes everything
  // else straight to _setState. Reused rather than calling _setState directly so
  // the QR-building path is the same one the screenshots use.
  await page.evaluate(installState, { state: step.state, link: LINK })
  console.log(`  ${step.label}`)

  if (step.state.screen === 'transfer') {
    const total = FILE.size
    for (let i = 1; i <= RAMP.steps; i++) {
      await page.waitForTimeout(RAMP.ms / RAMP.steps)
      const moved = Math.round((total * i) / RAMP.steps)
      await page.evaluate(installState, {
        state: { screen: 'transfer', progress: { moved, total } },
        link: LINK,
      })
    }
  }

  if (step.hold) await page.waitForTimeout(step.hold)
}

await context.close()
const raw = await page.video()?.path()
if (!raw) throw new Error('no video was recorded')
await copyFile(raw, OUT)
await rm(recDir, { recursive: true, force: true })

await browser.close()
await server.close()

console.log(`\n${path.relative(ROOT, OUT)}`)
