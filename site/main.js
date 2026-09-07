/**
 * Entry point for the deployed site at share.stan-ely.com.
 *
 * This is the one place the frame-refusal check belongs. <qr-drop> itself
 * (src/web/element.js) does not refuse to run inside a frame, because being
 * embeddable is the entire point of shipping it as a package -- a consumer
 * who deliberately drops <qr-drop> into their own page is not an attacker.
 * *This* deployment is different: it is the specific origin whose two click
 * gestures (confirming the SAS, accepting a file) are worth clickjacking, so
 * refusing to render when framed is a property of this site, not of the
 * component.
 *
 * frame-ancestors would be the cleaner way to say this, but browsers ignore
 * it in a <meta> tag -- it only takes effect as an HTTP header, which is what
 * site/_headers sets for hosts that read that file. This check is the
 * fallback for hosts that don't, so the protection does not depend on the
 * host's cooperation.
 *
 * The import below is hoisted by the module system regardless of where it
 * appears textually, so it cannot be moved "after" the check to avoid
 * loading qrdrop's code inside a frame -- but that does not matter: the
 * check runs before defineQRDrop() is called, so a framed load never
 * registers the element or renders anything beyond the refusal message.
 */
import { defineQRDrop } from '../src/web/index.js'
import { wireInfoSheets } from './wire-sheets.js'
import { STASH, STASH_KEY, NAME_HEADER, SHARED_PARAM } from './share-keys.js'

if (window.top !== window.self) {
  document.body.textContent = 'qrdrop will not run inside a frame.'
  throw new Error('Refusing to run in a frame')
}

defineQRDrop()

// This deployment IS the landing page a QR code can point at, so it is safe
// -- and worth doing -- to have the component's QR encode a URL a phone's
// own camera app can open, rather than the bare `qrdrop:` form (see
// core/secret.js's encodeSecretURL). An embedder who has not set up their
// own page for this does not get this attribute for free: `base-url` is
// opt-in per element.js, precisely so a consumer who never configured a
// landing page never emits a QR pointing at share.stan-ely.com instead of
// their own site.
document.querySelector('qr-drop')?.setAttribute('base-url', location.origin + location.pathname)

// Shared with app/src/main.js -- see wire-sheets.js's own comment for why
// this isn't written twice.
wireInfoSheets()

/*
 * The OS share sheet, which is a property of THIS DEPLOYMENT and not of the
 * component -- exactly like the frame refusal at the top of this file and the
 * base-url attribute above it.
 *
 * A consumer who embeds <qr-drop> in their own page gets no service worker
 * and no share target from us. Registering one on their origin would be this
 * package installing a fetch handler across a site it does not own, which is
 * a far larger thing to do than render a widget. site/sw.js explains what the
 * worker does and, more importantly, what it deliberately does not.
 *
 * Both halves are best-effort. A browser with no service worker support, a
 * private window that refuses to register one, or a share that arrives with
 * nothing usable in it all end the same way: the app opens on the choose
 * screen and the person picks a file, which is what happens today.
 */
if ('serviceWorker' in navigator) {
  // Relative URL and relative scope, so the stable tree at / and the edge
  // tree at /edge/ each register their own worker for their own directory.
  // An absolute '/sw.js' would have the stable worker claim /edge/ as well,
  // and whichever build the person visited last would be answering shares for
  // the other one.
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {
    // Nothing to report and nothing to retry. A failed registration costs the
    // share target and nothing else, and a console error on every private
    // window would be noise about a feature the person is not using.
  })
}

consumeSharedFile()

/**
 * Picks up a file the service worker parked in the cache and starts a send.
 *
 * The marker is a query parameter, which is allowed HERE and would not be for
 * a pairing code: a code may only ever ride in the fragment, because the
 * fragment is the one part of a URL never sent to a server (see
 * src/core/secret.js and CLAUDE.md's invariant). This parameter carries no
 * secret at all -- it says a file is waiting in a same-origin cache, and the
 * bytes never touch the URL.
 *
 * It is stripped from the address bar afterwards, for the same reason
 * element.js clears the hash: a reloaded page should not try to re-send a
 * file that has already been taken out of the cache, and a copied URL should
 * not carry a marker that means nothing on another device.
 */
async function consumeSharedFile() {
  const params = new URLSearchParams(location.search)
  if (params.get(SHARED_PARAM) !== '1') return

  // Strip the marker before anything can fail below, so a share that goes
  // wrong once does not go wrong again on every reload.
  const clean = new URL(location.href)
  clean.searchParams.delete(SHARED_PARAM)
  history.replaceState(null, '', clean.pathname + clean.search + clean.hash)

  try {
    const cache = await caches.open(STASH)
    const stashed = await cache.match(STASH_KEY)
    if (!stashed) return
    // Taken out, not left behind: these bytes are a one-shot handoff, and a
    // copy of someone's file sitting in a cache after it has been sent is a
    // thing this app should not be doing.
    await cache.delete(STASH_KEY)

    const name = decodeURIComponent(stashed.headers.get(NAME_HEADER) || 'shared-file')
    const type = stashed.headers.get('content-type') || 'application/octet-stream'
    const file = new File([await stashed.blob()], name, { type })

    // The component's one public entry, which declines if a transfer is
    // already running rather than clobbering it. See element.js's sendFile.
    const el = /** @type {any} */ (document.querySelector('qr-drop'))
    el?.sendFile(file)
  } catch {
    // Same posture as the registration above: the app is open on the choose
    // screen and the person can pick the file by hand.
  }
}
