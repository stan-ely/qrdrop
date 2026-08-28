import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFileSink } from '../src/node/sink.js'

/** @param {string} name */
const manifest = (name, extra = {}) =>
  /** @type {Manifest} */ ({ t: 'manifest', seq: 0, name, size: 0, mime: 'application/octet-stream', chunks: 1, ...extra })

test('writes bytes to disk and round-trips them exactly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-sink-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const createSink = createFileSink({ outDir: dir })
  const sink = await createSink(manifest('hello.txt'))

  assert.equal(sink.streaming, true)
  assert.equal(sink.name, 'hello.txt')

  await sink.write(new TextEncoder().encode('hello, '))
  await sink.write(new TextEncoder().encode('world'))
  await sink.close()

  const got = await readFile(join(dir, 'hello.txt'), 'utf8')
  assert.equal(got, 'hello, world')
})

test('a hostile manifest name cannot escape outDir', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-sink-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const createSink = createFileSink({ outDir: dir })

  const hostileNames = [
    '../../.bashrc',
    '..\\..\\evil',
    '../../../etc/passwd',
    'CON',
    'CON.txt',
    '',
    '   ',
    '../',
  ]

  for (const name of hostileNames) {
    const sink = await createSink(manifest(name))
    // Whatever name it actually picked, the write must have landed inside dir.
    await sink.write(new Uint8Array([1, 2, 3]))
    await sink.close()

    const entries = await readdir(dir)
    for (const entry of entries) {
      assert.doesNotMatch(entry, /\.\./, `entry escaped sandbox for input ${JSON.stringify(name)}: ${entry}`)
    }
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
  }

  // Nothing outside dir was ever created.
  const parent = join(dir, '..')
  const parentBefore = await readdir(parent)
  assert.ok(!parentBefore.includes('.bashrc'))
  assert.ok(!parentBefore.includes('evil'))
  assert.ok(!parentBefore.includes('passwd'))
})

test('abort() unlinks the partial file rather than leaving it behind', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-sink-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const createSink = createFileSink({ outDir: dir })

  const sink = await createSink(manifest('partial.bin'))
  await sink.write(new Uint8Array([1, 2, 3, 4]))
  await sink.abort()

  const entries = await readdir(dir)
  assert.deepEqual(entries, [], 'aborted transfer must not leave a file on disk')
})

test('does not clobber an existing file of the same name', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-sink-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const createSink = createFileSink({ outDir: dir })

  const first = await createSink(manifest('report.pdf'))
  await first.write(new TextEncoder().encode('first'))
  await first.close()

  const second = await createSink(manifest('report.pdf'))
  assert.equal(second.name, 'report (2).pdf')
  await second.write(new TextEncoder().encode('second'))
  await second.close()

  const third = await createSink(manifest('report.pdf'))
  assert.equal(third.name, 'report (3).pdf')
  await third.write(new TextEncoder().encode('third'))
  await third.close()

  assert.equal(await readFile(join(dir, 'report.pdf'), 'utf8'), 'first')
  assert.equal(await readFile(join(dir, 'report (2).pdf'), 'utf8'), 'second')
  assert.equal(await readFile(join(dir, 'report (3).pdf'), 'utf8'), 'third')
})
