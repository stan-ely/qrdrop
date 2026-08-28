/**
 * FileSource adapter over a browser File.
 *
 * core/sender.js used to take a File directly and call
 * `file.slice(a, b).arrayBuffer()` itself, which meant the sending half of the
 * protocol could only ever run in a browser. Moving that one call behind the
 * FileSource contract (see core/source.js) is what makes sender.js runtime-
 * agnostic, and runtime-agnostic is what makes a Node CLI possible at all:
 * src/node/ gets its own adapter over fs, and sender.js never has to know
 * which one it was handed.
 *
 * This file stays a thin wrapper on purpose. Anything cleverer than "read the
 * File's own fields, slice on demand" would be logic core should own instead,
 * and core cannot depend on File existing.
 */

/**
 * @param {File} file
 * @returns {FileSource}
 */
export function fromFile(file) {
  return {
    name: file.name,
    size: file.size,
    // File.type is '' when the browser could not determine one (an unknown
    // extension, or a file with none) -- never absent, just empty, so `||`
    // rather than `??` is the right fallback here.
    mime: file.type || 'application/octet-stream',
    async slice(start, end) {
      return new Uint8Array(await file.slice(start, end).arrayBuffer())
    },
  }
}
