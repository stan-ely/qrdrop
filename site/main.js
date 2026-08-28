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
