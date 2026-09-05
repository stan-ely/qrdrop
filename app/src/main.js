/**
 * Entry point for the Tauri app build -- site/main.js's counterpart. See
 * scripts/build-site.mjs's `channel === 'app'` branch, which points esbuild
 * here instead of at site/main.js.
 *
 * registerPlatform() has to run before defineQRDrop(): element.js reads
 * src/web/platform.js's registry once, at construction time
 * (_initialState), so a <qr-drop> created before this call would be stuck
 * with the default web sink no native window can actually use.
 *
 * No frame-refusal check and no base-url wiring, unlike site/main.js: a
 * Tauri window is never framed, and there is no landing-page URL for a QR
 * code to point at here -- this build's QR codes carry the bare `qrdrop:`
 * code, the same form the manual-entry field and the CLI already speak.
 */
import { defineQRDrop, registerPlatform } from '../../src/web/index.js'
import { wireInfoSheets } from '../../site/wire-sheets.js'
import { createTauriSink, canStreamToDisk } from './tauri-sink.js'

registerPlatform({ createSink: createTauriSink, canStreamToDisk })

defineQRDrop()

// Shared with site/main.js -- see wire-sheets.js's own comment.
wireInfoSheets()
