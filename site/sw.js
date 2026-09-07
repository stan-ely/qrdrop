/**
 * The service worker, and it exists for exactly one reason: to receive a file
 * from the operating system's share sheet.
 *
 * WHY A SERVICE WORKER AT ALL, on a project whose stated position is that
 * every dependency is one more thing between `npm install` and a working
 * transfer. The Web Share Target API delivers files as a multipart POST to a
 * URL in the app's scope. GitHub Pages is a static host and cannot answer a
 * POST; a service worker's fetch handler is the only thing that can. There is
 * no version of this feature without one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: cache anything. Not the shell, not the
 * scripts, not the styles. A caching service worker is the usual reason to
 * have one and it is the wrong trade here twice over. This site is two builds
 * out of one Pages artifact -- the latest tag at / and the tip of main at
 * /edge/ -- and a stale cached bundle is a person running code from a release
 * they cannot name, on a page whose build stamp confidently says otherwise.
 * It is worse than that for an app about authenticating the other end: the one
 * failure mode nobody could debug from a screenshot is two devices running
 * different versions of the framing while both claim to be current. Offline
 * support buys nothing here anyway, since a transfer needs a network by
 * definition (and the one mode that does not, beam, needs the other device in
 * the room, not a cache).
 *
 * So: no install-time precache, no fetch fallback, no cache-first anything.
 * Every request but the share POST goes straight to the network, untouched,
 * by simply not calling respondWith.
 */

/*
 * The share POST lands here, and the file is handed on through the Cache API.
 *
 * A `File` cannot be posted through postMessage to a page that does not exist
 * yet -- the share arrives before the app is open, and the redirect below is
 * what opens it. So the bytes have to be parked somewhere the page can find
 * them a moment later. The Cache API takes a Response, and a Response can be
 * constructed straight from a File without reading it into memory, so a large
 * file is not copied through JS on the way past. IndexedDB was the
 * alternative and needs a schema, a version and an upgrade path to store one
 * object for a few hundred milliseconds.
 *
 * The filename rides in a header rather than in the cache key, because a
 * peer-supplied name has no business being part of a URL -- see vdom.js on
 * why filenames are kept inert by construction. The key is a constant.
 *
 * The constants themselves live in share-keys.js, imported by this worker
 * and by the page that reads what it writes. This file is bundled for that
 * reason -- see bundleWorker in scripts/build-site.mjs.
 */
import { STASH, STASH_KEY, NAME_HEADER, SHARED_PARAM } from './share-keys.js'

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab on this scope to
  // close. Nothing here caches, so there is no old worker holding a stale
  // shell that a delayed activation would protect anyone from -- and a share
  // that lands before activation simply fails, which reads as the app
  // refusing the file.
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Scope-relative, so this is correct for the stable tree at / and the edge
  // tree at /edge/ without either knowing which it is. registration.scope is
  // the directory this worker was registered for.
  const shareURL = new URL('share', self.registration.scope)

  if (event.request.method === 'POST' && url.pathname === shareURL.pathname) {
    event.respondWith(receiveShare(event.request))
    return
  }

  // EVERY OTHER REQUEST: not handled. Returning without calling respondWith
  // lets the browser do exactly what it would have done with no service
  // worker at all, which is the entire intent -- see the header.
})

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function receiveShare(request) {
  const home = new URL('./', self.registration.scope)
  try {
    const form = await request.formData()
    const file = form.get('file')

    // A share with no file is not an error worth a message: the OS can send a
    // text-only share to any target that accepts one, and this target does
    // not. Landing on the app is the right outcome.
    if (!(file instanceof File)) return Response.redirect(home.href, 303)

    const cache = await caches.open(STASH)
    await cache.put(STASH_KEY, new Response(file, {
      headers: {
        // encodeURIComponent because a header is a latin-1 byte string and a
        // filename is not. site/main.js decodes it. A name with a newline in
        // it would otherwise be a header injection into our own response,
        // which is harmless here but is the habit worth keeping.
        [NAME_HEADER]: encodeURIComponent(file.name),
        'content-type': file.type || 'application/octet-stream',
      },
    }))

    // 303, not 302: the redirect has to turn a POST into a GET, and only 303
    // is specified to do that for certain. A 302 is followed with GET by
    // every browser in practice and by none of them by specification.
    //
    // The marker is a query parameter and it is NOT a secret -- see
    // core/secret.js and CLAUDE.md on why a code may only ever ride in the
    // fragment. This says "there is a file waiting in the cache" and nothing
    // more; the file itself never touches the URL, and site/main.js never
    // reads a qrdrop code from the query string.
    const landing = new URL('./', self.registration.scope)
    landing.searchParams.set(SHARED_PARAM, '1')
    return Response.redirect(landing.href, 303)
  } catch {
    // A share that fails to parse should still open the app, not show the
    // browser's own network error page on a URL the person never typed.
    return Response.redirect(home.href, 303)
  }
}
