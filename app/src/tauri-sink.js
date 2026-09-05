/**
 * Tauri's answer to src/web/sink.js: where received bytes land inside the
 * desktop/mobile shell.
 *
 * Neither of sink.js's two implementations exist here. showSaveFilePicker is
 * File System Access, a Chromium-only web API absent from every webview Tauri
 * embeds -- WebView2, WebKitGTK, WKWebView, per app/CAPABILITIES.md -- and the
 * Blob-download fallback needs a browser's own download manager behind the
 * `<a download>` click, which a Tauri window does not have.
 *
 * The destination is picked by @tauri-apps/plugin-dialog's save(). The bytes,
 * though, go through this crate's own sink_open / sink_write / sink_close
 * commands (app/src-tauri/src/sink.rs), NOT plugin-fs's write(): on WebView2
 * plugin-fs moves bytes across the IPC boundary at ~2 MB/s whatever the block
 * size, where sink_write -- bytes in the invoke request's raw body -- reaches
 * ~40 MB/s once frames are coalesced to 1 MiB. app/bench/ measured both. The
 * comment this file used to carry ("plugin-fs write() carries its Uint8Array
 * over Tauri's binary IPC path, not JSON") was true on paper and false on
 * WebView2, which is exactly the kind of trap CLAUDE.md's invariants section
 * is for.
 *
 * This module is NOT part of src/web/ and never reaches the deployed
 * website's bundle: it imports @tauri-apps/* packages that exist only under
 * app/node_modules. src/web/platform.js is the seam that keeps the two apart
 * -- see registerPlatform() in app/src/main.js, the only caller.
 */
import { save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'

import { safeFilename } from '../../src/web/sink.js'

/**
 * How much to buffer before crossing the JS<->Rust boundary. element.js hands
 * this sink one write() per CHUNK_SIZE (16 KiB) transfer frame; at that size
 * even the raw-body path only manages ~5 MB/s, because ~3 ms of per-invoke
 * cost dominates. At 256 KiB it is ~34 MB/s and at 1 MiB ~42 MB/s, then it
 * flattens -- so 1 MiB is the knee. The buffer this holds is bounded to this
 * many bytes; it is not the whole-file accumulation the Blob fallback does.
 */
const FLUSH_BYTES = 1024 * 1024

/**
 * Concatenates the pending frames into one exact-length block. Exact-length
 * matters: `invoke` serialises a Uint8Array by its underlying ArrayBuffer, so
 * a view over a larger buffer would send the slack too.
 *
 * @param {Bytes[]} parts
 * @param {number} total
 * @returns {Uint8Array}
 */
function joinChunks(parts, total) {
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

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

  await invoke('sink_open', { path })
  let closed = false

  /** @type {Bytes[]} */
  let pending = []
  let pendingBytes = 0

  const flush = async () => {
    if (!pendingBytes) return
    const block = joinChunks(pending, pendingBytes)
    pending = []
    pendingBytes = 0
    // The Uint8Array as the sole argument is what puts it in the raw request
    // body -- see sink_write in src-tauri/src/sink.rs.
    await invoke('sink_write', block)
  }

  return {
    streaming: true,
    name,
    write: async chunk => {
      pending.push(chunk)
      pendingBytes += chunk.length
      if (pendingBytes >= FLUSH_BYTES) await flush()
    },
    close: async () => {
      closed = true
      await flush()
      await invoke('sink_close')
    },
    // Deletes the partial file, Rust-side (sink_abort). The File System Access
    // writable this mirrors cannot do that -- element.js's beam teardown
    // comment spells out why an abandoned web transfer leaves an empty file on
    // disk with no handle able to remove it.
    abort: async () => {
      pending = []
      pendingBytes = 0
      if (!closed) {
        closed = true
        await invoke('sink_abort').catch(() => {
          // already torn down
        })
      }
    },
  }
}

/**
 * Always true: sink_write streams straight to disk, so there is no
 * buffer-in-memory fallback here and no capability note to show for it.
 */
export const canStreamToDisk = () => true
