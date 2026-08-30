/**
 * Pairing, via Trystero -- now over more than one signalling network.
 *
 * Trystero handles relay connections, peer discovery, offer/answer, ICE, and
 * the data channel; what stays ours is everything above it -- the ECDH session,
 * the SAS, and the per-chunk AEAD in transfer/.
 *
 * WHY MORE THAN ONE NETWORK:
 *
 * A single strategy (this was Nostr alone) is a single point of failure. Public
 * Nostr relays go down, start rejecting writes, or demand proof-of-work, and
 * when enough of them are unreachable for one peer, pairing just times out.
 * `openRoom` now joins every entry in STRATEGIES at once and pairs on whichever
 * completes the handshake first, then tears the losers down. Both peers are
 * present on every network simultaneously, so they meet on the fastest path
 * they share -- no cross-peer agreement on which network to use is needed,
 * which a sequential fallback could not guarantee.
 *
 * WHY NOSTR + TORRENT AND NOT MORE: the BitTorrent-tracker strategy shares
 * Trystero's core and adds ~2 kB gzipped, so a second independent network is
 * nearly free. The MQTT strategy pulls in a full MQTT client (~112 kB gzipped,
 * quadrupling the page) for a third network whose marginal value over two is
 * small; it was measured and left out. Adding it back is a one-line change if
 * the two chosen networks ever show correlated outages.
 *
 * WHY `password` IS NOT OPTIONAL HERE:
 *
 * Trystero owns the session descriptions now, so we can no longer seal the SDP
 * ourselves. `password` is what replaces that: it encrypts session descriptions
 * with AES-GCM as they cross the relays. Without it Trystero falls back to a
 * key derived from the app ID and room name -- both of which any observer of
 * the relay already has -- which would leave the DTLS fingerprint substitutable
 * in transit, the exact man-in-the-middle this design exists to prevent.
 *
 * The password is HKDF output from the QR secret, so only someone holding the
 * code can produce session descriptions either peer will accept.
 *
 * Our own ECDH still runs on top of that, and still uses the QR secret as its
 * HKDF salt. So even if Trystero's signalling encryption were broken outright,
 * file bytes stay closed: an attacker would also need the secret to derive the
 * session key. The layers fail independently, which is the point of having two.
 *
 * API NOTE: Trystero 0.25 is object-based, not tuple-based. makeAction returns
 * an object with `send()` and an assignable `onMessage`, and onPeerJoin /
 * onPeerLeave are assigned rather than called. The older
 * `const [send, receive] = room.makeAction(...)` form throws "object is not
 * iterable" against this version. Every strategy package exposes the identical
 * `joinRoom` signature, so joinVia treats them uniformly.
 */

import { joinRoom as joinNostr } from '@trystero-p2p/nostr'
import { joinRoom as joinTorrent } from '@trystero-p2p/torrent'
import { createChannel } from './channel.js'
import { createEphemeralKeypair, exportPublicKey, establishSession } from '../core/session.js'
import { fromBase64url, toBase64url } from '../core/secret.js'

const APP_ID = 'qrdrop'
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * The Nostr relay list. Pinned rather than using Trystero's built-in pool of
 * ~44 relays, so the connect-src allowlist on the page can name every host it
 * will ever contact. Passing `urls` makes Trystero use exactly this list and
 * ignore its own.
 *
 * Chosen from Trystero's pool by actually connecting to each one. The obvious
 * picks -- relay.damus.io, relay.nostr.band, relay.snort.social -- are the
 * best-known Nostr relays and were all unreachable when this list was built;
 * popularity and availability are not the same thing. Re-test before editing,
 * and re-test by PUBLISHING, not by opening a socket: relay.nostr.place was
 * dropped from this list after it started demanding proof-of-work (NIP-13) on
 * writes. It still accepts connections and still answers reads, so a
 * connectivity probe calls it healthy; Trystero cannot announce a peer on it,
 * which is the only thing we need a relay to do.
 *
 * Still exported under this name because src/index.js and external callers
 * import it; it is now one entry of STRATEGIES rather than the whole story.
 */
export const RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.mostr.pub',
  'wss://purplerelay.com',
  'wss://nostr.data.haus',
  'wss://nostr-01.yakihonne.com',
  'wss://bucket.coracle.social',
]

/**
 * Public WebTorrent tracker sockets, no account. Seeded from
 * `@trystero-p2p/torrent`'s defaultRelayUrls -- same "verify by PUBLISHING, not
 * by connecting" caveat as RELAYS.
 */
const TORRENT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
]

/**
 * The signalling networks openRoom races. Each entry pairs a Trystero strategy
 * with the exact URL list it may dial. Order is cosmetic -- every entry is
 * joined at once -- but nostr stays first as the historical default and the
 * one proven under node-datachannel.
 *
 * @type {readonly SignalingStrategy[]}
 */
export const STRATEGIES = [
  { name: 'nostr', join: joinNostr, urls: RELAYS },
  { name: 'torrent', join: joinTorrent, urls: TORRENT_TRACKERS },
]

/**
 * Every signalling URL any strategy may dial, flattened. scripts/build-site.mjs
 * imports this and generates connect-src from it (reduced to origins), so the
 * allowlist cannot drift out of step with the list the code actually dials.
 * Editing a strategy's `urls` above is enough.
 */
export const SIGNALING_URLS = STRATEGIES.flatMap(s => s.urls)

/**
 * STUN spread across operators, plus free no-auth TURN.
 *
 * STUN only tells a peer its own public address and costs nothing; a single
 * provider (this was Google alone) is a single point of failure and is blocked
 * on some networks, hence the spread.
 *
 * TURN actually relays the media when NAT traversal fails outright -- roughly
 * 10-15% of pairings. The Open Relay Project publishes these static credentials
 * with no signup; they are best-effort and rate-limited, which is why
 * transfers that end up relayed are size-capped (see RELAYED_MAX_BYTES). A
 * relay costs no confidentiality: it carries DTLS-wrapped frames that are
 * themselves sealed under the session key, so the operator sees ciphertext and
 * byte counts, never contents. It does see both peers' IPs. Adding
 * `iceTransportPolicy: 'relay'` to rtcConfig would hide each peer's IP from the
 * other, at the cost of requiring TURN to connect at all -- deliberately left
 * opt-in.
 *
 * @type {readonly RTCIceServer[]}
 */
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
]

/**
 * The ceiling on a transfer whose path runs through a free TURN relay. Free
 * TURN relays real bytes and is metered, so a multi-gigabyte transfer over it
 * is abusive and would be throttled or cut mid-stream anyway. Only enforced
 * when isRelayed() reports true; a direct connection has no such limit.
 *
 * 100 MiB. Deliberately conservative while there is no resume: an interrupted
 * transfer starts over from zero.
 */
export const RELAYED_MAX_BYTES = 100 * 1024 * 1024

/**
 * Narrows an inbound Trystero payload to bytes.
 *
 * Anything that is not already binary is turned into an empty array rather
 * than coerced. A peer that sends a string or a number where a frame belongs
 * is misbehaving, and an empty array is refused one layer down as a runt frame
 * -- which is a clean, reported failure instead of `new Uint8Array('...')`
 * quietly producing garbage the receiver then tries to decrypt.
 *
 * @param {TrysteroPayload} data
 * @returns {Bytes}
 */
const toBytes = data => {
  if (data instanceof Uint8Array) return /** @type {Bytes} */ (data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    // Copied rather than wrapped: `buffer` here is ArrayBufferLike, which
    // includes SharedArrayBuffer, and WebCrypto refuses those. Uint8Array.from
    // gives a plainly-backed copy. Only reachable if a peer sends some other
    // view type, so the copy is not on the hot path.
    return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  return new Uint8Array(0)
}

/** @param {{ leave: () => unknown }} room */
const tryLeave = room => {
  try {
    room.leave()
  } catch {
    // Already gone.
  }
}

/**
 * Whether an ICE candidate address is one that only exists on a local network.
 *
 * Needed because "both ends reported a host candidate" is too strict a test for
 * a LAN hop, and fails asymmetrically -- which is how this was found: a phone
 * and a laptop on one Wi-Fi disagreed, the laptop saying 'local' and the phone
 * 'direct', over the same nominated pair.
 *
 * The cause is mDNS. Browsers do not signal raw LAN addresses; a host candidate
 * goes out as a random `<uuid>.local` name. When the far side cannot resolve
 * that name -- Android Chrome is markedly worse at it than desktop, and plenty
 * of access points block multicast between clients -- ICE still connects,
 * because the connectivity check arrives anyway and its SOURCE address is
 * adopted as a peer-reflexive candidate. So the peer that resolved the name
 * sees host/host, and the peer that did not sees host/prflx, for one connection.
 *
 * A prflx address is read off the packet rather than out of the SDP, so it is
 * always a real IP and never an mDNS name. That is what makes inspecting the
 * address safe here specifically, and it is not a licence to inspect addresses
 * generally: classifying a HOST candidate by address would see `.local` and
 * silently downgrade every LAN transfer, which is the trap the type check
 * exists to avoid.
 *
 * `.local` still counts as private below, for the case where a resolvable mDNS
 * name reaches us paired with something else.
 *
 * A VPN or Tailscale interface also hands out RFC1918 addresses, so "private"
 * here means "not routed over the public internet", which is the strongest
 * claim available and exactly what pathDescription's copy is hedged to.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const addr = address.toLowerCase()

  // An mDNS name is a local-network name by definition.
  if (addr.endsWith('.local')) return true

  // An IPv4-mapped IPv6 address (::ffff:192.168.1.5) is an IPv4 address
  // wearing a hat, and must be judged as one. Read as IPv6 it looks global,
  // which would call a LAN address public.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)
  if (mapped) return isPrivateAddress(mapped[1])

  // IPv6. Link-local (fe80::/10) and unique-local (fc00::/7), plus loopback.
  if (addr.includes(':')) {
    return addr === '::1' || /^fe[89ab]/.test(addr) || /^f[cd]/.test(addr)
  }

  const parts = addr.split('.')
  if (parts.length !== 4) return false
  const [a, b] = parts.map(Number)
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false

  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // link-local, no DHCP
  return false
}

/**
 * One verdict from two, when both peers have classified their own end.
 *
 * Needed because the two peers genuinely see different evidence and neither is
 * wrong. Firefox withholds the address of a peer-reflexive candidate, so the
 * side that failed to resolve the other's mDNS name can only answer 'unknown',
 * while the side that resolved it answers 'local' about the same connection.
 * Left alone, one person is told where their bytes went and the person beside
 * them is told nothing.
 *
 * Precedence is relay > direct > local > unknown, which is two rules at once.
 *
 * Evidence beats absence: 'local' and 'unknown' resolves to 'local', because
 * 'unknown' is one peer having nothing to say, not a claim that contradicts
 * the other. And where the two genuinely conflict, the more expensive reading
 * wins: 'local' and 'direct' resolves to 'direct'. Being wrongly warned about
 * data cost is an annoyance; being wrongly told a metered transfer is free is
 * a bill. The asymmetry of those two mistakes is the whole reason this ordering
 * is not symmetric.
 *
 * @param {NetworkPath} mine
 * @param {NetworkPath} theirs
 * @returns {NetworkPath}
 */
export function combinePaths(mine, theirs) {
  const both = [mine, theirs]
  if (both.includes('relay')) return 'relay'
  if (both.includes('direct')) return 'direct'
  if (both.includes('local')) return 'local'
  return 'unknown'
}

/**
 * The candidate pair the connection actually settled on, or null if it has not
 * settled yet.
 *
 * Asking this properly is the whole point. A connection can hold SEVERAL pairs
 * that are both `succeeded` and `nominated: true` -- a real dump from two
 * laptops on one Wi-Fi carried a host/host pair and a srflx/srflx pair, both
 * marked exactly that way, describing the same connection at two different
 * moments of ICE's work. Only one of them was the pair in use.
 *
 * The previous version of this code scanned for the first pair that was
 * succeeded and not explicitly `nominated: false`, and returned it. That reads
 * an arbitrary row: which one comes first is whatever order getStats() happens
 * to produce. It made the path badge intermittent, and made two peers on one
 * network disagree about their own connection -- one reading the host pair and
 * saying "Local network", the other reading the srflx pair and saying "Direct,
 * over the internet". It looked like a difference between browsers for several
 * rounds. It was a coin toss.
 *
 * So: the transport's selectedCandidatePairId first, which is the spec's answer
 * to "which pair won". Firefox's non-standard `selected` flag second. The old
 * scan is kept last, because something is better than nothing on an
 * implementation that offers neither, but it is now the fallback rather than
 * the strategy.
 *
 * @param {Map<string, any>} byId
 * @returns {any | null}
 */
function selectedPair(byId) {
  for (const report of byId.values()) {
    if (report.type !== 'transport' || !report.selectedCandidatePairId) continue
    const pair = byId.get(report.selectedCandidatePairId)
    if (pair) return pair
  }

  for (const report of byId.values()) {
    if (report.type === 'candidate-pair' && report.selected) return report
  }

  for (const report of byId.values()) {
    if (report.type !== 'candidate-pair') continue
    if (report.state !== 'succeeded') continue
    if (report.nominated === false) continue
    return report
  }

  return null
}

/**
 * Which route the live connection actually took, read off the nominated ICE
 * candidate pair. Drives both the RELAYED_MAX_BYTES cap and the path badge the
 * user sees.
 *
 *   'local'   both ends nominated a host candidate -- the bytes are staying on
 *             this network and never reach an ISP.
 *   'direct'  a direct peer connection, but reached through NAT (srflx/prflx),
 *             so every byte crosses the internet.
 *   'relay'   through a third-party TURN server: across the internet twice.
 *   'unknown' this build cannot tell.
 *
 * This used to return a bare boolean -- relayed or not -- which threw away the
 * host/srflx distinction it was already reading. That collapse is why a
 * same-Wi-Fi transfer and a transfer billed against a mobile plan looked
 * identical to the user.
 *
 * Polls briefly: the nominated candidate pair is not always in getStats() the
 * instant the connection opens. If it never resolves -- including
 * node-datachannel builds where getStats() reports nothing useful -- this
 * answers 'unknown' rather than guessing. Callers must keep 'unknown' failing
 * OPEN for the cap (see isRelayed below): the cap is a courtesy to free
 * infrastructure, not a security boundary, and treating "cannot tell" as
 * "relayed" would refuse every Node send over 100 MiB.
 *
 * Not defeated by mDNS: browsers replace the address of a host candidate with a
 * random `.local` name, but `candidateType` still reads 'host'. Classify off
 * that field, never by parsing the address -- an address-based check would see
 * an opaque hostname and silently downgrade every LAN transfer to 'direct'.
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<NetworkPath>}
 */

export async function classifyPath(pc) {
  const deadline = Date.now() + 3000

  while (Date.now() < deadline) {
    /** @type {RTCStatsReport | undefined} */
    let stats
    try {
      stats = await pc.getStats()
    } catch {
      return 'unknown'
    }

    /** @type {Map<string, any>} */
    const byId = new Map()
    stats.forEach((report, id) => byId.set(id, report))

    const pair = selectedPair(byId)
    if (pair) {
      const local = byId.get(pair.localCandidateId)
      const remote = byId.get(pair.remoteCandidateId)
      if (local || remote) return classifyPair(local, remote)
    }

    await new Promise(resolve => setTimeout(resolve, 300))
  }

  return 'unknown'
}

/**
 * The verdict for one candidate pair, from whatever evidence it carries.
 *
 * Ordered by how much each piece of evidence is worth, strongest first, and
 * ending in 'unknown' rather than in a guess. That last part is the important
 * one: the previous version finished with `return 'direct'`, so every case it
 * had no evidence about was reported to the user as a metered internet
 * connection -- confidently, and sometimes wrongly, complete with a warning
 * about what it might cost them.
 *
 * Evidence is genuinely scarce here, because Firefox does not hand out the
 * address of a peer-reflexive candidate: it reports the literal string
 * "(redacted)". So a pairing where one side failed to resolve the other's mDNS
 * name yields host/prflx with no address at all, which is neither provably
 * local nor provably remote. It now says so.
 *
 * @param {any} local
 * @param {any} remote
 * @returns {NetworkPath}
 */
function classifyPair(local, remote) {
  const types = [local?.candidateType, remote?.candidateType]
  const addresses = [local?.address ?? local?.ip, remote?.address ?? remote?.ip]

  // Through a TURN server, whatever else is true.
  if (types.includes('relay')) return 'relay'

  // A server-reflexive candidate IS the address STUN observed from outside,
  // so a pair using one went out through NAT by construction. This needs no
  // address to be readable, which is what makes it worth checking before any
  // of the address rules below.
  if (types.includes('srflx')) return 'direct'

  // Both ends on a host candidate: each side is talking to an address it
  // found on one of its own interfaces.
  if (types[0] === 'host' && types[1] === 'host') return 'local'

  // Or both addresses are readable AND not routable on the public internet.
  if (addresses.every(isPrivateAddress)) return 'local'

  // Positive evidence the other way: an address we can read that is public,
  // or carrier-grade NAT -- which is not public, but is a mobile network, and
  // is billed like one.
  const OUTSIDE = ['ipv4-public', 'ipv6-global', 'ipv4-cgnat']
  if (addresses.some(a => OUTSIDE.includes(addressForm(a)))) return 'direct'

  // Everything else: a prflx candidate whose address the browser withheld,
  // most often. Not knowing is a real answer, and much better than the
  // alternative -- claiming 'local' here would tell someone on a mobile plan
  // their transfer is free, and claiming 'direct' would nag someone on their
  // own Wi-Fi about data charges they are not incurring.
  return 'unknown'
}

/**
 * A coarse category for an ICE candidate address: enough to reason about a
 * path, not enough to identify anyone.
 *
 * Exists because diagnosing this needed the address, and an address is exactly
 * the thing a person is right to be reluctant to paste into a chat window. The
 * category answers every question the raw value would -- is this a LAN
 * address, a carrier-NAT address, a public one -- while being useless to
 * anyone who reads it later.
 *
 * @param {unknown} address
 * @returns {string}
 */
export function addressForm(address) {
  if (typeof address !== 'string' || address === '') return 'none'
  const addr = address.toLowerCase()

  // An mDNS placeholder. Deliberately its own category rather than folded in
  // with the private ranges: it is a NAME, and it says nothing whatsoever
  // about where the packets actually went.
  if (addr.endsWith('.local')) return 'mdns'

  // See isPrivateAddress: judged by the IPv4 inside, not the IPv6 wrapper.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)
  if (mapped) return addressForm(mapped[1])

  if (addr.includes(':')) {
    if (addr === '::1') return 'ipv6-loopback'
    if (/^fe[89ab]/.test(addr)) return 'ipv6-linklocal'
    if (/^f[cd]/.test(addr)) return 'ipv6-ula'
    return 'ipv6-global'
  }

  const parts = addr.split('.')
  if (parts.length !== 4) return 'unrecognised'
  const [a, b] = parts.map(Number)
  if (!Number.isInteger(a) || !Number.isInteger(b)) return 'unrecognised'

  if (a === 127) return 'ipv4-loopback'
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'ipv4-rfc1918'
  if (a === 169 && b === 254) return 'ipv4-linklocal'
  // Carrier-grade NAT. Not routable on the public internet, but not a LAN
  // address either -- a phone on mobile data typically has one.
  if (a === 100 && b >= 64 && b <= 127) return 'ipv4-cgnat'
  return 'ipv4-public'
}

/**
 * The SHAPE of an address my categoriser did not recognise, with every
 * character of content replaced.
 *
 * Digits become #, letters become a, punctuation is kept. So 192.168.1.34
 * reads ###.###.#.## and a UUID mDNS name reads
 * aaaaaaaa-####-####-... -- which is everything needed to see what format
 * arrived, and nothing about who it belongs to.
 *
 * Only ever produced for the 'unrecognised' category, which by definition
 * means the value is not one of the forms this code knows how to reason
 * about. That is exactly the case where the format matters and the value
 * does not.
 *
 * @param {unknown} address
 * @returns {string | null}
 */
export function addressShape(address) {
  if (typeof address !== 'string' || address === '') return null
  return address
    .replace(/[0-9]/g, '#')
    .replace(/[a-z]/gi, 'a')
    .slice(0, 80)
}

/**
 * Every candidate pair the connection knows about, for diagnosing a
 * disagreement between two peers about one connection.
 *
 * TEMPORARY, and deliberately not wired into classifyPath. It exists because a
 * phone and a laptop on one Wi-Fi reported different paths, the disagreement
 * survived a first fix, and which side was wrong REVERSED when the browser
 * pairing changed -- so the next change should be driven by what the browsers
 * actually report rather than by a third theory about it. Delete this and its
 * `?debug=path` surface once the classification is settled.
 *
 * Dumps ALL pairs, not just the one classifyPath picks, plus the transport's
 * selectedCandidatePairId. That last field is the point of the exercise:
 * classifyPath scans for the first succeeded, non-`nominated: false` pair,
 * while the spec's answer to "which pair actually won" is this id. If browsers
 * disagree about `nominated`, or keep several succeeded pairs, the two peers
 * would be reading different rows of the same table -- which would explain a
 * disagreement that flips depending on which browsers are involved.
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<object>}
 */
export async function collectPathEvidence(pc) {
  /** @type {Map<string, any>} */
  const byId = new Map()
  try {
    ;(await pc.getStats()).forEach((report, id) => byId.set(id, report))
  } catch (error) {
    return { error: String(error) }
  }

  /** @param {any} c */
  // The address itself is NOT reported. Its category and the answer
  // isPrivateAddress gives for it are what a diagnosis needs, and asking
  // someone to paste their IP into a chat to get a bug fixed is a bad trade
  // when the category answers the same questions.
  const candidate = c => c && {
    type: c.candidateType,
    addressForm: addressForm(c.address ?? c.ip),
    // Only when the form was not understood -- see addressShape.
    addressShape: addressForm(c.address ?? c.ip) === 'unrecognised'
      ? addressShape(c.address ?? c.ip)
      : undefined,
    privateByRule: isPrivateAddress(c.address ?? c.ip),
    port: c.port ?? null,
    protocol: c.protocol ?? null,
    network: c.networkType ?? null,
  }

  // Every server-reflexive address in these stats -- that is, this peer's own
  // public mappings as STUN reported them.
  /** @type {Set<string>} */
  const reflexive = new Set()
  for (const r of byId.values()) {
    if ((r.type === 'local-candidate' || r.type === 'remote-candidate')
      && r.candidateType === 'srflx' && (r.address ?? r.ip)) reflexive.add(r.address ?? r.ip)
  }

  /** @type {string[]} */
  const selectedIds = []
  for (const report of byId.values()) {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      selectedIds.push(report.selectedCandidatePairId)
    }
  }

  const pairs = []
  for (const [id, report] of byId) {
    if (report.type !== 'candidate-pair') continue
    pairs.push({
      id,
      state: report.state,
      nominated: report.nominated,
      // Firefox's non-standard marker for the winning pair; included because
      // its absence or presence is itself evidence about the two browsers.
      selectedFlag: report.selected,
      isSelectedByTransport: selectedIds.includes(id),
      local: candidate(byId.get(report.localCandidateId)),
      remote: candidate(byId.get(report.remoteCandidateId)),
      // Whether this pair's remote address is the SAME address STUN reported
      // as the peer's public mapping. If it is, the packets are going to the
      // peer's internet-facing address, whatever the candidate types claim --
      // which is the check that does not depend on trusting an mDNS name.
      remoteIsPeerPublic: (() => {
        const rc = byId.get(report.remoteCandidateId)
        const addr = rc?.address ?? rc?.ip
        return Boolean(addr && reflexive.has(addr))
      })(),
      // Exactly which branch of classifyPath this pair would take.
      wouldBeBothHost: byId.get(report.localCandidateId)?.candidateType === 'host'
        && byId.get(report.remoteCandidateId)?.candidateType === 'host',
      wouldBeBothPrivate: isPrivateAddress(byId.get(report.localCandidateId)?.address
          ?? byId.get(report.localCandidateId)?.ip)
        && isPrivateAddress(byId.get(report.remoteCandidateId)?.address
          ?? byId.get(report.remoteCandidateId)?.ip),
    })
  }

  return { selectedIds, pairs, classified: await classifyPath(pc) }
}

/**
 * Brings up one signalling strategy and resolves once a peer is connected over
 * it and session keys are agreed. Rejects if this strategy errors, if the peer
 * sends a malformed key, or if `signal` aborts (another strategy won, or the
 * overall timeout fired) -- in which case it leaves the room it opened.
 *
 * @param {SignalingStrategy} strategy
 * @param {object} ctx
 * @param {string} ctx.topic HKDF'd from the secret -- never the secret itself.
 * @param {string} ctx.password A string, not a CryptoKey: Trystero stretches it internally.
 * @param {Bytes} ctx.secret The QR secret, passed on as the ECDH HKDF salt.
 * @param {'host' | 'guest'} ctx.role
 * @param {readonly RTCIceServer[]} ctx.iceServers
 * @param {typeof RTCPeerConnection} [ctx.rtcPolyfill] Node has no WebRTC.
 * @param {AbortSignal} ctx.signal
 * @param {(text: string) => void} [ctx.onStatus]
 * @returns {Promise<ResolvedAttempt>}
 */
async function joinVia(strategy, { topic, password, secret, role, iceServers, rtcPolyfill, signal, onStatus }) {
  // Generated BEFORE joining, deliberately. Awaiting anything between
  // strategy.join() and assigning onPeerJoin leaves a window in which the other
  // peer can join unobserved -- and that is the normal case here, not a rare
  // one: the host is already sitting in the room when the guest scans, so the
  // guest's very first discovery can land inside that gap and be lost.
  //
  // Generated PER CALL, equally deliberately, and this is the forward-secrecy
  // boundary. openRoom races every strategy at once, so one pairing pays for
  // two generateKey calls and only one of them is ever used -- which makes
  // hoisting this to module scope look like free money. It is not: the whole
  // reason for doing ECDH on top of a secret both sides already hold is that a
  // code photographed off a screen must not open transfers made before it
  // leaked, and a cached keypair means every session that process ever ran
  // shares one shared secret. test/room.test.mjs pairs twice over one secret
  // and asserts the second session cannot decrypt the first's traffic, which
  // is what fails if this line moves.
  const keypair = await createEphemeralKeypair()
  const myPublic = toBase64url(await exportPublicKey(keypair))

  const room = strategy.join(
    {
      appId: APP_ID,
      password,
      relayConfig: { urls: [...strategy.urls] },
      rtcConfig: { iceServers: [...iceServers] },
      ...(rtcPolyfill ? { rtcPolyfill } : {}),
    },
    topic,
  )

  const keyAction = room.makeAction('ecdh')
  const frameAction = room.makeAction('frame')

  // Annotated rather than inferred: from the no-op initialiser alone the
  // checker reads this as a zero-argument function, and every later call
  // through it becomes an arity error at the call site instead of a type error
  // here. The placeholder exists so frames arriving before onFrame() is
  // registered are dropped rather than thrown on.
  /** @type {(bytes: Bytes) => void} */
  let frameHandler = () => {}

  // The peer we committed to, or null until one arrives.
  //
  // The send side has always been targeted at exactly this id, and channel.js
  // names the reason in as many words: a third party holding the code can be
  // sitting in this room. The receive side accepted frames from anyone, which
  // made that targeting a courtesy rather than a boundary -- and because
  // core/frame.js used to read a frame's cleartext header before
  // authenticating it, fourteen bytes from a stranger were enough to abort a
  // live transfer and throw away the partial file. Both halves or neither.
  /** @type {string | null} */
  let pairedPeerId = null

  frameAction.onMessage = (data, { peerId: from }) => {
    // Dropped rather than queued. Nothing legitimate can arrive before
    // pairing: frames only start once openRoom has resolved and the caller
    // has registered a handler, and until then frameHandler is the no-op
    // placeholder that would discard them anyway. Buffering them "just in
    // case" would mean holding an unpaired stranger's bytes for later replay
    // into an authenticated session, which is the opposite of the intent.
    if (from !== pairedPeerId) return
    frameHandler(toBytes(data))
  }

  return new Promise((resolve, reject) => {
    /** @param {Error} reason */
    const abandon = reason => {
      tryLeave(room)
      reject(reason)
    }
    const onAbort = () => abandon(new Error(`${strategy.name}: superseded`))

    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })

    let settled = false

    room.onPeerJoin = id => {
      onStatus?.(`Found the other device via ${strategy.name}, agreeing keys…`)
      // Both sides fire this on connection, so both announce and both receive.
      keyAction.send(myPublic, { target: id })
    }

    keyAction.onMessage = async (peerPublic, { peerId: id }) => {
      // A third party holding the code could also join. We pair with whoever
      // arrives first and ignore the rest; the SAS is what surfaces a wrong
      // partner to the user.
      if (settled) return
      settled = true

      // Set here rather than beside resolve(): establishSession is awaited
      // below, and this is already the peer whose public key is about to be
      // mixed into the session. Waiting for that derivation to finish would
      // leave the await as a window in which a stranger's frames are still
      // accepted.
      pairedPeerId = id

      // Trystero delivers whatever the peer serialised, so this is a string
      // only by convention. Checked rather than assumed: without it a peer
      // sending null or a number reaches fromBase64url, which throws
      // "replace is not a function" from inside an event handler.
      if (typeof peerPublic !== 'string') {
        signal.removeEventListener('abort', onAbort)
        return abandon(new Error(`${strategy.name}: peer sent a malformed public key`))
      }

      try {
        const session = await establishSession({
          keypair,
          peerPublicRaw: fromBase64url(peerPublic),
          secret,
          role,
        })
        signal.removeEventListener('abort', onAbort)
        resolve({
          strategy: strategy.name,
          room,
          frameAction,
          setFrameHandler: fn => { frameHandler = fn },
          session,
          peerId: id,
        })
      } catch (error) {
        signal.removeEventListener('abort', onAbort)
        abandon(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
}

/**
 * Joins every strategy at once and resolves once ONE of them has a peer
 * connected and session keys agreed. The losers are torn down.
 *
 * `role` is 'host' for the peer that generated the QR, 'guest' for the scanner.
 * It only decides which direction gets which key; both sides derive both.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.password
 * @param {Bytes} args.secret
 * @param {'host' | 'guest'} args.role
 * @param {number} [args.timeoutMs]
 * @param {(text: string) => void} [args.onStatus]
 * @param {readonly SignalingStrategy[]} [args.strategies] Defaults to STRATEGIES.
 *   A caller passing its own list is on the hook for the CSP on any page that
 *   uses it.
 * @param {readonly RTCIceServer[]} [args.iceServers] Defaults to ICE_SERVERS.
 * @param {typeof RTCPeerConnection} [args.rtcPolyfill] The CLI passes
 *   node-datachannel's implementation here; browsers leave it undefined.
 * @returns {Promise<PairedRoom>}
 */
export async function openRoom({
  topic,
  password,
  secret,
  role,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onStatus,
  strategies = STRATEGIES,
  iceServers = ICE_SERVERS,
  rtcPolyfill,
}) {
  const ac = new AbortController()

  const attempts = strategies.map(strategy =>
    joinVia(strategy, { topic, password, secret, role, iceServers, rtcPolyfill, signal: ac.signal, onStatus }),
  )
  // Every attempt needs a rejection handler from the outset: once the race
  // settles, a losing strategy's rejection would otherwise surface as an
  // unhandledRejection.
  attempts.forEach(p => p.catch(() => {}))

  onStatus?.(`Waiting for the other device (${strategies.map(s => s.name).join(', ')})…`)

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  /** @type {Promise<never>} */
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timed out waiting for the other device')),
      timeoutMs,
    )
  })

  /** @type {ResolvedAttempt} */
  let winner
  try {
    winner = await Promise.race([Promise.any(attempts), timeout])
  } catch (error) {
    ac.abort()
    clearTimeout(timer)
    // Promise.any rejects with an AggregateError only when every strategy
    // failed; collapse it to one readable line but keep .errors for --debug.
    if (error instanceof AggregateError) {
      throw new Error('Could not pair on any signalling network', { cause: error })
    }
    throw error
  }
  clearTimeout(timer)

  // Winner found. Aborting tears down every strategy still trying; the .then()
  // mops up the rare loser that resolved in the same tick as the winner.
  ac.abort()
  attempts.forEach(p =>
    p.then(
      resolved => { if (resolved !== winner) tryLeave(resolved.room) },
      () => {},
    ),
  )

  onStatus?.(`Paired over ${winner.strategy}`)

  const { session, peerId, room, frameAction, setFrameHandler } = winner

  /**
   * Memoised: classifyPath polls for up to three seconds, and there are now
   * several callers (the cap check, the badge, the metered warning) where there
   * used to be one -- unmemoised, each would re-pay that wait.
   *
   * @type {Promise<NetworkPath> | null}
   */
  let pathOnce = null

  /** @returns {Promise<NetworkPath>} */
  const resolvePath = () => {
    if (pathOnce) return pathOnce
    const pc = room.getPeers()[peerId]
    if (!pc) return Promise.resolve(/** @type {NetworkPath} */ ('unknown'))
    pathOnce = classifyPath(pc)
    return pathOnce
  }

  return {
    session,
    peerId,

    /**
     * The seam. See transport/channel.js, and the Channel contract it implements.
     *
     * send() returns Trystero's promise, which settles when local sending is
     * complete, and sender.js awaits it -- that await IS the backpressure now.
     * Trystero manages the data channel's buffer internally, so bufferedAmount
     * stays 0 and the manual high/low watermark logic in sender.js never fires
     * on this path.
     */
    channel: createChannel(frameAction, peerId),

    /**
     * Register the inbound frame handler.
     * @param {(bytes: Bytes) => void} callback
     */
    onFrame(callback) {
      setFrameHandler(callback)
    },

    /** @param {() => void} callback */
    onPeerLeave(callback) {
      room.onPeerLeave = id => {
        if (id === peerId) callback()
      }
    },

    /**
     * Which route this connection took. Drives the path badge the user sees.
     * @returns {Promise<NetworkPath>}
     */
    path: resolvePath,

    /**
     * TEMPORARY diagnostic -- see collectPathEvidence. Surfaced by the web
     * component only under `?debug=path`.
     * @returns {Promise<object | null>}
     */
    async pathEvidence() {
      const pc = room.getPeers()[peerId]
      if (!pc) return null
      return collectPathEvidence(pc)
    },

    /**
     * Whether the paired connection is going through a TURN relay. Callers use
     * this to enforce RELAYED_MAX_BYTES before a large file starts moving.
     *
     * Derived from path() rather than asking its own question, so the cap and
     * the path shown to the user can never disagree. Note 'unknown' is false
     * here: "cannot tell" must not refuse a send. See classifyPath.
     *
     * @returns {Promise<boolean>}
     */
    async isRelayed() {
      return (await resolvePath()) === 'relay'
    },

    close() {
      tryLeave(room)
    },
  }
}
