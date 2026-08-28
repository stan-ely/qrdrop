import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fromPath } from '../src/node/source.js'
import { fromBytes } from '../src/core/source.js'
import { CHUNK_SIZE } from '../src/core/frame.js'

/** @param {number} n */
const randomBytes = n => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) % 256
  return b
}

/**
 * Reads every chunk-sized slice of both sources and asserts they agree,
 * including the final (possibly short) chunk.
 * @param {FileSource} a
 * @param {FileSource} b
 */
async function assertIdenticalSlices(a, b) {
  assert.equal(a.size, b.size)
  const total = a.size
  const chunks = Math.max(1, Math.ceil(total / CHUNK_SIZE))

  for (let i = 0; i < chunks; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, total)
    if (start === end) continue // only possible when total === 0
    const [sa, sb] = await Promise.all([a.slice(start, end), b.slice(start, end)])
    assert.deepEqual([...sa], [...sb], `chunk ${i} (bytes ${start}-${end}) differs`)
  }
}

test('fromPath and fromBytes agree on a size that spans a partial final chunk', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const bytes = randomBytes(CHUNK_SIZE * 3 + 12345)
  const file = join(dir, 'data.bin')
  await writeFile(file, bytes)

  const pathSource = await fromPath(file)
  const bytesSource = fromBytes({ bytes, name: 'data.bin' })

  await assertIdenticalSlices(pathSource, bytesSource)
  await pathSource.close?.()
})

test('fromPath and fromBytes agree on a size that is an exact multiple of CHUNK_SIZE', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const bytes = randomBytes(CHUNK_SIZE * 2)
  const file = join(dir, 'exact.bin')
  await writeFile(file, bytes)

  const pathSource = await fromPath(file)
  const bytesSource = fromBytes({ bytes, name: 'exact.bin' })

  assert.equal(pathSource.size, CHUNK_SIZE * 2)
  await assertIdenticalSlices(pathSource, bytesSource)
  await pathSource.close?.()
})

test('an empty file has size 0 and no chunks to slice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const file = join(dir, 'empty.bin')
  await writeFile(file, new Uint8Array(0))

  const pathSource = await fromPath(file)
  assert.equal(pathSource.size, 0)
  assert.equal(pathSource.name, 'empty.bin')
  await pathSource.close?.()
})

test('close() releases the underlying file handle', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const file = join(dir, 'handle.bin')
  await writeFile(file, randomBytes(100))

  const source = await fromPath(file)
  await source.close?.()

  // fs.promises rejects any operation on an already-closed FileHandle with
  // "file closed" -- reading after close() is how we can tell close()
  // actually released the handle, rather than being a no-op that forgot to
  // call handle.close() at all.
  await assert.rejects(() => source.slice(0, 10))
})

test('mime is a fixed value rather than sniffed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const file = join(dir, 'photo.jpg')
  await writeFile(file, randomBytes(10))
  const source = await fromPath(file)
  assert.equal(source.mime, 'application/octet-stream')
  await source.close?.()
})
