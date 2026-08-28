/**
 * Outbound side of a transfer.
 *
 * Flow per file, deliberately gated on the receiver agreeing first:
 *
 *   manifest  -->            name, size, chunk count
 *             <--  accept    (or decline; nothing is sent if declined)
 *   chunks    -->            sealed, ordered, backpressure-aware
 *   complete  -->            hash chain over the plaintext
 *             <--  done
 *
 * Waiting for `accept` is not just politeness. On the receiving side, streaming
 * straight to disk needs showSaveFilePicker(), which browsers only allow from a
 * user gesture -- so the receiver physically cannot open its destination until
 * a human clicks. Gating the stream on that click is what lets large files go
 * to disk instead of accumulating in memory.
 */

import { CHUNK_SIZE, TYPE_CHUNK, seal, sealControl } from './frame.js'
import { EMPTY_CHAIN, chainHash, hex } from './digest.js'

// Pause above HIGH_WATER, resume once the channel drains to LOW_WATER. Without
// this the send loop will happily queue an entire file into the SCTP buffer and
// take the tab down; it is the single most common way naive DataChannel file
// senders fail, and it only shows up on large files.
const HIGH_WATER = 4 * 1024 * 1024
const LOW_WATER = 256 * 1024

/**
 * @param {Channel} channel
 * @returns {Promise<void> | null} null when there is nothing to wait for.
 */
function drain(channel) {
  if (channel.bufferedAmount <= HIGH_WATER) return null
  return new Promise(resolve => {
    const onLow = () => {
      channel.removeEventListener('bufferedamountlow', onLow)
      resolve()
    }
    channel.addEventListener('bufferedamountlow', onLow)
  })
}

/**
 * Sends one file. `control` is the paired inbound control stream, awaited for
 * the accept/done replies. Returns the digest so the UI can display it.
 *
 * @param {object} args
 * @param {Channel} args.channel
 * @param {CryptoKey} args.key The session's sendKey. Never recvKey.
 * @param {File} args.file
 * @param {number} args.fileSeq uint32, and the AEAD nonce prefix for every chunk.
 * @param {ControlStream} args.control
 * @param {() => number} args.nextControlIndex
 * @param {(p: SendProgress) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ declined: true } | { declined: false, digest: string }>}
 */
export async function sendFile({ channel, key, file, fileSeq, control, nextControlIndex, onProgress, signal }) {
  channel.bufferedAmountLowThreshold = LOW_WATER

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
  await channel.send(await sealControl(key, nextControlIndex(), {
    t: 'manifest',
    seq: fileSeq,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    chunks: totalChunks,
  }))

  const reply = await control.next(['accept', 'decline', 'error'], fileSeq)
  if (reply.t === 'error') throw new Error('Peer refused the transfer: ' + reply.message)
  if (reply.t === 'decline') return { declined: true }

  let digest = EMPTY_CHAIN()
  let sent = 0

  for (let index = 0; index < totalChunks; index++) {
    if (signal?.aborted) throw new Error('Transfer cancelled')
    await drain(channel)

    const start = index * CHUNK_SIZE
    const chunk = new Uint8Array(await file.slice(start, start + CHUNK_SIZE).arrayBuffer())
    digest = await chainHash(digest, chunk)

    // Awaited, not fired off: on a raw RTCDataChannel send() returns
    // undefined and this costs nothing, but Trystero returns a promise that
    // settles when the frame is actually out, which is the backpressure on
    // that path since its internal buffer keeps bufferedAmount at zero.
    await channel.send(await seal(
      key,
      { type: TYPE_CHUNK, fileSeq, index, last: index === totalChunks - 1 },
      chunk,
    ))

    sent += chunk.length
    onProgress?.({ sent, total: file.size, chunk: index + 1, chunks: totalChunks })
  }

  await channel.send(await sealControl(key, nextControlIndex(), {
    t: 'complete', seq: fileSeq, chunks: totalChunks, digest: hex(digest),
  }))

  const finish = await control.next(['done', 'error'], fileSeq)
  if (finish.t === 'error') throw new Error('Peer could not complete the transfer: ' + finish.message)

  return { declined: false, digest: hex(digest) }
}

export const _internals = { drain, HIGH_WATER, LOW_WATER }
