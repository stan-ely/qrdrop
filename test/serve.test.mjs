/**
 * The static file server behind `qrdrop web`, and the argv parsing for the
 * `web` subcommand.
 *
 * The server exists only to hand site/dist/ to a local browser, but a
 * traversal hole in "it only serves a build directory" is still a traversal
 * hole -- so the confinement to `root` is pinned here alongside the ordinary
 * serve/404 behaviour. Everything runs on 127.0.0.1 with an OS-assigned port,
 * so this stays in the offline `npm test` suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serveStatic } from '../src/node/serve.js'

/**
 * Spins up a server over a fresh temp dir and tears it down after the test.
 * @param {import('node:test').TestContext} t
 */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qrdrop-serve-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>ok</title>')
  await writeFile(join(dir, 'app.js'), 'export const x = 1\n')
  const server = await serveStatic({ root: dir, port: 0 })
  t.after(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, ...server }
}

test('serves index.html at the root with a text/html type', async t => {
  const { url } = await fixture(t)
  const res = await fetch(url)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await res.text(), /<title>ok<\/title>/)
})

test('serves a named file with a type from the map', async t => {
  const { url } = await fixture(t)
  const res = await fetch(new URL('app.js', url))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /javascript/)
})

test('a missing file is a 404, not a 500', async t => {
  const { url } = await fixture(t)
  const res = await fetch(new URL('nope.js', url))
  assert.equal(res.status, 404)
})

test('a traversal path cannot escape the served root', async t => {
  const { url } = await fixture(t)
  // Pre-encoded so fetch/undici does not normalise the ../ away before it is
  // sent; the server is what must refuse it.
  const res = await fetch(`${url}..%2f..%2f..%2fpackage.json`)
  assert.equal(res.status, 404)
})

test('port 0 resolves to a real listening port', async t => {
  const { port } = await fixture(t)
  assert.ok(Number.isInteger(port) && port > 0)
})
