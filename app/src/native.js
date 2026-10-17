/**
 * The native session's page half: a transfer run by qrdrop-session in Rust
 * (src-tauri/src/native.rs), with element.js drawing what it reports.
 *
 * Why the app has one at all is in docs/notes/rust-session.md ("Why"). The
 * short version is that the JS session's ceilings on a phone are main-thread
 * time per frame sending and the base64 sink receiving, and that Linux's
 * WebKitGTK has no WebRTC, so there the JS session cannot run at all.
 *
 * WHICH ONE RUNS. The shell answers `native_session_default` (Linux yes,
 * elsewhere no until the device runs in that note's phase 7 have passed, and
 * `QRDROP_NATIVE_SESSION` overrides it on a desktop), and a localStorage key
 * overrides the shell, so a phone can be switched without a rebuild:
 * `localStorage.setItem('qrdrop:native-session', '1')` from the WebView's
 * devtools, then reload. A key that cannot be read is no override.
 *
 * WHAT A NATIVE SEND NEEDS IS A PATH. The Rust side opens the file itself, and
 * a `File` from an <input> or an HTML drop carries no path a webview will
 * give up. So the pick goes through plugin-dialog, which returns one, and a
 * desktop drop through the window's own drag-and-drop event, which does too.
 * On Android a pick is a `content://` URI with no display name, which only new
 * Kotlin could supply, so `pick` is not offered there and a picked file keeps
 * the JS session; a share handoff is a real path in the cache directory and
 * goes native.
 */

const OVERRIDE_KEY = 'qrdrop:native-session'

/**
 * @typedef {import('../../src/web/platform.js').NativeSession} NativeSession
 * @typedef {import('../../src/web/platform.js').NativeFile} NativeFile
 */

/** @returns {boolean | null} */
function override() {
  try {
    const value = localStorage.getItem(OVERRIDE_KEY)
    if (value === '1') return true
    if (value === '0') return false
  } catch { /* storage blocked: no override */ }
  return null
}

/**
 * The native session when this app should run one, else null.
 *
 * @param {{ android: boolean }} opts
 * @returns {Promise<NativeSession | null>}
 */
export async function createNativeSession({ android }) {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const enabled = override() ?? await invoke('native_session_default')
  if (!enabled) return null

  /**
   * @param {(event: any) => void} onEvent
   */
  const channel = onEvent => {
    const ch = new Channel()
    ch.onmessage = onEvent
    return ch
  }
  /** @param {number} id */
  const control = id => (/** @type {string} */ word) => {
    invoke('native_control', { id, word }).catch(() => {})
  }

  /** @type {NativeSession} */
  const session = {
    async send(file, onEvent) {
      /** @type {{ id: number, code: string }} */
      const started = await invoke('native_send', { path: file.path, name: file.name, events: channel(onEvent) })
      return { code: started.code, control: control(started.id) }
    },
    async receive(code, onEvent) {
      /** @type {number} */
      const id = await invoke('native_receive', { code, events: channel(onEvent) })
      return { control: control(id) }
    },
  }
  if (!android) {
    session.pick = async () => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const path = await open({ multiple: false, directory: false })
      return typeof path === 'string' ? stat(path) : null
    }
  }
  return session
}

/**
 * Name and size of a path, for the send screen.
 *
 * @param {string} path
 * @returns {Promise<NativeFile>}
 */
export async function stat(path) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke('native_stat', { path })
}

/**
 * A desktop drop onto the window, as a path, handed to `onFile`.
 *
 * The window's own event rather than the page's HTML drop: Tauri intercepts a
 * file drop before the webview sees it (dragDropEnabled), and the HTML one
 * carries no path anyway.
 *
 * @param {(file: NativeFile) => void} onFile
 */
export async function onNativeDrop(onFile) {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  await getCurrentWebview().onDragDropEvent(event => {
    if (event.payload.type !== 'drop') return
    const [path] = event.payload.paths
    if (path) stat(path).then(onFile, error => console.warn('qrdrop: dropped file unreadable', String(error)))
  })
}
