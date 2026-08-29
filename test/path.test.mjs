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

import {
  classifyPath, isPrivateAddress, addressForm, addressShape, combinePaths, openRoom,
} from '../src/transport/room.js'
import { createEphemeralKeypair, exportPublicKey, establishSession } from '../src/core/session.js'
import { createControlStream } from '../src/core/control.js'
import { createReceiver, sendPathVerdict } from '../src/core/receiver.js'
import { pathDescription, meteredWarning, METERED_WARN_BYTES } from '../src/core/messages.js'
import { generateSecret, deriveTopic, derivePassword } from '../src/core/secret.js'
import { fakeNetwork } from './helpers/fake-network.mjs'

/**
 * A peer connection that reports exactly one nominated, succeeded candidate
 * pair between the two given candidate types.
 *
 * Addresses default to public ones, so a test that says nothing about them is
 * asking purely about candidate types.
 *
 * @param {string | null} local
 * @param {string | null} remote
 * @param {{ localAddress?: string, remoteAddress?: string }} [addrs]
 */
function fakePC(local, remote, addrs = {}) {
  const { localAddress = '203.0.113.7', remoteAddress = '198.51.100.9' } = addrs
  const reports = new Map()
  reports.set('pair', {
    type: 'candidate-pair', state: 'succeeded', nominated: true,
    localCandidateId: 'L', remoteCandidateId: 'R',
  })
  if (local) reports.set('L', { type: 'local-candidate', candidateType: local, address: localAddress })
  if (remote) reports.set('R', { type: 'remote-candidate', candidateType: remote, address: remoteAddress })

  return /** @type {any} */ ({
    getStats: async () => ({
      forEach: (/** @type {(v: any, k: string) => void} */ fn) =>
        reports.forEach((v, k) => fn(v, k)),
    }),
  })
}

test('classifyPath: both ends on a host candidate means the bytes stayed local', async () => {
  // Type alone decides here -- these carry public addresses, and a host
  // candidate under mDNS has no usable address at all.
  assert.equal(await classifyPath(fakePC('host', 'host')), 'local')

  assert.equal(await classifyPath(fakePC('host', 'host', {
    localAddress: 'e6c1a0f2-9d4b-4a11-8f3e-2b7c5d9a1e04.local',
    remoteAddress: '9f2b7c5d-1e04-4a11-8f3e-e6c1a0f29d4b.local',
  })), 'local')
})

test('classifyPath: a LAN pair is local even when one side saw peer-reflexive', async () => {
  // The regression this rule exists for. A phone and a laptop on one Wi-Fi
  // reported different paths to their users: the laptop resolved the phone's
  // mDNS name and saw host/host, the phone did not and saw host/prflx, so the
  // phone told its user the transfer was crossing the internet. Same LAN, same
  // nominated pair, and the difference was visible to two people side by side.
  assert.equal(await classifyPath(fakePC('host', 'prflx', {
    localAddress: '192.168.1.42', remoteAddress: '192.168.1.17',
  })), 'local')
  assert.equal(await classifyPath(fakePC('prflx', 'host', {
    localAddress: '10.0.0.8', remoteAddress: '10.0.0.31',
  })), 'local')

  // Both directions of the same pairing must agree, whichever side is asked.
  const laptop = await classifyPath(fakePC('host', 'host', {
    localAddress: '192.168.1.17', remoteAddress: '192.168.1.42',
  }))
  const phone = await classifyPath(fakePC('host', 'prflx', {
    localAddress: '192.168.1.42', remoteAddress: '192.168.1.17',
  }))
  assert.equal(laptop, phone)
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

  // A peer-reflexive candidate holding a PUBLIC address is a NAT-traversed
  // path, and must not be swept up by the private-address rule above.
  assert.equal(await classifyPath(fakePC('host', 'prflx', {
    localAddress: '192.168.1.42', remoteAddress: '203.0.113.55',
  })), 'direct')
})

test('isPrivateAddress: only addresses that stay off the public internet', () => {
  for (const addr of ['10.0.0.1', '192.168.1.42', '172.16.0.1', '172.31.255.254',
    '169.254.1.1', '127.0.0.1', '::1', 'fe80::1', 'fd12:3456::1',
    'abc-123.local', 'ABC.LOCAL']) {
    assert.equal(isPrivateAddress(addr), true, addr)
  }

  // 172.15 and 172.32 sit just outside the /12, and are the boundaries an
  // off-by-one in that range check would wrongly claim as local.
  for (const addr of ['203.0.113.7', '8.8.8.8', '172.15.0.1', '172.32.0.1',
    '2001:db8::1', '', 'not-an-address']) {
    assert.equal(isPrivateAddress(addr), false, addr)
  }

  assert.equal(isPrivateAddress(undefined), false)
  assert.equal(isPrivateAddress(null), false)

  // An IPv4-mapped IPv6 address is an IPv4 address wearing a hat. Read as
  // IPv6 it looks globally routable, which would call a LAN address public.
  assert.equal(isPrivateAddress('::ffff:192.168.1.34'), true)
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true)
  assert.equal(isPrivateAddress('::ffff:103.74.136.124'), false)
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

test('addressForm: categorises without revealing the address', () => {
  assert.equal(addressForm('abc-123.local'), 'mdns')
  assert.equal(addressForm('192.168.1.34'), 'ipv4-rfc1918')
  assert.equal(addressForm('10.1.2.3'), 'ipv4-rfc1918')
  assert.equal(addressForm('172.20.0.1'), 'ipv4-rfc1918')
  assert.equal(addressForm('169.254.5.5'), 'ipv4-linklocal')
  assert.equal(addressForm('127.0.0.1'), 'ipv4-loopback')
  assert.equal(addressForm('103.74.136.124'), 'ipv4-public')
  assert.equal(addressForm('fe80::1'), 'ipv6-linklocal')
  assert.equal(addressForm('fd00::1'), 'ipv6-ula')
  assert.equal(addressForm('2401:4900::1'), 'ipv6-global')
  assert.equal(addressForm(undefined), 'none')
  assert.equal(addressForm(''), 'none')

  // Carrier-grade NAT, 100.64.0.0/10: what a phone on mobile data usually
  // has. Not routable, but not a LAN address either, and its own category so
  // the two can never be confused for one another.
  assert.equal(addressForm('100.64.0.1'), 'ipv4-cgnat')
  assert.equal(addressForm('100.127.255.254'), 'ipv4-cgnat')
  assert.equal(addressForm('100.63.0.1'), 'ipv4-public')
  assert.equal(addressForm('100.128.0.1'), 'ipv4-public')

  assert.equal(addressForm('::ffff:192.168.1.34'), 'ipv4-rfc1918')
  assert.equal(addressForm('::ffff:103.74.136.124'), 'ipv4-public')
})

test('addressShape: format without content', () => {
  // Everything identifying is replaced; punctuation and length survive, which
  // is all that is needed to recognise a format we do not yet parse.
  assert.equal(addressShape('192.168.1.34'), '###.###.#.##')
  assert.equal(addressShape('abc-123.local'), 'aaa-###.aaaaa')
  assert.equal(addressShape(''), null)
  assert.equal(addressShape(undefined), null)
  assert.doesNotMatch(String(addressShape('192.168.1.34')), /[0-9]/)
})

/**
 * A connection holding several candidate pairs, only one of which won.
 *
 * @param {string} selectedId
 * @param {Array<[string, any]>} pairs
 * @param {Record<string, { type: string, address?: string }>} candidates
 */
function fakeMultiPC(selectedId, pairs, candidates) {
  /** @type {Map<string, any>} */
  const reports = new Map()
  reports.set('T', { type: 'transport', selectedCandidatePairId: selectedId })
  for (const [id, pair] of pairs) reports.set(id, { type: 'candidate-pair', ...pair })
  for (const [id, c] of Object.entries(candidates)) {
    reports.set(id, { type: 'local-candidate', candidateType: c.type, address: c.address })
  }
  return /** @type {any} */ ({
    getStats: async () => ({
      forEach: (/** @type {(v: any, k: string) => void} */ fn) => reports.forEach((v, k) => fn(v, k)),
    }),
  })
}

test('classifyPath: reads the pair that won, not the first one listed', async () => {
  // Taken from a real dump. TWO pairs were state 'succeeded' AND
  // nominated: true -- a host/host pair and a srflx/srflx pair -- describing
  // one connection at two moments of ICE's work. Only the first was actually
  // in use.
  //
  // The old code returned the first such pair it iterated, so the verdict
  // depended on the order getStats happened to emit rows in. That made the
  // badge intermittent and made two peers on one Wi-Fi disagree about their
  // own connection; it looked for several rounds like a difference between
  // browsers, and was a coin toss.
  const pairs = /** @type {Array<[string, any]>} */ ([
    ['won', { state: 'succeeded', nominated: true, selected: true, localCandidateId: 'Lh', remoteCandidateId: 'Rh' }],
    ['lost', { state: 'succeeded', nominated: true, selected: false, localCandidateId: 'Ls', remoteCandidateId: 'Rs' }],
  ])
  const candidates = {
    Lh: { type: 'host', address: 'aaa.local' }, Rh: { type: 'host', address: 'bbb.local' },
    Ls: { type: 'srflx', address: '103.74.136.124' }, Rs: { type: 'srflx', address: '203.0.113.9' },
  }

  assert.equal(await classifyPath(fakeMultiPC('won', pairs, candidates)), 'local')
  // Same stats, losing pair emitted first. The answer must not move.
  assert.equal(await classifyPath(fakeMultiPC('won', [...pairs].reverse(), candidates)), 'local')
})

test('classifyPath: an address the browser withheld is unknown, not direct', async () => {
  // Firefox does not expose the address of a peer-reflexive candidate -- it
  // reports the literal string "(redacted)". So when one peer fails to resolve
  // the other's mDNS name, this is all the evidence there is, and it supports
  // no verdict either way.
  //
  // It must not be 'direct'. The old code ended in `return 'direct'`, so this
  // case told people on their own Wi-Fi that the transfer was crossing the
  // internet, and warned them what it might cost.
  const pc = fakeMultiPC('sel', [
    ['sel', { state: 'succeeded', nominated: true, selected: true, localCandidateId: 'Lh', remoteCandidateId: 'Rp' }],
  ], {
    Lh: { type: 'host', address: 'ccc.local' },
    Rp: { type: 'prflx', address: '(redacted)' },
  })
  assert.equal(await classifyPath(pc), 'unknown')
})

test('classifyPath: srflx is direct without needing a readable address', async () => {
  const pc = fakeMultiPC('sel', [
    ['sel', { state: 'succeeded', nominated: true, selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
  ], { L: { type: 'host', address: 'ccc.local' }, R: { type: 'srflx', address: '(redacted)' } })
  assert.equal(await classifyPath(pc), 'direct')
})

test('classifyPath: carrier-grade NAT counts as crossing the internet', async () => {
  // Not routable, but a mobile network, and billed like one -- so a warning
  // about data cost is right here even though the address is not public.
  const pc = fakeMultiPC('sel', [
    ['sel', { state: 'succeeded', nominated: true, selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
  ], { L: { type: 'host', address: '192.168.1.5' }, R: { type: 'prflx', address: '100.71.3.9' } })
  assert.equal(await classifyPath(pc), 'direct')
})

test('combinePaths: evidence beats absence, and cost beats convenience', () => {
  // Absence of evidence is not evidence. One peer answering 'unknown' -- the
  // normal outcome when Firefox withholds a peer-reflexive address -- must not
  // erase what the other peer could actually see.
  assert.equal(combinePaths('local', 'unknown'), 'local')
  assert.equal(combinePaths('unknown', 'local'), 'local')
  assert.equal(combinePaths('direct', 'unknown'), 'direct')

  // A genuine conflict resolves the expensive way. Being wrongly warned about
  // data cost is an annoyance; being wrongly told a metered transfer is free
  // is a bill, and this asymmetry is why the ordering is not symmetric.
  assert.equal(combinePaths('local', 'direct'), 'direct')
  assert.equal(combinePaths('direct', 'local'), 'direct')

  // Relay outranks everything: it is the only one carrying a size cap.
  assert.equal(combinePaths('relay', 'local'), 'relay')
  assert.equal(combinePaths('local', 'relay'), 'relay')
  assert.equal(combinePaths('relay', 'direct'), 'relay')

  assert.equal(combinePaths('local', 'local'), 'local')
  assert.equal(combinePaths('unknown', 'unknown'), 'unknown')
})

test('a path verdict crosses the wire sealed, and reaches the peer', async () => {
  // The exchange end to end over the real framing, because the risk in adding
  // a control message is not the message: it is the counted nonce stream it
  // shares with the manifest and the replies. Sealed with the sender's key and
  // opened with the receiver's, at the right index, or nothing arrives.
  const secret = generateSecret()
  const [hk, gk] = await Promise.all([createEphemeralKeypair(), createEphemeralKeypair()])
  const [host, guest] = await Promise.all([
    establishSession({ keypair: hk, peerPublicRaw: await exportPublicKey(gk), secret, role: 'host' }),
    establishSession({ keypair: gk, peerPublicRaw: await exportPublicKey(hk), secret, role: 'guest' }),
  ])

  /** @type {NetworkPath[]} */
  const received = []
  let guestCtl = 0
  /** @type {any} */
  const guestCh = { bufferedAmount: 0, send: async () => {}, onbufferedamountlow: null }
  const guestRx = createReceiver({
    channel: guestCh,
    sendKey: guest.sendKey,
    recvKey: guest.recvKey,
    control: createControlStream(),
    nextControlIndex: () => guestCtl++,
    onOffer: () => {},
    onPeerPath: path => received.push(path),
    createSink: async () => { throw new Error('no file expected') },
  })

  let hostCtl = 0
  /** @type {any} */
  const hostCh = {
    bufferedAmount: 0, onbufferedamountlow: null,
    send: (/** @type {Bytes} */ bytes) => guestRx.handleFrame(bytes),
  }

  await sendPathVerdict({
    channel: hostCh, key: host.sendKey, nextControlIndex: () => hostCtl++, path: 'local',
  })

  assert.deepEqual(received, ['local'])
})
