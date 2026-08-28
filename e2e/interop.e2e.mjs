/**
 * Two Node processes, one real file, over real public relays.
 *
 * This is the proof that one package genuinely serves two runtimes: it drives
 * the shipped `qrdrop` CLI end to end -- argument parsing, the terminal QR,
 * both confirmation prompts, node-datachannel's WebRTC, the fs sink -- and
 * checks the bytes that land on disk are the bytes that went in.
 *
 * TWO PROCESSES, NOT TWO ROOMS IN ONE. Trystero computes `selfId` once per
 * module instance (@trystero-p2p/core/dist/utils.mjs line 7), so two rooms
 * sharing a process also share an identity: each sees the other's
 * announcement carrying its own id and discards it as itself, and they wait
 * for each other until the timeout. That is a property of Trystero rather
 * than a bug here, but it is invisible until you try it, and it is the reason
 * this file spawns children instead of calling openRoom twice.
 *
 * Kept out of `npm test` deliberately: it needs a network and the goodwill of
 * public infrastructure, so it must never be the thing that fails a unit run.
 *
 * BOTH SAS PROMPTS ARE ANSWERED, not bypassed. --yes cannot skip the SAS by
 * design, so the harness types "y" at it exactly as a person would. That the
 * test cannot skip it either is the point -- if a future change let --yes
 * through that gate, this file would still pass, so it also asserts the
 * prompt was actually shown.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'src', 'cli.js')
const TIMEOUT = 120_000

// 300 KB is ~19 chunks: enough that frames arrive in bursts rather than one
// settled delivery at a time, which is the condition ordering bugs need.
const PAYLOAD_BYTES = 300 * 1024

/** @param {Buffer} buf */
const sha = buf => createHash('sha256').update(buf).digest('hex')

/**
 * Spawns one CLI process, streaming its output into a buffer that `waitFor`
 * can watch. stdin stays open so prompts can be answered as they appear.
 *
 * @param {string[]} args
 * @param {string} label
 */
function launch(args, label) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Force the non-TTY path: progress becomes plain lines instead of \r
    // redraws, which is what makes the output parseable here.
    env: { ...process.env, NO_COLOR: '1' },
  })

  let output = ''
  /** @type {(() => void)[]} */
  const listeners = []
  /** @param {string} chunk */
  const absorb = chunk => {
    output += chunk
    process.stderr.write(`  [${label}] ${chunk}`.replace(/\n(?!$)/g, `\n  [${label}] `))
    for (const notify of listeners.splice(0)) notify()
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', absorb)
  child.stderr.on('data', absorb)

  return {
    child,
    get output() { return output },
    /** @param {string} line */
    say: line => child.stdin.write(line + '\n'),

    /**
     * Resolves once `pattern` appears in anything the process has written.
     * @param {RegExp} pattern
     */
    waitFor(pattern) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`[${label}] timed out waiting for ${pattern}\n--- output ---\n${output}`)),
          TIMEOUT,
        )
        const check = () => {
          const hit = pattern.exec(output)
          if (!hit) return listeners.push(check)
          clearTimeout(deadline)
          resolve(hit)
        }
        check()
      })
    },

    exited: new Promise(resolve => child.on('exit', code => resolve(code))),
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrdrop-interop-'))
  const outDir = path.join(dir, 'out')
  fs.mkdirSync(outDir)

  const source = path.join(dir, 'payload.bin')
  const payload = randomBytes(PAYLOAD_BYTES)
  fs.writeFileSync(source, payload)

  console.log(`payload ${PAYLOAD_BYTES} bytes, sha256 ${sha(payload)}`)

  const sender = launch(['send', source, '--no-qr'], 'send')
  let receiver

  try {
    // The sender prints the code before it starts waiting for a peer.
    const [, code] = await sender.waitFor(/(qrdrop:[A-Za-z0-9_-]{43})/)
    console.log(`\ncode: ${code}\n`)

    receiver = launch(['receive', code, '--out', outDir], 'recv')

    // Both sides show the SAS and stop. Neither moves until a human -- here,
    // this harness -- says the emoji match.
    const [, sasSender] = await sender.waitFor(/Both devices should be showing:\s*\n\s*\n\s*(\S.*?)\s*\n/)
    const [, sasReceiver] = await receiver.waitFor(/Both devices should be showing:\s*\n\s*\n\s*(\S.*?)\s*\n/)

    if (sasSender.trim() !== sasReceiver.trim()) {
      throw new Error(`SAS mismatch: sender ${sasSender} vs receiver ${sasReceiver}`)
    }
    console.log(`\nboth peers agree on the SAS: ${sasSender}\n`)

    sender.say('y')
    receiver.say('y')

    // Then the receiver is asked whether to accept the file itself.
    await receiver.waitFor(/Incoming:.*Accept\?/)
    receiver.say('y')

    const [senderCode, receiverCode] = await Promise.all([sender.exited, receiver.exited])
    if (senderCode !== 0) throw new Error(`sender exited ${senderCode}`)
    if (receiverCode !== 0) throw new Error(`receiver exited ${receiverCode}`)

    const written = fs.readdirSync(outDir)
    if (written.length !== 1) throw new Error(`expected one file, got ${written.join(', ')}`)

    const landed = fs.readFileSync(path.join(outDir, written[0]))
    if (!landed.equals(payload)) {
      throw new Error(`bytes differ: sent sha ${sha(payload)}, got sha ${sha(landed)}`)
    }

    // Both ends compute the chain digest independently; they must agree.
    const senderDigest = /digest=([0-9a-f]{64})/.exec(sender.output)?.[1]
    const receiverDigest = /digest=([0-9a-f]{64})/.exec(receiver.output)?.[1]
    if (!senderDigest || senderDigest !== receiverDigest) {
      throw new Error(`digest mismatch: ${senderDigest} vs ${receiverDigest}`)
    }

    console.log(`\nPASS  ${written[0]} (${landed.length} bytes) matched, digest ${senderDigest}`)
  } finally {
    sender.child.kill()
    receiver?.child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\nFAIL', error.message)
  process.exit(1)
})
