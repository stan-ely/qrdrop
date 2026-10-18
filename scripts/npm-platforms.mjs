#!/usr/bin/env node
/**
 * The Rust CLI's npm packages: one per platform, each holding one binary, and
 * the `optionalDependencies` that make `npm install qrdrop` fetch the right
 * one. esbuild's shape, and for its reason: npm installs an optional
 * dependency only where its `os` and `cpu` match, so each machine downloads
 * one binary of a few megabytes rather than all of them, with no postinstall
 * script and no download from anywhere but the registry.
 *
 * PLATFORMS below is the one list. `.github/workflows/cli-binaries.yml` builds
 * its matrix from it, `publish.yml` stages and publishes from it, and
 * `bin/qrdrop.js` resolves the installed package by the same names
 * (`packageName`). A fourth copy of the list anywhere would be the one that
 * drifts.
 *
 *   node scripts/npm-platforms.mjs --matrix
 *       The build matrix, as JSON for `fromJSON`.
 *   node scripts/npm-platforms.mjs --stage <binaries-dir> <out-dir>
 *       Writes one publishable package directory per platform into <out-dir>,
 *       from <binaries-dir>/cli-<target>/qrdrop[.exe] -- the layout
 *       download-artifact leaves cli-binaries.yml's artifacts in. Refuses a
 *       missing binary.
 *   node scripts/npm-platforms.mjs --wire <package.json>
 *       Adds the exact-version optionalDependencies to that package.json.
 *       Done at publish time and never committed: a dependency on a version
 *       that is not on the registry yet would break `npm ci` in this
 *       repository for everyone, every time package.json's version moves.
 *   node scripts/npm-platforms.mjs --placeholders <out-dir>
 *       Empty 0.0.0 packages, one per name, for the one-time first publish by
 *       hand: npm configures a trusted publisher only on a package that
 *       already exists (docs/notes/rust-session.md, phase 8).
 */

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `os` and `cpu` are Node's `process.platform` and `process.arch`, which is
 * what npm matches and what the launcher looks the name up by.
 *
 * Linux is musl and static, so one binary runs on any distribution, glibc or
 * not, of any age. A glibc build would be tied to the runner's glibc and fail
 * on an older one with a loader error nobody can act on. The x64 macOS build is
 * cross-compiled on the Apple-silicon runner; Rosetta runs it there for the
 * smoke test.
 *
 * @typedef {{ os: string, cpu: string, target: string, runner: string, exe: string }} Platform
 * @type {Platform[]}
 */
export const PLATFORMS = [
  { os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-musl', runner: 'ubuntu-latest', exe: 'qrdrop' },
  { os: 'linux', cpu: 'arm64', target: 'aarch64-unknown-linux-musl', runner: 'ubuntu-24.04-arm', exe: 'qrdrop' },
  { os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin', runner: 'macos-latest', exe: 'qrdrop' },
  { os: 'darwin', cpu: 'x64', target: 'x86_64-apple-darwin', runner: 'macos-latest', exe: 'qrdrop' },
  { os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc', runner: 'windows-latest', exe: 'qrdrop.exe' },
]

/** @param {{ os: string, cpu: string }} p */
export const packageName = p => `qrdrop-${p.os}-${p.cpu}`

/** @returns {{ version: string, repository: unknown, license: string, author: string }} */
function rootPackage() {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

/**
 * @param {Platform} p
 * @param {string} version
 */
export function platformManifest(p, version) {
  const root = rootPackage()
  return {
    name: packageName(p),
    version,
    description: `The qrdrop command line for ${p.os} ${p.cpu}. Installed by the qrdrop package; not meant to be installed by hand.`,
    license: root.license,
    author: root.author,
    repository: root.repository,
    os: [p.os],
    cpu: [p.cpu],
    // No `bin`: the qrdrop package's launcher is the one command, and two
    // packages claiming the same bin name is an install-time conflict.
    files: [p.exe],
    preferUnplugged: true,
  }
}

/**
 * @param {string} binaries
 * @param {string} out
 */
function stage(binaries, out) {
  const { version } = rootPackage()
  for (const p of PLATFORMS) {
    const from = path.join(binaries, `cli-${p.target}`, p.exe)
    if (!existsSync(from)) throw new Error(`no binary for ${p.target} at ${from}`)
    const dir = path.join(out, packageName(p))
    mkdirSync(dir, { recursive: true })
    copyFileSync(from, path.join(dir, p.exe))
    // An artifact download does not keep the mode bit, and npm packs what it
    // finds: without this the binary installs and cannot be executed.
    if (p.os !== 'win32') chmodSync(path.join(dir, p.exe), 0o755)
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(platformManifest(p, version), null, 2) + '\n')
    writeFileSync(path.join(dir, 'README.md'),
      `# ${packageName(p)}\n\nThe \`qrdrop\` command line, built for ${p.os} ${p.cpu} (\`${p.target}\`). `
      + 'The [qrdrop](https://www.npmjs.com/package/qrdrop) package installs it as an optional dependency '
      + 'and runs it; install that instead.\n')
    console.log(`staged ${packageName(p)}@${version} from ${from}`)
  }
}

/** @param {string} file */
function wire(file) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.optionalDependencies = {
    ...pkg.optionalDependencies,
    ...Object.fromEntries(PLATFORMS.map(p => [packageName(p), pkg.version])),
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`wired ${PLATFORMS.length} platform packages at ${pkg.version} into ${file}`)
}

/** @param {string} out */
function placeholders(out) {
  for (const p of PLATFORMS) {
    const dir = path.join(out, packageName(p))
    mkdirSync(dir, { recursive: true })
    const manifest = { ...platformManifest(p, '0.0.0'), files: ['README.md'] }
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    writeFileSync(path.join(dir, 'README.md'),
      `# ${packageName(p)}\n\nA placeholder, published once so that npm Trusted Publishing can be configured `
      + 'for this name. The real binary arrives with the next qrdrop release.\n')
    console.log(`placeholder ${dir}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, a, b] = process.argv.slice(2)
  if (flag === '--matrix') {
    process.stdout.write(JSON.stringify({ include: PLATFORMS }) + '\n')
  } else if (flag === '--stage' && a && b) {
    stage(a, b)
  } else if (flag === '--wire' && a) {
    wire(a)
  } else if (flag === '--placeholders' && a) {
    placeholders(a)
  } else {
    console.error('usage: npm-platforms.mjs --matrix | --stage <binaries> <out> | --wire <package.json> | --placeholders <out>')
    process.exit(2)
  }
}
