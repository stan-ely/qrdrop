/**
 * Zero-dependency ANSI colour for the CLI.
 *
 * No chalk, no picocolors -- raw escape codes behind six named helpers. This
 * project's stated position (see cli.js's header) is that every dependency is
 * one more thing between `npm install` and a working transfer, and colouring
 * six kinds of line is not a reason to add one.
 *
 * COLOUR IS DECIDED ONCE, PER STREAM, AT MODULE LOAD. stdout and stderr each
 * get their own on/off decision -- `stdout.isTTY` and `stderr.isTTY` are
 * independent (a script can redirect one and not the other, and the
 * interop e2e redirects both to a pipe it reads itself), so one flag cannot
 * cover both. `styleFor(stream)` returns the right set of helpers for
 * whichever stream a call site is about to write to.
 *
 * WHEN DISABLED, EVERY HELPER IS THE IDENTITY FUNCTION. This is not
 * cosmetic: e2e/interop.e2e.mjs and a plain shell pipe both parse the CLI's
 * stdout, and this is what keeps that output byte-for-byte what it is with
 * colour compiled out entirely, rather than "close, minus some escape codes
 * we hope nothing depends on."
 */

import process from 'node:process'

/**
 * @param {NodeJS.WriteStream | { isTTY?: boolean }} stream
 * @returns {boolean}
 */
function shouldColour(stream) {
  // FORCE_COLOR is the one override: sets like CI runners that pipe a TTY
  // through something that still wants colour rely on being able to say so
  // explicitly, in either direction (an unset/empty value does not count).
  if (process.env.FORCE_COLOR) return true
  if (process.env.NO_COLOR) return false
  if (process.env.TERM === 'dumb') return false
  return Boolean(stream.isTTY)
}

const CODES = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  accent: '\x1b[36m', // cyan -- the Code:/QR line, informational rather than a verdict
  ok: '\x1b[32m', // green -- sent/received
  bad: '\x1b[31m', // red -- errors and failed transfers
  warn: '\x1b[33m', // yellow -- declined, relay-capped
}
const RESET = '\x1b[0m'

const identity = (
  /** @type {string} */ s,
) => s

/** @typedef {{ bold: (s: string) => string, dim: (s: string) => string, accent: (s: string) => string, ok: (s: string) => string, bad: (s: string) => string, warn: (s: string) => string }} Style */

/** @type {Style} */
const plain = { bold: identity, dim: identity, accent: identity, ok: identity, bad: identity, warn: identity }

/** @returns {Style} */
function makeStyle() {
  /** @type {Record<keyof typeof CODES, (s: string) => string>} */
  // @ts-expect-error -- populated in the loop below
  const style = {}
  for (const name of /** @type {(keyof typeof CODES)[]} */ (Object.keys(CODES))) {
    style[name] = s => `${CODES[name]}${s}${RESET}`
  }
  return style
}

const coloured = makeStyle()

/**
 * @param {{ isTTY?: boolean }} stream Pass `process.stdout` or `process.stderr`.
 * @returns {Style}
 */
export function styleFor(stream) {
  return shouldColour(stream) ? coloured : plain
}
