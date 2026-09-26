import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TAURI_ANDROID_RUSTFLAGS, androidRustflags, cargoHomeOf } from '../scripts/android-env.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TAURI_APPS = path.join(ROOT, 'app', 'node_modules', '@tauri-apps')

test("Tauri's flags come first and both remaps follow, CARGO_HOME last", () => {
  const flags = androidRustflags({ repoRoot: '/work/qrdrop', cargoHome: '/home/u/.cargo' })
  assert.deepEqual(flags.slice(0, TAURI_ANDROID_RUSTFLAGS.length), TAURI_ANDROID_RUSTFLAGS)
  assert.deepEqual(flags.slice(TAURI_ANDROID_RUSTFLAGS.length), [
    '--remap-path-prefix=/work/qrdrop=/qrdrop',
    '--remap-path-prefix=/home/u/.cargo=/cargo'
  ])
})

test('CARGO_HOME follows cargo: the variable if set, ~/.cargo if not', () => {
  assert.equal(cargoHomeOf({ CARGO_HOME: '/opt/cargo' }), '/opt/cargo')
  assert.equal(cargoHomeOf({}), path.join(os.homedir(), '.cargo'))
  assert.equal(cargoHomeOf({ CARGO_HOME: '' }), path.join(os.homedir(), '.cargo'))
})

// The copy of Tauri's flags is only right while it matches the Tauri CLI that
// actually runs. The CLI is a native binary per platform, and its flags sit in
// it as one run of adjacent string constants, so the check is a byte search.
// Skipped where app/ has no node_modules, which includes ci.yml. It runs in
// app-reproducible.yml, which installs them.
test("the copied flags are the installed Tauri CLI's own", async t => {
  const packages = await readdir(TAURI_APPS).catch(() => [])
  const cli = packages.find(name => name.startsWith('cli-'))
  if (!cli) return t.skip('no platform package under app/node_modules/@tauri-apps')
  const dir = path.join(TAURI_APPS, cli)
  const binary = (await readdir(dir)).find(name => name.endsWith('.node'))
  assert.ok(binary, `no .node binary in ${dir}`)
  const bytes = await readFile(path.join(dir, binary))
  assert.ok(
    bytes.includes(Buffer.from(TAURI_ANDROID_RUSTFLAGS.join(''))),
    `${cli} no longer carries ${TAURI_ANDROID_RUSTFLAGS.join(' ')} -- update TAURI_ANDROID_RUSTFLAGS in scripts/android-env.mjs`
  )
})
