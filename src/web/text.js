/**
 * Sending a few lines of text rather than a file.
 *
 * There is no text frame on the wire and this module is why none is needed:
 * the sender wraps what was typed as an ordinary `File` of type
 * `text/plain;charset=utf-8`, and it goes through _startSend like any other
 * file, so the SAS is still confirmed before a manifest leaves and the
 * receiver still answers with Accept. A protocol message of its own was the
 * alternative, and it would have bought nothing but a second road past both
 * safety gestures -- plus a wire change the CLI, the Rust session and every
 * deployed copy of this page would have to learn before they could even
 * decline one.
 *
 * The receiver recognises text by what the manifest says, and only that:
 * plain text, and small. Everything older -- both CLIs, a page from before
 * this, the app's native session -- sees a small .txt file and saves it, which
 * is the right degradation and needs nothing from them. The rule is the same
 * one the sender's screens use, so a `notes.txt` someone dropped is shown as
 * text on both ends too, and both ends agree about what they are looking at.
 *
 * The type and the size are claims from the peer. That is safe because of
 * what showing the text means: view.js renders it as a text node through h(),
 * which has no innerHTML path, so a message can say anything and do nothing.
 */

/**
 * The largest offer read into memory and shown, rather than saved. 64 KiB is
 * some thirty pages of prose, far past anything a person pastes to move a
 * link or a password, and small enough that holding it costs nothing on any
 * device -- the message sink below buffers it whole, with no disk behind it.
 * A bigger text file is a file, and goes to the save path like one.
 */
export const TEXT_MAX_BYTES = 64 * 1024

export const TEXT_NAME = 'message.txt'
export const TEXT_MIME = 'text/plain;charset=utf-8'

/**
 * Whether an offer, or a file about to be sent, is shown as text.
 *
 * Only the media type before any parameters is compared, case-folded, since
 * `text/plain; charset=UTF-8` and `text/plain` are the same thing to every
 * other program that reads them. Any other parameter is ignored rather than
 * refused, which costs nothing: whatever the charset says, the bytes are
 * decoded as UTF-8 with replacement, never trusted to be well formed.
 *
 * @param {{ mime?: unknown, type?: unknown, size: number }} file A manifest
 *   (`mime`) or a browser File (`type`).
 */
export function isText(file) {
  const type = typeof file.mime === 'string' ? file.mime : typeof file.type === 'string' ? file.type : ''
  return type.split(';')[0].trim().toLowerCase() === 'text/plain'
    && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= TEXT_MAX_BYTES
}

/**
 * What the compose sheet sends: the text, encoded once, so the size the
 * manifest states is the size in bytes and not in UTF-16 units.
 *
 * @param {string} text
 * @returns {File}
 */
export function textFile(text) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > TEXT_MAX_BYTES) throw new RangeError(tooLongMessage(bytes.length))
  return new File([bytes], TEXT_NAME, { type: TEXT_MIME })
}

/**
 * The compose sheet's complaint, said against the field rather than as a
 * failure, since the text is still sitting there to be shortened.
 *
 * @param {number} size bytes
 */
export function tooLongMessage(size) {
  return `That is ${Math.ceil(size / 1024)} KB, and a message can be ${TEXT_MAX_BYTES / 1024} KB at most. `
    + 'Save it to a file and send the file instead.'
}

/**
 * The bytes in a string's UTF-8 form, for the compose sheet to check before
 * anything is built from them.
 *
 * @param {string} text
 */
export const textBytes = text => new TextEncoder().encode(text).length

/**
 * A sink that keeps the text in memory instead of asking where to save it.
 *
 * Nothing is opened, so the Accept click spends no user activation here and
 * the platform's save path -- a picker on the web, Downloads in the app --
 * never runs for a message. The text is read back with `text()` only once the
 * receiver has called onFileDone, which core/receiver.js does after the digest
 * checked out. Reading it any earlier -- at close, say, which is the obvious
 * hook for "the bytes are all here" -- would put a message on the screen that
 * the digest might yet reject.
 *
 * @param {Manifest} manifest
 * @returns {Sink & { text(): string }}
 */
export function createTextSink(manifest) {
  /** @type {Bytes[]} */
  let parts = []
  let received = 0
  return {
    streaming: false,
    name: TEXT_NAME,
    async write(chunk) {
      // The receiver already refuses more bytes than the manifest declared;
      // this is the same bound said again where the memory is, so a peer that
      // got past it could not grow this past the size it was accepted at.
      received += chunk.length
      if (received > manifest.size) throw new Error('Peer sent more data than the manifest declared')
      parts.push(chunk)
    },
    async close() {},
    async abort() { parts = [] },
    text() {
      const all = new Uint8Array(received)
      let at = 0
      for (const part of parts) {
        all.set(part, at)
        at += part.length
      }
      return new TextDecoder('utf-8').decode(all)
    },
  }
}
