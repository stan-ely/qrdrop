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
