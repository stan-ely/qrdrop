/**
 * QR rendering for a terminal.
 *
 * The browser draws the code as SVG (src/web/qr.js); a terminal has no
 * vector graphics, so this renders it as text using half-block characters
 * (▀ ▄ █), which is what lets one character cell hold two square QR modules
 * stacked vertically instead of one -- most monospace fonts render a
 * character roughly twice as tall as it is wide, so without that trick every
 * module would come out as a tall rectangle rather than a square, and a
 * camera reads a QR by module geometry.
 *
 * qrcode-generator's createASCII(cellSize, margin) only takes this path when
 * cellSize < 2 -- see qrcode.js's _createHalfASCII. Passing cellSize >= 2
 * instead doubles every module into full block characters with no half-block
 * packing, which came out roughly 75 columns wide and 37 lines tall for a
 * qrdrop code when tried during development: it fits 80 columns by luck of
 * this particular payload length, but the moment the code is a few characters
 * longer it bumps the QR version up and no longer does, and it is needlessly
 * tall regardless. createASCII(1, margin) stays compact -- a 33-module code
 * (the size a `qrdrop:<43 chars>` secret produces) renders as 33+2*margin
 * columns by roughly half that many lines, comfortably inside an 80-column
 * terminal with room to spare.
 *
 * margin=2 rather than the spec-recommended 4-module quiet zone: four is
 * safest for a marginal camera or a low-quality print, but this code is read
 * off a terminal a few centimetres from the lens, not scanned across a room,
 * and two held up fine in manual testing while keeping the block narrower.
 * Widen it here if phones start struggling to lock on.
 */

import qrcode from 'qrcode-generator'

/**
 * @param {string} text
 * @returns {string} A block of lines, newline-separated, no trailing newline.
 */
export function renderQRToTerminal(text) {
  // Type 0 auto-sizes to the data, same as the browser renderer; 'M'
  // correction tolerates ~15% damage, which matters more here than on a
  // screen since a terminal's rendering can be re-flowed or partially
  // scrolled out of view.
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createASCII(1, 2)
}
