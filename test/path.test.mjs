/**
 * Which route the bytes took, and what the user is told about it.
 *
 * The classification is read off ICE stats, which normally means a real peer
 * connection -- but classifyPath only ever calls getStats() and walks the
 * report map it returns, so a fake `pc` that answers with a hand-built Map
 * exercises the whole decision offline, in a millisecond.
 *
 * The rows worth caring about are the ones that used to be a single boolean:
 * host/host (the bytes stayed on the network) and srflx (a direct connection
 * that still crosses the internet) were both "not relayed" before this, which
 * is why a same-Wi-Fi transfer and a metered one looked identical.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyPath, openRoom } from '../src/transport/room.js'
import { pathDescription, meteredWarning, METERED_WARN_BYTES } from '../src/core/messages.js'
import { generateSecret, deriveTopic, derivePassword } from '../src/core/secret.js'
import { fakeNetwork } from './helpers/fake-network.mjs'

/**
 * A peer connection that reports exactly one nominated, succeeded candidate
 * pair between the two given candidate types.
 *
 * @param {string | null} local
 * @param {string | null} remote
 */
function fakePC(local, remote) {
  const reports = new Map()
  reports.set('pair', {
    type: 'candidate-pair', state: 'succeeded', nominated: true,
    localCandidateId: 'L', remoteCandidateId: 'R',
  })
  if (local) reports.set('L', { type: 'local-candidate', candidateType: local })
  if (remote) reports.set('R', { type: 'remote-candidate', candidateType: remote })

  return /** @type {any} */ ({
    getStats: async () => ({
      forEach: (/** @type {(v: any, k: string) => void} */ fn) =>
        reports.forEach((v, k) => fn(v, k)),
    }),
  })
}

test('classifyPath: both ends on a host candidate means the bytes stayed local', async () => {
  assert.equal(await classifyPath(fakePC('host', 'host')), 'local')
})

test('classifyPath: a TURN candidate on either end is a relay', async () => {
  assert.equal(await classifyPath(fakePC('relay', 'host')), 'relay')
  assert.equal(await classifyPath(fakePC('host', 'relay')), 'relay')
  assert.equal(await classifyPath(fakePC('relay', 'srflx')), 'relay')
})

test('classifyPath: NAT-traversed pairs are direct, not local', async () => {
  assert.equal(await classifyPath(fakePC('srflx', 'srflx')), 'direct')
  assert.equal(await classifyPath(fakePC('prflx', 'srflx')), 'direct')

  // The distinction the old boolean threw away, and the one most likely to be
  // "simplified" back out: one end being on a local interface says nothing
  // about the other. Reaching a peer through NAT is an internet path however
  // local the near end looks, and calling it 'local' would tell someone on a
  // mobile plan their transfer is free when it is not.
  assert.equal(await classifyPath(fakePC('host', 'srflx')), 'direct')
  assert.equal(await classifyPath(fakePC('srflx', 'host')), 'direct')
})

test('classifyPath: says unknown rather than guessing', async t => {
  // node-datachannel builds land here, and so does any connection whose stats
  // have not settled within the poll window.
  const throws = /** @type {any} */ ({ getStats: async () => { throw new Error('no stats') } })
  assert.equal(await classifyPath(throws), 'unknown')

  // No candidate pair at all. classifyPath polls for three seconds before
  // giving up, which is the whole point -- stats are not there the instant a
  // connection opens -- so this one test pays that wall-clock cost.
  t.diagnostic('polls for ~3s before answering unknown')
  const empty = /** @type {any} */ ({ getStats: async () => ({ forEach: () => {} }) })
  assert.equal(await classifyPath(empty), 'unknown')
})

test('an unclassifiable connection is not treated as relayed', async () => {
  // The fail-open the 100 MiB cap depends on. The fake network in
  // room.test.mjs has no peer connections at all, so path() cannot resolve --
  // and isRelayed() must still be false, or every send over the cap on a build
  // that cannot read stats (which is every Node build) would be refused.
  const secret = generateSecret()
  const [topic, password] = await Promise.all([deriveTopic(secret), derivePassword(secret)])
  const { strategy } = fakeNetwork()

  const open = (/** @type {'host' | 'guest'} */ role) =>
    openRoom({ topic, password, secret, role, strategies: [strategy], iceServers: [], timeoutMs: 5000 })

  const [host, guest] = await Promise.all([open('host'), open('guest')])

  assert.equal(await host.path(), 'unknown')
  assert.equal(await host.isRelayed(), false)

  host.close()
  guest.close()
})

test('pathDescription: every path has copy, and local never overclaims', () => {
  for (const path of /** @type {const} */ (['local', 'direct', 'relay', 'unknown'])) {
    const { label, detail } = pathDescription(path)
    assert.ok(label.length > 0, `${path} has a label`)
    assert.ok(detail.length > 0, `${path} has a detail`)
  }

  // A host candidate can belong to a VPN or Tailscale interface, so the local
  // copy may describe where the bytes go but must never promise what it costs.
  const local = pathDescription('local')
  assert.doesNotMatch(`${local.label} ${local.detail}`, /free|no charge|no data/i)
})

test('meteredWarning: fires on internet paths above the threshold only', () => {
  const big = METERED_WARN_BYTES + 1
  const small = METERED_WARN_BYTES

  assert.ok(meteredWarning({ name: 'a.bin', size: big, path: 'direct' }))
  assert.ok(meteredWarning({ name: 'a.bin', size: big, path: 'relay' }))

  assert.equal(meteredWarning({ name: 'a.bin', size: small, path: 'direct' }), null)
  assert.equal(meteredWarning({ name: 'a.bin', size: small, path: 'relay' }), null)

  // Silent on a local path at any size -- that is what classifying bought.
  assert.equal(meteredWarning({ name: 'a.bin', size: big, path: 'local' }), null)

  // And silent on 'unknown' at any size. This is the row a later "be safer,
  // warn more often" change would flip, without noticing that 'unknown' is the
  // normal answer on Node -- which would put a warning on every large CLI
  // send, and a warning that always fires stops being read.
  assert.equal(meteredWarning({ name: 'a.bin', size: big, path: 'unknown' }), null)
})

test('meteredWarning names the file and hedges the cost', () => {
  const warning = meteredWarning({ name: 'report.pdf', size: 900 * 1024 * 1024, path: 'direct' })
  assert.match(String(warning), /report\.pdf/)
  // "may cost", never "will": plenty of direct transfers run over unmetered
  // home broadband, and a warning that overclaims gets dismissed on sight.
  assert.match(String(warning), /may cost/)
  assert.doesNotMatch(String(warning), /will cost/)
})
