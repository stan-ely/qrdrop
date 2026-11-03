/**
 * Bottom-sheet dismissal for a modal <dialog>: a tap on the backdrop, or a
 * drag down from the sheet's top edge.
 *
 * Both do exactly what Escape already does, and that equivalence is the whole
 * safety argument for adding them. Every sheet in this app could be closed
 * with Escape from the day it was a <dialog>, and none of them holds a
 * decision that closing makes for the person: the beam offer reopens from
 * Review file, a beam confirm drops its picked file, and nothing is accepted,
 * started or sent by a sheet going away. So a gesture that closes one is a
 * gesture that says "not now", never one that says "yes". It goes through
 * `dialog.close()`, so the `close` event every caller already listens for is
 * the only thing that reports it.
 *
 * Shared by the component's one sheet (element.js) and the site's two page
 * dialogs (site/wire-sheets.js), which are styled by the same sheetCSS() and
 * would otherwise be a sheet with a handle that does nothing.
 *
 * It is wired on every pointer. On a mouse the drag never starts, because it
 * is asked for only under (pointer: coarse), where the handle it starts from
 * is drawn; the backdrop tap works on both, as a centred dialog's usually
 * does.
 */

/** Pixels from the sheet's top edge that count as its handle. */
const HANDLE_ZONE = 40
/** How far down, as a share of the sheet's height, a release dismisses it. */
const DISMISS_SHARE = 0.25
/** Or how fast, in px/ms, whatever the distance: a flick. */
const DISMISS_SPEED = 0.6

/**
 * @param {HTMLDialogElement} dialog
 * @param {{ canDismiss?: () => boolean }} [options] `canDismiss` is asked
 *   before a backdrop tap closes the sheet. The compose sheet answers false
 *   while its box has text, because a stray tap beside a message must not lose
 *   it; a drag is deliberate and is not asked, and neither is Escape.
 */
export function enableSheetDismiss(dialog, { canDismiss = () => true } = {}) {
  // A click whose target is the dialog itself and whose point is outside its
  // box landed on ::backdrop -- the backdrop has no element of its own. The
  // box test is not redundant: the sheet's own padding also targets the
  // dialog, and a tap there must not close it.
  dialog.addEventListener('click', ev => {
    if (ev.target !== dialog || !dialog.open) return
    const box = dialog.getBoundingClientRect()
    const inside = ev.clientX >= box.left && ev.clientX <= box.right
      && ev.clientY >= box.top && ev.clientY <= box.bottom
    if (!inside && canDismiss()) dialog.close()
  })

  /** @type {{ id: number, y: number, t: number, dy: number, v: number } | null} */
  let drag = null

  dialog.addEventListener('pointerdown', ev => {
    if (!dialog.open || ev.button !== 0) return
    if (!matchMedia('(pointer: coarse)').matches) return
    const box = dialog.getBoundingClientRect()
    if (ev.clientY - box.top > HANDLE_ZONE) return
    // A control in the top band (a heading has none, but a sheet might) keeps
    // its own tap.
    if (/** @type {Element} */ (ev.target).closest('button, a, input, textarea, select, summary')) return
    drag = { id: ev.pointerId, y: ev.clientY, t: ev.timeStamp, dy: 0, v: 0 }
    dialog.setPointerCapture(ev.pointerId)
    dialog.style.transition = 'none'
  })

  dialog.addEventListener('pointermove', ev => {
    if (!drag || ev.pointerId !== drag.id) return
    const dy = Math.max(0, ev.clientY - drag.y)
    const dt = Math.max(1, ev.timeStamp - drag.t)
    drag.v = (dy - drag.dy) / dt
    drag.dy = dy
    drag.t = ev.timeStamp
    dialog.style.transform = `translateY(${dy}px)`
  })

  /** @param {PointerEvent} ev */
  const release = ev => {
    if (!drag || ev.pointerId !== drag.id) return
    const { dy, v } = drag
    drag = null
    const far = dy > dialog.getBoundingClientRect().height * DISMISS_SHARE
    if (ev.type !== 'pointerup' || !(far || v > DISMISS_SPEED)) {
      // Not far enough: back to rest, which the stylesheet's transition on
      // transform carries.
      dialog.style.transition = ''
      dialog.style.transform = ''
      return
    }
    // Far enough: carried the rest of the way from where the finger left it,
    // then closed. Handing the inline transform back to the stylesheet first
    // would snap the sheet up to rest before its exit transition took it down.
    // The timer is the fallback for an engine or a reduced-motion setting that
    // never fires transitionend.
    let done = false
    const finish = () => {
      if (done) return
      done = true
      dialog.close()
      dialog.style.transition = ''
      dialog.style.transform = ''
    }
    dialog.style.transition = 'transform var(--dur-slow) ease-in'
    dialog.style.transform = 'translateY(100%)'
    dialog.addEventListener('transitionend', finish, { once: true })
    setTimeout(finish, 300)
  }
  dialog.addEventListener('pointerup', release)
  dialog.addEventListener('pointercancel', release)
}
