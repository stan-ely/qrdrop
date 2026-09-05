import { decodeSecret, encodeSecret } from '../../src/core/secret.js'

/**
 * Turns a deep-link URL the OS handed the app into the canonical bare
 * `qrdrop:<code>` string, or throws if it carries no usable code.
 *
 * This file imports NOTHING from @tauri-apps -- it is pure string work over
 * src/core/secret.js's decodeSecret, so test/deeplink.test.mjs can run it
 * under `node --test` with nothing installed. app/src/main.js is where the
 * plugin subscription that feeds URLs in here lives.
 *
 * THE FRAGMENT RULE IS PRESERVED BY CONSTRUCTION. Every path below funnels
 * through decodeSecret, which accepts a code only from a URL fragment and
 * refuses it outright from the query string or the path (see the long comment
 * in src/core/secret.js). This function never reaches past that: it hands the
 * whole URL to decodeSecret and, on the way back out, re-encodes to the bare
 * form so the caller only ever puts the code where a fragment goes. A
 * `?code=` link therefore fails here exactly as it fails a paste into the
 * page, rather than being unwrapped into something that looks safe.
 *
 * Two shapes arrive, and both are registered in tauri.conf.json / lib.rs:
 *
 *   1. `https://share.stan-ely.com/#qrdrop:<43>` -- the universal/app link the
 *      app's QR now encodes (app/src/main.js sets base-url). When the app is
 *      installed the OS routes this here; when it is not, the same URL opens
 *      share.stan-ely.com in a browser and site/main.js's location.hash path
 *      picks the code up. One string, an install and a no-install audience.
 *
 *   2. `qrdrop:<43>` -- the bare form the CLI and the manual-entry field speak
 *      (src/core/secret.js's encodeSecret). Registered as a custom URI scheme
 *      so a `qrdrop:` link anywhere on the device opens the app. Some
 *      platforms hand a registered scheme back with an authority slash pair it
 *      never had (`qrdrop://<43>`); that is normalised below rather than
 *      rejected, because the alternative is a link that launches the app and
 *      then fails to do anything.
 *
 * @param {string} url Untrusted: whatever the OS matched against a registered
 *   scheme or app-link domain.
 * @returns {string} The canonical `qrdrop:<code>` form, safe to place after a `#`.
 */
export function secretFromDeepLink(url) {
  const trimmed = String(url).trim()

  // `qrdrop://<opaque>` -> `qrdrop:<opaque>`. Only the scheme-plus-slashes
  // prefix with nothing that looks like a host/path/query after it: a real
  // `qrdrop://host/x?y` (which no part of this project ever emits) is left
  // alone so it reaches decodeSecret and is rejected there rather than being
  // mangled into a false positive.
  const candidate = /^qrdrop:\/\/([A-Za-z0-9_-]+)$/.test(trimmed)
    ? trimmed.replace('qrdrop://', 'qrdrop:')
    : trimmed

  // Throws on a query-string or path code, on the wrong length, on anything
  // that is not a qrdrop code at all. The caller (app/src/main.js) reports
  // that to the user the same way a mistyped manual code is reported.
  const secret = decodeSecret(candidate)

  // Re-encode rather than returning `candidate`: this guarantees the caller
  // gets the bare form regardless of which shape came in, so the only place
  // the code is ever written back is a fragment.
  return encodeSecret(secret)
}
