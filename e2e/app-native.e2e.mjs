/**
 * The desktop app on its native session, against the Node CLI, both ways,
 * over real public relays.
 *
 * browser-cli.e2e.mjs puts the website's JS session against the Rust CLI.
 * This is the other crossing: the app's page drawing a transfer that
 * qrdrop-session runs in the app's own Rust (app/src-tauri/src/native.rs),
 * against the JS core in Node. What it proves is the seam -- the page's
 * Confirm and Accept reaching native.rs as words, native.rs's events drawing
 * the same screens and ids the JS session does -- since the session itself
 * is interop.e2e.mjs's.
 *
 * The app is the real debug binary, launched with QRDROP_NATIVE_SESSION=1
 * and WebView2's remote-debugging port, and Playwright attaches over CDP.
 * Windows only, for that reason: WebView2 is the one webview here with a CDP
 * port to attach to.
 *
 * 1. The app sends. A native send needs a path, which only the platform's
 *    picker or a window drop gives up, and neither can be driven from here;
 *    so the file goes in through `sendFile`, the component's one public
 *    entry, exactly as the share handoff and a window drop hand it over.
 * 2. The app receives, from a code put in `location.hash`, as a deep link
 *    does. It saves to Downloads/qrdrop without asking; the done screen says
 *    where, and the file is removed afterwards.
 * 3. The app declines an offer: the CLI sender exits 1, the app is back on
 *    choose, and nothing is written.
 *
 * Build first: `mise run app:build-site`, then
 * `npx tauri build --debug --no-bundle` in app/. QRDROP_APP points at another
 * binary.
 */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = process.env.QRDROP_APP ?? path.join(ROOT, 'app', 'src-tauri', 'target', 'debug', 'qrdrop.exe')
const CDP_PORT = 9339
const TIMEOUT = 120_000
const PAYLOAD_BYTES = 1024 * 1024

/** @param {Uint8Array} buf */
const sha = buf => createHash('sha256').update(buf).digest('hex')

/** @param {unknown[]} a */
const log = (...a) => console.log('  ', ...a)

/**
 * A child process with its output gathered for `waitFor`, stdin left open
 * for the answers -- browser-cli.e2e.mjs's, with the command a parameter.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} label
 * @param {NodeJS.ProcessEnv} [env]
 */
function launch(command, args, label, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    // WebRTC only on the CLI: the desktop app listens on no local port
    // (Windows would raise a firewall prompt), so a LAN offer would only be
    // waited out.
    env: { ...process.env, NO_COLOR: '1', QRDROP_LAN_LISTEN: 'none', ...env },
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

/** @param {string[]} args @param {string} label */
const cli = (args, label) => launch(process.execPath, [path.join(ROOT, 'src', 'cli.js'), ...args], label)

/**
 * @param {import('playwright').Page} page
 * @param {string} selector
 */
async function text(page, selector) {
  const value = await page.textContent(selector)
  if (value === null) throw new Error(`No element matched ${selector}`)
  return value.trim()
}

/** @param {ReturnType<typeof launch>} peer */
async function cliSas(peer) {
  const [, line] = await peer.waitFor(/Both devices should be showing:\s*\n\s*\n\s*(\S.*?)\s*\n/)
  return String(line).trim().split('   ').map(pair => pair.split(' ')[0]).join(' ')
}

/** @param {import('playwright').Page} page */
async function toChoose(page) {
  // The page CDP hands over may still be loading -- the app was just
  // launched -- and evaluating into a navigation destroys the context.
  await page.waitForLoadState('load')
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#btn-send', { timeout: TIMEOUT })
}

/**
 * @param {import('playwright').Page} page
 * @param {string} tmp
 */
async function appSends(page, tmp) {
  const source = path.join(tmp, 'from-app.bin')
  const payload = randomBytes(PAYLOAD_BYTES)
  fs.writeFileSync(source, payload)
  const outDir = fs.mkdtempSync(path.join(tmp, 'cli-out-'))

  await toChoose(page)
  const accepted = await page.evaluate(
    file => /** @type {any} */ (document.querySelector('qr-drop')).sendFile(file),
    { path: source, name: 'from-app.bin', size: payload.length },
  )
  if (!accepted) throw new Error('sendFile declined on the choose screen')
  await page.waitForFunction(
    () => /^qrdrop:/.test(document.querySelector('qr-drop')?.shadowRoot?.querySelector('#manual-code')?.textContent?.trim() ?? ''),
    null, { timeout: TIMEOUT },
  )
  const code = await text(page, '#manual-code')
  log('app shows', code.slice(0, 20) + '...')

  const peer = cli(['receive', code, '--out', outDir], 'recv:js')
  try {
    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    const appSas = await text(page, '#sas')
    const theirs = await cliSas(peer)
    if (appSas !== theirs) throw new Error(`SAS mismatch: app ${appSas} vs CLI ${theirs}`)
    log('SAS agreed:', appSas)

    await page.click('#verify-status button.primary')
    peer.say('y')
    await peer.waitFor(/Incoming:.*Accept\?/)
    peer.say('y')

    const exit = await peer.exited
    if (exit !== 0) throw new Error(`qrdrop receive exited ${exit}`)
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })

    const written = fs.readdirSync(outDir)
    if (written.length !== 1) throw new Error(`expected one file, got ${written.join(', ')}`)
    const landed = fs.readFileSync(path.join(outDir, written[0]))
    if (!landed.equals(payload)) throw new Error(`bytes differ: sent ${sha(payload)}, got ${sha(landed)}`)
    const appDigest = await text(page, '#done-digest')
    const cliDigest = /digest=([0-9a-f]{64})/.exec(peer.output)?.[1]
    if (!cliDigest || cliDigest !== appDigest) throw new Error(`digest mismatch: app ${appDigest} vs CLI ${cliDigest}`)
    console.log(`\nPASS  app(native) -> js  ${landed.length} bytes, digest ${cliDigest}`)
  } finally {
    peer.child.kill()
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} tmp
 */
async function appReceives(page, tmp) {
  const name = `qrdrop-e2e-${randomBytes(4).toString('hex')}.bin`
  const source = path.join(tmp, name)
  const payload = randomBytes(PAYLOAD_BYTES)
  fs.writeFileSync(source, payload)
  const expected = path.join(os.homedir(), 'Downloads', 'qrdrop', name)

  const peer = cli(['send', source, '--no-qr'], 'send:js')
  try {
    const [, code] = await peer.waitFor(/(qrdrop:[A-Za-z0-9_-]{43})/)
    await toChoose(page)
    // A deep link's road in (app/src/main.js's openDeepLink).
    await page.evaluate(c => {
      location.hash = c
    }, code)

    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    const appSas = await text(page, '#sas')
    const theirs = await cliSas(peer)
    if (appSas !== theirs) throw new Error(`SAS mismatch: app ${appSas} vs CLI ${theirs}`)
    log('SAS agreed:', appSas)

    peer.say('y')
    await page.waitForSelector('#verify-status button.primary:has-text("Accept")', { timeout: TIMEOUT })
    await page.click('#verify-status button.primary')

    const exit = await peer.exited
    if (exit !== 0) throw new Error(`qrdrop send exited ${exit}`)
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })

    const landed = fs.readFileSync(expected)
    if (!landed.equals(payload)) throw new Error(`bytes differ: sent ${sha(payload)}, got ${sha(landed)}`)
    const appDigest = await text(page, '#done-digest')
    const cliDigest = /digest=([0-9a-f]{64})/.exec(peer.output)?.[1]
    if (!cliDigest || cliDigest !== appDigest) throw new Error(`digest mismatch: app ${appDigest} vs CLI ${cliDigest}`)
    console.log(`\nPASS  js -> app(native)  ${landed.length} bytes, digest ${cliDigest}, at ${expected}`)
  } finally {
    peer.child.kill()
    fs.rmSync(expected, { force: true })
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} tmp
 */
async function appDeclines(page, tmp) {
  const name = `qrdrop-e2e-${randomBytes(4).toString('hex')}.bin`
  const source = path.join(tmp, name)
  fs.writeFileSync(source, randomBytes(4096))
  const unexpected = path.join(os.homedir(), 'Downloads', 'qrdrop', name)

  const peer = cli(['send', source, '--no-qr'], 'send:js')
  try {
    const [, code] = await peer.waitFor(/(qrdrop:[A-Za-z0-9_-]{43})/)
    await toChoose(page)
    await page.evaluate(c => { location.hash = c }, code)
    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    peer.say('y')
    await page.waitForSelector('#verify-status button:has-text("Decline")', { timeout: TIMEOUT })
    await page.click('#verify-status button:has-text("Decline")')

    const exit = await peer.exited
    if (exit !== 1) throw new Error(`a declined qrdrop send exited ${exit}, not 1`)
    await page.waitForSelector('#btn-send', { timeout: TIMEOUT })
    if (fs.existsSync(unexpected)) throw new Error(`a declined file was written: ${unexpected}`)
    console.log('\nPASS  app(native) declines  sender exited 1, nothing written')
  } finally {
    peer.child.kill()
    fs.rmSync(unexpected, { force: true })
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only: it attaches to WebView2 over CDP')
  if (!fs.existsSync(APP)) throw new Error(`no app at ${APP}: build it with \`npx tauri build --debug --no-bundle\` in app/`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrdrop-app-native-'))
  const app = launch(APP, [], 'app', {
    QRDROP_NATIVE_SESSION: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  })
  /** @type {import('playwright').Browser | undefined} */
  let browser
  try {
    const deadline = Date.now() + 30_000
    while (!browser) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    const page = browser.contexts()[0]?.pages()[0]
    if (!page) throw new Error('the app has no page to attach to')
    // CDP can hand the page over before the webview's first navigation, to
    // the app's own origin, has begun: a reload then is aborted by it.
    log('attached at', page.url())
    await page.waitForURL(/^(http|https|tauri):\/\/tauri\.localhost\//, { timeout: TIMEOUT })
    await page.waitForSelector('#btn-send', { timeout: TIMEOUT })
    /** @type {string[]} */
    const errors = []
    page.on('pageerror', e => errors.push(e.message))

    await appSends(page, tmp)
    await appReceives(page, tmp)
    await appDeclines(page, tmp)
    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'))
    console.log('\nAPP-NATIVE E2E PASSED')
  } finally {
    await browser?.close().catch(() => {})
    app.child.kill()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\nFAIL', error.message)
  process.exit(1)
})
