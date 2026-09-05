/**
 * Wires the page's two explanation dialogs ("How does this work?" and the
 * security disclosure). Shared by site/main.js and app/src/main.js -- the
 * markup lives in the template both entries build from (site/index.html), so
 * both need the same two `<dialog>`s to actually open.
 *
 * The copy lives in the markup and is *moved* into the dialog here rather
 * than written twice. That ordering matters for more than tidiness: with no
 * script running, index.html is still a page whose orientation steps and
 * security disclosure are both present and readable, and only their
 * presentation depends on this file.
 *
 * `showModal`, not the `open` attribute. The two differ in every way that
 * counts here -- top layer (so the sheet cannot be clipped by the
 * fixed-height grid it sits in), a focus trap, an inert background, a
 * ::backdrop, and Escape. Setting `open` gets a plain in-flow box with none
 * of it.
 *
 * Focus goes to the heading, not to the first control. That is the same rule
 * <qr-drop> follows for its screen headings (see _focusScreenHeading in
 * src/web/element.js): a dialog that opens with a button focused turns a
 * stray Enter -- from someone still finishing the keystroke that opened it --
 * into a click on that button. Harmless on a Close button, which is why this
 * is worth keeping consistent before a dialog exists whose default control is
 * not.
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

/**
 * The three-step strip is copied, not moved: site/styles.css shows it inline
 * when the viewport is tall and wide enough and shows the button instead when
 * it is not, so both copies have to stay live. The disclosure has no inline
 * form at any size, so it moves.
 */
export function wireInfoSheets() {
  wireSheet('how-open', 'how-dialog', document.querySelector('.how'), 'copy')
  wireSheet('protect-open', 'protect-dialog', document.getElementById('protect-body'), 'move')
}
