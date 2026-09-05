/**
 * The CSP generator, in isolation.
 *
 * connect-src is derived from SIGNALING_URLS so the page's allowlist cannot
 * drift from the hosts src/transport/room.js actually dials. The one subtlety
 * is that each URL is reduced to its origin: a connect-src entry that carried a
 * path would restrict matching to that prefix, so a strategy URL with a path
 * (a tracker announce endpoint, say) would silently fail to connect. These
 * tests pin that reduction and the surrounding directives.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCSP, buildStamp, wellKnownFiles } from '../scripts/build-site.mjs'
import { SIGNALING_URLS } from '../src/transport/room.js'

test('connect-src lists every signalling origin plus self, and nothing else', () => {
  const csp = buildCSP(['wss://a.example', 'wss://b.example:8443'])
  const connect = csp.split('; ').find(d => d.startsWith('connect-src '))
  assert.equal(connect, `connect-src 'self' wss://a.example wss://b.example:8443`)
})

test('a URL with a path is reduced to its origin', () => {
  const csp = buildCSP(['wss://broker.example:8084/mqtt', 'wss://tracker.example/announce'])
  assert.match(csp, /connect-src 'self' wss:\/\/broker\.example:8084 wss:\/\/tracker\.example;/)
  assert.doesNotMatch(csp, /\/mqtt|\/announce/)
})

test('duplicate origins collapse to one entry', () => {
  const csp = buildCSP(['wss://h.example/one', 'wss://h.example/two', 'wss://h.example'])
  const origins = csp.match(/wss:\/\/h\.example/g) ?? []
  assert.equal(origins.length, 1)
})

test('the real SIGNALING_URLS produce a path-free, self-first connect-src', () => {
  const csp = buildCSP(SIGNALING_URLS)
  const connect = /** @type {string} */ (csp.split('; ').find(d => d.startsWith('connect-src ')))
  assert.ok(connect.startsWith(`connect-src 'self' `))
  for (const token of connect.slice(`connect-src 'self' `.length).split(' ')) {
    assert.equal(new URL(token).origin, token, `${token} is not a bare origin`)
  }
})

test('the non-connect directives are the locked-down set', () => {
  const csp = buildCSP([])
  for (const directive of [
    `default-src 'self'`,
    `script-src 'self'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `object-src 'none'`,
  ]) {
    assert.ok(csp.includes(directive), `missing: ${directive}`)
  }
})

/**
 * The footer's build stamp.
 *
 * One template produces two deployed pages -- the last released tag at / and
 * the tip of main at /edge/ -- and this function is the whole of what differs
 * between them. The cases below pin the part a reader of the page acts on: the
 * identifier each channel shows, and that the link under it goes where that
 * identifier lives. A stamp that said v0.3.1 and linked to a commit would look
 * entirely correct in a screenshot.
 */

const META = { version: '1.2.3', commit: 'abc1234', date: '2026-09-04T10:00:00+00:00' }

test('stable names the release, and links to it', () => {
  const stamp = buildStamp({ channel: 'stable', ...META })
  assert.equal(stamp.label, 'v1.2.3')
  assert.equal(stamp.href, 'https://github.com/stan-ely/qrdrop/releases/tag/v1.2.3')
})

test('edge names the commit, never the version', () => {
  const stamp = buildStamp({ channel: 'edge', ...META })
  assert.match(stamp.label, /abc1234/)
  assert.equal(stamp.href, 'https://github.com/stan-ely/qrdrop/commit/abc1234')
  // package.json on main carries the PREVIOUS release's number until the next
  // bump, so a version anywhere on the edge page is a wrong answer to "what am
  // I running", not merely a redundant one.
  assert.doesNotMatch(stamp.label, /1\.2\.3/)
})

test('the build date is available but not in the label', () => {
  for (const channel of ['stable', 'edge']) {
    const stamp = buildStamp({ channel, ...META })
    assert.match(stamp.title, /2026-09-04/)
    assert.doesNotMatch(stamp.label, /2026/)
  }
})

test('og:url names the page being previewed, per channel', () => {
  assert.equal(buildStamp({ channel: 'stable', ...META }).ogUrl, 'https://share.stan-ely.com/')
  assert.equal(buildStamp({ channel: 'edge', ...META }).ogUrl, 'https://share.stan-ely.com/edge/')
})

test('the app channel carries no absolute URL at all', () => {
  // Embedded in the Tauri shell, never served over HTTP -- asserting the
  // website's domain here would be a build claiming to be a site it is not.
  const stamp = buildStamp({ channel: 'app', ...META })
  assert.equal(stamp.ogUrl, '')
  assert.match(stamp.label, /abc1234/)
  assert.doesNotMatch(stamp.label, /1\.2\.3/)
})

/**
 * The universal / app link association files. Structurally complete always,
 * live only once a signing identity is fed in -- these pin both halves of
 * that: the shape iOS/Android parse, and that the identity is a passed-in
 * input rather than a baked constant.
 */

test('wellKnownFiles emits the three association paths as valid JSON', () => {
  const files = wellKnownFiles({ appleTeamId: 'TEAMID', androidCertFingerprints: [] })
  assert.deepEqual(Object.keys(files).sort(), [
    '.well-known/apple-app-site-association',
    '.well-known/assetlinks.json',
    'apple-app-site-association',
  ])
  for (const contents of Object.values(files)) JSON.parse(contents)
  // The root and .well-known AASA copies are byte-identical.
  assert.equal(files['apple-app-site-association'], files['.well-known/apple-app-site-association'])
})

test('the AASA appID is team-prefix + the shared app identifier', () => {
  const aasa = JSON.parse(wellKnownFiles({ appleTeamId: 'ABCDE12345', androidCertFingerprints: [] })['apple-app-site-association'])
  assert.deepEqual(aasa.applinks.details[0].appIDs, ['ABCDE12345.com.stan-ely.qrdrop'])
  // Every path: the code rides in the fragment, which AASA cannot match and
  // does not need to.
  assert.deepEqual(aasa.applinks.details[0].components, [{ '/': '*' }])
})

test('assetlinks carries the package name and only the fingerprints it is given', () => {
  const empty = JSON.parse(wellKnownFiles({ appleTeamId: 'TEAMID', androidCertFingerprints: [] })['.well-known/assetlinks.json'])
  assert.equal(empty[0].target.package_name, 'com.stan-ely.qrdrop')
  assert.deepEqual(empty[0].target.sha256_cert_fingerprints, [])
  assert.deepEqual(empty[0].relation, ['delegate_permission/common.handle_all_urls'])

  const signed = JSON.parse(wellKnownFiles({ appleTeamId: 'TEAMID', androidCertFingerprints: ['AA:BB', 'CC:DD'] })['.well-known/assetlinks.json'])
  assert.deepEqual(signed[0].target.sha256_cert_fingerprints, ['AA:BB', 'CC:DD'])
})

test('an unknown channel fails the build rather than defaulting', () => {
  // A typo in the workflow's --channel flag would otherwise deploy a second
  // copy of the stable page at /edge/, which is a silently wrong site rather
  // than a failed one.
  assert.throws(() => buildStamp({ channel: 'Edge', ...META }), /Unknown channel/)
})
