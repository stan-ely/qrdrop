/**
 * Clipboard writes for the two blobs a person actually needs to move off this
 * screen by hand: the manual transfer code and the verification digest. Both
 * are `word-break: break-all` strings nobody should have to retype.
 *
 * WHY A FALLBACK: `navigator.clipboard.writeText` is a secure-context API and
 * is missing entirely on some older engines. `document.execCommand('copy')`
 * is deprecated, but it is the only thing that still works there, so it stays
 * as a second attempt rather than leaving those contexts with no copy button
 * that does anything.
 */

/**
 * @param {string} text
 * @returns {Promise<boolean>} Whether the text actually made it to the
 *   clipboard -- callers use this to show a "Copied" confirmation only when
 *   one is earned, rather than optimistically claiming success.
 */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // A denied permission or a mid-flight context change lands here; fall
      // through to the legacy path rather than giving up on the one attempt.
    }
  }

  // The legacy path needs a real, selectable element -- `display: none` or
  // `hidden` would make it unselectable, so it is moved off-screen instead.
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  textarea.remove()
  return ok
}
