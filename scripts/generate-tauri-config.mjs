/**
 * Regenerates app/src-tauri/tauri.conf.json from tauri.conf.template.json,
 * filling in __CSP__ with the policy the website build serves, plus the one
 * thing only the app needs: Tauri's own IPC origin in connect-src (`ipc: true`
 * below). Without it every `invoke` silently downgrades to a JSON body and the
 * native sink rejects the first chunk it is handed -- see buildCSP's comment
 * for how that surfaces, which is nowhere near the CSP.
 *
 * This is the app-side half of the invariant scripts/build-site.mjs already
 * enforces for the website's CSP meta tag: connect-src is derived from
 * SIGNALING_URLS (src/transport/room.js) rather than a second hand-kept list.
 * Reusing buildCSP() itself -- not a parallel reimplementation -- is what
 * makes "the app and the website agree about what qrdrop is allowed to talk
 * to" a build property instead of something that has to be remembered every
 * time a relay or tracker is added.
 *
 * tauri.conf.json IS committed, same as Cargo.lock, and this script
 * regenerates it in place -- run automatically by the `app:dev` / `app:build`
 * mise tasks before every invocation of the Tauri CLI, so a stale committed
 * copy is never more than one run out of date, and a fresh clone still has a
 * working config before anyone runs anything.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCSP } from './build-site.mjs'
import { SIGNALING_URLS } from '../src/transport/room.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC_TAURI = path.join(ROOT, 'app', 'src-tauri')

async function main() {
  const template = await readFile(path.join(SRC_TAURI, 'tauri.conf.template.json'), 'utf8')
  const csp = buildCSP(SIGNALING_URLS, { ipc: true })

  const output = template.replaceAll('__CSP__', csp)
  if (output.includes('__CSP__')) {
    // Can't happen with the template as written, but a JSON.stringify'd CSP
    // containing the literal token would silently defeat the check below --
    // asserting on the raw text first, before the file is even valid JSON
    // yet, catches that case as loudly as a truly-missing placeholder.
    throw new Error('tauri.conf.template.json: __CSP__ was not fully replaced')
  }

  // Parse-and-restringify rather than writing the substituted text directly:
  // it validates the result is actually valid JSON (a CSP containing an
  // unescaped quote would otherwise corrupt the file silently) and gives a
  // stable, diff-friendly two-space format regardless of how the template
  // happened to be edited.
  const config = JSON.parse(output)
  await writeFile(path.join(SRC_TAURI, 'tauri.conf.json'), JSON.stringify(config, null, 2) + '\n')
  console.log('Generated app/src-tauri/tauri.conf.json')
}

if (import.meta.filename === process.argv[1]) {
  await main()
}
