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
 * 4. The app sends text from the compose sheet, past the same SAS, and the CLI
 *    saves it: the CLI has no idea it was typed.
 * 5. The app receives text, from send-text-peer.mjs since neither CLI offers
 *    any. It is shown on the done screen, and nothing lands in Downloads.
 * 6. History holds those five, in a QRDROP_HISTORY_DIR of the suite's own,
 *    with no code, digest or message text anywhere in the file.
 * 7. With Settings' "Pair without internet" on, the app sends on each of its
 *    sessions, native and then the page's own, with a code that carries this
 *    machine's address, and the CLI pairs at that address rather than over a
 *    relay. The relays are reachable here, so what this proves is that the
 *    two ends agree on the rendezvous through the app's listeners; that
 *    neither needs a relay is offline.sh's gate. After History, so its five
 *    stay five. Binding on every interface is what raises Windows' firewall
 *    prompt, and the switch is how a person asks for it; the CLI dials this
 *    machine's own address, which the firewall does not stand between.
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

/**
 * @param {import('playwright').Page} page
 * @param {string} tmp
 */
async function appSendsText(page, tmp) {
  const message = `sent from the app's native session ${randomBytes(4).toString('hex')} é世`
  const outDir = fs.mkdtempSync(path.join(tmp, 'cli-text-'))

  await toChoose(page)
  await page.click('#btn-text')
  await page.fill('#text-input', message)
  await page.click('#btn-text-send')
  await page.waitForFunction(
    () => /^qrdrop:/.test(document.querySelector('qr-drop')?.shadowRoot?.querySelector('#manual-code')?.textContent?.trim() ?? ''),
    null, { timeout: TIMEOUT },
  )
  const code = await text(page, '#manual-code')

  const peer = cli(['receive', code, '--out', outDir], 'recv:js')
  try {
    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    const appSas = await text(page, '#sas')
    const theirs = await cliSas(peer)
    if (appSas !== theirs) throw new Error(`SAS mismatch: app ${appSas} vs CLI ${theirs}`)
    peer.say('y')
    // The SAS before any manifest: with the CLI's half answered, nothing may
    // reach it until the app's Confirm is pressed.
    await new Promise(resolve => setTimeout(resolve, 3000))
    if (/Incoming:/.test(peer.output)) throw new Error('an offer reached the peer before the SAS was confirmed')
    log('SAS agreed, no offer before Confirm:', appSas)

    await page.click('#verify-status button.primary')
    await peer.waitFor(/Incoming:.*Accept\?/)
    peer.say('y')

    const exit = await peer.exited
    if (exit !== 0) throw new Error(`qrdrop receive exited ${exit}`)
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })
    const landed = fs.readFileSync(path.join(outDir, 'message.txt'), 'utf8')
    if (landed !== message) throw new Error(`text differs: sent ${message}, got ${landed}`)
    console.log(`\nPASS  app(native) text -> js  ${Buffer.byteLength(landed)} bytes`)
  } finally {
    peer.child.kill()
  }
}

/**
 * @param {import('playwright').Page} page
 */
async function appReceivesText(page) {
  const message = `sent to the app's native session ${randomBytes(4).toString('hex')} é世\n<b>inert</b>`
  const folder = path.join(os.homedir(), 'Downloads', 'qrdrop')
  const listing = () => (fs.existsSync(folder) ? fs.readdirSync(folder).sort().join('\n') : '')
  const before = listing()

  const peer = launch(process.execPath, [path.join(ROOT, 'e2e', 'send-text-peer.mjs'), message], 'send:text')
  try {
    const [, code] = await peer.waitFor(/(qrdrop:[A-Za-z0-9_-]{43})/)
    await toChoose(page)
    await page.evaluate(c => { location.hash = c }, code)

    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    const appSas = await text(page, '#sas')
    const theirs = await cliSas(peer)
    if (appSas !== theirs) throw new Error(`SAS mismatch: app ${appSas} vs peer ${theirs}`)
    log('SAS agreed:', appSas)

    await page.waitForSelector('#verify-status button.primary:has-text("Accept")', { timeout: TIMEOUT })
    await page.click('#verify-status button.primary')

    const exit = await peer.exited
    if (exit !== 0) throw new Error(`the text peer exited ${exit}`)
    await page.waitForSelector('#done-text', { timeout: TIMEOUT })

    const shown = await page.textContent('#done-text')
    if (shown !== message) throw new Error(`text differs: sent ${message}, shown ${shown}`)
    if (listing() !== before) throw new Error('text reached the Downloads folder')
    await page.waitForSelector('button:has-text("Save as file")', { timeout: TIMEOUT })
    console.log(`\nPASS  js text -> app(native)  ${Buffer.byteLength(message)} bytes shown, nothing written`)
  } finally {
    peer.child.kill()
  }
}

/**
 * What the five legs above left in History: one entry each, newest first,
 * read from the file history.rs wrote rather than from the page, and then
 * the same list drawn on the History page.
 *
 * The file is also searched, whole, for what must never be in it. The codes,
 * the digests and both messages went past the component during the legs
 * above, so a record that carried any of them would carry it here.
 *
 * @param {import('playwright').Page} page
 * @param {string} dir QRDROP_HISTORY_DIR
 */
async function appHistory(page, dir) {
  const file = path.join(dir, 'history.json')
  // The last append is a moment behind the done screen.
  const deadline = Date.now() + 10_000
  /** @type {{ enabled: boolean, entries: any[] }} */
  let store = { enabled: true, entries: [] }
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (store.entries.length >= 5) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const raw = fs.readFileSync(file, 'utf8')
  const shape = store.entries.map(e => `${e.direction} ${e.kind} ${e.outcome}`)
  const expected = [
    'received text received', 'sent text sent', 'received file declined', 'received file received', 'sent file sent',
  ]
  if (JSON.stringify(shape) !== JSON.stringify(expected)) {
    throw new Error(`history holds\n  ${shape.join('\n  ')}\nexpected\n  ${expected.join('\n  ')}`)
  }
  for (const e of store.entries.filter(e => e.kind === 'text')) {
    if (e.name !== null || e.location !== null) throw new Error(`a message was recorded with a name or place: ${JSON.stringify(e)}`)
  }
  if (store.entries[4].name !== 'from-app.bin') throw new Error(`the sent file is recorded as ${store.entries[4].name}`)
  if (!/^Downloads\/qrdrop\//.test(store.entries[3].location ?? '')) {
    throw new Error(`the received file's location is ${store.entries[3].location}`)
  }
  for (const [what, pattern] of /** @type {const} */ ([
    ['a pairing code', /qrdrop:[A-Za-z0-9_-]{43}/],
    ['a digest', /[0-9a-f]{64}/],
    ['message text', /native session|é世|inert/],
  ])) {
    if (pattern.test(raw)) throw new Error(`history.json holds ${what}`)
  }

  await toChoose(page)
  await page.click('#nav-history')
  await page.waitForSelector('#app-page .entry', { timeout: TIMEOUT })
  const names = await page.$$eval('#app-page .entry-name', els => els.map(e => e.textContent))
  if (names.length !== 5 || names[0] !== 'Message' || names[4] !== 'from-app.bin') {
    throw new Error(`the History page shows ${names.join(', ')}`)
  }
  await page.click('#nav-back')
  console.log('\nPASS  app(native) history  five entries, newest first, no code, digest or text in it')
}

/**
 * The app sends with "Pair without internet" on (app/src/offline.js's key),
 * on the native session or, with `native` false, the page's own: the
 * localStorage override switches the session for the reload toChoose does.
 *
 * @param {import('playwright').Page} page
 * @param {string} tmp
 * @param {{ native: boolean }} opts
 */
async function appSendsOffline(page, tmp, { native }) {
  const label = native ? 'app(native)' : 'app(js)'
  const payload = randomBytes(256 * 1024)
  const source = path.join(tmp, 'offline.bin')
  fs.writeFileSync(source, payload)
  const outDir = fs.mkdtempSync(path.join(tmp, 'cli-offline-'))

  await page.evaluate(js => {
    localStorage.setItem('qrdrop:offline-pairing', '1')
    if (js) localStorage.setItem('qrdrop:native-session', '0')
    else localStorage.removeItem('qrdrop:native-session')
  }, !native)
  await toChoose(page)
  // A path for the native session; a File built in the page for its own,
  // which cannot open a path.
  const accepted = native
    ? await page.evaluate(
      file => /** @type {any} */ (document.querySelector('qr-drop')).sendFile(file),
      { path: source, name: 'offline.bin', size: payload.length },
    )
    : await page.evaluate(
      bytes => /** @type {any} */ (document.querySelector('qr-drop'))
        .sendFile(new File([new Uint8Array(bytes)], 'offline.bin')),
      Array.from(payload),
    )
  if (!accepted) throw new Error('sendFile declined on the choose screen')
  await page.waitForFunction(
    () => /^qrdrop:/.test(document.querySelector('qr-drop')?.shadowRoot?.querySelector('#manual-code')?.textContent?.trim() ?? ''),
    null, { timeout: TIMEOUT },
  )
  const code = await text(page, '#manual-code')
  if (!/^qrdrop:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error(`${label}: the code carries no locator: ${code}`)
  }
  log(label, 'shows a code with a locator')

  const peer = cli(['receive', code, '--out', outDir], 'recv:js')
  try {
    await peer.waitFor(/Paired over the local network/)
    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    const appSas = await text(page, '#sas')
    const theirs = await cliSas(peer)
    if (appSas !== theirs) throw new Error(`SAS mismatch: app ${appSas} vs CLI ${theirs}`)

    await page.click('#verify-status button.primary')
    peer.say('y')
    await peer.waitFor(/Incoming:.*Accept\?/)
    peer.say('y')
    const exit = await peer.exited
    if (exit !== 0) throw new Error(`qrdrop receive exited ${exit}`)
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })

    const written = fs.readdirSync(outDir)
    const landed = fs.readFileSync(path.join(outDir, written[0]))
    if (!landed.equals(payload)) throw new Error(`bytes differ: sent ${sha(payload)}, got ${sha(landed)}`)
    console.log(`\nPASS  ${label} -> js offline  ${landed.length} bytes, paired at the code's address`)
  } finally {
    peer.child.kill()
    await page.evaluate(() => {
      localStorage.removeItem('qrdrop:offline-pairing')
      localStorage.removeItem('qrdrop:native-session')
    })
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only: it attaches to WebView2 over CDP')
  if (!fs.existsSync(APP)) throw new Error(`no app at ${APP}: build it with \`npx tauri build --debug --no-bundle\` in app/`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrdrop-app-native-'))
  // Its own, so these transfers stay out of the History of an installed copy,
  // which shares the debug build's data directory, and so it starts empty.
  const historyDir = path.join(tmp, 'history')
  const app = launch(APP, [], 'app', {
    QRDROP_HISTORY_DIR: historyDir,
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
    await appSendsText(page, tmp)
    await appReceivesText(page)
    await appHistory(page, historyDir)
    await appSendsOffline(page, tmp, { native: true })
    await appSendsOffline(page, tmp, { native: false })
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
