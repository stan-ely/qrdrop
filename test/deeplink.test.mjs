import test from 'node:test'
import assert from 'node:assert/strict'

import { secretFromDeepLink } from '../app/src/deep-link.js'
import {
  generateSecret, encodeSecret, encodeSecretURL, decodeSecret, toBase64url,
} from '../src/core/secret.js'

/**
 * @param {Bytes} a
 * @param {Bytes} b
 */
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

test('the universal-link form (code in the fragment) decodes', () => {
  const secret = generateSecret()
  const link = encodeSecretURL(secret, 'https://share.stan-ely.com/')
  assert.match(link, /#qrdrop:/)
  assert.equal(secretFromDeepLink(link), encodeSecret(secret))
  assert.ok(bytesEqual(decodeSecret(secretFromDeepLink(link)), secret))
})

test('the bare qrdrop: scheme form decodes -- CLI/manual parity', () => {
  const secret = generateSecret()
  assert.equal(secretFromDeepLink(encodeSecret(secret)), encodeSecret(secret))
})

test('a registered scheme handed back with an authority slash pair is normalised', () => {
  const secret = generateSecret()
  const code = toBase64url(secret)
  assert.equal(secretFromDeepLink(`qrdrop://${code}`), `qrdrop:${code}`)
  assert.ok(bytesEqual(decodeSecret(secretFromDeepLink(`qrdrop://${code}`)), secret))
})

test('whitespace around a deep link is tolerated', () => {
  const secret = generateSecret()
  const link = encodeSecretURL(secret, 'https://share.stan-ely.com/')
  assert.equal(secretFromDeepLink(`\n  ${link}  \n`), encodeSecret(secret))
})

// The reason this whole file exists: a deep link is an attacker-influenced
// string arriving from outside the app, and the one property that must not be
// lost on the way in is that the code rides in the fragment -- the single part
// of a URL a browser never sends to a server. secretFromDeepLink delegates to
// decodeSecret precisely so these cases fail here too.

test('a code in the query string is refused, not unwrapped', () => {
  const secret = generateSecret()
  const code = encodeSecret(secret)
  assert.throws(
    () => secretFromDeepLink(`https://share.stan-ely.com/?${code}`),
    /fragment/,
    'a ?code= app link must never resolve to a secret -- that string reaches the server',
  )
})

test('a code in the path is refused', () => {
  const secret = generateSecret()
  const code = encodeSecret(secret)
  assert.throws(() => secretFromDeepLink(`https://share.stan-ely.com/${code}`), /fragment/)
})

test('a custom-scheme link with a real query is refused', () => {
  const secret = generateSecret()
  const code = toBase64url(secret)
  assert.throws(() => secretFromDeepLink(`qrdrop://open/?code=${code}`))
})

test('garbage and non-http(s) schemes are refused', () => {
  assert.throws(() => secretFromDeepLink('https://share.stan-ely.com/#nope'))
  assert.throws(() => secretFromDeepLink('ftp://share.stan-ely.com/#qrdrop:' + 'A'.repeat(43)))
  assert.throws(() => secretFromDeepLink('not a url at all'))
})

test('the returned string is always the bare form -- safe to place after a #', () => {
  const secret = generateSecret()
  for (const input of [
    encodeSecret(secret),
    `qrdrop://${toBase64url(secret)}`,
    encodeSecretURL(secret, 'https://share.stan-ely.com/'),
    encodeSecretURL(secret, 'https://share.stan-ely.com/edge/'),
  ]) {
    const out = secretFromDeepLink(input)
    assert.match(out, /^qrdrop:[A-Za-z0-9_-]{43}$/)
    // What app/src/main.js does with it: location.hash = '#' + out, which
    // element.js then feeds straight back to decodeSecret.
    assert.ok(bytesEqual(decodeSecret(out), secret))
    assert.ok(bytesEqual(decodeSecret(`https://share.stan-ely.com/#${out}`), secret))
  }
})
