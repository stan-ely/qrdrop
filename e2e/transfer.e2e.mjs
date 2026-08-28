/**
 * Two real browsers, one real file, over real public relays.
 *
 * The unit suite covers the crypto and the framing with fakes. This covers what
 * fakes cannot: that Nostr relays actually accept our events, that WebRTC
 * negotiates, that both peers land on the same SAS, and that the bytes arriving
 * at a download are the bytes that went in.
 *
 * Kept out of `npm test` deliberately -- it needs a network and the goodwill of
 * public infrastructure, so it must never be the thing that fails a unit run.
 * Run it with `npm run test:e2e`.
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 4173
const ORIGIN = `http://127.0.0.1:${PORT}`
const TIMEOUT = 90_000
const PAYLOAD_BYTES = 300 * 1024   // spans ~19 chunks, so backpressure and ordering are exercised

const sha = buf => createHash('sha256').update(buf).digest('hex')

async function waitForServer(url, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`Preview server never came up at ${url}`)
}

const log = (...a) => console.log('  ', ...a)

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrbeam-e2e-'))
  const sourcePath = path.join(tmp, 'payload.bin')
  const payload = randomBytes(PAYLOAD_BYTES)
  fs.writeFileSync(sourcePath, payload)

  // Spawned without a shell, straight at vite's entry point: `npx` through a
  // shell needs shell:true, which Node now warns about because the arguments
  // are concatenated rather than escaped.
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore' },
  )

  let browser
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
              .map(s => s.textContent.trim()).filter(Boolean),
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
    await waitForServer(ORIGIN)
    log('preview server up')

    browser = await chromium.launch({
      args: [
        // The receiver's scan loop calls getUserMedia; a fake device lets it
        // start and fail to find a code, which is the path manual entry takes.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    })

    const sender = await browser.newContext({ permissions: ['camera'] })
    const receiver = await browser.newContext({
      permissions: ['camera'],
      acceptDownloads: true,
    })

    // Headless Chromium exposes showSaveFilePicker but has no UI to answer it,
    // so the picker never settles and the transfer stalls before it starts.
    // Removing it forces the Blob fallback, which produces a real download
    // event. Consequence worth stating: this run exercises the in-memory path,
    // and the File System Access streaming path is not covered here.
    await receiver.addInitScript(() => {
      delete window.showSaveFilePicker
    })

    const a = await sender.newPage()
    const b = await receiver.newPage()

    pages.push(['sender', a], ['receiver', b])

    const errors = []
    const relayFailures = []
    for (const [name, page] of pages) {
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`))
      page.on('console', m => {
        if (m.type() !== 'error') return
        // A public relay refusing a connection is the expected weather, not a
        // fault -- it is the reason four are used at once. The transfer
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
    const code = (await a.textContent('#manual-code')).trim()
    if (!/^qrbeam:[A-Za-z0-9_-]{43}$/.test(code)) throw new Error(`Bad code: ${code}`)
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
    log('receiver joined, negotiating...')

    // --- both should reach the same SAS -------------------------------------
    await a.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    await b.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })

    const sasA = (await a.textContent('#sas')).trim()
    const sasB = (await b.textContent('#sas')).trim()
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

    const digestA = (await a.textContent('#done-digest')).trim()
    const digestB = (await b.textContent('#done-digest')).trim()
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
    server.kill()
    // vite preview spawns through a shell on Windows; make sure it is gone.
    if (process.platform === 'win32' && server.pid) {
      spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
    }
  }
}

main().catch(err => {
  console.error('\nE2E FAILED:', err.message)
  process.exit(1)
})
