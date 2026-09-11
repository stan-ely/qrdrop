import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { crateVersion, msixVersion, renderManifest } from '../scripts/make-msix.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC_TAURI = path.join(ROOT, 'app', 'src-tauri')

test('a release version gains a fourth part of 0 and nothing else', () => {
  assert.equal(msixVersion('1.0.0'), '1.0.0.0')
  assert.equal(msixVersion('2.13.7'), '2.13.7.0')
})

test('a 0.x version is refused rather than mapped onto another number', () => {
  // The Store forbids a first part of 0. Quietly rewriting it would put a
  // version on the listing that no tag, Release or changelog agrees with.
  assert.throws(() => msixVersion('0.1.0'), /first version part of 0/)
})

test('a prerelease is refused, since it never goes to the Store', () => {
  assert.throws(() => msixVersion('1.0.0-rc.1'), /prerelease has no MSIX form/)
})

test('a part above 65535 is refused', () => {
  assert.throws(() => msixVersion('1.65536.0'), /65535 or less/)
})

test('crateVersion reads [package] and not a dependency', () => {
  const toml = '[package]\nname = "qrdrop"\nversion = "1.2.3"\n\n[dependencies]\nserde = { version = "1.0.229" }\n'
  assert.equal(crateVersion(toml), '1.2.3')
})

/** @returns {Promise<string>} */
async function manifest() {
  const template = await readFile(path.join(SRC_TAURI, 'AppxManifest.template.xml'), 'utf8')
  return renderManifest(template, '1.0.0')
}

test('no comment in the manifest contains a double hyphen', async () => {
  // XML forbids `--` inside a comment, and this repository's prose uses it as
  // an em dash. makeappx reports it only as "'>' expected" at a line number,
  // and only on Windows -- it has already happened here once, and twice in
  // AndroidManifest.xml -- so it is checked where every platform runs.
  const xml = await manifest()
  for (const [, body] of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(!body.includes('--'), `comment contains "--": ${body.trim().slice(0, 80)}`)
  }
})

test('the identity is the one reserved in Partner Center, verbatim', async () => {
  // Case- and punctuation-sensitive. An upload that disagrees with the
  // reserved product is refused, and that is the expensive place to find out.
  const xml = await manifest()
  assert.match(xml, /Name="stan-ely\.qrdrop"/)
  assert.match(xml, /Publisher="CN=83DEB6F1-2747-47C0-B94F-38A296EF8C5B"/)
  assert.match(xml, /<PublisherDisplayName>stan-ely<\/PublisherDisplayName>/)
  assert.match(xml, /Version="1\.0\.0\.0"/)
})

test('every scheme the app registers is declared in the manifest', async () => {
  // A packaged app's runtime registration writes a virtualized HKCU the shell
  // never reads, so a scheme missing here is a link that opens nothing -- with
  // the unpackaged build working perfectly beside it.
  const config = JSON.parse(await readFile(path.join(SRC_TAURI, 'tauri.conf.template.json'), 'utf8'))
  const xml = await manifest()
  for (const scheme of config.plugins['deep-link'].desktop.schemes) {
    assert.match(xml, new RegExp(`<uap3:Protocol Name="${scheme}" Parameters="&quot;%1&quot;">`))
  }
})

test('the camera is declared, and so is full trust', async () => {
  const xml = await manifest()
  assert.match(xml, /<DeviceCapability Name="webcam" \/>/)
  assert.match(xml, /<rescap:Capability Name="runFullTrust" \/>/)
  assert.match(xml, /EntryPoint="Windows\.FullTrustApplication"/)
})

test('every logo the manifest names exists in icons/', async () => {
  const xml = await manifest()
  const named = [...xml.matchAll(/Assets\\([\w.]+\.png)/g)].map((m) => m[1])
  assert.ok(named.length >= 3)
  for (const logo of new Set(named)) {
    await assert.doesNotReject(readFile(path.join(SRC_TAURI, 'icons', logo)), `icons/${logo}`)
  }
})
