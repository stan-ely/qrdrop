/**
 * The verify screen offers no way back into a pairing.
 *
 * The SAS is four symbols out of 64 -- 24 bits -- and 24 bits only holds at
 * one attempt per secret. Bits times shots is the real strength, and the shots
 * are a property of how the screens are wired rather than of any crypto: if a
 * user who sees mismatched symbols can re-scan the same QR, an attacker keeps
 * rolling against the same secret, and by the third try that user has been
 * taught to read a re-pair as ordinary flakiness.
 *
 * Today there is one roll per secret, and it is emergent rather than enforced.
 * Cancel routes to _reset(), which lands on the file picker, and the only way
 * back to a pairing is _startSend(), which calls generateSecret() for fresh
 * bytes. Nothing stated that, and nothing tested it -- so a "Try again" button
 * on verify would have reintroduced the loop, and it is a tempting button to
 * add, because a genuine pairing failure and an attack look identical from
 * that screen.
 *
 * This is the tripwire. The other half of the invariant -- that a second
 * pairing over the same secret cannot open the first -- is already pinned in
 * test/room.test.mjs and is not repeated here.
 *
 * WHY THIS FILE CAN EXIST AT ALL: render() is pure, and h() builds plain
 * objects; only patch() touches the DOM (see src/web/vdom.js). So the view can
 * be rendered and walked in bare Node with no jsdom and no new dependency,
 * which is worth knowing generally -- src/web/view.js had no unit coverage of
 * any kind before this.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { render, dialogContent } from '../src/web/view.js'

/**
 * Every intent that begins a pairing. A control on the verify screen wired to
 * any of these is the loop above, whatever it is labelled.
 *
 * Read off element.js's _dispatch: these are the cases that reach _startSend,
 * _beginScan, _startReceive or a beam flow. Listed rather than derived because
 * a derivation would need element.js, which needs a DOM -- and a list that
 * drifts fails loudly here, where a wrong derivation would pass quietly.
 */
const PAIRING_INTENTS = new Set([
  'send:pick', 'send:photo', 'receive:scan', 'manual:submit', 'beam:pick', 'beam:start', 'beam:scan',
])

const SAS_WORDS = ['anchor', 'butter', 'cactus', 'dolphin']

/** @param {Partial<Record<string, any>>} overrides */
function state(overrides) {
  return /** @type {any} */ ({
    screen: 'choose', role: null, status: '', error: null, code: '', qrNode: null,
    qrIsLink: false, path: null, pathDebug: null, cameraAvailable: true, rtcAvailable: true,
    capabilityNote: null, coarse: false, sas: '🎧 🧈 🌵 🐬', sasWords: SAS_WORDS,
    offer: null, file: null, progress: null, outcome: null, message: null, digest: '',
    dragging: false, copied: null, pairing: false, busy: false, manualError: null,
    mode: 'p2p', beamNode: null, beam: null, dialogNode: null, modal: null, toast: null,
    beamEnlarged: false,
    ...overrides,
  })
}

const senderVerify = () => state({
  screen: 'verify', role: 'sender', sas: '🎧 🧈 🌵 🐬', sasWords: SAS_WORDS,
  file: { name: 'report.pdf', size: 2_097_152 },
})

/**
 * Every vnode in a tree, depth first.
 *
 * @param {any} node
 * @returns {Generator<any>}
 */
function* walk(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)
    return
  }
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

/**
 * The subtree for one screen. render() emits every screen on every pass and
 * hides the inactive ones, so picking by id is the only honest way to ask
 * what a given screen offers.
 *
 * @param {any} s
 * @param {string} name
 */
function screenTree(s, name) {
  const dispatch = () => {}
  const found = [...walk(render(s, dispatch))].find(n => n.props?.id === `screen-${name}`)
  assert.ok(found, `expected a #screen-${name} in the render`)
  return found
}

/**
 * Every intent reachable by clicking something on `name`, collected by firing
 * each onclick against a recording dispatch. Handlers are plain closures over
 * dispatch, so this reaches what a user can reach and nothing else.
 *
 * @param {any} s
 * @param {string} name
 * @returns {Set<string>}
 */
function intentsOn(s, name) {
  /** @type {Set<string>} */
  const intents = new Set()
  const dispatch = (/** @type {string} */ intent) => void intents.add(intent)
  const tree = [...walk(render(s, dispatch))].find(n => n.props?.id === `screen-${name}`)
  for (const node of walk(tree)) node.props?.onclick?.()
  return intents
}

test('the sender verify screen offers no control that starts a pairing', () => {
  const offered = intentsOn(senderVerify(), 'verify')

  for (const intent of offered) {
    assert.ok(!PAIRING_INTENTS.has(intent),
      `'${intent}' on the verify screen would let a mismatch re-roll the same secret -- `
      + 'the SAS is 24 bits and that only holds at one attempt each. Recovery from a '
      + 'mismatch has to go through the choose screen, where _startSend mints fresh bytes.')
  }
})

test('the sender verify screen names the mismatch, and keeps one primary', () => {
  const offered = intentsOn(senderVerify(), 'verify')

  assert.ok(offered.has('verify:confirm'), 'the match gesture must stay on the screen')
  assert.ok(offered.has('verify:reject'),
    'a user looking at symbols that do not match needs a control that says so')

  // Pins e2e/transfer.e2e.mjs's '#verify-status button.primary' from Node,
  // where it currently takes two browsers and a public relay to discover that
  // a second .primary made the selector ambiguous.
  const status = [...walk(screenTree(senderVerify(), 'verify'))]
    .find(n => n.props?.id === 'verify-status')
  const primaries = [...walk(status)].filter(n => n.tag === 'button' && n.props?.class?.includes('primary'))
  assert.equal(primaries.length, 1, '#verify-status must hold exactly one .primary button')
})

test('the mismatch outcome says what happened and what starting over means', () => {
  const tree = screenTree(state({
    screen: 'done', role: 'sender', outcome: 'mismatch', file: null, digest: '',
  }), 'done')
  const text = [...walk(tree)].flatMap(n => n.children.filter((/** @type {unknown} */ c) => typeof c === 'string')).join(' ')

  assert.match(text, /didn't match/, 'the heading must name the outcome')
  assert.match(text, /relaying/, 'the message must say what a mismatch means')
  assert.match(text, /fresh code/, 'and that starting over means a new one')
  assert.ok(!text.includes('Send another file'),
    'the restart label must not invite re-offering the code an attacker just rolled against')
})

/**
 * Beam's warning is said in full before anything moves, and only a tag stays
 * on the live screens.
 *
 * The sentence used to be a callout on both beam screens for the whole
 * transfer, where it arrived after the decision it informs and was the
 * tallest thing competing with a QR that has to be large to be read. It moved
 * to the two sheets that stand in front of each end's decision -- the
 * sender's confirm before a frame is shown, the receiver's offer before
 * Accept writes anything -- and these tests are what stop it quietly
 * disappearing from one of them, or creeping back onto a screen.
 */

/** Every string in a tree, joined. @param {any} tree */
function textOf(tree) {
  return [...walk(tree)].flatMap(n => (n.children ?? []).filter((/** @type {any} */ c) => typeof c === 'string')).join(' ')
}

const FULL_WARNING = 'This is not encrypted, and cannot be'
const beamFile = { name: 'report.pdf', size: 2_097_152 }

test('the sender confirms the beam warning before anything is shown', () => {
  /** @type {Set<string>} */
  const intents = new Set()
  const sheet = dialogContent(state({ modal: 'beam-confirm', file: beamFile }),
    (/** @type {string} */ intent) => void intents.add(intent))

  assert.match(textOf(sheet), new RegExp(FULL_WARNING))
  for (const node of walk(sheet)) node.props?.onclick?.()
  assert.ok(intents.has('beam:start'), 'the confirm sheet is the only way to start a beam')
})

test('the receiver sees the beam warning on the sheet that holds Accept', () => {
  const sheet = dialogContent(state({
    screen: 'beam-receive', mode: 'beam', role: 'receiver', modal: 'beam-offer', offer: beamFile,
  }), () => {})
  assert.match(textOf(sheet), new RegExp(FULL_WARNING))
})

test('the live beam screens carry the tag, not the paragraph', () => {
  const beam = { fps: 10, loops: 2, solved: 41, blocks: 190, eta: 31 }
  for (const [name, role] of [['beam-send', 'sender'], ['beam-receive', 'receiver']]) {
    const text = textOf(screenTree(state({ screen: name, mode: 'beam', role, file: beamFile, beam }), name))
    assert.ok(!text.includes(FULL_WARNING), `${name} should not carry BEAM_WARNING inline`)
    assert.ok(text.includes('Not encrypted'), `${name} must still say it is not encrypted`)
  }
})

test('the beam code enlarges on press, and the backdrop only ever shrinks it', () => {
  /** @type {[string, any][]} */
  const calls = []
  const dispatch = (/** @type {string} */ intent, /** @type {any} */ payload) => void calls.push([intent, payload])
  const s = state({ screen: 'beam-send', mode: 'beam', role: 'sender', file: beamFile, beamEnlarged: true })
  const tree = [...walk(render(s, dispatch))].find(n => n.props?.id === 'screen-beam-send')
  const nodes = [...walk(tree)]

  nodes.find(n => n.props?.id === 'beam-stage').props.onclick()
  nodes.find(n => n.props?.class === 'beam-hint').props.onclick()
  assert.deepEqual(calls, [['beam:enlarge', undefined], ['beam:enlarge', false]])
})
