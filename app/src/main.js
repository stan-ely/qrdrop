/**
 * Entry point for the Tauri app build -- site/main.js's counterpart. See
 * scripts/build-site.mjs's `channel === 'app'` branch, which points esbuild
 * here instead of at site/main.js.
 *
 * registerPlatform() has to run before defineQRDrop(): element.js reads
 * src/web/platform.js's registry once, at construction time (_initialState),
 * so a <qr-drop> created before this call would be stuck with the default web
 * sink no native window can actually use.
 *
 * No frame-refusal check, unlike site/main.js: a Tauri window is never framed.
 *
 * base-url IS wired here now (Phase 3). The app's QR encodes the universal /
 * app link `https://share.stan-ely.com/#qrdrop:<code>` -- one string that
 * opens THIS app when it is installed (the OS matches the registered app-link
 * domain, tauri.conf.json's `plugins.deep-link`), and otherwise lands the
 * scanner on share.stan-ely.com in a browser, where site/main.js's
 * location.hash path picks the same code up. The manual-entry field still
 * shows the bare `qrdrop:` form for a human to read aloud -- element.js keeps
 * the two independent (see _startSend).
 *
 * APP_LINK_ORIGIN is share.stan-ely.com, not this build's own origin (there
 * isn't one -- it is `tauri://localhost` / `http://tauri.localhost`), which is
 * why buildStamp's 'app' branch emits no absolute URLs and this constant is
 * written here rather than read from `location`.
 */
import { defineQRDrop, registerPlatform } from '../../src/web/index.js'
import { wireInfoSheets } from '../../site/wire-sheets.js'
import { createTauriSink, canStreamToDisk } from './tauri-sink.js'
import { secretFromDeepLink } from './deep-link.js'

const APP_LINK_ORIGIN = 'https://share.stan-ely.com/'

registerPlatform({ createSink: createTauriSink, canStreamToDisk })

defineQRDrop()

const el = document.querySelector('qr-drop')
el?.setAttribute('base-url', APP_LINK_ORIGIN)

// Shared with site/main.js -- see wire-sheets.js's own comment.
wireInfoSheets()

/**
 * Hands a deep-link URL to <qr-drop> by writing the code into location.hash,
 * exactly the shape element.js's _consumeHashCode already listens for. The
 * value is always the bare `qrdrop:` form regardless of which link shape the
 * OS matched -- secretFromDeepLink re-encodes it -- so the only place a code
 * is ever written is the fragment, and a `?code=` link throws here rather than
 * resolving to a secret.
 *
 * @param {string} url
 */
function openDeepLink(url) {
  let code
  try {
    code = secretFromDeepLink(url)
  } catch (error) {
    // A malformed or non-qrdrop link. The manual-entry field is the recovery
    // path; nothing to abort here since no session was started.
    console.warn('qrdrop: ignoring deep link', url, String(error))
    return
  }
  // A normal navigation would push a history entry holding the key; replace
  // it. element.js clears the hash again the moment it reads the code.
  location.replace(location.pathname + location.search + '#' + code)
  // location.replace does not fire hashchange when only the fragment changed
  // in some engines; dispatch one so a running component reacts immediately.
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

// The deep-link plugin is app-only -- @tauri-apps/plugin-deep-link is in
// app/package.json, never the root (CLAUDE.md, "no new runtime dependencies").
// Imported dynamically so a plain `esbuild` of this file for a non-Tauri
// smoke test does not hard-fail on a missing module; in the real app build it
// resolves normally.
import('@tauri-apps/plugin-deep-link')
  .then(async ({ onOpenUrl, getCurrent }) => {
    // Cold start: the URL that launched the app, if any.
    const initial = await getCurrent().catch(() => null)
    if (initial?.length) openDeepLink(initial[0])
    // Warm: every subsequent link while the app is running. On desktop this
    // arrives via tauri-plugin-single-instance forwarding the second launch's
    // argv to the first (wired in src-tauri/src/lib.rs); on mobile the OS
    // delivers it to the live process directly.
    await onOpenUrl(urls => { if (urls.length) openDeepLink(urls[0]) })
  })
  .catch(error => {
    console.warn('qrdrop: deep-link plugin unavailable', String(error))
  })

/**
 * The Android share sheet's last leg.
 *
 * MainActivity.kt copied the shared stream into the app's cache directory and
 * wrote a handoff beside it; src-tauri/src/share.rs reads and deletes that
 * handoff. This turns what comes back into a File and hands it to the
 * component through its one public entry.
 *
 * WHY THE ASSET PROTOCOL AND NOT plugin-fs. convertFileSrc + fetch gives back
 * a Response the webview can turn into a Blob, and a Blob in a Chromium
 * webview is backed by disk once it is any size at all -- so the File built
 * from it slices lazily, and src/web/source.js's 2 MiB block reads and
 * read-ahead work on it completely unchanged. plugin-fs's readFile would
 * bring the entire file across the IPC boundary into JS memory first, at the
 * ~2 MB/s app/CAPABILITIES.md measured for that path: a 1 GB share would be
 * eight minutes of waiting and a gigabyte of heap before the first frame went
 * out. It is the same reasoning tauri-sink.js records for the write side.
 *
 * The asset scope is narrowed to that one cache subdirectory in
 * tauri.conf.template.json, and the CSP entries are ASSET_ORIGINS in
 * scripts/build-site.mjs.
 */
async function consumeSharedFile() {
  try {
    const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')

    // Ok(None) on every ordinary launch: the app was opened from its icon and
    // nothing was shared in. Not an error and not worth a log line.
    const shared = await invoke('take_shared_file')
    if (!shared) return

    const response = await fetch(convertFileSrc(shared.path))
    if (!response.ok) throw new Error(`asset protocol returned ${response.status}`)

    // The name from the content provider, which is what the person saw in the
    // app they shared from. It reaches the UI through the vdom like every
    // other filename, and is never used to build a path on either side.
    const file = new File([await response.blob()], shared.name, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    })

    // Declines rather than clobbers if a transfer is already running -- see
    // element.js's sendFile. Android can hand a share to an app that is
    // already open and busy, and on that path the person did not necessarily
    // mean to interrupt anything.
    el?.sendFile(file)
  } catch (error) {
    // Same posture as the deep-link plugin above: a share that cannot be
    // picked up leaves the app on the choose screen, where the person can
    // pick the file by hand. Warned rather than silent, because unlike the
    // Kotlin side this runs where a developer can see a console.
    console.warn('qrdrop: no shared file taken', String(error))
  }
}

/*
 * Twice, and both are needed.
 *
 * A share to an app that was not running arrives before this script does, so
 * the call at load finds the handoff already written. A share to an app that
 * WAS running goes through MainActivity.onNewIntent while this page is alive
 * and unaware, and the only signal the web layer gets is the window coming
 * back to the foreground. Handling just the first case works exactly once per
 * cold start, which is the most misleading way this could fail: it looks
 * correct the first time anyone tries it.
 *
 * take_shared_file deletes the handoff as it reads it, so the extra calls
 * this makes on every focus are a file stat that finds nothing.
 */
consumeSharedFile()
window.addEventListener('focus', () => { consumeSharedFile() })
