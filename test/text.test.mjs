/**
 * Text travels as a small text/plain file (src/web/text.js), and the receiver
 * decides it is text from the manifest alone. These pin that rule from both
 * sides, and the memory sink that stands in for a save dialog.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isText, textFile, textBytes, createTextSink, TEXT_MAX_BYTES, TEXT_NAME, TEXT_MIME,
} from '../src/web/text.js'

test('text is plain text and small, by the manifest, whatever the parameters say', () => {
  assert.ok(isText({ mime: 'text/plain', size: 0 }))
  assert.ok(isText({ mime: 'Text/Plain; charset=UTF-8', size: 10 }))
  assert.ok(isText({ mime: TEXT_MIME, size: TEXT_MAX_BYTES }))
  assert.ok(!isText({ mime: TEXT_MIME, size: TEXT_MAX_BYTES + 1 }),
    'one byte over is a file, and goes to the save path like one')
  assert.ok(!isText({ mime: 'text/html', size: 10 }))
  assert.ok(!isText({ mime: 'application/octet-stream', size: 10 }))
  // The manifest is the peer's, so nothing about its shape is assumed.
  assert.ok(!isText({ mime: /** @type {any} */ (42), size: 10 }))
  assert.ok(!isText({ mime: 'text/plain', size: -1 }))
  assert.ok(!isText({ mime: 'text/plain', size: 1.5 }))
})

test('the sender and the receiver apply the same rule', () => {
  const file = textFile('hello')
  assert.equal(file.name, TEXT_NAME)
  assert.ok(isText(file), 'a File is read by its type')
  assert.ok(isText({ mime: file.type, size: file.size }), 'and its manifest by its mime')
})

test('the size is counted in UTF-8 bytes, which is what the manifest states', async () => {
  const text = 'héllo 👋'
  const file = textFile(text)
  assert.equal(file.size, textBytes(text))
  assert.equal(file.size, 11)
  assert.equal(await file.text(), text)
})

test('a message over the limit is refused before a file is built from it', () => {
  // 'é' is two bytes: under the limit in characters, over it in bytes.
  const text = 'é'.repeat(TEXT_MAX_BYTES / 2 + 1)
  assert.ok(text.length < TEXT_MAX_BYTES)
  assert.throws(() => textFile(text), RangeError)
})

test('the sink reassembles a character split across two writes', async () => {
  const bytes = new TextEncoder().encode('a👋b')
  const sink = createTextSink(/** @type {any} */ ({ size: bytes.length }))
  await sink.write(bytes.subarray(0, 3))
  await sink.write(bytes.subarray(3))
  await sink.close()
  assert.equal(sink.text(), 'a👋b')
})

test('the sink holds no more than the size it was accepted at', async () => {
  const sink = createTextSink(/** @type {any} */ ({ size: 4 }))
  await sink.write(new Uint8Array(4))
  await assert.rejects(sink.write(new Uint8Array(1)), /more data than the manifest declared/)
})

test('bytes that are not UTF-8 are replaced, never thrown on', async () => {
  const sink = createTextSink(/** @type {any} */ ({ size: 3 }))
  await sink.write(new Uint8Array([0x61, 0xff, 0x62]))
  assert.equal(sink.text(), 'a�b')
})
