/**
 * The CLI's listening end of the local-network fast path (transport/lan.js):
 * a WebSocket server on node:http, taking one connection that presents the
 * session's token.
 *
 * Hand-rolled rather than the `ws` package, for the reason every dependency
 * here is argued over (see the header of src/cli.js): four runtime
 * dependencies is the position, and this server needs very little of
 * RFC 6455. Binary messages, fragmentation, close, ping and pong, from
 * clients only, so every inbound frame is masked and every outbound one is
 * not. No extensions and no subprotocols are offered, so a client asking for
 * permessage-deflate is simply not granted it.
 *
 * Messages are capped at MAX_MESSAGE, a little over the largest sealed frame
 * core/frame.js accepts. Anything bigger is a peer that is not speaking this
 * protocol, and it is closed with 1009 rather than buffered.
 *
 * Only the CLI listens, and only where listening is quiet (node/lan.js):
 * Linux. On Windows, binding here is what puts a firewall dialog in front of
 * the person, which is why nothing calls it there.
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { createLanSocket, serverHandshake } from '../transport/lan.js'
import { isPrivateAddress } from '../transport/room.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 64 * 1024
const HANDSHAKE_MS = 5000

/**
 * This machine's private IPv4 addresses, for the offer. Loopback and link-
 * local are left out: the first is never the peer, and a 169.254 address
 * means an interface that never got an address from anybody.
 *
 * @returns {string[]}
 */
export function lanAddresses() {
  /** @type {string[]} */
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue
      if (nic.address.startsWith('169.254.') || !isPrivateAddress(nic.address)) continue
      out.push(nic.address)
    }
  }
  return out
}

/**
 * Server-to-client frame header: FIN set, never masked.
 *
 * @param {number} opcode
 * @param {number} length
 */
function header(opcode, length) {
  if (length < 126) return Buffer.from([0x80 | opcode, length])
  if (length < 65536) {
    const h = Buffer.alloc(4)
    h[0] = 0x80 | opcode
    h[1] = 126
    h.writeUInt16BE(length, 2)
    return h
  }
  const h = Buffer.alloc(10)
  h[0] = 0x80 | opcode
  h[1] = 127
  h.writeBigUInt64BE(BigInt(length), 2)
  return h
}

/**
 * Completes the upgrade and wraps the socket as a LanSocket.
 *
 * @param {import('node:net').Socket} tcp
 * @param {Buffer} head Bytes the HTTP parser read past the request.
 * @returns {LanSocket}
 */
function adopt(tcp, head) {
  tcp.setNoDelay(true)
  let closeSent = false

  /**
   * @param {number} opcode
   * @param {Uint8Array} payload
   */
  const write = (opcode, payload) => {
    if (tcp.destroyed || tcp.writableEnded) return
    // Corked so the header and the payload leave as one write, without
    // copying a 16 KiB frame into a new buffer to prepend two bytes.
    tcp.cork()
    tcp.write(header(opcode, payload.length))
    tcp.write(payload)
    tcp.uncork()
  }

  /** @param {number} code */
  const sendClose = code => {
    if (closeSent) return
    closeSent = true
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code, 0)
    write(0x8, body)
    tcp.end()
  }

  const { socket, deliver, closed } = createLanSocket({
    send: bytes => write(0x2, bytes),
    bufferedAmount: () => tcp.writableLength,
    isOpen: () => !closeSent && !tcp.destroyed,
    drained: threshold => new Promise(resolve => {
      if (tcp.writableLength <= threshold || tcp.destroyed) return resolve()
      const done = () => {
        tcp.off('drain', done)
        tcp.off('close', done)
        resolve()
      }
      tcp.on('drain', done)
      tcp.on('close', done)
    }),
    close: () => sendClose(1000),
  })

  /** @type {Buffer} */
  let buf = Buffer.alloc(0)
  /** @type {Buffer[]} */
  let fragments = []
  let fragmentBytes = 0
  let fragmentOpcode = 0

  /** @param {Buffer} chunk */
  const onData = chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let length = buf[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buf.length < 4) return
        length = buf.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE)) return sendClose(1009)
        length = Number(big)
        offset = 10
      }
      // A client must mask; RFC 6455 section 5.1 says to close on one that
      // does not.
      if (!masked) return sendClose(1002)
      if (length > MAX_MESSAGE || fragmentBytes + length > MAX_MESSAGE) return sendClose(1009)
      if (buf.length < offset + 4 + length) return

      const mask = buf.subarray(offset, offset + 4)
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.subarray(offset + 4 + length)

      if (opcode === 0x8) return sendClose(payload.length >= 2 ? payload.readUInt16BE(0) : 1000)
      if (opcode === 0x9) { write(0xa, payload); continue }
      if (opcode === 0xa) continue

      if (opcode !== 0x0) {
        fragmentOpcode = opcode
        fragments = []
        fragmentBytes = 0
      }
      fragments.push(payload)
      fragmentBytes += payload.length
      if (!fin) continue
      const message = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
      fragments = []
      fragmentBytes = 0
      // Binary only. Text is not part of this protocol; it is read off the
      // wire so the stream stays in step, and dropped.
      if (fragmentOpcode === 0x2) {
        // A Buffer's backing store is typed ArrayBufferLike; this one came
        // from Buffer.from/concat above, which never allocate shared memory.
        deliver(new Uint8Array(/** @type {ArrayBuffer} */ (message.buffer), message.byteOffset, message.byteLength))
      }
    }
  }

  tcp.on('data', onData)
  tcp.on('close', () => closed())
  // 'close' follows every 'error', and it is the one acted on.
  tcp.on('error', () => {})
  if (head.length) onData(head)
  return socket
}

/**
 * Listens on every interface for the one connection that presents `token`,
 * and stops listening the moment it has one.
 *
 * @param {object} args
 * @param {Bytes} args.token
 * @param {string} [args.host]
 * @param {number} [args.port] 0 picks a free one.
 * @param {() => string[]} [args.addresses] Overridable for tests.
 * @returns {Promise<LanListener>}
 */
export async function listenLan({ token, host = '0.0.0.0', port = 0, addresses = lanAddresses }) {
  /** @type {Set<import('node:net').Socket>} */
  const pending = new Set()
  let done = false

  /** @type {(socket: LanSocket) => void} */
  let resolveAccepted = () => {}
  /** @type {(error: Error) => void} */
  let rejectAccepted = () => {}
  /** @type {Promise<LanSocket>} */
  const accepted = new Promise((resolve, reject) => {
    resolveAccepted = resolve
    rejectAccepted = reject
  })
  accepted.catch(() => {})

  const server = createServer((_req, res) => {
    res.writeHead(426, { Connection: 'close' })
    res.end()
  })

  server.on('upgrade', (req, tcp, head) => {
    const key = req.headers['sec-websocket-key']
    if (done
      || String(req.headers.upgrade).toLowerCase() !== 'websocket'
      || req.headers['sec-websocket-version'] !== '13'
      || typeof key !== 'string') {
      tcp.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const acceptKey = createHash('sha1').update(key + GUID).digest('base64')
    tcp.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`)

    const sock = /** @type {import('node:net').Socket} */ (tcp)
    pending.add(sock)
    serverHandshake(adopt(sock, head), token, HANDSHAKE_MS).then(
      socket => {
        pending.delete(sock)
        if (done) return socket.close()
        done = true
        server.close()
        for (const other of pending) other.destroy()
        pending.clear()
        resolveAccepted(socket)
      },
      () => { pending.delete(sock) },
    )
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : 0

  return {
    port: boundPort,
    addrs: addresses(),
    accepted,
    close() {
      server.close()
      for (const sock of pending) sock.destroy()
      pending.clear()
      if (!done) {
        done = true
        rejectAccepted(new Error('Stopped listening'))
      }
    },
  }
}
