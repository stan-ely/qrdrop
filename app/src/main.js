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

/**
 * The launcher shortcuts' and the Quick Settings tile's last leg.
 *
 * consumeSharedFile's twin, and deliberately built the same way: MainActivity
 * wrote which screen was asked for into a small JSON in the app cache
 * directory, src-tauri/src/share.rs reads and deletes it, and this hands the
 * name to the component. An intention rather than a file, through the same
 * boundary, because a second way of getting one across would be a second thing
 * to keep in step with a chain that already has four links.
 *
 * startAction, not a click on a button in the shadow DOM. It validates the
 * name, goes through the same _dispatch every other control does, and declines
 * on anything but the choose screen -- which matters more here than it does
 * for a share: a tile can be pulled down from inside another app while a
 * transfer is running, and the person doing it has no way to know that.
 */
async function consumeLaunchAction() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')

    // Ok(None) on every ordinary launch, exactly as take_shared_file is.
    const action = await invoke('take_launch_action')
    if (!action) return

    el?.startAction(action)
  } catch (error) {
    // Same posture as the two above: a shortcut that cannot be picked up
    // leaves the app on the choose screen, which is where tapping the icon
    // would have left it anyway. The failure mode is losing the shortcut's
    // value, never doing the wrong thing.
    console.warn('qrdrop: no launch action taken', String(error))
  }
}

/**
 * Takes both handoffs and offers them to the component, busy or not.
 *
 * NOT gated on whether the component is idle, and that was tried the other
 * way first. Gating the TAKE looks obviously right -- the take deletes, so
 * why spend an intent the component is only going to decline? -- and it
 * quietly replaces "declined, and said so" with "deferred": the file stays on
 * disk and fires whenever the app next reaches the choose screen. Measured on
 * a device, that is worse than it sounds. A transfer ends on the DONE screen,
 * not the choose screen, so a tile tapped mid-transfer sits there until the
 * person happens to start over, and then moves the app to the scanner they
 * asked for minutes ago and have long since stopped expecting.
 *
 * A tile pulled from inside another app means "scan now". If qrdrop cannot
 * scan now, the honest answer is to say so while the person is still looking,
 * which is what `startAction` and `sendFile` already do -- see element.js,
 * where declining and toasting is a deliberate choice with its own reasoning.
 * Honouring it later is not a kindness; it is an interruption with a delay
 * on it.
 */
function consumeHandoffs() {
  consumeSharedFile()
  consumeLaunchAction()
}

/*
 * At load, on focus, and on a slow poll -- and the poll is the one that
 * actually works on Android.
 *
 * A share or a shortcut reaching an app that was NOT running arrives before
 * this script does, so the call at load finds the handoff already written.
 * That path was never in doubt. The warm path is: MainActivity.onNewIntent
 * stashes the file while this page is alive and unaware, and the web layer
 * has to notice by itself.
 *
 * `window.focus` was the whole mechanism for that, and MEASURED ON A DEVICE
 * (Realme RMX3868, Android 16, WebView 151) it never fires. Nor does `blur`,
 * `pageshow`, or `visibilitychange` -- `document.visibilityState` reads
 * "visible" and `document.hasFocus()` reads true for the entire time the app
 * sits behind the launcher. This webview is simply never told it was
 * backgrounded. The symptom was a tile or a shortcut leaving
 * qrdrop-launch.json on disk, unconsumed, with the app foreground on top of
 * it; verified with no debugger attached, since an attached debugger can
 * itself keep a page from being backgrounded, and from both the launcher and
 * another app.
 *
 * So the poll is not belt-and-braces, it is the load-bearing half. The
 * listener stays because it costs nothing and does fire on desktop, where
 * single-instance forwarding raises the existing window.
 *
 * WHY POLLING IS CHEAP ENOUGH. Each pass is two `take_*` commands that stat a
 * file and find nothing -- plain std::fs on the app's own cache directory
 * (src-tauri/src/share.rs), with no JSON to parse and no bytes to move on the
 * empty path, which is every pass but the one that matters. It does keep
 * running during a transfer, which an earlier draft avoided by gating on the
 * choose screen; that gate is gone for the behavioural reason above, and the
 * cost it was buying back is two stats a second beside a data channel moving
 * 16 KiB frames and a sink writing at ~40 MB/s.
 *
 * The alternative was a signal pushed from the native side -- a Tauri resume
 * event, or MainActivity calling evaluateJavascript after it stashes. The
 * first could not be confirmed to fire on Android at all; the second couples
 * Kotlin to a JS function name and adds a fourth hand-edit inside gen/, which
 * is the second source of truth this whole chain was shaped to avoid.
 *
 * The two handoffs are separate files, so taking one never consumes the
 * other; a Rust test pins that, since it is the kind of thing that would only
 * show up as "sharing into a cold app sometimes does nothing".
 */
const HANDOFF_POLL_MS = 1500

consumeHandoffs()
window.addEventListener('focus', consumeHandoffs)
setInterval(consumeHandoffs, HANDOFF_POLL_MS)
