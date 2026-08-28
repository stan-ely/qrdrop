import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generateSecret, encodeSecret, encodeSecretURL, decodeSecret, toBase64url,
} from '../src/core/secret.js'

/**
 * @param {Bytes} a
 * @param {Bytes} b
 */
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

test('bare form round-trips', () => {
  const secret = generateSecret()
  const code = encodeSecret(secret)
  assert.match(code, /^qrdrop:[A-Za-z0-9_-]{43}$/)
  assert.ok(bytesEqual(decodeSecret(code), secret))
})

test('URL form round-trips via encodeSecretURL', () => {
  const secret = generateSecret()
  const url = encodeSecretURL(secret, 'https://example.com/qrdrop/')
  assert.equal(url, `https://example.com/qrdrop/#${encodeSecret(secret)}`)
  assert.ok(bytesEqual(decodeSecret(url), secret))
})

test('encodeSecretURL strips an existing fragment or query from the base', () => {
  const secret = generateSecret()
  const url = encodeSecretURL(secret, 'https://example.com/app?ref=old#stale')
  assert.equal(url, `https://example.com/app#${encodeSecret(secret)}`)
  // Only one fragment marker: the stale one is gone, not merely appended past.
  assert.equal(url.split('#').length, 2)
  assert.ok(!url.includes('ref=old'))
})

test('a bare code still decodes -- CLI/browser interop', () => {
  const secret = generateSecret()
  const code = encodeSecret(secret)
  assert.ok(bytesEqual(decodeSecret(code), secret))
})

test('a URL carrying the code in the query string is rejected, not silently accepted', () => {
  const secret = generateSecret()
  const code = encodeSecret(secret)
  assert.throws(
    () => decodeSecret(`https://example.com/?${code}`),
    /fragment/,
    'the whole point of the fragment form is that this string never reaches a server',
  )
})

test('a URL carrying the code in the path is rejected', () => {
  const secret = generateSecret()
  const code = encodeSecret(secret)
  assert.throws(() => decodeSecret(`https://example.com/${code}`), /fragment/)
})

test('malformed base64url is rejected', () => {
  assert.throws(() => decodeSecret('nope'))
  assert.throws(() => decodeSecret('qrdrop:not-valid-base64url-at-all!!!!!!!!!!!'))
})

test('wrong-length secret is rejected', () => {
  assert.throws(() => decodeSecret('qrdrop:tooshort'))
  assert.throws(() => decodeSecret(`qrdrop:${toBase64url(generateSecret())}extra`))
})

test('whitespace around either form is tolerated', () => {
  const secret = generateSecret()
  assert.ok(bytesEqual(decodeSecret(`  ${encodeSecret(secret)}  \n`), secret))
  const url = encodeSecretURL(secret, 'https://example.com/')
  assert.ok(bytesEqual(decodeSecret(`  ${url}  \n`), secret))
})

test('encodeSecretURL rejects a non-absolute base', () => {
  const secret = generateSecret()
  assert.throws(() => encodeSecretURL(secret, '/qrdrop'))
  assert.throws(() => encodeSecretURL(secret, 'not a url'))
})

test('encodeSecretURL rejects a non-http(s) base', () => {
  const secret = generateSecret()
  assert.throws(() => encodeSecretURL(secret, 'ftp://example.com/'))
  assert.throws(() => encodeSecretURL(secret, 'mailto:someone@example.com'))
})
