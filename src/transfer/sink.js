/**
 * Where received bytes land.
 *
 * Two implementations, because browsers disagree on whether a web page may
 * stream to disk:
 *
 *  - File System Access (Chromium): bytes go straight to the chosen file, so
 *    memory stays flat and size is bounded only by the disk.
 *  - Blob fallback (Firefox, Safari): the whole file accumulates in memory
 *    before it can be handed over, capping practical transfers at roughly a
 *    gigabyte, and failing well below that on a low-memory device.
 *
 * The gap is closable with a Service Worker that fabricates a streaming
 * download response, which is how StreamSaver-style libraries do it. That is
 * worth doing and is not done yet; `streaming: false` is surfaced so the UI can
 * warn rather than let someone start a 4 GB transfer that dies at 90%.
 */

export const canStreamToDisk = () =>
  typeof window !== 'undefined' && 'showSaveFilePicker' in window

// CON, PRN and friends are device names on Windows with or without an
// extension, and a file cannot be created using one.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * The filename arrives from the peer, so it is untrusted input heading for a
 * save dialog.
 *
 * This takes the basename rather than escaping separators. A peer offering
 * "docs/report.pdf" means report.pdf, and reducing to the final segment
 * disposes of every "../" prefix as a side effect, instead of mangling
 * "../../.bashrc" into "_.._.bashrc" the way escaping does.
 *
 * The browser would not let a page escape the directory the user picked in any
 * case. The risk being closed here is social: a traversal-flavoured or
 * device-flavoured name sitting prefilled in a save dialog is the kind of thing
 * a hurried user clicks straight through.
 */
export function safeFilename(name, fallback = 'received.bin') {
  const base = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? ''

  const cleaned = base
    .replace(/^\.+/, '')         // no dotfiles, and no bare ".." surviving
    .replace(/[<>:"|?*]/g, '_')  // reserved on Windows, awkward everywhere
    .trim()
    .slice(0, 180)

  if (cleaned === '' || WINDOWS_RESERVED.test(cleaned)) return fallback
  return cleaned
}

/** Must be called from a user gesture: showSaveFilePicker requires one. */
export async function createSink(manifest) {
  const name = safeFilename(manifest.name)

  if (canStreamToDisk()) {
    const handle = await window.showSaveFilePicker({ suggestedName: name })
    const writable = await handle.createWritable()
    return {
      streaming: true,
      name,
      write: chunk => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort().catch(() => {}),
    }
  }

  let parts = []
  return {
    streaming: false,
    name,
    async write(chunk) { parts.push(chunk) },
    async close() {
      const blob = new Blob(parts, { type: manifest.mime || 'application/octet-stream' })
      parts = []
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), { href: url, download: name })
      document.body.append(a)
      a.click()
      a.remove()
      // Revoked late: revoking immediately can cancel the download in Safari.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    async abort() { parts = [] },
  }
}
