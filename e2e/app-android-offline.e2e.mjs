/**
 * Offline pairing against the Android app, in an emulator, over CDP. The
 * desktop app-native suite covers the app as a listener; this is the one that
 * covers the app as a *dialler*, on Android, on both of its sessions.
 *
 * 1. The app receives a CLI `send --offline` code on its JS session, then on
 *    its native one, and pairs at the code's address, not over a relay.
 * 2. The app sends with Settings' "Pair without internet" on, and the CLI
 *    pairs at the app's listener. The emulator's own address (10.0.2.x) is
 *    not reachable from the host, so the port goes through `adb forward` and
 *    a proxy on the host's private address, and the code's locator is
 *    rewritten to point there. The keys come from the secret alone, so the
 *    rewrite changes where the dialler goes and nothing it proves.
 *
 * The relays are reachable, as in every e2e here, so this shows the ends agree
 * on the rendezvous through the app's real listener and dialler; that neither
 * needs a relay is offline.sh's gate.
 *
 * WAIT BEFORE SCANNING. The Node CLI sender accepts no connection for about
 * two seconds after it prints its code, while it loads its relay stack, and
 * the app's dial budget is three seconds from the first connect. A scan inside
 * that window was measured to fall back to the relays at 2,973 ms in one run
 * and to miss in the next, with the socket's open taking 2-2.8 s; five seconds
 * later the same open took 120-250 ms. A person pointing a camera is slower
 * than that, so the test waits as one would.
 *
 * GIVE AN EMULATOR 4 GB. The qrdrop29 AVD's default 2 GB had the guest
 * swapping 595 MB with load at 4 on 4 cores, and a WebSocket from the page to
 * its own relay on 127.0.0.1 then took up to five seconds to open; the send
 * leg failed four runs in five. At `-memory 4096` it passed five in five,
 * unchanged. A failure here on a starved guest says nothing about a phone.
 *
 * Needs the debug app running in an emulator or on a device:
 * `mise run app:android:build -- --debug --target x86_64`, `adb install -r`
 * the universal debug APK, launch it, then run this under `mise exec` (for
 * adb). ADB names another adb.
 */

import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { decodePairing, encodeSecret } from '../src/core/secret.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ADB = process.env.ADB ?? 'adb'
const TIMEOUT = 90_000
const CDP_PORT = 9334
const CODE_RE = /Transfer code: (qrdrop:[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]+)?)/
// Long enough for the Node CLI to be accepting; see the header.
const SCAN_DELAY_MS = 5000

/** @param {string[]} args */
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' })
/** @param {Uint8Array} buf */
const sha = buf => createHash('sha256').update(buf).digest('hex')
/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The Node CLI, with its output gathered for `waitFor` and stdin open for the
 * answers: app-native.e2e.mjs's helper, cut to what this suite asks of it.
 *
 * @param {string[]} args
 * @param {string} label
 */
function cli(args, label) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), ...args], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  })
  let output = ''
  /** @type {(() => void)[]} */
  const listeners = []
  /** @param {string} chunk */
  const absorb = chunk => {
    output += chunk
    process.stderr.write(`  [${label}] ${chunk}`)
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
    /**
     * @param {RegExp} pattern
     * @returns {Promise<RegExpExecArray>}
     */
    waitFor: pattern => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`[${label}] timed out on ${pattern}\n${output}`)), TIMEOUT)
      const check = () => {
        const hit = pattern.exec(output)
        if (!hit) return void listeners.push(check)
        clearTimeout(deadline)
        resolve(hit)
      }
      check()
    }),
    /** @type {Promise<number | null>} */
    exited: new Promise(resolve => child.on('exit', resolve)),
  }
}

/** @param {ReturnType<typeof cli>} peer */
async function cliSas(peer) {
  const [, line] = await peer.waitFor(/Both devices should be showing:\s*\n\s*\n\s*(\S.*?)\s*\n/)
  return String(line).trim().split('   ').map(pair => pair.split(' ')[0]).join(' ')
}

/**
 * @param {import('playwright').Page} page
 * @param {string} selector
 */
const text = async (page, selector) => (await page.textContent(selector))?.trim() ?? ''

/**
 * Sets the two app switches, which are localStorage keys, and reloads to the
 * choose screen so a session-mode change takes effect.
 *
 * @param {import('playwright').Page} page
 * @param {Record<string, string | null>} storage
 */
async function toChoose(page, storage) {
  await page.evaluate(entries => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
  }, storage)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#btn-send', { timeout: TIMEOUT })
}

/**
 * @param {import('playwright').Page} page
 * @param {boolean} native
 */
async function appReceives(page, native) {
  const label = native ? 'app(native)' : 'app(js)'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrdrop-android-'))
  const name = `qrdrop-e2e-${randomBytes(4).toString('hex')}.bin`
  const payload = randomBytes(512 * 1024)
  fs.writeFileSync(path.join(tmp, name), payload)
  await toChoose(page, { 'qrdrop:native-session': native ? '1' : '0', 'qrdrop:offline-pairing': null })
  const peer = cli(['send', path.join(tmp, name), '--no-qr', '--offline'], 'send:js')
  try {
    const [, code] = await peer.waitFor(CODE_RE)
    if (!code.includes('.')) throw new Error('the CLI printed no locator')
    await sleep(SCAN_DELAY_MS)
    // A deep link's road in, as app-native's receive takes it.
    await page.evaluate(c => { location.hash = c }, code)
    await page.waitForSelector('#screen-verify:not([hidden])', { timeout: TIMEOUT })
    await peer.waitFor(/Paired over the local network/)
    const appSas = await text(page, '#sas')
    const theirs = await cliSas(peer)
    if (appSas !== theirs) throw new Error(`SAS mismatch: app ${appSas} vs CLI ${theirs}`)
    peer.say('y')
    await page.waitForSelector('#verify-status button.primary:has-text("Accept")', { timeout: TIMEOUT })
    await page.click('#verify-status button.primary')
    const exit = await peer.exited
    if (exit !== 0) throw new Error(`qrdrop send exited ${exit}`)
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })
    const appDigest = await text(page, '#done-digest')
    const cliDigest = /digest=([0-9a-f]{64})/.exec(peer.output)?.[1]
    if (appDigest !== cliDigest) throw new Error(`digest mismatch: app ${appDigest} vs CLI ${cliDigest}`)
    // What MediaStore published, read back from the device, not the digest
    // the app computed on the way in.
    const saved = `/sdcard/Download/qrdrop/${name}`
    const onDevice = adb('shell', 'sha256sum', saved).split(' ')[0]
    adb('shell', 'rm', saved)
    if (onDevice !== sha(payload)) throw new Error(`the saved file differs: ${onDevice}`)
    console.log(`\nPASS  js --offline -> ${label}  ${payload.length} bytes, paired at the code's address`)
  } finally {
    peer.child.kill()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** The host's private IPv4 address, which the CLI will agree to dial. */
function hostAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        return a.address
      }
    }
  }
  throw new Error('this host has no private IPv4 address')
}

/** @param {import('playwright').Page} page */
async function appSends(page) {
  await toChoose(page, { 'qrdrop:native-session': '0', 'qrdrop:offline-pairing': '1' })
  const payload = randomBytes(256 * 1024)
  // A File built in the page: on Android a native send needs a path the
  // shell can open, and the JS session is the Android default anyway.
  const accepted = await page.evaluate(
    bytes => /** @type {any} */ (document.querySelector('qr-drop')).sendFile(new File([new Uint8Array(bytes)], 'from-android.bin')),
    Array.from(payload),
  )
  if (!accepted) throw new Error('sendFile declined on the choose screen')
  await page.waitForFunction(
    () => /^qrdrop:\S+\./.test(document.querySelector('qr-drop')?.shadowRoot?.querySelector('#manual-code')?.textContent?.trim() ?? ''),
    null, { timeout: TIMEOUT },
  )
  const { secret, locator } = decodePairing(await text(page, '#manual-code'))
  if (!locator?.addresses.some(a => a.startsWith('10.0.2.'))) {
    throw new Error(`the app's locator does not name the emulator: ${JSON.stringify(locator)}`)
  }
  const { port } = locator

  // The host's address, forwarded to the app's port: see the header. Both
  // host ports are whatever is free, since the app's own number may be taken
  // here, and the rewritten locator names the proxy's.
  const forwarded = Number(adb('forward', 'tcp:0', `tcp:${port}`).trim())
  const host = hostAddress()
  const proxy = net.createServer(inbound => {
    const outbound = net.connect(forwarded, '127.0.0.1')
    inbound.pipe(outbound)
    outbound.pipe(inbound)
    inbound.on('error', () => outbound.destroy())
    outbound.on('error', () => inbound.destroy())
  })
  await new Promise((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, host, () => resolve(undefined))
  })
  const proxyPort = /** @type {import('node:net').AddressInfo} */ (proxy.address()).port
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrdrop-android-out-'))
  const peer = cli(['receive', encodeSecret(secret, { port: proxyPort, addresses: [host] }), '--out', tmp], 'recv:js')
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
    const [file] = fs.readdirSync(tmp)
    if (!fs.readFileSync(path.join(tmp, file)).equals(payload)) throw new Error('the received bytes differ')
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: TIMEOUT })
    console.log(`\nPASS  app(js) -> js offline  ${payload.length} bytes, paired at the app's listener`)
  } finally {
    peer.child.kill()
    proxy.close()
    adb('forward', '--remove', `tcp:${forwarded}`)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function main() {
  const socket = /(webview_devtools_remote_\d+)/.exec(adb('shell', 'cat', '/proc/net/unix'))
  if (!socket) throw new Error('no WebView devtools socket: is the debug app open on the device?')
  adb('forward', `tcp:${CDP_PORT}`, `localabstract:${socket[1]}`)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  const page = browser.contexts()[0]?.pages().find(p => /tauri\.localhost/.test(p.url()))
  if (!page) throw new Error('the app has no page to attach to')
  /** @type {string[]} */
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  try {
    await appReceives(page, false)
    await appReceives(page, true)
    await appSends(page)
    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'))
    console.log('\nAPP-ANDROID OFFLINE E2E PASSED')
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem('qrdrop:offline-pairing')
      localStorage.removeItem('qrdrop:native-session')
    }).catch(() => {})
    await browser.close().catch(() => {})
    adb('forward', '--remove', `tcp:${CDP_PORT}`)
  }
}

main().catch(error => {
  console.error('\nFAIL', error.message)
  process.exit(1)
})
