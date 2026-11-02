/**
 * The app's pages, and what crosses the seam between them and <qr-drop>.
 *
 * Pure for the same reason test/view.test.mjs can exist: h() builds plain
 * objects, so app-view.js renders in bare Node. Back and the history stack need
 * a browser, and check-layout.mjs walks them on the app tree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { bar, page } from '../app/src/app-view.js'
import { transferRecord } from '../src/web/events.js'
import { infoCopy } from '../scripts/build-site.mjs'

/** @param {Record<string, unknown>} [overrides] */
const shellState = overrides => /** @type {any} */ ({
  page: 'home',
  running: false,
  version: '1.3.0',
  build: { label: 'app · abc1234', href: 'https://example.com', title: 'built' },
  saveLocation: 'Download/qrdrop',
  canChangeFolder: false,
  saveError: null,
  how: { title: 'How it works', node: null },
  protect: { title: 'What this does and does not protect', node: null },
  ...overrides,
})

/**
 * @param {any} node
 * @returns {any[]}
 */
const walk = node => {
  if (Array.isArray(node)) return node.flatMap(walk)
  if (typeof node !== 'object' || node === null) return []
  return [node, ...walk(node.children)]
}

/**
 * @param {any} tree
 * @returns {string}
 */
const text = tree => {
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  if (typeof tree === 'string') return tree
  return text(tree.children ?? [])
}

/** @param {any} tree @param {string} id */
const byId = (tree, id) => walk(tree).find(n => n.props.id === id)

test('Home has the wordmark and exactly the two ways off it, each with a name', () => {
  const tree = bar(shellState(), () => {})
  assert.match(text(tree), /qrdrop/)
  const buttons = walk(tree).filter(n => n.tag === 'button')
  assert.deepEqual(buttons.map(b => b.props['aria-label']), ['History', 'Settings'])
})

test('a page has the way back and its name', () => {
  /** @type {string[]} */
  const seen = []
  const tree = bar(shellState({ page: 'history' }), i => seen.push(i))
  assert.match(text(tree), /History/)
  byId(tree, 'nav-back').props.onclick()
  assert.deepEqual(seen, ['nav:back'])
})

test('Home draws no page at all', () => {
  assert.deepEqual(page(shellState(), () => {}), [])
})

test('Settings says where files go and offers a change only where there is one', () => {
  const fixed = page(shellState({ page: 'settings' }), () => {})
  assert.match(text(fixed), /Download\/qrdrop/)
  assert.equal(byId(fixed, 'change-folder'), undefined)

  /** @type {string[]} */
  const seen = []
  const android = page(shellState({ page: 'settings', canChangeFolder: true }), i => seen.push(i))
  byId(android, 'change-folder').props.onclick()
  assert.deepEqual(seen, ['save:change-folder'])
})

test('Settings has something true to say when Android has no folder yet', () => {
  const tree = page(shellState({ page: 'settings', saveLocation: null, canChangeFolder: true }), () => {})
  assert.match(text(tree), /asked the first time/)
})

test('Settings links to About', () => {
  /** @type {any[]} */
  const seen = []
  const tree = page(shellState({ page: 'settings' }), (i, p) => seen.push([i, p]))
  byId(tree, 'settings-about').props.onclick()
  assert.deepEqual(seen, [['nav:open', 'about']])
})

test('About carries everything the page chrome used to', () => {
  const tree = page(shellState({ page: 'about' }), () => {})
  const all = text(tree)
  for (const needed of ['How it works', 'What this does and does not protect', 'Version', '1.3.0', 'Source', 'Feedback']) {
    assert.ok(all.includes(needed), needed)
  }
})

test('every link on About is one the opener capability allows', () => {
  const capability = JSON.parse(readFileSync(new URL('../app/src-tauri/capabilities/default.json', import.meta.url), 'utf8'))
  const { allow } = capability.permissions.find((/** @type {any} */ p) => p.identifier === 'opener:allow-open-url')
  const links = walk(page(shellState({ page: 'about' }), () => {})).filter(n => n.tag === 'a')
  assert.ok(links.length >= 2)
  for (const { props: { href } } of links) {
    const permitted = allow.some((/** @type {{ url: string }} */ { url }) =>
      url.endsWith('*') ? href.startsWith(url.slice(0, -1)) : href === url)
    assert.ok(permitted, href)
  }
})

test('the two adopted copy blocks hold their position across a render', () => {
  /** @type {any} */
  const node = { nodeType: 1 }
  const tree = page(shellState({ page: 'about', how: { title: 'How it works', node } }), () => {})
  assert.equal(walk(tree).find(n => n.key === 'how-copy').props.adopt, node)
})

test('the transfer record is the plan\'s fields and nothing else', () => {
  const state = /** @type {any} */ ({
    screen: 'done', role: 'receiver', outcome: 'received', mode: 'p2p',
    file: { name: 'report.pdf', size: 42 }, path: 'local', lan: false, quic: false,
    saveLocation: 'Downloads/qrdrop/report.pdf',
    // Everything below must stay in the component.
    code: 'qrdrop:SECRET', digest: 'DIGEST', sas: 'SAS', text: 'a password', draft: 'DRAFT',
  })
  const record = transferRecord(state, new Date('2026-11-02T10:00:00Z'))
  assert.deepEqual(record, {
    name: 'report.pdf', size: 42, direction: 'received', route: 'local', outcome: 'received',
    location: 'Downloads/qrdrop/report.pdf', date: '2026-11-02T10:00:00.000Z',
  })
  assert.doesNotMatch(JSON.stringify(record), /SECRET|DIGEST|SAS|password|DRAFT/)
})

test('the record names the route the file actually took', () => {
  const state = /** @type {any} */ ({ role: 'sender', mode: 'p2p', path: 'direct', lan: false, quic: false, file: null })
  assert.equal(transferRecord({ ...state, lan: true }).route, 'lan')
  assert.equal(transferRecord({ ...state, quic: true }).route, 'quic')
  assert.equal(transferRecord({ ...state, lan: true, quic: true }).route, 'lan')
  assert.equal(transferRecord({ ...state, mode: 'beam' }).route, 'beam')
  assert.equal(transferRecord(state).route, 'direct')
  assert.equal(transferRecord(state).direction, 'sent')
})

test('About\'s copy is read from the site\'s template, whole', () => {
  const copy = infoCopy(readFileSync(new URL('../site/index.html', import.meta.url), 'utf8'))
  assert.equal(copy.howTitle, 'How it works')
  assert.equal(copy.protectTitle, 'What this does and does not protect')
  assert.match(copy.how, /^<ol class="how">[\s\S]*Check the words match[\s\S]*<\/ol>$/)
  // The first bullet and the last, so a selector that stopped short fails here.
  assert.match(copy.protect, /Files are encrypted end to end/)
  assert.match(copy.protect, /has always had\.<\/li>\s*<\/ul>$/)
  assert.match(copy.howMore, /__DOCS__\/protocol\.md/)
  assert.match(copy.protectMore, /__DOCS__\/threat-model\.md/)
})

test('a template that no longer holds the copy fails the build', () => {
  assert.throws(() => infoCopy('<html></html>'), /About page/)
})

test('the app\'s template has what the build requires of it and no website chrome', () => {
  const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8')
  for (const token of ['__CSP__', '__SCRIPT__', '__STYLES__', '__THEME_COLOR__', '__HOW__', '__PROTECT__']) {
    assert.ok(html.includes(token), token)
  }
  assert.match(html, /<qr-drop shell="app"><\/qr-drop>/)
  assert.doesNotMatch(html, /class="tagline"|<footer|og:/)
  assert.match(html, /viewport-fit=cover/)
})
