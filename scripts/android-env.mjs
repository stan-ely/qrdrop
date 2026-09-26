/**
 * Runs an Android build with the rustflags that make its native library
 * reproducible, and is the one place those flags are spelled:
 *
 *   node scripts/android-env.mjs npx tauri android build --apk     # from app/
 *
 * app-release.yml runs every signed build through it, app-reproducible.yml
 * runs its two comparison builds through it, `mise run app:android:build` does
 * too, and the f-droid.org recipe calls it with its own `cargo tauri`. That
 * last caller is why this exists. f-droid.org publishes our signed APK, rather
 * than one signed with its own key, only if its build from source matches ours
 * byte for byte (CLAUDE.md, "f-droid.org"). Rust writes absolute source paths
 * into the library: panic locations, and file!() in generated code. F-Droid
 * builds in another directory with another CARGO_HOME, so without remapping
 * those paths the two builds can never match. Measured on a local release
 * build: every registry crate's path, e.g. .cargo/registry/src/index.crates.io-
 * 1949cf8c6b5b557f/tao-0.35.3/src/platform_impl/android/ndk_glue.rs, was in
 * the .so. Rust's own std paths are already /rustc/<hash>, so need no mapping.
 *
 * A wrapper rather than anything declarative, because there is nowhere
 * declarative for it to go. Cargo's `trim-paths` profile option does exactly
 * this and is still unstable (refused by cargo 1.98.1). A .cargo/config.toml
 * cannot hold a path that differs per machine. gen/android's BuildTask.kt is
 * the one place every Gradle build goes through, but `tauri android build`
 * compiles the Rust itself before it starts Gradle, so a flag set there never
 * reaches the build that ships.
 */

import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Tauri's own Android rustflags, copied, and they are not optional. The Tauri
 * CLI passes them as CARGO_TARGET_<triple>_RUSTFLAGS and sets that variable
 * outright, so a value of ours there is thrown away. Cargo also takes only the
 * first rustflags source it finds and does not merge, so our flags replace
 * Tauri's. Both were measured with a logging RUSTC_WRAPPER. Leaving these out
 * would not fail the link; it would fail when the library loads on a phone.
 * test/android-env.test.mjs checks this list against the installed Tauri CLI
 * binary, so a Tauri upgrade that changes it fails there.
 */
export const TAURI_ANDROID_RUSTFLAGS = [
  '-Clink-arg=-landroid',
  '-Clink-arg=-llog',
  '-Clink-arg=-lOpenSLES'
]

/**
 * @param {{ repoRoot: string, cargoHome: string }} where
 * @returns {string[]}
 */
export function androidRustflags({ repoRoot, cargoHome }) {
  return [
    ...TAURI_ANDROID_RUSTFLAGS,
    // Where two mappings match, rustc uses the last one, so CARGO_HOME goes
    // after the checkout in case one is ever inside the other.
    `--remap-path-prefix=${repoRoot}=/qrdrop`,
    `--remap-path-prefix=${cargoHome}=/cargo`
  ]
}

/**
 * Cargo's own rule: CARGO_HOME if it is set, and ~/.cargo if it is not.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function cargoHomeOf(env) {
  return env.CARGO_HOME || path.join(os.homedir(), '.cargo')
}

/** @param {string[]} argv */
function main(argv) {
  if (argv.length === 0) throw new Error('usage: node scripts/android-env.mjs <command> [args...]')
  // CARGO_ENCODED_RUSTFLAGS outranks RUSTFLAGS, so an inherited RUSTFLAGS
  // would be dropped with no message at all. Refuse it instead.
  for (const name of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']) {
    if (process.env[name]) throw new Error(`${name} is set; unset it, or its flags would be silently dropped here`)
  }
  const flags = androidRustflags({ repoRoot: ROOT, cargoHome: cargoHomeOf(process.env) })
  // Encoded, with \x1f between flags, so a space in a path (a Windows profile
  // directory can have one) cannot split a flag in two.
  const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') }
  // A shell on Windows only, where `npx` is npx.cmd and cannot be spawned
  // directly.
  const result = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

if (import.meta.filename === process.argv[1]) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(/** @type {Error} */ (error).message)
    process.exit(1)
  }
}
