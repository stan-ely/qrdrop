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
  history: { enabled: true, entries: [], error: null },
  confirm: null,
  offline: { on: false, available: true, prompts: false },
  ...overrides,
})

/** @param {Record<string, unknown>} [overrides] */
const entry = overrides => ({
  kind: 'file', name: 'report.pdf', size: 2048, direction: 'received', route: 'local',
  outcome: 'received', location: 'Downloads/qrdrop/report.pdf', date: '2026-11-03T10:00:00.000Z',
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

/**
 * Everything in a done screen's state that must never leave the component,
 * each spelled so a leak anywhere in the record is a substring match.
 */
const SECRETS = {
  code: 'qrdrop:SECRETCODE', qrText: 'https://x/#qrdrop:SECRETCODE', digest: 'DIGESTVALUE',
  sas: 'SASWORDS', sasWords: ['SASWORD1'], text: 'hunter2 is my password', draft: 'DRAFTTEXT',
}
const LEAK = /SECRETCODE|DIGESTVALUE|SASWORD|hunter2|DRAFTTEXT/

const FIELDS = ['kind', 'name', 'size', 'direction', 'route', 'outcome', 'location', 'date']

test('the transfer record is the plan\'s fields and nothing else', () => {
  const state = /** @type {any} */ ({
    screen: 'done', role: 'receiver', outcome: 'received', mode: 'p2p',
    file: { name: 'report.pdf', size: 42 }, path: 'local', lan: false, quic: false,
    saveLocation: 'Downloads/qrdrop/report.pdf', isText: false,
    ...SECRETS,
  })
  const record = transferRecord(state, { now: new Date('2026-11-02T10:00:00Z') })
  assert.deepEqual(record, {
    kind: 'file', name: 'report.pdf', size: 42, direction: 'received', route: 'local', outcome: 'received',
    location: 'Downloads/qrdrop/report.pdf', date: '2026-11-02T10:00:00.000Z',
  })
  assert.doesNotMatch(JSON.stringify(record), LEAK)
})

// CLAUDE.md's invariant: history never stores a code, key or text content.
// Every shape a session can end in, sent and received, file and message, on
// done and on choose, with the secrets in the state each time.
test('no ending puts a code, digest, SAS or message text into the record', () => {
  const base = /** @type {any} */ ({
    mode: 'p2p', path: 'direct', lan: false, quic: false, saveLocation: null, isText: false, ...SECRETS,
  })
  const endings = []
  for (const role of ['sender', 'receiver']) {
    for (const isText of [false, true]) {
      const live = { ...base, role, isText, screen: 'transfer', file: { name: 'message.txt', size: 22 } }
      for (const outcome of ['sent', 'received', 'declined', 'failed', 'too-large', 'mismatch']) {
        endings.push(transferRecord({ ...live, screen: 'done', outcome, file: null }, { prior: live }))
      }
      endings.push(transferRecord(live, { outcome: 'cancelled' }))
    }
  }
  for (const record of endings) {
    assert.deepEqual(Object.keys(record), FIELDS)
    assert.doesNotMatch(JSON.stringify(record), LEAK)
  }
})

test('a message is recorded as a message, without a name or a place', () => {
  const state = /** @type {any} */ ({
    screen: 'done', role: 'receiver', outcome: 'received', mode: 'p2p', path: 'local',
    file: { name: 'message.txt', size: 22 }, isText: true, saveLocation: 'somewhere', ...SECRETS,
  })
  const record = transferRecord(state)
  assert.equal(record.kind, 'text')
  assert.equal(record.name, null)
  assert.equal(record.location, null)
  assert.equal(record.size, 22)
})

test('a failure keeps the name the done screen cleared', () => {
  const prior = /** @type {any} */ ({ role: 'sender', mode: 'p2p', path: 'direct', file: { name: 'big.iso', size: 9 } })
  const done = /** @type {any} */ ({ ...prior, screen: 'done', outcome: 'failed', file: null })
  const record = transferRecord(done, { prior })
  assert.equal(record.name, 'big.iso')
  assert.equal(record.outcome, 'failed')
})

test('a receiver\'s offer names a session that ended before the transfer', () => {
  const state = /** @type {any} */ ({ role: 'receiver', mode: 'p2p', path: 'local', file: null, offer: { name: 'a.zip', size: 3 } })
  const record = transferRecord(state, { outcome: 'declined' })
  assert.equal(record.name, 'a.zip')
  assert.equal(record.outcome, 'declined')
  assert.equal(record.direction, 'received')
})

test('a mismatch forgets the route, as the done screen does', () => {
  const prior = /** @type {any} */ ({ role: 'sender', mode: 'p2p', path: 'local', file: { name: 'a', size: 1 } })
  const record = transferRecord({ ...prior, screen: 'done', outcome: 'mismatch', file: null, path: null }, { prior })
  assert.equal(record.route, null)
  assert.equal(record.name, 'a')
})

test('element.js dispatches transferend with the record and nothing else', () => {
  // The component cannot run in bare Node, so the seam is pinned at the
  // source: one dispatch, and every call into it builds its detail through
  // transferRecord, which the tests above hold to its fields.
  const source = readFileSync(new URL('../src/web/element.js', import.meta.url), 'utf8')
  assert.equal(source.match(/'transferend'/g)?.length, 1)
  assert.match(source, /new CustomEvent\('transferend', \{ detail: record \}\)/)
  const calls = [...source.matchAll(/this\._recordEnd\(([^)]*)/g)].map(m => m[1])
  assert.ok(calls.length >= 2, 'a dispatch on done and one on reset')
  for (const call of calls) assert.match(call, /^transferRecord\(/)
})

test('history.rs takes exactly the record\'s fields', () => {
  // deny_unknown_fields on one side, an explicit list on the other: the two
  // lists have to be the same list, or appends fail at the IPC.
  const rust = readFileSync(new URL('../app/src-tauri/src/history.rs', import.meta.url), 'utf8')
  const body = /pub struct Entry \{([^}]*)\}/.exec(rust)?.[1] ?? ''
  const fields = [...body.matchAll(/pub (\w+):/g)].map(m => m[1])
  assert.deepEqual(fields, FIELDS)
  assert.match(rust, /#\[serde\(deny_unknown_fields\)\]\s*pub struct Entry/)
})

test('History lists what the store holds, in its order, with an empty state', () => {
  const empty = page(shellState({ page: 'history' }), () => {})
  assert.match(text(empty), /No transfers yet/)

  const off = page(shellState({ page: 'history', history: { enabled: false, entries: [], error: null } }), () => {})
  assert.match(text(off), /History is off/)

  const tree = page(shellState({
    page: 'history',
    history: { enabled: true, error: null, entries: [entry({ name: 'newest.pdf' }), entry({ name: 'older.pdf' })] },
  }), () => {})
  const names = walk(tree).filter(n => n.props.class === 'entry-name').map(text)
  assert.deepEqual(names, ['newest.pdf', 'older.pdf'])
  // Saved under another name than the one shown, so the whole location.
  assert.match(text(tree), /Saved to Downloads\/qrdrop\/report\.pdf/)
  assert.match(text(tree), /Received · 2.0 KB · Local network/)

  // Saved under the name shown, so the folder alone and the name only once.
  const same = page(shellState({ page: 'history', history: { enabled: true, error: null, entries: [entry()] } }), () => {})
  assert.match(text(same), /Saved to Downloads\/qrdrop$/)
})

test('a peer\'s filename in History is a text node, never markup', () => {
  const hostile = '<img src=x onerror=alert(1)>.pdf'
  const tree = page(shellState({ page: 'history', history: { enabled: true, error: null, entries: [entry({ name: hostile })] } }), () => {})
  const name = walk(tree).find(n => n.props.class === 'entry-name')
  assert.deepEqual(name.children, [hostile])
  assert.equal(walk(tree).some(n => n.tag === 'img'), false)
})

test('History says what did not go well and leaves the ordinary endings quiet', () => {
  const tree = page(shellState({
    page: 'history',
    history: {
      enabled: true, error: null, entries: [
        entry({ outcome: 'declined', direction: 'sent', location: null }),
        entry({ outcome: 'mismatch', direction: 'sent', route: null, location: null }),
        entry({ kind: 'text', name: null, outcome: 'received', location: null }),
      ],
    },
  }), () => {})
  const outcomes = walk(tree).filter(n => String(n.props.class).startsWith('entry-outcome')).map(text)
  assert.deepEqual(outcomes, ['Declined', 'Stopped: the symbols did not match'])
  assert.match(text(tree), /Message/)
})

test('Settings has the History switch, and Clear only when there is something', () => {
  /** @type {any[]} */
  const seen = []
  const empty = page(shellState({ page: 'settings' }), (i, p) => seen.push([i, p]))
  const sw = byId(empty, 'history-enabled')
  assert.equal(sw.props.role, 'switch')
  assert.equal(sw.props.checked, true)
  assert.equal(byId(empty, 'history-clear').props.disabled, true)
  sw.props.onchange({ target: { checked: false } })
  assert.deepEqual(seen, [['history:enabled', false]])

  const full = page(shellState({ page: 'settings', history: { enabled: true, entries: [entry()], error: null } }), (i, p) => seen.push([i, p]))
  assert.equal(byId(full, 'history-clear').props.disabled, false)
  byId(full, 'history-clear').props.onclick()
  assert.deepEqual(seen.at(-1), ['history:clear', undefined])
})

test('Settings has "Pair without internet", off until switched on, and says what it costs', () => {
  /** @type {any[]} */
  const seen = []
  const quiet = page(shellState({ page: 'settings' }), (i, p) => seen.push([i, p]))
  const sw = byId(quiet, 'offline-enabled')
  assert.equal(sw.props.role, 'switch')
  assert.equal(sw.props.checked, false)
  assert.match(text(quiet), /same Wi-Fi can pair with no internet/)
  assert.match(text(quiet), /Older versions may not read the code/)
  assert.doesNotMatch(text(quiet), /accept connections/)
  sw.props.onchange({ target: { checked: true } })
  assert.deepEqual(seen, [['offline:enabled', true]])

  // Where listening asks the firewall, the row says so before it is on.
  const prompts = page(shellState({ page: 'settings', offline: { on: false, available: true, prompts: true } }), () => {})
  assert.match(text(prompts), /Your system may ask to let qrdrop accept connections/)

  // With no LanPlatform nothing could listen, so the row is not offered.
  const none = page(shellState({ page: 'settings', offline: { on: false, available: false, prompts: false } }), () => {})
  assert.equal(byId(none, 'offline-enabled'), undefined)
})

test('the offline listener is read per send, and only in the app', () => {
  // The setting is the app's: src/web never reads it, and the website has no
  // LanPlatform, so getPlatform().lan?.openOffline is absent there.
  const element = readFileSync(new URL('../src/web/element.js', import.meta.url), 'utf8')
  assert.doesNotMatch(element, /qrdrop:offline-pairing|offlinePairing/)
  assert.match(element, /getPlatform\(\)\.lan\?\.openOffline/)
  const site = readFileSync(new URL('../site/main.js', import.meta.url), 'utf8')
  assert.doesNotMatch(site, /registerPlatform/)
  // Both of the app's sessions read it as a send starts.
  for (const file of ['../app/src/lan.js', '../app/src/native.js']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /offlinePairing\(\)/, file)
  }
})

test('clearing is asked first, and switching off asks about what is kept', () => {
  const entries = [entry(), entry()]
  /** @type {string[]} */
  const seen = []
  const clear = page(shellState({ page: 'settings', confirm: 'clear', history: { enabled: true, entries, error: null } }), i => seen.push(i))
  assert.match(text(clear), /Clear 2 transfers from this device\?/)
  assert.equal(byId(clear, 'history-clear'), undefined)
  byId(clear, 'history-clear-confirm').props.onclick()
  byId(clear, 'history-keep').props.onclick()
  assert.deepEqual(seen, ['history:clear-confirm', 'history:keep'])

  const off = page(shellState({ page: 'settings', confirm: 'off', history: { enabled: false, entries, error: null } }), () => {})
  assert.match(text(off), /History is off\. Clear the 2 transfers already saved\?/)
  assert.match(text(byId(off, 'history-keep')), /Keep/)
})

test('the record names the route the file actually took', () => {
  const state = /** @type {any} */ ({ role: 'sender', mode: 'p2p', path: 'direct', lan: false, quic: false, file: null, outcome: 'sent' })
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
  assert.match(copy.protect, /code always has\.<\/li>\s*<\/ul>$/)
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
