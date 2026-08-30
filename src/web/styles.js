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
/*
 * The component fills the box it is given, and does NOT claim the viewport.
 *
 * \`block-size: 100%\` rather than \`100dvh\`, which is the obvious thing to
 * write and is wrong here: on the deployed site <qr-drop> is one row of a page
 * grid that also holds a heading and a footer (site/index.html), so a
 * component sized to the whole viewport would overflow it by exactly the
 * height of that chrome -- which is the bug this layout exists to fix,
 * reintroduced one level up. The page owns the viewport; the component owns
 * its row. site/styles.css is where \`100dvh\` is allowed to appear.
 *
 * It also degrades correctly for the embedding case package.json's
 * \`exports["./web"]\` exists to serve: \`height: 100%\` inside a parent of
 * auto height resolves to auto, so a consumer who drops <qr-drop> into an
 * ordinary flowing page gets a component the height of its content, exactly
 * as before. Nothing about this requires the host page to cooperate.
 *
 * min-block-size: 0 because this is itself a grid item on that page, and a
 * grid item refuses to shrink below its content without it -- the single most
 * common reason a "fixed height" layout silently keeps growing.
 *
 * A flex column rather than a grid with named rows, which was tried first and
 * does not survive contact with render(): the shadow root's children are the
 * step rail, all eight screens, and the error banner, of which the rail and
 * the banner are conditional and seven of the screens are \`hidden\`. The
 * number of laid-out children is therefore 1, 2, or 3 depending on state, and
 * a three-row template silently puts the card in the wrong row whenever the
 * rail is absent -- which is every beam screen. Flex asks nothing about how
 * many children there are.
 */
:host {
  all: initial;
  display: flex;
  flex-direction: column;
  block-size: 100%;
  min-block-size: 0;
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
  width: var(--sp-2);
  height: var(--sp-2);
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

/*
 * The live screen. Exactly one .card is ever laid out -- screen() renders all
 * eight and marks seven \`hidden\` -- so this is the component's flexible row,
 * and it is split into a body that may give up space and an action bar that
 * may not.
 *
 * That split is the whole fix. A beam receiver used to render its heading,
 * warning, camera, filename and two paragraphs of notes above Accept, in one
 * flat column, and on a phone Accept landed 99px past the bottom of the
 * screen: the tester read a camera with nothing under it as a failed scan and
 * put the phone down. Buttons are no longer laid out after content -- they are
 * laid out in a row content cannot reach, so "below the fold" stops being a
 * state this component can express.
 */
.card {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-block-size: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
  padding: var(--sp-6);
  gap: var(--sp-4);
}

/*
 * Restores what \`display: flex\` above just broke.
 *
 * screen() renders all eight screens and marks seven \`hidden\`, and \`hidden\`
 * hides them by exactly one mechanism: \`[hidden] { display: none }\` in the UA
 * stylesheet. Any author \`display\` on the same element wins on specificity, so
 * the moment .card gained one, all eight screens laid themselves out in a
 * column -- a 4300px page inside a component that had just been told to be
 * exactly one viewport tall.
 *
 * This is the same edit that has to be made for \`<dialog>\` in
 * site/styles.css, and for the same reason. Anywhere a rule sets \`display\` on
 * something the platform hides with \`display: none\`, the hiding has to be
 * said again.
 */
.card[hidden] { display: none; }

/* The card body: the media slot and the copy slot, stacked. */
.card-body {
  flex: 1 1 auto;
  min-block-size: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

/* The two halves of a card body. .card-media holds the screen's one visual
 * thing -- QR, camera, SAS tiles -- and .card-copy everything else. They stack
 * at most sizes and sit side by side on a wide, short window; see the media
 * query further down. The slot exists in the markup at every size so that the
 * switch is a change of direction and nothing else.
 *
 * The scroll lives on .card-copy rather than on .card-body, or the two columns
 * would scroll as one and take the camera with them. */
/* flex-shrink: 4, so the media gives up space roughly four times as readily as
 * the words beside it. Equal shrink is the default and is wrong here: the two
 * had similar natural heights, so both gave up the same amount, and since the
 * copy is the half that can scroll it was the half that ended up scrolling --
 * a camera holding its full size above a clipped sentence. The media has a
 * floor it cannot pass (a QR below ~7rem stops being scannable, a viewfinder
 * below 8rem stops being aimable), so letting it yield first costs nothing
 * until that floor and buys the copy every pixel up to it. */
.card-media { display: flex; flex-direction: column; min-block-size: 0; flex: 0 4 auto; }
.card-copy {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

/*
 * flex: none, so it keeps its height while .card-body above gives up whatever
 * is needed. The separator is drawn only when the body can scroll away
 * underneath it, which is what makes the bar read as pinned rather than as
 * the end of the content.
 */
.card-actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  align-items: center;
  padding-block-start: var(--sp-4);
  border-block-start: 1px solid var(--line);
}

/* The primary action leads and takes the room; the ghost escape hatch does
 * not stretch to match it. Reusing .choices' flex basis so a button in the bar
 * and a button in the body are visibly the same object. */
.card-actions .btn { flex: 1 1 12rem; }
.card-actions .btn.ghost { flex: 0 1 auto; }

/* An action bar with nothing in it draws a rule across the card for no
 * reason -- the choose screen has no cancel and no primary. */
.card-actions:empty { display: none; }

/*
 * The sheet: the component's one <dialog>, owned by element.js and adopted by
 * the view (see the .dialog-host wrapper in view.js).
 *
 * .dialog-host is display: contents so that wrapping the dialog in a <div> the
 * \`adopt\` prop needs does not put a flex item in :host's column. The dialog
 * itself is out of flow the moment showModal() runs, but the wrapper is not,
 * and an empty flex child still eats the column's gap.
 *
 * display goes on [open], never on .sheet. A closed <dialog> is hidden by
 * exactly one thing -- \`display: none\` in the UA stylesheet -- and any author
 * \`display\` beats it, which renders the sheet permanently, in flow, at the
 * bottom of the component. That mistake cost 4300px of page height once
 * already in this file's sibling, site/styles.css; it is written down in both
 * places because it looks correct in a stylesheet either way.
 *
 * No z-index: showModal() promotes the element to the browser's top layer,
 * which is above every stacking context by definition. That immunity is the
 * reason this is a real <dialog> rather than a positioned div -- the layout it
 * sits inside is made of fixed-height, overflow-hidden boxes, and any
 * in-flow overlay would be clipped by one of them.
 */
.dialog-host { display: contents; }

.sheet {
  max-inline-size: min(30rem, calc(100vw - var(--sp-6)));
  max-block-size: min(80dvh, calc(100dvh - var(--sp-6)));
  inline-size: 100%;
  margin: auto;
  padding: var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  flex-direction: column;
  gap: var(--sp-4);
  font: var(--fs-0)/var(--lh-body) var(--font-sans);
}

.sheet[open] { display: flex; }

.sheet::backdrop { background: rgb(0 0 0 / 0.45); }

.sheet-title {
  margin: 0;
  font-size: var(--fs-1);
  line-height: var(--lh-tight);
  font-weight: 600;
}
/* No ring, for the reason already written above h2:focus -- a rounded box
 * around a line of text is the universal look of an editable field, and users
 * tried to type in it. The sheet heading takes focus on open (see
 * dialogContent) precisely so Accept does not, so it is a focus target that is
 * never Tab-reachable, and the ring would be misleading rather than helpful.
 * This rule exists only because .sheet-title would otherwise out-specify that
 * one; it says the same thing. */
.sheet-title:focus, .sheet-title:focus-visible { outline: none; box-shadow: none; }

/* The one box in the component allowed to scroll. Long copy lives here
 * precisely so that it does not have to fit on a screen that cannot grow. */
.sheet-body {
  overflow-y: auto;
  min-block-size: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.sheet-body p { margin: 0; color: var(--muted); font-size: var(--fs--1); }
.sheet-body .filename { color: var(--text); font-size: var(--fs-0); }

.sheet-actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}
.sheet-actions .btn { flex: 1 1 10rem; }
.sheet-actions .btn.ghost { flex: 0 1 auto; }

/*
 * The toast: one transient line, for a change the user did not cause.
 *
 * position: absolute against :host, NOT fixed against the viewport. Fixed was
 * the first attempt and is wrong on the deployed site: the viewport's bottom
 * edge is the page's, not the component's, so the toast landed on top of the
 * site footer's links. Absolute anchors it to the component, which is the
 * thing it is reporting about. Nothing clips it -- :host sets no overflow, and
 * only .card-body does, which is not an ancestor of this.
 *
 * Sitting just above the card's bottom edge puts it directly over the action
 * bar, which is where the eye already is.
 *
 * pointer-events: none because it must never intercept a tap meant for the
 * button underneath it. It says something; it is not something to use.
 */
:host { position: relative; }

.toast {
  position: absolute;
  inset-block-end: var(--sp-4);
  inset-inline: var(--sp-4);
  margin-inline: auto;
  inline-size: fit-content;
  max-inline-size: calc(100% - var(--sp-6));
  z-index: var(--z-toast);
  pointer-events: none;
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--r-full);
  background: var(--text);
  color: var(--surface);
  font-size: var(--fs--1);
  font-weight: 500;
  box-shadow: var(--shadow-1);
  animation: toast-in var(--dur-slow) ease-out;
}

@keyframes toast-in {
  from { opacity: 0; transform: translateY(var(--sp-3)); }
  to { opacity: 1; transform: none; }
}

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
  transition: border-color var(--dur-base), background var(--dur-base), transform var(--dur-fast);
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

/* ---- callout boxes: info, warn, danger variants ----
 * A left border rather than a full outline keeps boxed guidance from reading
 * as an error the way a bordered box always would. Colour and weight carry
 * the meaning; the left border is shared across all levels. */
.callout {
  border-left: 3px solid;
  font-weight: 600;
  font-size: var(--fs--1);
}

/* Variants with backgrounds (used for boxed/emphasized content) */
.callout.info {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm);
  border-left-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.callout.warn {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm);
  border-left-color: var(--warn);
  background: var(--warn-soft);
  color: var(--warn);
}

.callout.danger {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm);
  border-left-color: var(--bad);
  background: var(--bad-soft);
  color: var(--bad);
}

/* ---- drop zone: drag-and-drop / paste entry point for a send ---- */
.dropzone {
  border: 2px dashed var(--line-strong);
  border-radius: var(--r-md);
  padding: var(--sp-7) var(--sp-4);
  text-align: center;
  color: var(--muted);
  transition: border-color var(--dur-base), background var(--dur-base);
}

.dropzone.is-dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

/* Always light, whatever the page theme: scanners read dark-on-light best. */
/*
 * Sized from its HEIGHT, with aspect-ratio deriving the width -- the reverse
 * of the obvious inline-size cap this used to have.
 *
 * A QR is square, so whichever axis is scarcer has to be the one that governs.
 * On a phone that is the height: a 16rem-wide code demands 16rem of vertical
 * space unconditionally, and on the send screen that was 322px of a card that
 * did not have it, pushing the rest of the screen into a scroll. Driving the
 * block size instead lets the code shrink when the card is short and sit at
 * its full size when it is not, with the width following rather than leading.
 *
 * The floor matters: below roughly 7rem the modules of a version-6 code get
 * small enough that a phone camera at arm length stops locking on, and a QR
 * nobody can scan is not a smaller QR, it is a broken screen.
 */
.qr {
  background: var(--qr-quiet-zone);
  border-radius: var(--r-sm);
  padding: var(--sp-3);
  flex: 0 1 auto;
  block-size: min(16rem, 100%);
  min-block-size: 7rem;
  aspect-ratio: 1;
  max-inline-size: 100%;
  margin: 0 auto var(--sp-5);
}
.qr svg { display: block; inline-size: 100%; block-size: 100%; }

/* Same "always light" reasoning as .qr above, and the same quiet-zone padding
 * -- a beam frame is read by the exact same class of scanner as the pairing
 * QR, so it needs the same white margin around the modules to lock on. */
.beam-stage {
  background: var(--qr-quiet-zone);
  border-radius: var(--r-sm);
  padding: var(--sp-3);
  flex: 0 1 auto;
  block-size: min(16rem, 100%);
  min-block-size: 7rem;
  aspect-ratio: 1;
  max-inline-size: 100%;
  margin: 0 auto var(--sp-4);
}

/* web/beam.js paints one canvas pixel per QR module and leaves the CSS to
 * blow it up to display size (see startBeamSend's canvas). image-rendering:
 * pixelated is not decorative here -- the default smoothing algorithm blurs
 * those hard module edges into a soft gradient a scanner cannot binarize, so
 * an un-pixelated beam looks fine to a person and is unreadable to a camera. */
.beam-canvas {
  display: block;
  inline-size: 100%;
  block-size: 100%;
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
/*
 * The camera is the one element allowed to give up space, and it is the reason
 * everything else used to be pushed off the screen.
 *
 * \`width: 100%; aspect-ratio: 1\` with nothing capping it made this an
 * unconditional 390px square on a 390px phone -- the tallest thing in the app,
 * demanding its full height before any of the text or buttons under it were
 * given a pixel. \`flex: 1 1 auto\` with \`min-block-size\` puts that the other
 * way round: the frame takes the space the card has left after the copy and
 * the action bar are served, down to a floor below which a viewfinder stops
 * being usable to aim with. The square is now a preference, not a demand --
 * \`object-fit: cover\` on the video means a shorter frame crops the picture
 * rather than distorting it, which is what a camera viewfinder does anyway.
 */
.scanner-frame {
  position: relative;
  flex: 1 1 auto;
  inline-size: 100%;
  aspect-ratio: 1;
  min-block-size: 8rem;
  max-block-size: 100%;
  margin-bottom: var(--sp-4);
}

.scanner {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: var(--scan-bg);
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
  width: var(--sp-5);
  height: var(--sp-5);
  border: 3px solid var(--scan-line);
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
  transition: width var(--dur-slow) ease-out;
}

/* Indeterminate: pairing has no percentage to report, so a shimmering fixed
 * segment reads as "working" instead of the old static "Starting…" text. */
.bar.indeterminate .bar-fill {
  width: 40%;
  animation: qrdrop-shimmer var(--dur-shimmer) ease-in-out infinite;
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

/* ---- network path: which route the bytes actually took ----
   A pill plus one explanatory line, sitting next to the SAS confirm and the
   Accept button. Styled flat and unclickable on purpose: it is the answer to
   "is this costing me data", not a control, and anything button-shaped beside
   a safety gesture is something people learn to click through. Same reasoning
   as .callout above -- a permanent property of the connection, not a
   fault. */
.path-info { margin: var(--sp-3) 0; }

.path-badge {
  display: inline-block;
  margin: 0 0 var(--sp-1);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--r-full);
  font-size: var(--fs--1);
  font-weight: 600;
}

.path-badge.local { background: var(--ok-soft); color: var(--ok); }
.path-badge.direct { background: var(--accent-soft); color: var(--accent); }
.path-badge.relay { background: var(--warn-soft); color: var(--warn); }
.path-badge.unknown { background: var(--surface-raised); color: var(--muted); }

/* TEMPORARY, ?debug=path only -- the raw candidate-pair dump. Scrolls in its
   own box so a long dump cannot make the page scroll sideways. Remove along
   with collectPathEvidence. */
.path-debug {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--surface-raised);
  color: var(--muted);
  font-size: 0.7rem;
  line-height: 1.4;
  max-height: 18rem;
  overflow: auto;
  white-space: pre;
}


.status { color: var(--muted); font-size: var(--fs--1); margin: var(--sp-2) 0 0; }
.note { color: var(--muted); font-size: var(--fs--1); }
.filename { font-weight: 600; margin: 0; word-break: break-all; }

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
  .card { padding: var(--sp-4); gap: var(--sp-3); }
  .card-body, .card-copy { gap: var(--sp-3); }
  .card-actions { padding-block-start: var(--sp-3); }
  .steps { gap: var(--sp-1); }
  .step { padding: var(--sp-1) var(--sp-2); font-size: 0.7rem; }
  .sas-grid { gap: var(--sp-2); }
  .sas-tile { flex: 1 1 40%; }
  .sas-emoji { font-size: var(--fs-2); }
}

/*
 * The height counterpart, and the query this stylesheet did not have.
 *
 * Every breakpoint here used to be about width, which is the axis a phone
 * makes obvious and the one this component was never actually short of. The
 * failure mode was always vertical -- a wide, short laptop window has plenty
 * of room for the text and none for the padding around it, and the first thing
 * to go was whatever sat at the bottom of the card. Trading generous spacing
 * for a screen that fits is the right way round: the padding is a comfort and
 * the content is the point.
 */
@media (max-height: 46rem) {
  .card { padding: var(--sp-4); gap: var(--sp-3); }
  /* The rail is "a sense of place, not a wizard nav" (see its own comment), and
   * on a 620px window it was spending ~50px of a 258px content box on that
   * sense. The screen heading says where you are; the rail only said it more
   * decoratively. It is the most expendable thing on a short screen, so it is
   * the first to go. */
  .steps { display: none; }
  /* Same trade as the narrow-width rule below: the route is stated by the
   * toast and named by the badge, so the sentence explaining it is the third
   * telling and the one that can go when height is scarce. */
  .path-info .note { display: none; }
  .card-body { gap: var(--sp-3); }
  .card-actions { padding-block-start: var(--sp-3); }
  .steps { margin-bottom: var(--sp-3); }
  .outcome { padding: var(--sp-3); }
  .qr, .beam-stage { block-size: min(12rem, 100%); }
}

/*
 * Wide and short: media beside the words instead of above them.
 *
 * A laptop in landscape is short of height with several hundred horizontal
 * pixels to spare, so a single column scrolls next to an empty margin -- the
 * layout refusing to use the axis it has plenty of. The send screen scrolled
 * 303px internally in exactly that window.
 *
 * THIS QUERY MUST MATCH the one in site/styles.css, which widens the page
 * column so these two have somewhere to go. A media query cannot read a custom
 * property, so unlike every other shared value here these are two copies that
 * have to agree.
 */
@media (min-width: 60rem) and (max-height: 62rem) {
  .card-body.has-media { flex-direction: row; align-items: stretch; gap: var(--sp-5); }
  .card-media { flex: 0 1 22rem; align-items: center; }
  .card-copy { flex: 1 1 20rem; }

  /* Height stops being the scarce axis in two columns, so the QR goes back to
   * filling the width it is given. */
  .qr, .beam-stage { block-size: auto; inline-size: 100%; margin-inline: 0; }
}

/*
 * The SAS tiles on a small phone, which is the one screen where trimming
 * padding was not enough.
 *
 * Four tiles at their full size, a two-line heading and the "if these differ"
 * warning together overflow a 390x844 viewport, and the warning is the half
 * that was being cut -- the sentence that tells a person what the screen is
 * FOR. Shrinking the tiles is the right trade: the emoji is decoration and the
 * word underneath is the content (see view.js), so the tile can lose a few
 * millimetres without losing anything a person reads aloud.
 */
@media (max-width: 26rem) {
  .sas-tile { padding: var(--sp-2); }
  .sas-emoji { font-size: var(--fs-1); }
  h2 { font-size: var(--fs-0); }

  /* The path badge keeps its label and loses its explanatory sentence. On this
   * screen that sentence is the third time the same fact is stated -- the
   * toast announces the route, the badge names it, and this explains it -- and
   * it was costing 40px that the "if these differ" warning needed. The badge
   * itself stays: losing the fact would be a different and worse trade. */
  .path-info .note { display: none; }
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
