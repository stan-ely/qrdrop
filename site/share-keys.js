/**
 * The handoff protocol between site/sw.js and site/main.js.
 *
 * Three constants, in one file, imported by both ends -- not because three
 * strings are hard to remember, but because they are the entire contract
 * between a service worker and a page that never speak to each other
 * directly. A share is written by one and read by the other, minutes of
 * wall-clock apart in the worst case, with no call between them that a type
 * checker or a test could see. Two copies that disagreed would fail as "the
 * app opened and nothing happened", on a code path that only runs when
 * someone shares a file from another app.
 *
 * Same argument as src/web/tokens.js and buildCSP: the second copy is the one
 * that rots, and this one would rot silently.
 *
 * Kept free of every DOM and worker global, so both a window and a
 * ServiceWorkerGlobalScope can import it.
 */

/** The Cache Storage bucket the shared file is parked in. */
export const STASH = 'qrdrop-share'

/**
 * The key it is parked under. A constant rather than anything derived from
 * the file: a peer-supplied filename has no business in a URL, which is the
 * same reasoning that keeps vdom.js free of an innerHTML path. Only one share
 * can be in flight at a time, which is true of the UI as well -- the
 * component declines a second one while a transfer is running.
 */
export const STASH_KEY = './__shared__'

/**
 * Where the filename rides. A header, because the key is a constant and the
 * name still has to survive the trip. Percent-encoded by the writer and
 * decoded by the reader: a header value is a latin-1 byte string and a
 * filename is not.
 */
export const NAME_HEADER = 'x-qrdrop-filename'

/**
 * The query parameter that tells the page a file is waiting.
 *
 * A QUERY PARAMETER IS CORRECT HERE AND WOULD NOT BE FOR A PAIRING CODE. The
 * fragment-only rule in src/core/secret.js exists because a fragment is never
 * sent to a server, which is what makes it safe to carry a decryption key.
 * This carries no secret: it says "there is something in a same-origin cache"
 * and nothing else, and the bytes never touch the URL. Nothing on this path
 * may ever read a qrdrop code out of the query string.
 */
export const SHARED_PARAM = 'shared'
