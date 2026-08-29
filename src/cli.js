#!/usr/bin/env node
/**
 * qrdrop: send a file straight from one device to another over WebRTC, keyed
 * by a QR code, with nothing readable in between.
 *
 *   qrdrop send <file> [--no-qr] [--yes] [--relay <url>]... [--debug]
 *   qrdrop receive [code] [--out <dir>] [--yes] [--relay <url>]... [--debug]
 *   qrdrop --help | --version
 *
 * This is the Node counterpart to src/web/element.js: same protocol, same
 * two-gesture shape (confirm the SAS, then -- on the receiving side -- accept
 * the file), reimplemented against a terminal instead of a page. See that
 * file for the reasoning behind running a receiver on both peers and behind
 * gating the manifest on the SAS confirmation.
 *
 * No argument-parsing dependency: node:util's parseArgs is enough for a CLI
 * this small, and every dependency is one more thing between "npm install"
 * and a working transfer.
 */

import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import process from 'node:process'

import {
  generateSecret, encodeSecret, decodeSecret, deriveTopic, derivePassword,
  openRoom, STRATEGIES, RELAYED_MAX_BYTES, createControlStream, createReceiver, sendFile,
} from './index.js'
import { encodeSecretURL } from './core/secret.js'
import { bytes as formatBytes } from './core/format.js'
import { relayCapMessage, relayCapDeclineMessage, PEER_DISCONNECTED } from './core/messages.js'
import { createFileSink, fromPath, renderQRToTerminal, loadRTCPolyfill, serveStatic } from './node/index.js'
import { openURL } from './node/open-url.js'
import { styleFor } from './cli/style.js'

/**
 * The options table `--help` is generated from, rather than a hand-aligned
 * literal. `--strategy <name>` used to overrun the description column while
 * `--relay`/`--yes` sat one column to its left -- a one-line diff to any flag
 * name would silently reintroduce that drift in a literal. Computing the
 * column from the longest flag, once, makes it impossible instead of just
 * fixed-for-now.
 *
 * @type {ReadonlyArray<{ flag: string, desc: readonly string[] }>}
 */
const OPTIONS = [
  { flag: '--no-qr', desc: [
    `Don't draw the QR code (the qrdrop:... code is always printed too)`,
  ] },
  { flag: '--out <dir>', desc: [
    'Directory to save into (receive only; default: current directory)',
  ] },
  { flag: '--port <n>', desc: [
    'Port for the local web UI (web only; default 4173, 0 picks',
    'a free one)',
  ] },
  { flag: '--no-open', desc: [
    `Don't open a browser; just print the URL (web only)`,
  ] },
  { flag: '--strategy <name>', desc: [
    'Pair over one signalling network only: nostr or torrent.',
    'Default races both and uses whichever connects first.',
  ] },
  { flag: '--relay <url>', desc: [
    'Pair over Nostr only, using these relays instead of the',
    'built-in list (repeatable; implies --strategy nostr)',
  ] },
  { flag: '--qr-url <base>', desc: [
    'Encode the QR as <base>#qrdrop:<code> so a phone camera can',
    'open the web app directly, instead of a code no camera app',
    'can follow. No default: that would silently point CLI users',
    `at a host they didn't choose -- see the code comment on`,
    '--qr-url below.',
  ] },
  { flag: '--yes', desc: [
    `Skip the "accept this file?" prompt on receive.`,
    'Never skips the code-match confirmation -- see below.',
  ] },
  { flag: '--debug', desc: [
    'Print stack traces instead of one-line error messages',
  ] },
  { flag: '--help', desc: [
    'Show this message',
  ] },
  { flag: '--version', desc: [
    'Show the installed version',
  ] },
]

// Two spaces of gap after the longest flag, so nothing ever butts up against
// its own description the way --strategy <name> used to.
const DESC_COL = 2 + Math.max(...OPTIONS.map(o => o.flag.length)) + 2

/**
 * @param {ReadonlyArray<{ flag: string, desc: readonly string[] }>} options
 * @returns {string}
 */
function formatOptions(options) {
  return options.map(({ flag, desc }) => {
    const pad = ' '.repeat(DESC_COL - 2 - flag.length)
    const indent = ' '.repeat(DESC_COL)
    return desc.map((line, i) => (i === 0 ? `  ${flag}${pad}${line}` : `${indent}${line}`)).join('\n')
  }).join('\n')
}

const USAGE = `qrdrop -- send a file peer-to-peer, keyed by a QR code

Usage:
  qrdrop send <file> [--no-qr] [--yes] [--strategy <name>] [--relay <url>]... [--qr-url <base>] [--debug]
  qrdrop receive [code] [--out <dir>] [--yes] [--strategy <name>] [--relay <url>]... [--debug]
  qrdrop web [--port <n>] [--no-open]
  qrdrop --help
  qrdrop --version

Options:
${formatOptions(OPTIONS)}

"qrdrop web" serves this project's browser UI from the copy you installed, on
http://127.0.0.1 — nothing is uploaded, and no other device can reach it. It is
the way to run a transfer whose code you can read before trusting it with a file.

Beaming — an unencrypted, no-network transfer shown as an animated QR code and
read back by a camera — is a browser-only mode inside "qrdrop web". There is no
"qrdrop beam" command: it needs a screen to animate and a camera watching it,
and a terminal on the receiving end has neither.

A transfer that ends up going through a public TURN relay (rare — only when a
direct connection cannot be made) is capped at ${Math.round(RELAYED_MAX_BYTES / (1024 * 1024))} MB.

Every transfer — send or receive — stops to show four emoji and asks you to
confirm they match on both devices before anything about the file moves. That
check is what stops a third party from slipping into the exchange; --yes does
not and cannot skip it.
`

class UsageError extends Error {}

/**
 * A prompt-and-confirm helper bound to one readline interface, so callers
 * never have to remember to close it or handle Ctrl-C themselves.
 *
 * @param {import('node:readline/promises').Interface} rl
 */
function makePrompter(rl) {
  return {
    /** @param {string} question */
    async ask(question) {
      return (await rl.question(question)).trim()
    },
    /**
     * Requires an explicit "y" -- an empty answer (just pressing enter) is a
     * decline, not a default accept. A safety confirmation that treats
     * "I didn't type anything" as "yes" is not a safety confirmation.
     * @param {string} question
     */
    async confirm(question) {
      const answer = await rl.question(`${question} [y/N] `)
      return /^y(es)?$/i.test(answer.trim())
    },
  }
}

/**
 * Renders progress as a single re-drawn line on a TTY (so a long transfer
 * doesn't scroll the terminal to pieces), or as sparse plain lines when
 * stdout is redirected -- a pipe or log file has no concept of "redraw", and
 * a raw \r sprayed into a file is unreadable noise. Matches the
 * bytes-moved-of-total idiom from src/web/element.js's trackProgress.
 *
 * @param {{ verb: string }} args
 */
function makeProgressReporter({ verb }) {
  const isTTY = Boolean(process.stdout.isTTY)
  let lastPrintedAt = 0
  let printedAnything = false

  /** @param {TransferProgress} p */
  return p => {
    const moved = 'sent' in p ? p.sent : p.received
    const done = moved >= p.total
    const now = Date.now()

    // Throttled rather than printed on every chunk: at CHUNK_SIZE = 16 KiB a
    // multi-gigabyte file is tens of thousands of progress callbacks, and a
    // non-TTY line per chunk would dwarf the transfer itself in log volume.
    if (!done && printedAnything && now - lastPrintedAt < 200) return
    lastPrintedAt = now
    printedAnything = true

    const line = `${verb} ${formatBytes(moved)} of ${formatBytes(p.total)}`
    if (isTTY) {
      process.stdout.write(`\r\x1b[K${line}${done ? '\n' : ''}`)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }
}

/**
 * Everything both roles need once the room is up: a receiver, because a
 * sending peer still has to read the accept/done/error replies that arrive
 * as control frames on the same channel a real inbound file would use. See
 * src/web/element.js's attachReceiver for the fuller version of this note.
 *
 * @param {object} args
 * @param {PairedRoom} args.room
 * @param {Parameters<typeof createReceiver>[0]['onOffer']} [args.onOffer]
 * @param {(p: ReceiveProgress) => void} [args.onProgress]
 * @param {(file: { name: string, size: number, digest: string }) => void} [args.onFileDone]
 * @param {(manifest: Manifest) => Promise<Sink>} args.createSink
 */
function attachReceiver({ room, onOffer, onProgress, onFileDone, createSink }) {
  const control = createControlStream()
  let controlOut = 0
  const nextControlIndex = () => controlOut++

  const receiver = createReceiver({
    channel: room.channel,
    sendKey: room.session.sendKey,
    recvKey: room.session.recvKey,
    control,
    nextControlIndex,
    onOffer: onOffer ?? (() => {
      throw new Error('Peer offered a file while we were sending one')
    }),
    onProgress,
    onFileDone,
    onError: error => console.error('Transfer error:', error instanceof Error ? error.message : error),
    createSink,
  })

  // handleFrame serialises internally (see receiver.js), so a burst of
  // frames arriving together cannot race each other here.
  room.onFrame(frame => { receiver.handleFrame(frame).catch(err => console.error(err)) })

  return { control, nextControlIndex }
}

/**
 * Resolves the --strategy / --relay flags to the strategy list openRoom should
 * race. --relay pins to Nostr on the given URLs (chain off); --strategy narrows
 * to one named network on its built-in URLs; neither returns undefined, which
 * lets openRoom race its full default set.
 *
 * @param {object} args
 * @param {readonly string[] | undefined} args.relays
 * @param {string | undefined} args.strategy
 * @returns {readonly SignalingStrategy[] | undefined}
 */
function resolveStrategies({ relays, strategy }) {
  if (relays && relays.length) {
    const nostr = STRATEGIES.find(s => s.name === 'nostr')
    if (!nostr) throw new Error('internal: no nostr strategy to apply --relay to')
    return [{ ...nostr, urls: relays }]
  }
  if (strategy) {
    const picked = STRATEGIES.filter(s => s.name === strategy)
    if (!picked.length) {
      throw new UsageError(
        `Unknown --strategy: ${strategy}. Options: ${STRATEGIES.map(s => s.name).join(', ')}`,
      )
    }
    return picked
  }
  return undefined
}

/**
 * Opens the rendezvous and pairs, then makes the peer confirm the SAS before
 * returning. This is the ONE gate that is never conditional on --yes: it is
 * the entire defence against a third party joining the room instead of the
 * intended peer (see the note on `password` in src/transport/room.js), so a
 * flag that could bypass it would be a vulnerability wearing a convenience
 * feature's name. --yes is threaded through send()/receive() below to skip
 * only the *file accept* prompt, never this one.
 *
 * @param {object} args
 * @param {Bytes} args.secret
 * @param {'host' | 'guest'} args.role
 * @param {readonly string[] | undefined} args.relays
 * @param {string | undefined} args.strategy
 * @param {ReturnType<typeof makePrompter>} args.prompter
 * @returns {Promise<PairedRoom>}
 */
async function establish({ secret, role, relays, strategy, prompter }) {
  const rtcPolyfill = await loadRTCPolyfill()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  // The SAS prompt is asked through the readline interface, whose output is
  // wired to stdout in main() -- so its colour decision is stdout's, not the
  // stderr write two lines below.
  const style = styleFor(process.stdout)

  process.stderr.write('Waiting for the other device…\n')
  const room = await openRoom({
    topic,
    password,
    secret,
    role,
    rtcPolyfill,
    strategies: resolveStrategies({ relays, strategy }),
    onStatus: text => process.stderr.write(`${text}\n`),
  })

  // Each emoji is shown next to its word name (session.js's sasWords, same
  // order as the emoji in session.sas) so two people on a phone call can read
  // the code aloud and agree on it without both staring at the same screen --
  // "cactus" survives a bad connection in a way that describing a small green
  // emoji does not. The raw emoji from session.sas are still exactly what is
  // on screen; only the words are added alongside them.
  const withWords = room.session.sas
    .split(' ')
    .map((emoji, i) => `${emoji} ${room.session.sasWords[i]}`)
    .join('   ')

  const matched = await prompter.confirm(
    `\nBoth devices should be showing:\n\n  ${style.bold(withWords)}\n\nDo they match?`,
  )
  if (!matched) {
    room.close()
    throw new Error('Codes did not match -- refusing to continue. This could mean a third party is in the room.')
  }

  return room
}

/**
 * @param {object} args
 * @param {string} args.filePath
 * @param {boolean} args.showQR
 * @param {readonly string[] | undefined} args.relays
 * @param {string | undefined} args.strategy
 * @param {string | undefined} args.qrUrl
 * @param {ReturnType<typeof makePrompter>} args.prompter
 */
async function runSend({ filePath, showQR, relays, strategy, qrUrl, prompter }) {
  const source = await fromPath(filePath)
  const style = styleFor(process.stdout)
  let room

  try {
    const secret = generateSecret()
    const code = encodeSecret(secret)

    // --qr-url, when given, is the only thing that changes what the QR
    // encodes -- see the flag's own comment in parseCliArgs for why there is
    // no default to fall back to here. The bare code is printed either way,
    // labelled "Code:": e2e/interop.e2e.mjs and every "type the code in by
    // hand" path depend on that exact form still being there.
    const qrText = qrUrl ? encodeSecretURL(secret, qrUrl) : code
    if (showQR) process.stdout.write(`\n${renderQRToTerminal(qrText)}\n\n`)
    if (qrUrl) process.stdout.write(`URL: ${style.accent(qrText)}\n`)
    process.stdout.write(`Transfer code: ${style.accent(code)}\n`)

    const sessionEnded = { done: false }
    room = await establish({ secret, role: 'host', relays, strategy, prompter })

    // Free TURN is metered; a large file over it will be throttled or cut.
    // Refuse before the manifest goes out rather than fail partway through.
    if (source.size > RELAYED_MAX_BYTES && await room.isRelayed()) {
      throw new Error(relayCapMessage({ name: source.name, size: source.size, limit: RELAYED_MAX_BYTES }))
    }
    const { control, nextControlIndex } = attachReceiver({ room, createSink: async () => {
      throw new Error('Peer tried to send us a file mid-send')
    } })

    // A peer that leaves mid-transfer would otherwise park this process on
    // control.next() forever: sendFile blocks awaiting an 'accept' or a 'done'
    // that is now never coming, and no timeout covers that wait. Failing the
    // control stream is what turns an indefinite hang into a reported error.
    //
    // Printing a warning here -- which is what this did first -- looked like
    // handling and was not: the message appeared, and the process still hung.
    //
    // Guarded on sessionEnded because both sides close once a transfer
    // completes, so each sees the other go in the ordinary success case. The
    // interop e2e caught that as 'The other device disconnected.' printed
    // immediately before 'Sent.'
    room.onPeerLeave(() => {
      if (!sessionEnded.done) control.fail(new Error(PEER_DISCONNECTED))
    })

    process.stdout.write(`\nSending ${source.name} (${formatBytes(source.size)})…\n`)
    const onProgress = makeProgressReporter({ verb: 'Sent' })

    const result = await sendFile({
      channel: room.channel,
      key: room.session.sendKey,
      file: source,
      fileSeq: 0,
      control,
      nextControlIndex,
      onProgress,
    })

    // Declined or sent, the exchange is over and the peer is entitled to
    // leave without that being news.
    sessionEnded.done = true

    if (result.declined) {
      process.stdout.write(`${style.warn('The other device declined the file.')}\n`)
      return 1
    }

    process.stdout.write(`${style.ok('Sent.')} digest=${result.digest}\n`)
    return 0
  } finally {
    room?.close()
    await source.close?.()
  }
}

/**
 * @param {object} args
 * @param {string | undefined} args.code
 * @param {string} args.outDir
 * @param {boolean} args.assumeYes
 * @param {readonly string[] | undefined} args.relays
 * @param {string | undefined} args.strategy
 * @param {ReturnType<typeof makePrompter>} args.prompter
 */
async function runReceive({ code, outDir, assumeYes, relays, strategy, prompter }) {
  const raw = code ?? await prompter.ask('Code (or paste a shared link): ')
  const secret = decodeSecret(raw)
  const createSink = createFileSink({ outDir })
  // --out defaults to '.', which says nothing about what that resolves to --
  // and by the time the success line prints, the file has already landed
  // wherever it was going to land. Resolved once here and said before the
  // wait, so it is a question answerable in advance rather than after.
  const outDirAbs = resolve(outDir)
  const style = styleFor(process.stdout)

  /** @type {PairedRoom | undefined} */
  let room

  try {
    // Bound to a const because the checker cannot carry the narrowing of a
    // reassignable `room` into the callbacks below -- while `finally` still
    // needs the outer binding, to close a room we may have failed after.
    const sessionEnded = { done: false }
    const paired = await establish({ secret, role: 'guest', relays, strategy, prompter })
    room = paired

    process.stdout.write(`\nSaving into ${outDirAbs}\n`)
    process.stdout.write('Waiting for the sender to offer a file…\n')
    const onProgress = makeProgressReporter({ verb: 'Received' })

    /**
     * The outcome travels out through the promise rather than through
     * variables the callbacks assign.
     *
     * Mutable outer state works at runtime and is how this started, but the
     * checker cannot see that a callback ran before the read -- it narrows the
     * variable to `never` at the point of use, and it is right to, because
     * nothing in the types says the callback fires at all. Carrying the value
     * through resolve() is honest about that, and is less state to hold.
     *
     * @type {{ kind: 'done', file: { name: string, size: number, digest: string } }
     *       | { kind: 'declined' }}
     */
    const outcome = await new Promise((resolve, reject) => {
      // Same reasoning as the send path: a peer that leaves while we are
      // waiting for an offer, or midway through one, leaves this promise
      // pending with nothing to settle it. Rejecting is what turns that into
      // a reported failure instead of a process that never exits.
      paired.onPeerLeave(() => {
        if (!sessionEnded.done) reject(new Error(PEER_DISCONNECTED))
      })

      attachReceiver({
        room: paired,
        createSink,
        onProgress,
        onFileDone: file => resolve({ kind: 'done', file }),
        onOffer: ({ manifest, accept, decline }) => {
          const describe = `${manifest.name} (${formatBytes(manifest.size)})`
          // Fire-and-forget from onOffer's point of view: onOffer itself is
          // synchronous (see receiver.js), so the accept/decline prompt has
          // to run after it returns rather than inside it.
          ;(async () => {
            try {
              if (manifest.size > RELAYED_MAX_BYTES && await paired.isRelayed()) {
                const refusal = relayCapDeclineMessage({
                  name: manifest.name, size: manifest.size, limit: RELAYED_MAX_BYTES,
                })
                process.stdout.write(`\n${style.warn(`Refused: ${refusal}`)}\n`)
                await decline()
                resolve({ kind: 'declined' })
                return
              }
              const ok = assumeYes || await prompter.confirm(`\nIncoming: ${describe}. Accept?`)
              if (!ok) {
                await decline()
                resolve({ kind: 'declined' })
                return
              }
              process.stdout.write(`Receiving ${describe}…\n`)
              await accept()
            } catch (error) {
              reject(error)
            }
          })()
        },
      })
    })

    sessionEnded.done = true

    if (outcome.kind === 'declined') {
      process.stdout.write(`${style.warn('Declined.')}\n`)
      return 0
    }

    process.stdout.write(
      `${style.ok(`Received ${outcome.file.name}.`)} Saved to ${resolve(outDirAbs, outcome.file.name)}\n`
      + `digest=${outcome.file.digest}\n`,
    )
    return 0
  } finally {
    room?.close()
  }
}

/**
 * `qrdrop web`: serve the built browser UI on localhost and, unless --no-open,
 * point a browser at it.
 *
 * site/dist/ is the same bundle this project deploys, shipped in the npm
 * tarball via package.json "files". Serving it is a file operation, not an
 * import, so nothing here loads src/web/ into Node.
 *
 * This branch never returns. The awaited promise at the end has no resolve
 * path, so main() stays parked and the module-scope `process.exit(code)` at
 * the bottom of this file -- which would kill the server -- never runs. The
 * server keeps the event loop alive until a signal; the SIGINT/SIGTERM
 * handlers here turn Ctrl-C into a clean close() and a 0 exit. main()'s own
 * rl.on('SIGINT') is not wired on this path, because readline is only set up
 * after this call, which does not come back.
 *
 * @param {object} args
 * @param {number} args.port
 * @param {boolean} args.open
 * @returns {Promise<never>}
 */
async function runWeb({ port, open }) {
  const style = styleFor(process.stdout)
  const distURL = new URL('../site/dist/', import.meta.url)

  const { access } = await import('node:fs/promises')
  await access(new URL('index.html', distURL)).catch(() => {
    throw new Error(
      'The web UI is not present in this install. It ships in published ' +
      'releases; from a source checkout, run `npm run build` first.',
    )
  })

  const { url, close } = await serveStatic({ root: fileURLToPath(distURL), port })

  process.stdout.write(`\nqrdrop web UI: ${style.accent(url)}\n`)
  process.stdout.write('Localhost only -- nothing is uploaded, and no other device can reach it.\n')
  process.stdout.write('Press Ctrl-C to stop.\n')

  if (open) {
    const opened = await openURL(url)
    if (!opened) process.stdout.write('Could not open a browser automatically; open the URL above yourself.\n')
  }

  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(signal, () => {
      process.stdout.write('\nStopping.\n')
      close().then(() => process.exit(0), () => process.exit(0))
    })
  }

  // Deliberately never settles -- see the note above. The process ends only
  // through a signal handler's process.exit().
  return new Promise(() => {})
}

/**
 * A discriminated union spelled out explicitly rather than left to
 * inference: the `command` field is what every call site switches on, and
 * without an annotation TypeScript infers it as plain `string` (object
 * literals returned from a function widen their literal properties unless
 * told otherwise), which loses the ability to narrow `parsed.filePath` and
 * friends after an `if (parsed.command === 'send')` check.
 *
 * @typedef {
 *   | { command: 'help' }
 *   | { command: 'version' }
 *   | { command: 'send', filePath: string, showQR: boolean, relays: readonly string[] | undefined, strategy: string | undefined, qrUrl: string | undefined, debug: boolean }
 *   | { command: 'receive', code: string | undefined, outDir: string, assumeYes: boolean, relays: readonly string[] | undefined, strategy: string | undefined, debug: boolean }
 *   | { command: 'web', port: number, open: boolean, debug: boolean }
 * } ParsedArgs
 */

/**
 * @param {readonly string[]} argv
 * @returns {ParsedArgs}
 */
function parseCliArgs(argv) {
  const [command, ...rest] = argv

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return { command: 'help' }
  }
  if (command === '--version') {
    return { command: 'version' }
  }
  // A tailored miss rather than the generic one below. Someone typing this
  // has read about beaming and wants it; "Unknown command" followed by a dump
  // of every flag answers a question they did not ask, and leaves them no
  // better off than before.
  if (command === 'beam') {
    throw new UsageError(
      'There is no "qrdrop beam" command. Beaming — an unencrypted, no-network transfer\n'
      + 'read by a camera — is a browser-only mode: run "qrdrop web" and choose it on\n'
      + 'the page.\n',
    )
  }
  if (command !== 'send' && command !== 'receive' && command !== 'web') {
    throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`)
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      // Node's parseArgs has no --no-<flag> negation, so the negative form is
      // its own option rather than an inverted `qr`. Declaring `qr` and
      // hoping --no-qr would negate it is what shipped first, and it threw
      // ERR_PARSE_ARGS_UNKNOWN_OPTION on a flag that --help documents.
      'no-qr': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      out: { type: 'string', default: '.' },
      // web only. Same --no-<flag> story as no-qr above: parseArgs has no
      // negation, so the off switch is its own boolean.
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      relay: { type: 'string', multiple: true },
      strategy: { type: 'string' },
      // No default -- deliberately. A default here would be a hosted origin
      // this project doesn't control, and every CLI user who never asked for
      // it would have their code silently start pointing a scanning phone at
      // that origin instead of at nothing. Send-only, and opt-in per run.
      'qr-url': { type: 'string' },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    process.stdout.write(USAGE)
    return { command: 'help' }
  }

  if (command === 'web') {
    // Number(), not parseInt(): parseInt('4173x') is 4173, and a port typo
    // that silently half-parses is worse than one that is rejected.
    const port = values.port === undefined ? 4173 : Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(`--port must be a whole number from 0 to 65535, got: ${values.port}\n\n${USAGE}`)
    }
    return { command, port, open: !values['no-open'], debug: values.debug }
  }

  if (command === 'send') {
    const [filePath] = positionals
    if (!filePath) throw new UsageError(`send requires a file path\n\n${USAGE}`)
    return {
      command,
      filePath,
      showQR: !values['no-qr'] && Boolean(process.stdout.isTTY),
      relays: values.relay,
      strategy: values.strategy,
      qrUrl: values['qr-url'],
      debug: values.debug,
    }
  }

  return {
    command,
    code: positionals[0],
    outDir: /** @type {string} */ (values.out),
    assumeYes: values.yes,
    relays: values.relay,
    strategy: values.strategy,
    debug: values.debug,
  }
}

/**
 * The failure report shared by the web branch and the send/receive branch of
 * main(): a one-line message on stderr, or the full stack under --debug.
 *
 * @param {unknown} error
 * @param {boolean} debug
 */
function reportError(error, debug) {
  if (debug) {
    console.error(error)
    return
  }
  const style = styleFor(process.stderr)
  process.stderr.write(`${style.bad('Error:')} ${error instanceof Error ? error.message : String(error)}\n`)
}

async function main() {
  let parsed
  try {
    parsed = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    throw error
  }

  if (parsed.command === 'help') return 0
  if (parsed.command === 'version') {
    const { readFile } = await import('node:fs/promises')
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(await readFile(url, 'utf8'))
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }

  // Before readline: `web` has no prompt, and its handler must not sit behind
  // the interface's SIGINT wiring, which is meant for an open transfer.
  if (parsed.command === 'web') {
    try {
      return await runWeb({ port: parsed.port, open: parsed.open })
    } catch (error) {
      reportError(error, parsed.debug)
      return 1
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const prompter = makePrompter(rl)

  // SIGINT during a prompt or an open room should not leave a relay
  // connection or a half-written file behind; readline's own 'SIGINT'
  // event fires on Ctrl-C while a question() is pending, and this closes
  // the interface (which restores the terminal) before the process exits.
  rl.on('SIGINT', () => {
    rl.close()
    process.stderr.write('\nCancelled.\n')
    process.exit(130)
  })

  try {
    if (parsed.command === 'send') {
      return await runSend({
        filePath: parsed.filePath, showQR: parsed.showQR,
        relays: parsed.relays, strategy: parsed.strategy, qrUrl: parsed.qrUrl, prompter,
      })
    }
    return await runReceive({
      code: parsed.code, outDir: parsed.outDir, assumeYes: parsed.assumeYes,
      relays: parsed.relays, strategy: parsed.strategy, prompter,
    })
  } catch (error) {
    reportError(error, parsed.debug)
    return 1
  } finally {
    rl.close()
  }
}

const code = await main()
// node-datachannel's relay sockets and native peer connections do not
// release the event loop on their own even after room.close() -- verified
// while building src/node/rtc.js: a script that opens and closes a room with
// no other pending work still hangs indefinitely. An explicit exit is what
// makes the CLI actually return control to the shell instead of hanging
// after a successful (or failed) transfer.
process.exit(code)
