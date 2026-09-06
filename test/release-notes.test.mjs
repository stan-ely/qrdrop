import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sectionFor } from '../scripts/release-notes.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(ROOT, 'scripts', 'release-notes.mjs')

/**
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = /** @type {{ status: number, stdout: string, stderr: string }} */ (error)
    return { status: e.status, stdout: e.stdout, stderr: e.stderr }
  }
}

const CHANGELOG = `# Changelog

## 2.0.0 -- 2026-01-02

Second.

### A deeper heading

Still the second entry.

## 1.0.0

First.
`

test('sectionFor returns an entry without its heading', () => {
  assert.equal(sectionFor(CHANGELOG, '1.0.0'), 'First.')
})

test('a deeper heading belongs to the entry and does not end it', () => {
  const section = sectionFor(CHANGELOG, '2.0.0')
  assert.match(section, /A deeper heading/)
  assert.match(section, /Still the second entry\./)
  assert.doesNotMatch(section, /First\./)
})

test('a version with no entry is null, not an empty string', () => {
  // The distinction is what lets main() tell "you forgot to write it" from
  // "you wrote a heading and nothing under it". Both are release-day
  // mistakes, and they have different fixes.
  assert.equal(sectionFor(CHANGELOG, '3.0.0'), null)
})

test('the root changelog is still the default', () => {
  const { status, stdout } = run(['0.3.1'])
  assert.equal(status, 0)
  assert.match(stdout, /rendezvous room/)
})

test('--file reads the app changelog instead', () => {
  const { status, stdout } = run(['--file', 'app/CHANGELOG.md', '0.1.0'])
  assert.equal(status, 0)
  assert.match(stdout, /first release of the app/i)
})

test('--file is resolved against the repo root, not the caller', () => {
  // The two workflows that call this run from different directories, and a
  // path that quietly depended on cwd would only fail on a release day.
  const stdout = execFileSync(process.execPath, [SCRIPT, '--file', 'app/CHANGELOG.md', '0.1.0'], {
    cwd: path.join(ROOT, 'scripts'), encoding: 'utf8',
  })
  assert.match(stdout, /first release of the app/i)
})

test('a missing section fails loudly, naming the file it looked in', () => {
  const { status, stderr } = run(['--file', 'app/CHANGELOG.md', '99.0.0'])
  assert.equal(status, 1)
  assert.match(stderr, /app\/CHANGELOG\.md has no "## 99\.0\.0" section/)
})

test('--file with no path is a usage error, not a read of undefined', () => {
  const { status, stderr } = run(['--file'])
  assert.equal(status, 2)
  assert.match(stderr, /--file needs a path/)
})
