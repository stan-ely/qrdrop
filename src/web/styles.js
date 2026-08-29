/**
 * The `<qr-drop>` component's full stylesheet, as a JS string.
 *
 * A real `.css` import would be simpler, but constraint 3 rules it out:
 * `exports["./web"]` in package.json points a consumer straight at raw ESM,
 * with no bundler guaranteed to sit between `npm install` and a working
 * import. A `.css` import needs one; a template literal does not. This is
 * also why the stylesheet used to live inline inside src/web/element.js's
 * TEMPLATE -- moving it here just gets the ~250 lines of it out of a
 * behaviour file and into one whose only job is to be read as CSS.
 *
 * `tokensCSS(':host')` supplies every custom property this file reads
 * (`--sp-*`, `--r-*`, `--fs-*`, colours, shadows, focus ring) -- see
 * src/web/tokens.js for the palette and the contrast reasoning behind it.
 *
 * Class names below are a contract with src/web/view.js, which renders the
 * markup these rules target. Element ids (`#qr`, `#sas`, `#manual-code`, ...)
 * stay the e2e contract described in element.js; classes are free to be
 * whatever reads best, since nothing outside this component depends on them.
 */
import { tokensCSS } from './tokens.js'

export const STYLES = `
:host {
  all: initial;
  display: block;
  font: var(--fs-0)/var(--lh-body) var(--font-sans);
  -webkit-font-smoothing: antialiased;
  color: var(--text);
}

${tokensCSS(':host')}

*, *::before, *::after { box-sizing: border-box; }

/* ---- step rail: Connect · Verify · Transfer ----
 * Sits above .card, hidden on the choose screen (there is nothing to show
 * progress through yet) and fully "done" on a successful outcome. Compact
 * and horizontal by design -- it is a sense of place, not a wizard nav. */
.steps {
  display: flex;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-4);
  padding: 0;
  list-style: none;
}

.step {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--surface-raised);
  color: var(--muted);
  font-size: var(--fs--1);
  font-weight: 500;
}

.step::before {
  content: '';
  width: 0.5rem;
  height: 0.5rem;
  border-radius: var(--r-full);
  background: var(--line-strong);
  flex: none;
}

.step.is-active {
  background: var(--accent-soft);
  color: var(--text);
}
.step.is-active::before { background: var(--accent); }

.step.is-done { color: var(--text); }
.step.is-done::before { background: var(--ok); }

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
  padding: var(--sp-6);
}

.card + .card { margin-top: var(--sp-5); }

h2 {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-1);
  line-height: var(--lh-tight);
  font-weight: 600;
}

/* The screen's <h2> takes focus on every transition (see element.js's
 * _afterRender) so assistive tech announces the new screen instead of
 * leaving focus stranded on a button that just went hidden. outline: none
 * on plain :focus keeps that programmatic move visually silent; :focus-visible
 * still shows a ring for anyone who then tabs away and back with a keyboard. */
/* The heading takes focus on every screen change so assistive tech announces
   the new screen instead of leaving focus stranded. It is tabindex="-1", so
   it is never reachable by Tab and a person navigating by keyboard can never
   land here by accident -- which is why it carries no focus ring in either
   state. A ring here is actively misleading: h2 is a block element, so it
   paints a full-width rounded box around the line, and a rounded box around
   text is the universal look of an editable field. Users tried to type in it. */
h2:focus, h2:focus-visible { outline: none; box-shadow: none; }

/* ---- buttons ---- */
.btn {
  font: inherit;
  font-weight: 500;
  font-size: var(--fs-0);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, transform 0.05s;
}

.btn:hover { border-color: var(--muted); background: var(--surface-raised); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.btn:disabled { opacity: 0.5; cursor: default; transform: none; }

.btn.primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}
.btn.primary:hover { background: var(--accent-hover); }

.btn.ghost {
  border-color: transparent;
  background: none;
  color: var(--muted);
}
.btn.ghost:hover { background: var(--surface-raised); color: var(--text); }

.btn.small {
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs--1);
}

.choices { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
.choices .btn { flex: 1 1 12rem; }

/* The beam entry point on the choose screen: deliberately smaller and looser
 * than .choices above it, so the eye lands on "Send a file" / "Receive a
 * file" first. A subordinate row, not a third equally-weighted button --
 * the network path is strictly better whenever there is a network. */
.beam-entry { margin-top: var(--sp-5); }
.choices.secondary { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-2); }
/* Bordered, unlike every other .ghost in the component. Ghost means "the way
 * out" elsewhere -- Cancel, Decline -- and a borderless control is legible
 * enough when the user already knows they want it. These two are the opposite:
 * an entry point into a mode nobody is looking for yet, and without an edge
 * they read as centred body text rather than as something clickable, which is
 * how they first rendered. Subordinate by size and colour, not by being
 * invisible. */
.choices.secondary .btn {
  flex: 1 1 12rem;
  font-size: var(--fs--1);
  border-color: var(--line);
}
.choices.secondary .btn:hover { border-color: var(--line-strong); }

/* ---- unmissable "this is not encrypted" banner, both beam screens ----
 * Reuses --warn/--warn-soft rather than a new colour: those tokens are
 * already the "heed this" pair everywhere else in the component (the
 * too-large outcome), and a second warning colour would just make the
 * palette bigger without making this one easier to notice. A left border
 * rather than a full outline keeps it from reading as an error box (--bad),
 * which this is not -- it is a permanent property of the mode, not a fault. */
.warn-banner {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-left: 3px solid var(--warn);
  border-radius: var(--r-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-weight: 600;
  font-size: var(--fs--1);
}

/* ---- drop zone: drag-and-drop / paste entry point for a send ---- */
.dropzone {
  border: 2px dashed var(--line-strong);
  border-radius: var(--r-md);
  padding: var(--sp-7) var(--sp-4);
  text-align: center;
  color: var(--muted);
  transition: border-color 0.15s, background 0.15s;
}

.dropzone.is-dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

/* Always light, whatever the page theme: scanners read dark-on-light best. */
.qr {
  background: #ffffff;
  border-radius: var(--r-sm);
  padding: var(--sp-3);
  width: min(16rem, 100%);
  margin: 0 auto var(--sp-5);
}
.qr svg { display: block; width: 100%; height: auto; }

/* Same "always light" reasoning as .qr above, and the same quiet-zone padding
 * -- a beam frame is read by the exact same class of scanner as the pairing
 * QR, so it needs the same white margin around the modules to lock on. */
.beam-stage {
  background: #ffffff;
  border-radius: var(--r-sm);
  padding: var(--sp-3);
  width: min(16rem, 100%);
  margin: 0 auto var(--sp-4);
}

/* web/beam.js paints one canvas pixel per QR module and leaves the CSS to
 * blow it up to display size (see startBeamSend's canvas). image-rendering:
 * pixelated is not decorative here -- the default smoothing algorithm blurs
 * those hard module edges into a soft gradient a scanner cannot binarize, so
 * an un-pixelated beam looks fine to a person and is unreadable to a camera. */
.beam-canvas {
  display: block;
  width: 100%;
  height: auto;
  image-rendering: pixelated;
}

.beam-controls {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.beam-controls select {
  font: inherit;
  font-size: var(--fs--1);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--bg);
  color: var(--text);
}

/* ---- camera scanner + corner-bracket viewfinder ----
 * .scanner-frame is a plain positioned box; .viewfinder draws its four
 * corner brackets with box-shadow slivers rather than four extra elements,
 * so it can sit over the <video> without intercepting pointer events. */
.scanner-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  margin-bottom: var(--sp-4);
}

.scanner {
  width: 100%;
  height: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  background: #000;
  border-radius: var(--r-sm);
  display: block;
}

.viewfinder {
  position: absolute;
  inset: 12%;
  pointer-events: none;
  border-radius: var(--r-sm);
}
.viewfinder::before, .viewfinder::after,
.viewfinder > span::before, .viewfinder > span::after {
  content: '';
  position: absolute;
  width: 1.5rem;
  height: 1.5rem;
  border: 3px solid #fff;
}
.viewfinder::before { top: 0; left: 0; border-right: none; border-bottom: none; }
.viewfinder::after { top: 0; right: 0; border-left: none; border-bottom: none; }
.viewfinder > span::before { bottom: 0; left: 0; border-right: none; border-top: none; }
.viewfinder > span::after { bottom: 0; right: 0; border-left: none; border-top: none; }

/* ---- SAS tiles: emoji above word, so the pair can be read aloud ---- */
.sas-grid {
  display: flex;
  gap: var(--sp-3);
  flex-wrap: wrap;
  justify-content: center;
  margin: var(--sp-5) 0;
}

.sas-tile {
  flex: 1 1 6rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-3);
  background: var(--surface-raised);
  border-radius: var(--r-md);
}

.sas-emoji {
  font-size: var(--fs-3);
  line-height: 1;
  /* Emoji fonts vary; give the glyph room so it cannot be mistaken. */
}

.sas-word {
  font-size: var(--fs--1);
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* ---- code block + copy button ---- */
.code-row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

.code {
  flex: 1 1 auto;
  display: block;
  font-family: var(--font-mono);
  font-size: var(--fs--1);
  word-break: break-all;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: var(--sp-3);
}

/* ---- progress bar ----
 * .bar-fill's width is driven by a --progress custom property set via
 * .style.setProperty from element.js on every progress event -- this is the
 * inline style write that keeps style-src 'unsafe-inline' in the site's CSP
 * (see scripts/build-site.mjs). Do not replace it with a class toggle; there
 * is no finite set of classes for a continuously-varying percentage. */
.bar {
  height: 0.5rem;
  background: var(--line);
  border-radius: var(--r-full);
  overflow: hidden;
  margin: var(--sp-4) 0 var(--sp-3);
}

.bar-fill {
  height: 100%;
  width: var(--progress, 0%);
  background: var(--accent);
  border-radius: var(--r-full);
  transition: width 0.2s ease-out;
}

/* Indeterminate: pairing has no percentage to report, so a shimmering fixed
 * segment reads as "working" instead of the old static "Starting…" text. */
.bar.indeterminate .bar-fill {
  width: 40%;
  animation: qrdrop-shimmer 1.4s ease-in-out infinite;
}

@keyframes qrdrop-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

/* ---- outcome banner: a failed transfer must not look like a success ---- */
.outcome {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  margin-bottom: var(--sp-4);
}

.outcome .glyph { font-size: var(--fs-2); line-height: 1; flex: none; }

.outcome.ok { background: var(--ok-soft); color: var(--ok); }
.outcome.bad { background: var(--bad-soft); color: var(--bad); }
.outcome.warn { background: var(--warn-soft); color: var(--warn); }

.status { color: var(--muted); font-size: var(--fs--1); margin: var(--sp-2) 0 0; }
.note { color: var(--muted); font-size: var(--fs--1); }
.filename { font-weight: 600; margin: 0; word-break: break-all; }

.error {
  margin-top: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm);
  border: 1px solid var(--bad);
  background: var(--bad-soft);
  color: var(--bad);
  font-size: var(--fs--1);
}

summary {
  cursor: pointer;
  color: var(--muted);
  font-size: var(--fs--1);
}

#manual-form { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }

input[type="text"] {
  flex: 1;
  font: inherit;
  font-size: var(--fs--1);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--bg);
  color: var(--text);
  min-width: 0;
}
input[type="text"]:focus-visible { outline: none; box-shadow: var(--focus-ring); }

@media (max-width: 30rem) {
  .card { padding: var(--sp-4); }
  .steps { gap: var(--sp-1); }
  .step { padding: var(--sp-1) var(--sp-2); font-size: 0.7rem; }
  .sas-grid { gap: var(--sp-2); }
  .sas-tile { flex: 1 1 40%; }
  .sas-emoji { font-size: var(--fs-2); }
}

/* Absent from the pre-restyle stylesheet entirely: every transition and the
 * pairing shimmer are motion, and someone who has asked the OS to reduce
 * motion should get a UI that still communicates state (colour, text) without
 * moving anything to do it. */
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0s !important; animation-duration: 0s !important; animation-iteration-count: 1 !important; }
  .bar.indeterminate .bar-fill { animation: none; width: 40%; }
}
`
