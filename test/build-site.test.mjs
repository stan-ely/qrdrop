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

import { buildCSP } from '../scripts/build-site.mjs'
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
