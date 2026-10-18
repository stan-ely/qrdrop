/**
 * bin/qrdrop.js, the `qrdrop` command, and the platform packages it looks for.
 *
 * The launcher is copied into a scratch package with a fake platform package
 * beside it, because it resolves that package relative to its own file, which
 * is how it finds it in a real install. The fake "binary" is a copy of this
 * very node, so what the launcher passes it can be run: `-p` prints, `-e`
 * exits with a code, and the test sees whether the output and the code came
 * back through unchanged.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLATFORMS, packageName, platformManifest } from '../scripts/npm-platforms.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

/**
 * A package holding the launcher, a stand-in src/cli.js, and -- unless
 * `native` is false -- this platform's package with node in it as the binary.
 *
 * @param {{ native: boolean }} opts
 */
function scratch({ native }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qrdrop-launcher-'))
  mkdirSync(path.join(dir, 'bin'))
  mkdirSync(path.join(dir, 'src'))
  copyFileSync(path.join(ROOT, 'bin', 'qrdrop.js'), path.join(dir, 'bin', 'qrdrop.js'))
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'qrdrop', type: 'module' }))
  writeFileSync(path.join(dir, 'src', 'cli.js'), "console.log('js cli', JSON.stringify(process.argv.slice(2)))\n")
  if (native) {
    const pkg = path.join(dir, 'node_modules', `qrdrop-${process.platform}-${process.arch}`)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: path.basename(pkg) }))
    copyFileSync(process.execPath, path.join(pkg, process.platform === 'win32' ? 'qrdrop.exe' : 'qrdrop'))
  }
  return dir
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(dir, args, env = {}) {
  const { QRDROP_CLI: _, ...rest } = process.env
  return spawnSync(process.execPath, [path.join(dir, 'bin', 'qrdrop.js'), ...args], {
    encoding: 'utf8',
    env: { ...rest, ...env },
  })
}

test('the launcher runs the platform binary with the arguments, and passes its output and exit code back', () => {
  const dir = scratch({ native: true })
  try {
    const printed = run(dir, ['-p', '"from the binary"'])
    assert.equal(printed.status, 0, printed.stderr)
    assert.equal(printed.stdout.trim(), 'from the binary')

    const exited = run(dir, ['-e', 'process.exit(7)'])
    assert.equal(exited.status, 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with no platform package the Node CLI runs, with the same arguments', () => {
  const dir = scratch({ native: false })
  try {
    const r = run(dir, ['send', 'a file.txt'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'js cli ["send","a file.txt"]')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('QRDROP_CLI=js runs the Node CLI past an installed binary, and =native refuses to fall back', () => {
  const withBinary = scratch({ native: true })
  const without = scratch({ native: false })
  try {
    const js = run(withBinary, ['receive'], { QRDROP_CLI: 'js' })
    assert.equal(js.stdout.trim(), 'js cli ["receive"]')

    const native = run(without, ['receive'], { QRDROP_CLI: 'native' })
    assert.equal(native.status, 1)
    assert.match(native.stderr, /no qrdrop-\S+ package is installed/)
    assert.equal(native.stdout, '')
  } finally {
    rmSync(withBinary, { recursive: true, force: true })
    rmSync(without, { recursive: true, force: true })
  }
})

test('the real launcher in this checkout runs the Node CLI, which has no binary beside it', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'qrdrop.js'), '--version'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), VERSION)
})

test('every platform package is named by the rule the launcher resolves, with npm vocabulary for os and cpu', () => {
  const platforms = ['linux', 'darwin', 'win32']
  const arches = ['x64', 'arm64']
  const names = new Set()
  for (const p of PLATFORMS) {
    assert.ok(platforms.includes(p.os), p.os)
    assert.ok(arches.includes(p.cpu), p.cpu)
    assert.equal(packageName(p), `qrdrop-${p.os}-${p.cpu}`)
    assert.equal(p.exe, p.os === 'win32' ? 'qrdrop.exe' : 'qrdrop')
    names.add(packageName(p))

    const m = platformManifest(p, '1.2.3')
    assert.deepEqual([m.os, m.cpu, m.version], [[p.os], [p.cpu], '1.2.3'])
    assert.deepEqual(m.files, [p.exe])
    assert.equal('bin' in m, false, 'one package owns the qrdrop command')
  }
  assert.equal(names.size, PLATFORMS.length)
})

test('staging refuses a missing binary, and wiring pins every platform at the package version', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qrdrop-platforms-'))
  try {
    const script = path.join(ROOT, 'scripts', 'npm-platforms.mjs')
    const missing = spawnSync(process.execPath, [script, '--stage', path.join(dir, 'none'), path.join(dir, 'out')], { encoding: 'utf8' })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /no binary for/)

    for (const p of PLATFORMS) {
      mkdirSync(path.join(dir, 'bins', `cli-${p.target}`), { recursive: true })
      writeFileSync(path.join(dir, 'bins', `cli-${p.target}`, p.exe), 'binary')
    }
    const staged = spawnSync(process.execPath, [script, '--stage', path.join(dir, 'bins'), path.join(dir, 'out')], { encoding: 'utf8' })
    assert.equal(staged.status, 0, staged.stderr)
    for (const p of PLATFORMS) {
      const pkg = path.join(dir, 'out', packageName(p))
      assert.ok(existsSync(path.join(pkg, p.exe)))
      assert.equal(JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8')).version, VERSION)
    }

    const manifest = path.join(dir, 'package.json')
    writeFileSync(manifest, JSON.stringify({ name: 'qrdrop', version: '9.8.7', optionalDependencies: { other: '1.0.0' } }))
    const wired = spawnSync(process.execPath, [script, '--wire', manifest], { encoding: 'utf8' })
    assert.equal(wired.status, 0, wired.stderr)
    const deps = JSON.parse(readFileSync(manifest, 'utf8')).optionalDependencies
    assert.equal(deps.other, '1.0.0')
    for (const p of PLATFORMS) assert.equal(deps[packageName(p)], '9.8.7')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Not also "no platform dependency in package.json": publish.yml wires them in
// and then npm publish runs this suite again from prepublishOnly, where that
// assertion would refuse every release.
test('the qrdrop command is the launcher, and the launcher ships', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.bin.qrdrop, './bin/qrdrop.js')
  assert.ok(pkg.files.includes('bin'))
})
