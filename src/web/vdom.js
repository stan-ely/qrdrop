/**
 * A minimal virtual DOM: `h()` to describe a tree, `patch()` to make the real
 * one match it.
 *
 * WHY THIS EXISTS: the UI used to be a template full of ids plus forty-odd
 * imperative pokes at them (`$('done-title').textContent = 'Sent'`). Every
 * screen's appearance was the sum of whichever pokes had run so far, which is
 * why a stale error banner could survive a screen change and why a failed
 * transfer left the progress bar frozen at its last value. Nothing described
 * a screen in one place, so nothing could be read in one place either.
 *
 * With this, `src/web/view.js` is a pure function from state to a tree, and
 * the DOM is derived rather than accumulated. A state that cannot be reached
 * cannot be rendered, and a state that is reached renders identically no
 * matter what came before it.
 *
 * WHY NOT A LIBRARY: preact would do this better, and in ~4 kB. But this
 * package's whole pitch is that `npm install qrdrop` pulls in four runtime
 * dependencies and nothing else -- see the note at the top of src/cli.js.
 * A hundred and fifty lines is a fair price for keeping that true, given how
 * little of a real vdom this actually needs: no components, no lifecycle, no
 * fragments, no context, one synchronous render per state change.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - No `innerHTML`, anywhere, by construction. Text children become text
 *     nodes. That is what keeps peer-supplied filenames inert without every
 *     call site having to remember it.
 *   - No async or batched rendering. `patch` is synchronous, so a click
 *     handler that calls setState sees the DOM updated when it returns.
 *   - No unkeyed list reconciliation subtleties: children are matched by
 *     position, and anything whose identity matters carries an explicit key.
 */

/**
 * @typedef {object} VNode
 * @property {string} tag
 * @property {string | undefined} key
 * @property {Record<string, any>} props
 * @property {(VNode | string)[]} children
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Describes an element.
 *
 * `children` accepts nested arrays and `null`/`false`/`undefined` so callers
 * can write `[cond && h('p', ...)]` without a filter step at every site.
 *
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {any} [children]
 * @returns {VNode}
 */
export function h(tag, props = {}, children = []) {
  return {
    tag,
    // Pulled out of props so the diff can reach it without a property lookup
    // on every candidate, and so it never lands on the DOM as an attribute.
    key: props.key,
    props,
    children: flatten(children),
  }
}

/**
 * @param {any} value
 * @returns {(VNode | string)[]}
 */
function flatten(value) {
  if (!Array.isArray(value)) value = [value]
  /** @type {(VNode | string)[]} */
  const out = []
  for (const child of value) {
    if (child === null || child === undefined || child === false || child === true) continue
    if (Array.isArray(child)) out.push(...flatten(child))
    else if (typeof child === 'object') out.push(child)
    else out.push(String(child))
  }
  return out
}

/**
 * Reconciles `parent`'s children against `next`.
 *
 * Pass the VNode returned by the previous call as `prev`; pass `null` on the
 * first call. Returns `next`, so the caller's bookkeeping is a single
 * assignment.
 *
 * @param {Element | DocumentFragment} parent
 * @param {VNode[]} next
 * @param {VNode[] | null} prev
 * @returns {VNode[]}
 */
export function patch(parent, next, prev) {
  patchChildren(parent, next, prev ?? [])
  return next
}

/**
 * Whether an existing DOM node can be updated in place to become `vnode`,
 * rather than being thrown away and rebuilt.
 *
 * The key check is what preserves `<video id="scanner">` across re-renders.
 * A rebuilt <video> would lose its `srcObject`, which means the camera track
 * would be re-attached on every progress tick -- a black flicker at best, and
 * a dropped MediaStream at worst. The same reasoning covers `#manual-input`:
 * a rebuilt input loses focus and caret position mid-typing.
 *
 * @param {Node} node
 * @param {VNode | string} vnode
 * @param {VNode | string | undefined} prevVNode
 */
function canReuse(node, vnode, prevVNode) {
  if (typeof vnode === 'string') return node.nodeType === Node.TEXT_NODE
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  if (/** @type {Element} */ (node).localName !== vnode.tag) return false
  const prevKey = typeof prevVNode === 'object' ? prevVNode?.key : undefined
  return prevKey === vnode.key
}

/**
 * @param {Element | DocumentFragment} parent
 * @param {(VNode | string)[]} next
 * @param {(VNode | string)[]} prev
 */
function patchChildren(parent, next, prev) {
  const nodes = /** @type {ChildNode[]} */ ([...parent.childNodes])

  for (let i = 0; i < next.length; i++) {
    const vnode = next[i]
    const existing = nodes[i]

    if (existing && canReuse(existing, vnode, prev[i])) {
      patchNode(existing, vnode, prev[i])
      continue
    }

    const created = create(vnode)
    if (existing) parent.replaceChild(created, existing)
    else parent.appendChild(created)
  }

  // Anything the new tree does not account for goes, back to front so the
  // live NodeList never shifts underneath the loop.
  for (let i = nodes.length - 1; i >= next.length; i--) parent.removeChild(nodes[i])
}

/**
 * @param {Node} node
 * @param {VNode | string} vnode
 * @param {VNode | string | undefined} prevVNode
 */
function patchNode(node, vnode, prevVNode) {
  if (typeof vnode === 'string') {
    // Assigning an unchanged value would still reset the caret in a
    // contenteditable and dirty the node for no reason.
    if (node.nodeValue !== vnode) node.nodeValue = vnode
    return
  }

  const el = /** @type {Element} */ (node)
  const prevProps = typeof prevVNode === 'object' && prevVNode ? prevVNode.props : {}
  applyProps(el, vnode.props, prevProps)

  if (vnode.props.adopt) return adoptInto(el, vnode.props.adopt)

  patchChildren(el, vnode.children, typeof prevVNode === 'object' && prevVNode ? prevVNode.children : [])
}

/**
 * The escape hatch for a real DOM node the view did not describe.
 *
 * `renderQR()` returns a built <svg> from a third-party generator, and the
 * camera scanner writes a MediaStream onto a <video>. Describing either in
 * vnodes would mean either re-implementing the QR generator's output or
 * hand-diffing several hundred <rect>s on every progress tick. Instead the
 * view says "this element's content is that node" and the diff steps aside.
 *
 * Identity-checked, so a re-render with the same node is a no-op and the QR
 * does not flicker.
 *
 * @param {Element} el
 * @param {Node} node
 */
function adoptInto(el, node) {
  if (el.firstChild === node && el.childNodes.length === 1) return
  el.replaceChildren(node)
}

/**
 * @param {VNode | string} vnode
 * @returns {Node}
 */
function create(vnode) {
  if (typeof vnode === 'string') return document.createTextNode(vnode)

  // <svg> subtrees need the SVG namespace or they render as unknown elements.
  // The QR code is injected as an already-built element (see renderQR), not
  // described in vnodes, so in practice this only covers small inline icons.
  const el = SVG_TAGS.has(vnode.tag)
    ? document.createElementNS(SVG_NS, vnode.tag)
    : document.createElement(vnode.tag)

  applyProps(el, vnode.props, {})
  for (const child of vnode.children) el.appendChild(create(child))
  return el
}

const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'g'])

// Reflected as IDL properties rather than attributes: setting the attribute
// either does nothing useful (`value` after a user has typed) or requires the
// presence/absence dance that `disabled`/`hidden` need.
const BOOLEAN_PROPS = new Set(['disabled', 'hidden', 'checked', 'muted'])

/**
 * @param {Element} el
 * @param {Record<string, any>} props
 * @param {Record<string, any>} prev
 */
function applyProps(el, props, prev) {
  for (const name of new Set([...Object.keys(prev), ...Object.keys(props)])) {
    if (name === 'key' || name === 'children') continue

    const value = props[name]
    const before = prev[name]
    if (value === before) continue

    // Handlers live on the element rather than going through addEventListener,
    // so a re-render replaces the previous one instead of stacking a second
    // copy on top of it. That stacking is a real hazard here: render runs on
    // every progress tick, and a "send" button with two hundred click
    // listeners would send two hundred manifests.
    if (name.startsWith('on')) {
      // @ts-expect-error -- indexing the element by handler name is the point.
      el[name.toLowerCase()] = typeof value === 'function' ? value : null
      continue
    }

    if (name === 'style') {
      applyStyle(/** @type {HTMLElement} */ (el), value ?? {}, before ?? {})
      continue
    }

    if (BOOLEAN_PROPS.has(name)) {
      // @ts-expect-error -- boolean IDL attribute.
      el[name] = Boolean(value)
      continue
    }

    if (name === 'value') {
      const input = /** @type {HTMLInputElement} */ (el)
      const text = value == null ? '' : String(value)
      // Guarded: writing an identical value still moves the caret to the end,
      // which is maddening if a re-render lands mid-word.
      if (input.value !== text) input.value = text
      continue
    }

    if (value === null || value === undefined || value === false) el.removeAttribute(name)
    else el.setAttribute(name, value === true ? '' : String(value))
  }
}

/**
 * Styles are set as individual properties, never by assigning `cssText`, so
 * that custom properties work. `--progress` on the transfer bar is the reason
 * this branch exists at all: `setProperty` is the only way to write one.
 *
 * @param {HTMLElement} el
 * @param {Record<string, string>} style
 * @param {Record<string, string>} prev
 */
function applyStyle(el, style, prev) {
  for (const name of Object.keys(prev)) {
    if (!(name in style)) el.style.removeProperty(name)
  }
  for (const [name, value] of Object.entries(style)) {
    if (prev[name] !== value) el.style.setProperty(name, value)
  }
}
