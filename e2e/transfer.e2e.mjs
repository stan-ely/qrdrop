/**
 * Two real browsers, one real file, over real public relays.
 *
 * The unit suite covers the crypto and the framing with fakes. This covers what
 * fakes cannot: that Trystero pairs over live Nostr relays, that the bundle
 * loads under the page's CSP, that both peers land on the same SAS, and that
 * the bytes arriving at a download are the bytes that went in.
 *
 * Kept out of `npm test` deliberately -- it needs a network and the goodwill of
 * public infrastructure, so it must never be the thing that fails a unit run.
 * Run it with `npm run test:e2e`, which runs the build first.
 *
 * Serves the built site from a small static server rather than a dev server, so
 * node is the only tool involved.
 */

import { chromium } from 'playwright'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const PORT = 4173
const ORIGIN = `http://127.0.0.1:${PORT}`
// site/dist/, matching scripts/build-site.mjs's output. This said 'public'
// until now -- the directory Hugo used to write -- so every run of this suite
// died on the "no build found" check below rather than testing anything. Hugo
// went away in f913bc8; this reference did not go with it.
const ROOT = path.join('site', 'dist')
const TIMEOUT = 90_000

// 1 MB is 64 chunks: enough to guarantee frames arrive in bursts rather than
// one settled delivery at a time, which is the condition ordering bugs need.
const PAYLOAD_BYTES = 1024 * 1024

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** @param {Uint8Array | string} buf */
const sha = buf => createHash('sha256').update(buf).digest('hex')

/** @param {unknown[]} a */
const log = (...a) => console.log('  ', ...a)

/**
 * @param {string} root
 * @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
function startServer(root, port) {
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url ?? '/', ORIGIN).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'

    // Confine to root: this serves a build directory, but a path-traversal hole
    // in a test harness is still a path-traversal hole.
    const file = path.join(root, path.normalize(pathname))
    if (!path.resolve(file).startsWith(path.resolve(root))) {
      res.writeHead(403).end('forbidden')
      return
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      })
      res.end(data)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/**
 * textContent() resolves to null when the selector misses, and every caller
 * here immediately trims. Failing with the selector named beats a
 * "Cannot read properties of null" with no clue which assertion broke.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {Promise<string>}
 */
async function text(page, selector) {
  const value = await page.textContent(selector)
  if (value === null) throw new Error(`No element matched ${selector}`)
  return value.trim()
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    throw new Error(`No build found in ${ROOT}/. Run \`npm run build\` first.`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrdrop-e2e-'))
  const sourcePath = path.join(tmp, 'payload.bin')
  const payload = randomBytes(PAYLOAD_BYTES)
  fs.writeFileSync(sourcePath, payload)

  /** @type {import('playwright').Browser | undefined} */
  let browser
  /** @type {import('node:http').Server | undefined} */
  let server

  // Tuples, annotated. Inferred from the push below this is (string | Page)[][],
  // which loses the pairing entirely and makes every `page.` access an error.
  /** @type {[name: string, page: import('playwright').Page][]} */
  const pages = []

  /** On failure, say what each page was actually showing rather than just timing out. */
  const diagnose = async () => {
    for (const [name, page] of pages) {
      try {
        const state = await page.evaluate(() => {
          const visible = [...document.querySelectorAll('section')]
            .filter(s => !s.hidden).map(s => s.id)
          const err = document.getElementById('error')
          return {
            visible,
            error: err?.hidden ? null : err?.textContent?.trim(),
            status: [...document.querySelectorAll('.status')]
              .map(s => s.textContent?.trim() ?? '').filter(Boolean),
          }
        })
        console.error(`  [${name}] screen=${state.visible.join(',') || 'none'}`)
        if (state.status.length) console.error(`  [${name}] status: ${state.status.join(' | ')}`)
        if (state.error) console.error(`  [${name}] error: ${state.error}`)
      } catch {
        console.error(`  [${name}] page unavailable`)
      }
    }
  }

  try {
    server = await startServer(ROOT, PORT)
    log(`serving ${ROOT}/ at ${ORIGIN}`)

    browser = await chromium.launch({
      args: [
        // The receiver's scan loop calls getUserMedia; a fake device lets it
        // start and fail to find a code, which is the path manual entry takes.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    })

    // Both peers share one context -- two tabs of one browser, which is how
    // people actually try this first, and a materially harsher test than two
    // separate contexts. Frames arrive in tighter bursts, which is what exposed
    // the receiver reentrancy bug that separate contexts sailed straight past.
    const context = await browser.newContext({
      permissions: ['camera'],
      acceptDownloads: true,
    })

    // Headless Chromium exposes showSaveFilePicker but has no UI to answer it,
    // so the picker never settles and the transfer stalls before it starts.
    // Removing it forces the Blob fallback, which produces a real download
    // event. Consequence worth stating: this run exercises the in-memory path,
    // and the File System Access streaming path is not covered here.
    await context.addInitScript(() => {
      // Not in lib.dom -- File System Access is Chromium-only. See
      // src/web/sink.js, which feature-detects the same property.
      delete (/** @type {any} */ (window)).showSaveFilePicker
    })

    const a = await context.newPage()
    const b = await context.newPage()
    pages.push(['sender', a], ['receiver', b])

    /** @type {string[]} */
    const errors = []
    /** @type {string[]} */
    const relayFailures = []
    for (const [name, page] of pages) {
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`))
      page.on('console', m => {
        if (m.type() !== 'error') return
        // A public relay refusing a connection is the expected weather, not a
        // fault -- it is the reason several are used at once. The transfer
        // completing at all proves enough of them worked.
        if (/WebSocket connection to 'wss:\/\/[^']*' failed/.test(m.text())) {
          relayFailures.push(m.text().match(/wss:\/\/[^/']*/)?.[0] ?? 'unknown')
          return
        }
        errors.push(`${name} console: ${m.text()}`)
      })
    }

    await a.goto(ORIGIN)
    await b.goto(ORIGIN)
    log('both pages loaded')

    // --- sender picks a file -------------------------------------------------
    const chooser = a.waitForEvent('filechooser')
    await a.click('#btn-send')
    await (await chooser).setFiles(sourcePath)

    await a.waitForSelector('#screen-send:not([hidden])', { timeout: TIMEOUT })
    const code = await text(a, '#manual-code')
    if (!/^qrdrop:[A-Za-z0-9_-]{43}$/.test(code)) throw new Error(`Bad code: ${code}`)
    log('code generated:', code.slice(0, 20) + '...')

    const qr = await a.innerHTML('#qr')
    if (!qr.includes('<svg')) throw new Error('QR did not render')
    log('QR rendered as SVG')

    // --- receiver joins with the code ---------------------------------------
    await b.click('#btn-receive')
    await b.waitForSelector('#screen-receive:not([hidden])')
    await b.click('#screen-receive .manual summary')
    await b.fill('#manual-input', code)
    await b.click('#manual-form button[type=submit]')
    log('receiver joined, pairing via Trystero...')

    // --- both should reach the same SAS -------------------------------------
    await a.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    await b.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })

    const sasA = await text(a, '#sas')
    const sasB = await text(b, '#sas')
    if (!sasA) throw new Error('Sender showed no SAS')
    if (sasA !== sasB) throw new Error(`SAS mismatch: ${sasA} vs ${sasB}`)
    log('SAS agreed on both devices:', sasA)

    // --- transfer ------------------------------------------------------------
    await a.click('#verify-status button.primary')
    log('sender confirmed')

    await b.waitForSelector('#verify-status button.primary', { timeout: TIMEOUT })
    const download = b.waitForEvent('download', { timeout: TIMEOUT })
    await b.click('#verify-status button.primary')
    log('receiver accepted')

    const saved = await download
    const outPath = path.join(tmp, 'received.bin')
    await saved.saveAs(outPath)

    const received = fs.readFileSync(outPath)
    if (received.length !== payload.length) {
      throw new Error(`Size mismatch: sent ${payload.length}, got ${received.length}`)
    }
    if (sha(received) !== sha(payload)) throw new Error('Content mismatch')
    log(`file arrived intact: ${received.length} bytes, sha256 ${sha(received).slice(0, 16)}...`)

    // --- both sides report success ------------------------------------------
    await a.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })
    await b.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })

    const digestA = await text(a, '#done-digest')
    const digestB = await text(b, '#done-digest')
    if (!digestA || digestA !== digestB) {
      throw new Error(`Digest mismatch: ${digestA} vs ${digestB}`)
    }
    log('both sides agree on digest:', digestA.slice(0, 16) + '...')

    if (errors.length) throw new Error('Console errors:\n' + errors.join('\n'))

    if (relayFailures.length) {
      log(`note: ${[...new Set(relayFailures)].join(', ')} were unreachable; `
        + 'the remaining relays carried the pairing')
    }

    console.log('\nE2E PASSED')
  } catch (error) {
    console.error('\nfailure state:')
    await diagnose()
    throw error
  } finally {
    await browser?.close()
    server?.close()
  }
}

main().catch(err => {
  console.error('\nE2E FAILED:', err.message)
  process.exit(1)
})
