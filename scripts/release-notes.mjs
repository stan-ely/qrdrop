/**
 * Prints one version's section of CHANGELOG.md, for a GitHub Release body.
 *
 * The changelog is already the record -- it is written by hand, in prose, and
 * says why each change happened. A release workflow that generated its own
 * notes from commit subjects would produce a worse document beside a better
 * one, so this extracts rather than summarises.
 *
 *   node scripts/release-notes.mjs 0.3.1
 *   node scripts/release-notes.mjs v0.3.1     # a leading v is fine
 *   node scripts/release-notes.mjs --file app/CHANGELOG.md 0.1.0
 *
 * There are two changelogs, because there are two things released on two tags
 * from one repository: `v*` publishes the npm package and reads CHANGELOG.md,
 * `app-v*` releases the Tauri shell and reads app/CHANGELOG.md. The app's
 * version is its crate version and deliberately unrelated to the package's
 * (see CLAUDE.md), so one file covering both would be a single list of
 * headings in two unrelated sequences.
 *
 * Exits non-zero, loudly, when the section is missing. A Release with an empty
 * body is worse than a failed job: the job can be re-run after the changelog is
 * written, but a published Release with no notes is what everyone sees first,
 * and fixing it after the fact is a manual edit nobody remembers to make.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Headings look like `## 0.3.1 -- 2026-08-30`, and `## 0.1.0` with no date at
 * all (see the note in that entry about it predating tagging). Match the
 * version and ignore whatever follows it, rather than requiring the dash and
 * date and failing on the one entry that has neither.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function sectionFor(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = /^## +(\d+\.\d+\.\d+[^\s]*)/

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const match = heading.exec(lines[i])
    if (!match) continue
    if (start === -1) {
      if (match[1] === version) start = i
      continue
    }
    // The next version heading ends the section. Deeper headings (### ...)
    // belong to the entry and must not terminate it.
    return lines.slice(start + 1, i).join('\n').trim()
  }

  if (start === -1) return null
  return lines.slice(start + 1).join('\n').trim()
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  // Parsed by hand rather than with parseArgs: one optional flag, and the
  // whole point of this script is that a release workflow can call it without
  // anything having to be installed first.
  let file = 'CHANGELOG.md'
  const rest = [...argv]
  const flag = rest.indexOf('--file')
  if (flag !== -1) {
    const value = rest[flag + 1]
    if (!value) {
      process.stderr.write('--file needs a path\n')
      process.exit(2)
    }
    file = value
    rest.splice(flag, 2)
  }

  const raw = rest[0]
  if (!raw) {
    process.stderr.write('usage: node scripts/release-notes.mjs [--file <changelog>] <version>\n')
    process.exit(2)
  }

  // Tags are `v0.3.1` and package.json says `0.3.1`; accept either so the
  // workflow can pass GITHUB_REF_NAME straight through.
  const version = raw.replace(/^v/, '')

  // Resolved against the repository root, not the working directory: the two
  // workflows that call this run from different places, and a relative read
  // that depends on the caller's cwd is a failure that only shows up on a
  // release day.
  const changelog = await readFile(path.join(ROOT, file), 'utf8')
  const section = sectionFor(changelog, version)

  if (section === null) {
    process.stderr.write(
      `${file} has no "## ${version}" section.\n`
      + 'Write the entry before tagging -- the release notes come from it.\n',
    )
    process.exit(1)
  }

  if (section === '') {
    process.stderr.write(`${file}'s "## ${version}" section is empty.\n`)
    process.exit(1)
  }

  process.stdout.write(section + '\n')
}

// Importable for tests, runnable as a script. Compared by resolved path rather
// than by name so a symlinked or differently-cased invocation still matches.
if (import.meta.url === new URL(`file://${process.argv[1]}`).href
  || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  await main(process.argv.slice(2))
}
