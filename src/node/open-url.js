/**
 * Open a URL in the user's default browser, for `qrdrop web` to save the
 * "now go and paste this into a browser" step.
 *
 * This is deliberately not a dependency. The `open` package does a little more
 * (WSL awareness, an app-name option) but this project's stated position is
 * that every dependency is one more thing between `npm install` and a working
 * transfer, and a three-way switch on process.platform covers the desktop
 * cases. On anything unusual the spawn simply fails, `openURL` resolves false,
 * and the caller falls back to printing the URL -- which it prints anyway.
 *
 * detached + unref so a long-lived browser process is not tied to the CLI's
 * lifetime, and stdio ignored so the opener's own chatter never lands in the
 * middle of the CLI's output.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

/**
 * @param {string} url
 * @returns {Promise<boolean>} true if the opener was launched, false if it
 *   could not be (unknown platform, missing command, spawn error).
 */
export function openURL(url) {
  const platform = process.platform

  /** @type {[string, string[]]} */
  const [command, args] =
    platform === 'darwin' ? ['open', [url]]
    // `start` is a cmd builtin, not an executable, so it has to go through
    // cmd. The empty "" is start's title argument -- without it, start reads
    // a quoted URL as the title and opens nothing.
    : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]]

  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      // spawn reports failure asynchronously via 'error'; give it a tick to
      // fire before calling this a success, then let the child outlive us.
      child.unref()
      setImmediate(() => resolve(true))
    } catch {
      resolve(false)
    }
  })
}
