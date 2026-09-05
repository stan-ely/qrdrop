/**
 * Tauri's answer to src/web/sink.js: where received bytes land inside the
 * desktop/mobile shell.
 *
 * Neither of sink.js's two implementations exist here. showSaveFilePicker is
 * File System Access, a Chromium-only web API absent from every webview
 * Tauri embeds -- WebView2, WebKitGTK, WKWebView, per app/CAPABILITIES.md --
 * and the Blob-download fallback needs a browser's own download manager
 * behind the `<a download>` click, which a Tauri window does not have. The
 * native equivalent of "ask where to save, then stream bytes there" is
 * @tauri-apps/plugin-dialog's save() plus @tauri-apps/plugin-fs's create(),
 * not a hand-rolled `invoke('save_chunk', { data: [...] })` command: a
 * plugin-fs write() carries its Uint8Array over Tauri's binary IPC path, not
 * JSON, so a chunk never becomes an array of a million stringified numbers.
 *
 * This module is NOT part of src/web/ and never reaches the deployed
 * website's bundle: it imports two packages that exist only under
 * app/node_modules. src/web/platform.js is the seam that keeps the two apart
 * -- see registerPlatform() in app/src/main.js, the only caller.
 */
import { save } from '@tauri-apps/plugin-dialog'
import { create, remove } from '@tauri-apps/plugin-fs'

import { safeFilename } from '../../src/web/sink.js'

/**
 * @param {{ name: unknown, mime?: string }} manifest
 * @returns {Promise<Sink | null>}
 */
export async function createTauriSink(manifest) {
  const name = safeFilename(manifest.name)

  // null means "dismissed", exactly like a cancelled showSaveFilePicker.
  // element.js already handles this (see _startReceive's onOfferAccept and
  // _startBeamReceive) by tearing the session down with an explanation, so
  // this sink does not need a second copy of that message.
  const path = await save({ defaultPath: name })
  if (!path) return null

  const file = await create(path)
  let closed = false

  return {
    streaming: true,
    name,
    write: chunk => file.write(chunk),
    close: async () => {
      closed = true
      await file.close()
    },
    // Deletes the partial file. The File System Access writable this mirrors
    // cannot do that -- element.js's beam teardown comment spells out why an
    // abandoned web transfer leaves an empty file on disk with no handle able
    // to remove it -- but plugin-fs's create() truncates a real path this
    // process can also unlink, so a cancelled native transfer leaves nothing
    // behind at all.
    abort: async () => {
      if (!closed) {
        closed = true
        try { await file.close() } catch { /* already gone */ }
      }
      await remove(path).catch(() => {})
    },
  }
}

/**
 * Always true: create() always streams straight to disk, so there is no
 * buffer-in-memory fallback here and no capability note to show for it.
 */
export const canStreamToDisk = () => true
