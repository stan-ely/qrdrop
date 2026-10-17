/**
 * A real browser against the Rust CLI, both ways, over real public relays.
 *
 * e2e/interop.e2e.mjs runs the Rust CLI against the Node one, and both of
 * those are native peers on node-datachannel or str0m. This is the check that
 * matters more: the website's own JS core in Chromium's WebRTC, against
 * str0m, on the same wire. The page is served by the Rust binary's own
 * `qrdrop web`, so that command is under test too.
 *
 * Two transfers, one per direction:
 *
 * 1. The page sends and `qrdrop receive` takes it. The page confirms the SAS,
 *    the CLI is told "y" twice -- the SAS, then the file.
 * 2. `qrdrop send` offers and the page receives. The CLI confirms the SAS, and
 *    the page's Accept is its whole answer: on the web the receiver's SAS and
 *    its Accept are one gesture.
 *
 * Each compares the SAS between the two ends (the page's #sas holds the
 * emoji, the CLI's line has the word beside each), the bytes on disk against
 * the bytes sent, and the digest both ends report.
 *
 * Build first: `npm run build`, then the CLI with the page inside it,
 * `mise exec -- cargo build -p qrdrop-cli --features web`. QRDROP_RUST_CLI
 * points at another binary. Out of `npm test`, as every e2e is.
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUST_CLI = process.env.QRDROP_RUST_CLI
  ?? path.join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'qrdrop.exe' : 'qrdrop')
const TIMEOUT = 120_000
// 1 MiB is 64 chunks, as transfer.e2e.mjs sends: frames in bursts.
const PAYLOAD_BYTES = 1024 * 1024

/** @param {Uint8Array} buf */
const sha = buf => createHash('sha256').update(buf).digest('hex')

/** @param {unknown[]} a */
const log = (...a) => console.log('  ', ...a)

/**
 * The CLI as a child, its output gathered for `waitFor`, stdin left open for
 * the answers. As interop.e2e.mjs launches it: NO_COLOR, stdout a pipe.
 *
 * @param {string[]} args
 * @param {string} label
 */
function launch(args, label) {
  const child = spawn(RUST_CLI, args, {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    // WebRTC only: the page has no local-network path, and a CLI that
    // offered one would be waiting out its own link timeout for nothing.
    env: { ...process.env, NO_COLOR: '1', QRDROP_LAN_LISTEN: 'none' },
  })
  let output = ''
  /** @type {(() => void)[]} */
  const listeners = []
  /** @param {string} chunk */
  const absorb = chunk => {
    output += chunk
    process.stderr.write(`  [${label}] ${chunk}`.replace(/\n(?!$)/g, `\n  [${label}] `))
    for (const notify of listeners.splice(0)) notify()
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', absorb)
  child.stderr.on('data', absorb)
  return {
    child,
    get output() { return output },
    /** @param {string} line */
    say: line => child.stdin.write(line + '\n'),
    /** @param {RegExp} pattern */
    waitFor(pattern) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`[${label}] timed out waiting for ${pattern}\n--- output ---\n${output}`)),
          TIMEOUT,
        )
        const check = () => {
          const hit = pattern.exec(output)
          if (!hit) return listeners.push(check)
          clearTimeout(deadline)
          resolve(hit)
        }
        check()
      })
    },
    /** @type {Promise<number | null>} */
    exited: new Promise(resolve => child.on('exit', code => resolve(code))),
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} selector
 */
async function text(page, selector) {
  const value = await page.textContent(selector)
  if (value === null) throw new Error(`No element matched ${selector}`)
  return value.trim()
}

/**
 * The SAS a CLI printed, as the page holds it: the emoji alone, one space
 * apart. The CLI's line is `emoji word`, four times, three spaces apart.
 *
 * @param {ReturnType<typeof launch>} cli
 */
async function cliSas(cli) {
  const [, line] = await cli.waitFor(/Both devices should be showing:\s*\n\s*\n\s*(\S.*?)\s*\n/)
  return String(line).trim().split('   ').map(pair => pair.split(' ')[0]).join(' ')
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} origin
 * @param {string} tmp
 */
async function pageSends(context, origin, tmp) {
  const source = path.join(tmp, 'from-page.bin')
  const payload = randomBytes(PAYLOAD_BYTES)
  fs.writeFileSync(source, payload)
  const outDir = fs.mkdtempSync(path.join(tmp, 'cli-out-'))

  const page = await context.newPage()
  await page.goto(origin)
  const chooser = page.waitForEvent('filechooser')
  await page.click('#btn-send')
  await (await chooser).setFiles(source)
  await page.waitForSelector('#screen-send:not([hidden])', { timeout: TIMEOUT })
  const code = await text(page, '#manual-code')
  log('page shows', code.slice(0, 20) + '...')

  const cli = launch(['receive', code, '--out', outDir], 'recv:rust')
  try {
    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    const pageSas = await text(page, '#sas')
    const theirs = await cliSas(cli)
    if (pageSas !== theirs) throw new Error(`SAS mismatch: page ${pageSas} vs CLI ${theirs}`)
    log('SAS agreed:', pageSas)

    await page.click('#verify-status button.primary')
    cli.say('y')
    await cli.waitFor(/Incoming:.*Accept\?/)
    cli.say('y')

    const code_ = await cli.exited
    if (code_ !== 0) throw new Error(`qrdrop receive exited ${code_}`)
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })

    const written = fs.readdirSync(outDir)
    if (written.length !== 1) throw new Error(`expected one file, got ${written.join(', ')}`)
    const landed = fs.readFileSync(path.join(outDir, written[0]))
    if (!landed.equals(payload)) throw new Error(`bytes differ: sent ${sha(payload)}, got ${sha(landed)}`)

    const pageDigest = await text(page, '#done-digest')
    const cliDigest = /digest=([0-9a-f]{64})/.exec(cli.output)?.[1]
    if (!cliDigest || cliDigest !== pageDigest) throw new Error(`digest mismatch: page ${pageDigest} vs CLI ${cliDigest}`)
    console.log(`\nPASS  page -> rust  ${landed.length} bytes, digest ${cliDigest}`)
  } finally {
    cli.child.kill()
    await page.close()
  }
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} origin
 * @param {string} tmp
 */
async function pageReceives(context, origin, tmp) {
  const source = path.join(tmp, 'from-cli.bin')
  const payload = randomBytes(PAYLOAD_BYTES)
  fs.writeFileSync(source, payload)

  const cli = launch(['send', source, '--no-qr'], 'send:rust')
  const page = await context.newPage()
  try {
    const [, code] = await cli.waitFor(/(qrdrop:[A-Za-z0-9_-]{43})/)
    await page.goto(origin)
    await page.click('#btn-receive')
    await page.waitForSelector('#screen-receive:not([hidden])')
    await page.fill('#manual-input', code)
    await page.click('#manual-form button[type=submit]')

    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    const pageSas = await text(page, '#sas')
    const theirs = await cliSas(cli)
    if (pageSas !== theirs) throw new Error(`SAS mismatch: page ${pageSas} vs CLI ${theirs}`)
    log('SAS agreed:', pageSas)

    cli.say('y')
    // The offer arrives once the CLI has confirmed; Accept is the page's
    // SAS answer and its yes to the file in one.
    await page.waitForSelector('#verify-status button.primary:has-text("Accept")', { timeout: TIMEOUT })
    const download = page.waitForEvent('download', { timeout: TIMEOUT })
    await page.click('#verify-status button.primary')
    const saved = await download
    const out = path.join(tmp, 'page-received.bin')
    await saved.saveAs(out)
    const landed = fs.readFileSync(out)
    if (!landed.equals(payload)) throw new Error(`bytes differ: sent ${sha(payload)}, got ${sha(landed)}`)

    const code_ = await cli.exited
    if (code_ !== 0) throw new Error(`qrdrop send exited ${code_}`)
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })
    const pageDigest = await text(page, '#done-digest')
    const cliDigest = /digest=([0-9a-f]{64})/.exec(cli.output)?.[1]
    if (!cliDigest || cliDigest !== pageDigest) throw new Error(`digest mismatch: page ${pageDigest} vs CLI ${cliDigest}`)
    console.log(`\nPASS  rust -> page  ${landed.length} bytes, digest ${cliDigest}`)
  } finally {
    cli.child.kill()
    await page.close()
  }
}

async function main() {
  if (!fs.existsSync(RUST_CLI)) {
    throw new Error(`no CLI at ${RUST_CLI}: run \`npm run build\`, then \`mise exec -- cargo build -p qrdrop-cli --features web\``)
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrdrop-browser-cli-'))
  const web = launch(['web', '--port', '0', '--no-open'], 'web:rust')
  /** @type {import('playwright').Browser | undefined} */
  let browser
  try {
    const [, origin] = await web.waitFor(/qrdrop web UI: (http:\/\/127\.0\.0\.1:\d+\/)/)
    log('page served by qrdrop web at', origin)

    browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    })
    const context = await browser.newContext({ permissions: ['camera'], acceptDownloads: true })
    // As transfer.e2e.mjs: headless Chromium cannot answer the save picker,
    // so the page takes its Blob path and a real download event.
    await context.addInitScript(() => {
      delete (/** @type {any} */ (window)).showSaveFilePicker
    })
    /** @type {string[]} */
    const errors = []
    context.on('page', page => {
      page.on('pageerror', e => errors.push(e.message))
      page.on('console', m => {
        if (m.type() === 'error' && !/WebSocket connection to 'wss:/.test(m.text())) errors.push(m.text())
      })
    })

    await pageSends(context, origin, tmp)
    await pageReceives(context, origin, tmp)
    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'))
    console.log('\nBROWSER-CLI E2E PASSED')
  } finally {
    await browser?.close()
    web.child.kill()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\nFAIL', error.message)
  process.exit(1)
})
