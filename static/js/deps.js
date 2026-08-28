/**
 * Every third-party module, in one file.
 *
 * Loaded straight from jsDelivr as ESM rather than bundled. Nothing is
 * installed for the site build -- `hugo` is the only tool needed.
 *
 * SWAPPING THE SIGNALLING NETWORK is a one-line change here. Trystero ships a
 * separate package per strategy and they share an interface, so any of these
 * work in place of the line below:
 *
 *   @trystero-p2p/nostr      (current)
 *   @trystero-p2p/mqtt
 *   @trystero-p2p/torrent
 *   @trystero-p2p/ws-relay   (needs relayConfig.urls)
 *   @trystero-p2p/supabase   (needs a project URL + key)
 *   @trystero-p2p/firebase   (needs a databaseURL)
 *
 * If you change it, update RELAYS in signal/room.js and the connect-src list in
 * layouts/index.html to match the new network, or the CSP will block it.
 *
 * VERSIONS ARE PINNED, exactly, on purpose. `/npm/pkg/+esm` without a version
 * resolves to whatever is newest at page load, which means a third party gets
 * to change the code running in this page at any moment without anyone
 * noticing. Pinned, an update is a visible commit here.
 *
 * The tradeoff that remains, and it is a real one: jsDelivr can serve arbitrary
 * JavaScript into a page whose entire purpose is confidentiality, and it sees
 * the IP of every visitor. Subresource Integrity would close the first half but
 * is not usable for ESM imports. Serving these files from our own origin --
 * same imports, files copied into static/vendor/ -- closes both, at the cost of
 * updating them by hand. See the README.
 */

export { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/@trystero-p2p/nostr@0.25.3/+esm'

export { default as qrcode } from 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm'

/**
 * Loaded on demand: it is 130 kB and only needed on browsers without a native
 * BarcodeDetector. Kept here so the URL lives with the others.
 */
export const loadJsQR = async () =>
  (await import('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm')).default
