/**
 * Formatting helpers shared by every surface that reports transfer sizes.
 *
 * This used to be pasted twice -- once in src/web/element.js, once in
 * src/cli.js -- byte-identical both times. Both the e2e suites parse this
 * output ("Sent 80 KB of 300 KB", the CLI's progress line), so a fork between
 * the two copies would have been a silent behaviour change for whichever one
 * drifted. One copy, imported by both, makes that impossible instead of just
 * unlikely.
 */

/**
 * A rough, human duration -- "about 2 min", not "1m 47s".
 *
 * Deliberately coarse. This is used to tell someone how long they have to keep
 * a phone pointed at a laptop, and a figure to the second reads as a promise
 * the transfer cannot keep: the real rate depends on how steady a hand is and
 * how well the camera is focusing, and it changes while they watch. Rounding
 * to something obviously approximate is the honest register, and it stops the
 * number flickering distractingly on every progress tick.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 20) return 'a few seconds'
  if (seconds < 90) return `about ${Math.round(seconds / 10) * 10} seconds`
  const mins = Math.round(seconds / 30) / 2 // nearest half-minute
  if (mins < 10) return `about ${mins % 1 === 0 ? mins : Math.floor(mins) + '½'} min`
  return `about ${Math.round(seconds / 60)} min`
}

/**
 * @param {number} n
 * @returns {string}
 */
export function bytes(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
