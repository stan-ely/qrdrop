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
import process from 'node:process'

import {
  generateSecret, encodeSecret, decodeSecret, deriveTopic, derivePassword,
  openRoom, STRATEGIES, RELAYED_MAX_BYTES, createControlStream, createReceiver, sendFile,
} from './index.js'
import { createFileSink, fromPath, renderQRToTerminal, loadRTCPolyfill } from './node/index.js'

const USAGE = `qrdrop -- send a file peer-to-peer, keyed by a QR code

Usage:
  qrdrop send <file> [--no-qr] [--yes] [--strategy <name>] [--relay <url>]... [--debug]
  qrdrop receive [code] [--out <dir>] [--yes] [--strategy <name>] [--relay <url>]... [--debug]
  qrdrop --help
  qrdrop --version

Options:
  --no-qr          Don't draw the QR code (the qrdrop:... code is always printed too)
  --out <dir>      Directory to save into (receive only; default: current directory)
  --strategy <name> Pair over one signalling network only: nostr or torrent.
                    Default races both and uses whichever connects first.
  --relay <url>    Pair over Nostr only, using these relays instead of the
                    built-in list (repeatable; implies --strategy nostr)
  --yes            Skip the "accept this file?" prompt on receive.
                    Never skips the code-match confirmation -- see below.
  --debug          Print stack traces instead of one-line error messages
  --help           Show this message
  --version        Show the installed version

A transfer that ends up going through a public TURN relay (rare -- only when a
direct connection cannot be made) is capped at ${Math.round(RELAYED_MAX_BYTES / (1024 * 1024))} MB.

Every transfer -- send or receive -- stops to show four emoji and asks you to
confirm they match on both devices before anything about the file moves. That
check is what stops a third party from slipping into the exchange; --yes does
not and cannot skip it.
`

/** @param {number} n */
function formatBytes(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

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

  const matched = await prompter.confirm(
    `\nBoth devices should be showing:\n\n  ${room.session.sas}\n\nDo they match?`,
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
 * @param {ReturnType<typeof makePrompter>} args.prompter
 */
async function runSend({ filePath, showQR, relays, strategy, prompter }) {
  const source = await fromPath(filePath)
  let room

  try {
    const secret = generateSecret()
    const code = encodeSecret(secret)

    if (showQR) {
      process.stdout.write(`\n${renderQRToTerminal(code)}\n\n`)
    }
    process.stdout.write(`Code: ${code}\n`)

    const sessionEnded = { done: false }
    room = await establish({ secret, role: 'host', relays, strategy, prompter })

    // Free TURN is metered; a large file over it will be throttled or cut.
    // Refuse before the manifest goes out rather than fail partway through.
    if (source.size > RELAYED_MAX_BYTES && await room.isRelayed()) {
      throw new Error(
        `This connection is going through a public relay, capped at `
        + `${formatBytes(RELAYED_MAX_BYTES)}. ${source.name} is ${formatBytes(source.size)}. `
        + `Try again on a network where a direct connection is possible.`,
      )
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
      if (!sessionEnded.done) control.fail(new Error('The other device disconnected.'))
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
      process.stdout.write('The other device declined the file.\n')
      return 1
    }

    process.stdout.write(`Sent. digest=${result.digest}\n`)
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
  const raw = code ?? await prompter.ask('Code: ')
  const secret = decodeSecret(raw)
  const createSink = createFileSink({ outDir })

  /** @type {PairedRoom | undefined} */
  let room

  try {
    // Bound to a const because the checker cannot carry the narrowing of a
    // reassignable `room` into the callbacks below -- while `finally` still
    // needs the outer binding, to close a room we may have failed after.
    const sessionEnded = { done: false }
    const paired = await establish({ secret, role: 'guest', relays, strategy, prompter })
    room = paired

    process.stdout.write('\nWaiting for the sender to offer a file…\n')
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
        if (!sessionEnded.done) reject(new Error('The other device disconnected.'))
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
                process.stdout.write(
                  `\nRefused: ${describe} is over the ${formatBytes(RELAYED_MAX_BYTES)} limit `
                  + `for a transfer going through a public relay.\n`,
                )
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
      process.stdout.write('Declined.\n')
      return 0
    }

    process.stdout.write(`Received ${outcome.file.name}. digest=${outcome.file.digest}\n`)
    return 0
  } finally {
    room?.close()
  }
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
 *   | { command: 'send', filePath: string, showQR: boolean, relays: readonly string[] | undefined, strategy: string | undefined, debug: boolean }
 *   | { command: 'receive', code: string | undefined, outDir: string, assumeYes: boolean, relays: readonly string[] | undefined, strategy: string | undefined, debug: boolean }
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
  if (command !== 'send' && command !== 'receive') {
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
      relay: { type: 'string', multiple: true },
      strategy: { type: 'string' },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    process.stdout.write(USAGE)
    return { command: 'help' }
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
        relays: parsed.relays, strategy: parsed.strategy, prompter,
      })
    }
    return await runReceive({
      code: parsed.code, outDir: parsed.outDir, assumeYes: parsed.assumeYes,
      relays: parsed.relays, strategy: parsed.strategy, prompter,
    })
  } catch (error) {
    if (parsed.debug) {
      console.error(error)
    } else {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    }
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
