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

/**
 * Wires the page's two explanation dialogs.
 *
 * The copy lives in the markup (site/index.html) and is *moved* into the
 * dialog here rather than written twice. That ordering matters for more than
 * tidiness: with no script running, index.html is still a page whose
 * orientation steps and security disclosure are both present and readable, and
 * only their presentation depends on this file.
 *
 * `showModal`, not the `open` attribute. The two differ in every way that
 * counts here -- top layer (so the sheet cannot be clipped by the fixed-height
 * grid it sits in), a focus trap, an inert background, a ::backdrop, and
 * Escape. Setting `open` gets a plain in-flow box with none of it.
 *
 * Focus goes to the heading, not to the first control. That is the same rule
 * <qr-drop> follows for its screen headings (see _focusScreenHeading in
 * src/web/element.js): a dialog that opens with a button focused turns a stray
 * Enter -- from someone still finishing the keystroke that opened it -- into a
 * click on that button. Harmless on a Close button, which is why this is worth
 * keeping consistent before a dialog exists whose default control is not.
 *
 * @param {string} triggerId
 * @param {string} dialogId
 * @param {Element | null} source Node whose content fills the dialog body.
 * @param {'move' | 'copy'} how `move` for copy that exists only in the sheet;
 *   `copy` for copy the page also shows inline at some viewport sizes.
 */
function wireSheet(triggerId, dialogId, source, how) {
  const trigger = document.getElementById(triggerId)
  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById(dialogId))
  const body = dialog?.querySelector('.sheet-body')
  if (!trigger || !dialog || !source || !body) return

  if (how === 'move') {
    source.removeAttribute('hidden')
    body.append(...source.childNodes)
    source.remove()
  } else {
    body.append(source.cloneNode(true))
  }

  trigger.addEventListener('click', () => {
    dialog.showModal()
    /** @type {HTMLElement | null} */ (dialog.querySelector('h2'))?.focus()
  })
}

// The three-step strip is copied, not moved: site/styles.css shows it inline
// when the viewport is tall and wide enough and shows the button instead when
// it is not, so both copies have to stay live. The disclosure has no inline
// form at any size, so it moves.
wireSheet('how-open', 'how-dialog', document.querySelector('.how'), 'copy')
wireSheet('protect-open', 'protect-dialog', document.getElementById('protect-body'), 'move')
