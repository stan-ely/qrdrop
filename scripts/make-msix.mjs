/**
 * Packs the Microsoft Store MSIX: app/src-tauri/AppxManifest.template.xml with
 * its version filled in, the release qrdrop.exe, and the three logos the
 * manifest names, through the Windows SDK's makeappx.
 *
 *   node scripts/make-msix.mjs                  # after `mise run app:build`
 *   node scripts/make-msix.mjs --check          # the version rule only; any OS
 *   node scripts/make-msix.mjs --version 1.0.0  # local sideload testing only
 *
 * The package is UNSIGNED and that is correct: the Store replaces any
 * signature on an MSIX with Microsoft's after certification, so there is
 * nothing for this script to sign with and nothing a certificate here would
 * add. The same bytes will not install from a GitHub Release, which is why
 * app-release.yml uploads the .msix as a job artifact and not a Release asset.
 *
 * A script rather than Microsoft's winapp CLI, which does the same packing:
 * makeappx already ships in the Windows SDK every Windows runner carries, and
 * a second tool installed per release would be one more thing between a tag
 * and a package for a job that is one command.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC_TAURI = path.join(ROOT, 'app', 'src-tauri')
const WORK = path.join(SRC_TAURI, 'target', 'msix')

/** The logos AppxManifest.template.xml names, all written by `tauri icon`. */
const LOGOS = ['Square150x150Logo.png', 'Square44x44Logo.png', 'StoreLogo.png']

/**
 * The crate version, read the way app-release.yml's check job reads it: the
 * first `version = "..."` line, which is [package]'s.
 *
 * @param {string} cargoToml
 * @returns {string}
 */
export function crateVersion(cargoToml) {
  const match = cargoToml.match(/^version = "(.*)"$/m)
  if (!match) throw new Error('Cargo.toml: no version line')
  return match[1]
}

/**
 * The crate version as the four-part version a Store package carries.
 *
 * It is the crate version with `.0` appended and nothing else, and every
 * refusal below is what keeps it that. The Store reserves the fourth part for
 * itself and forbids a first part of 0, so `0.1.0` has no faithful MSIX form.
 * Mapping it onto one (say `1.1.0.0`) was the alternative and was turned down:
 * the Store would then show a version no Release page, changelog or `--version`
 * agrees with. So a 0.x crate cannot produce a Store package at all -- the
 * app went to 1.0.0 for the Store instead.
 *
 * A prerelease has no four-part form either, and it should never reach the
 * Store: app-release.yml keeps prereleases away from every package index.
 *
 * @param {string} version
 * @returns {string}
 */
export function msixVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    throw new Error(`${version} is not a plain major.minor.patch version -- a prerelease has no MSIX form and never goes to the Store`)
  }
  const parts = match.slice(1).map(Number)
  if (parts[0] === 0) {
    throw new Error(`${version}: the Store forbids a first version part of 0, and mapping it onto another number would show a version nothing else agrees with -- release 1.0.0 or later`)
  }
  if (parts.some((part) => part > 65535)) {
    throw new Error(`${version}: every MSIX version part must be 65535 or less`)
  }
  return `${parts.join('.')}.0`
}

/**
 * @param {string} template
 * @param {string} version the crate version, not the MSIX one
 * @returns {string}
 */
export function renderManifest(template, version) {
  const output = template.replaceAll('__VERSION__', msixVersion(version))
  if (output.includes('__')) {
    throw new Error('AppxManifest.template.xml: a __PLACEHOLDER__ was left unfilled')
  }
  return output
}

/**
 * The newest makeappx.exe in the Windows SDK. Newest by version, not by
 * directory order: readdir sorts 10.0.9 after 10.0.26100 as text, and an old
 * SDK's makeappx rejects the uap3 namespace the manifest uses.
 *
 * @returns {Promise<string>}
 */
async function findMakeAppx() {
  if (process.env.MAKEAPPX) return process.env.MAKEAPPX
  const bin = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  const versions = existsSync(bin) ? await readdir(bin) : []
  const candidates = versions
    .filter((v) => /^\d+(\.\d+)*$/.test(v))
    .sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.split('.').map(Number))
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
      }
      return 0
    })
    .map((v) => path.join(bin, v, 'x64', 'makeappx.exe'))
    .filter((p) => existsSync(p))
  if (!candidates.length) {
    throw new Error(`no makeappx.exe under ${bin} -- install the Windows SDK, or point MAKEAPPX at one`)
  }
  return candidates[0]
}

/** @param {string[]} argv */
async function main(argv) {
  const flag = (/** @type {string} */ name) => {
    const i = argv.indexOf(name)
    if (i === -1) return undefined
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }

  const crate = crateVersion(await readFile(path.join(SRC_TAURI, 'Cargo.toml'), 'utf8'))

  if (argv.includes('--check')) {
    console.log(`${crate} packs as MSIX ${msixVersion(crate)}`)
    return
  }

  // The override exists so a 0.x tree can be sideloaded and tested before the
  // bump. In CI it would be a way to ship a package whose version disagrees
  // with the tag, which is the one thing msixVersion exists to prevent.
  const override = flag('--version')
  if (override && process.env.CI) {
    throw new Error('--version is for local sideload testing and is refused in CI')
  }
  const version = override ?? crate

  const exe = path.join(SRC_TAURI, 'target', 'release', 'qrdrop.exe')
  if (!existsSync(exe)) {
    throw new Error(`${exe} does not exist -- run \`mise run app:build\` first`)
  }

  const template = await readFile(path.join(SRC_TAURI, 'AppxManifest.template.xml'), 'utf8')
  const manifest = renderManifest(template, version)

  // A loose layout first, then the package. The layout is also what
  // `Add-AppxPackage -Register` takes, which is how an unsigned build is
  // tested with its real package identity on a machine in Developer Mode.
  const stage = path.join(WORK, 'stage')
  await rm(stage, { recursive: true, force: true })
  await mkdir(path.join(stage, 'Assets'), { recursive: true })
  await cp(exe, path.join(stage, 'qrdrop.exe'))
  for (const logo of LOGOS) {
    await cp(path.join(SRC_TAURI, 'icons', logo), path.join(stage, 'Assets', logo))
  }
  await writeFile(path.join(stage, 'AppxManifest.xml'), manifest)

  const out = path.resolve(flag('--out') ?? path.join(WORK, `qrdrop-${version}-x64.msix`))
  await mkdir(path.dirname(out), { recursive: true })
  // makeappx validates the manifest against the schema while packing, so a
  // malformed element fails here and not at upload.
  execFileSync(await findMakeAppx(), ['pack', '/d', stage, '/p', out, '/o'], { stdio: 'inherit' })

  console.log(`Packed ${path.relative(ROOT, out)} (MSIX ${msixVersion(version)})`)
  console.log(`Loose layout for Add-AppxPackage -Register: ${path.relative(ROOT, stage)}`)
}

if (import.meta.filename === process.argv[1]) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(/** @type {Error} */ (error).message)
    process.exit(1)
  }
}
