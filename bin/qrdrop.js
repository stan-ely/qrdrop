#!/usr/bin/env node
/**
 * The `qrdrop` command: the Rust CLI where this platform has one, the Node
 * CLI (src/cli.js) where it does not.
 *
 * The binary comes from an optional dependency named for this platform,
 * `qrdrop-<process.platform>-<process.arch>`, which npm installed only on a
 * machine whose os and cpu it matches (scripts/npm-platforms.mjs builds them).
 * The name is a rule here and not a list, so a platform with no package -- or
 * an install made with --omit=optional, or a checkout, which never has one --
 * simply finds nothing and runs the Node CLI, which speaks the same wire with
 * the same flags, exit codes and stdout (e2e/interop.e2e.mjs --matrix holds
 * the two to that). Falling back silently is the point: neither is a degraded
 * mode of the other.
 *
 * QRDROP_CLI=js runs the Node CLI regardless, and QRDROP_CLI=native refuses to
 * fall back, for anyone who needs to know which one they have.
 *
 * SIGNALS. The child shares this process's terminal, so a Ctrl-C reaches it
 * directly -- the whole foreground process group gets SIGINT, and on Windows
 * every process on the console gets the event. This process therefore ignores
 * SIGINT and waits for the child, whose own handler leaves the room and exits
 * 130. Forwarding it as well would deliver it twice. A SIGTERM or SIGHUP sent to
 * this process alone, as a supervisor sends one, is passed on, or the child
 * would outlive it holding the room open.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const mode = process.env.QRDROP_CLI

/** @returns {string | null} */
function nativeBinary() {
  const name = `qrdrop-${process.platform}-${process.arch}`
  try {
    const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`)
    return path.join(path.dirname(manifest), process.platform === 'win32' ? 'qrdrop.exe' : 'qrdrop')
  } catch {
    return null
  }
}

const binary = mode === 'js' ? null : nativeBinary()

if (!binary) {
  if (mode === 'native') {
    console.error(`qrdrop: QRDROP_CLI=native, and no qrdrop-${process.platform}-${process.arch} package is installed.`)
    process.exit(1)
  }
  // src/cli.js runs on import, with this process's argv.
  await import('../src/cli.js')
} else {
  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' })
  process.on('SIGINT', () => {})
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGHUP'])) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('error', error => {
    console.error(`qrdrop: could not run ${binary}: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      // Die of the same signal, so a shell sees what the child died of.
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })
}
