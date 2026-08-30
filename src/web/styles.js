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
import { tokensCSS, BREAKPOINT_WIDE, BREAKPOINT_SHORT } from './tokens.js'

/**
 * Core `.sheet` (dialog) CSS rules, extracted from src/web/styles.js and
 * site/styles.css so there is one definition, not two hand-kept copies.
 *
 * Used by both the component's shadow-DOM stylesheet and the site's main
 * stylesheet (injected at build time by scripts/build-site.mjs).
 *
 * @param {string} maxInlineSize The max-inline-size value; component uses
 *   '30rem' while the site uses 'var(--col)' for wider dialogs.
 * @returns {string}
 */
export function sheetCSS(maxInlineSize = '30rem') {
  return `
.sheet {
  max-inline-size: min(${maxInlineSize}, calc(100vw - var(--sp-6)));
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
`
}

/**
 * Button ghost variant CSS rules, extracted so there is one definition for
 * both the component's buttons and the site's .chip element.
 *
 * Used by both the component's shadow-DOM stylesheet and the site's main
 * stylesheet (injected at build time by scripts/build-site.mjs).
 *
 * @returns {string}
 */
export function buttonCSS() {
  return `
.btn.ghost {
  border-color: transparent;
  background: none;
  color: var(--muted);
}
.btn.ghost:hover { background: var(--surface-raised); color: var(--text); }
`
}

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
 * does not survive contact with render(): the shadow root's children are all
 * eight screens, the dialog host (\`display: contents\`, so it lays out
 * nothing) and the toast (absolutely positioned, so it lays out nothing
 * either), of which seven screens are \`hidden\`. The number of laid-out
 * children is therefore exactly one, but it was 1, 2 or 3 when the step rail
 * and the error banner were still root children, and a three-row template
 * silently put the card in the wrong row whenever the rail was absent. Flex
 * asks nothing about how many children there are, which is why it survived
 * both of those elements moving.
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
 *
 * Three segments of a hairline along the card's top edge, and it is a hairline
 * rather than the row of labelled pills it used to be for one reason above the
 * rest: it costs no height at all.
 *
 * The labelled version sat OUTSIDE .card, as a sibling, and was hidden on the
 * choose screen and on both beam screens. So it appeared and disappeared during
 * ordinary use, and every appearance moved the card and everything in it down
 * by ~50px -- most visibly on the way into beam, where the whole layout jumped
 * as the sheet closed. A conditional element in the block flow cannot not do
 * that. This one is absolutely positioned inside the card, so it contributes
 * zero height whether it is there or not, and the jump is gone by construction
 * rather than by remembering to reserve a placeholder.
 *
 * The second reason is that it never survived being short of room. Under
 * BREAKPOINT_SHORT the rail collapsed to three 8px dots via \`font-size: 0\`,
 * which the comment beside it described as "the sr-only clip technique
 * preserving them for assistive tech" -- it is not that, it has no clip and no
 * overflow, and text at zero size is read by nothing. So on the viewport where
 * it mattered most the rail was three identical grey dots to a sighted user and
 * absent to everyone else. The labels here are genuinely clipped (view.js
 * passes SR_ONLY_STYLE), so they read the same at every size, and there is one
 * appearance instead of two.
 *
 * The inline inset is --r-lg, the card's own corner radius, because that is
 * exactly the distance the rounded corner curves away from the top edge -- a
 * 3px bar run to inset-inline: 0 pokes out past the curve at both ends.
 * Naming the radius rather than a literal keeps the two tied if it changes.
 *
 * Not rendered at all on the beam screens -- see stepRail() in view.js for why
 * inventing a middle step for a mode that has no handshake would be the UI
 * telling the same lie core/beam.js refuses to tell about encryption. That it
 * can simply be absent, with no layout consequence, is what makes keeping that
 * position free.
 */
.rail {
  position: absolute;
  inset-block-start: 0;
  inset-inline: var(--r-lg);
  display: flex;
  gap: 2px;
  block-size: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rail-seg {
  flex: 1 1 0;
  border-radius: var(--r-full);
  background: var(--line);
  transition: background var(--dur-slower) var(--ease-out);
}

/* The third time this note has had to be written in this codebase, after
 * .card[hidden] and .sheet[open]: the rule above sets an author \`display\`, and
 * an author \`display\` beats the UA stylesheet's [hidden] { display: none } on
 * specificity. Without this the beam screens -- which render the rail hidden
 * rather than absent, so its siblings keep their positions and the adopted
 * canvas survives -- would show a full step rail for a mode that has no steps. */
.rail[hidden] { display: none; }

.rail-seg.is-active { background: var(--accent); }
.rail-seg.is-done { background: var(--ok); }

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
  /* The containing block for .rail above, which is positioned against this
   * card's top edge rather than against the component. Anchoring it to :host
   * would put it above the card on the screens where the card is not the
   * component's full height. */
  position: relative;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
  padding: var(--sp-6);
  gap: var(--sp-4);
}

/*
 * The entrance runs on the card's CONTENTS, not on the card.
 *
 * It used to be \`.card:not([hidden]) { animation: screen-in }\` with a keyframe
 * that only moved opacity, and between those two facts it animated the one
 * thing on screen that had not changed. The card is the same size, in the same
 * place, with the same border, on every screen -- it is the frame. What
 * actually changes is what is inside it, so that is what should arrive: a
 * short rise, settling, on the media block and the copy column.
 *
 * The selector still keys off :not([hidden]), so this matches on a screen
 * change and not on the progress ticks that re-render the same visible screen
 * ten times a second during a beam.
 */
.card:not([hidden]) > .card-body > .card-media,
.card:not([hidden]) > .card-body > .card-copy {
  animation: screen-in var(--dur-slower) var(--ease-out);
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
/*
 * min-block-size is the fix for the vertical twin of the reflow the
 * \`media: null\` comment in view.js's transfer() already records fixing
 * horizontally.
 *
 * The slot sizes to its content, and its contents across one run of the flow
 * are: a 16rem QR, a 1:1 camera frame, the SAS tiles at ~7rem, transfer's
 * progress bar at EIGHT PIXELS, and the outcome banner at ~5rem. So the copy
 * column's top edge -- the heading, the first thing read on every screen --
 * jumped several hundred pixels between verify, transfer and done, which is a
 * third of the way down the card and back in the space of two clicks. Nothing
 * was broken and everything moved, which is most of what "clunky" describes.
 *
 * A floor plus centring means the short blocks sit in a box the tall ones
 * already needed, so the heading holds still.
 *
 * 7rem IS NOT A ROUND NUMBER, IT IS .qr's OWN min-block-size. The floor has to
 * be the largest one the media already had, never larger: at 9rem, which was
 * the first guess, this rule stopped being free and started being a demand --
 * the QR could no longer shrink to the 7rem below which a phone camera stops
 * locking on, so it held 32px it used to give up and the send screen's copy
 * scrolled by 30px on a 390x844 phone. Which is the original bug, reintroduced
 * by the fix for the reflow. check-layout.mjs caught it; that is what it is
 * for. At 7rem nothing that was already tall gives up anything, and only the
 * short blocks -- the transfer meter, the outcome banner -- are lifted.
 *
 * \`min()\` against 20vh so the reserve still gives way first on a genuinely
 * short viewport, and BREAKPOINT_SHORT drops it entirely.
 */
.card-media {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-block-size: min(7rem, 20vh);
  /*
   * shrink 20, not 4, and the number is doing real work.
   *
   * The intent written below has always been "the media yields, the words do
   * not, until the media hits a floor it cannot pass". Flexbox does not
   * express that directly: it distributes a deficit across every shrinkable
   * item at once, in proportion to shrink-factor x base-size. At 4 against the
   * copy column's 1 that split a 94px deficit as 82px of media and 12px of
   * copy -- so the copy gave up 12px it did not have to, and scrolled, while
   * the camera above it still had 100px of slack before its own floor. Every
   * "card copy scrolls by 3px" in the sweep was a version of that: not too
   * little room, room taken from the wrong box.
   *
   * A ratio cannot make the copy's share exactly zero -- flex-shrink: 0 would,
   * and is wrong, because then a deficit the media cannot absorb has nowhere
   * to go and .card-body's content overflows across the action bar instead of
   * scrolling inside the one box allowed to scroll. So the copy stays
   * shrinkable as the last resort it is meant to be, and 20 makes its share
   * GROW 1, for the opposite problem at the other end of the range. The card
   * is a fixed height and several screens have very little to say in it -- the
   * choose screen is a heading and a dropzone, transfer is a filename and a
   * status line -- so with nothing growing, the content sat at the top and left
   * a 450px white void above the action bar. That void is the single most
   * visible unfinished thing on a phone. Letting the media take the slack fills
   * it with the screen's own subject: the dropzone becomes a target worth
   * aiming at, the QR and the outcome banner centre in the space, and the words
   * settle just above the buttons instead of floating half a screen away from
   * them. The copy column takes grow: 0 below so the slack goes to the media
   * rather than being split with a text block that cannot use it.
   *
   * 20 was the first try
   * and left 2-4px of it on three screens, which is still a scrollbar; 100
   * puts the copy's share under the sweep's 1px tolerance on every viewport it
   * checks, while keeping it non-zero so the fallback above still exists.
   */
  flex: 1 100 auto;
}
.card-copy {
  /* grow 0: see .card-media above. Free space belongs to the visual block,
   * not to a column of top-aligned text that looks identical either way. */
  flex: 0 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

/*
 * SPACING HAS ONE OWNER, AND IT IS \`gap\`.
 *
 * These are gapped flex containers, and until now nearly every child also
 * carried its own margin -- h2 \`0 0 sp-4\`, .qr \`0 auto sp-5\`, .bar
 * \`sp-4 0 sp-3\`, .callout \`0 0 sp-4\`, .sas-grid \`sp-5 0\`, .status
 * \`sp-2 0 0\`, and six more. Flex gaps do not collapse with margins, so every
 * real gap was the sum of two numbers written in different places: heading to
 * note was 32px, note to code 24px, filename to controls 16px. No two
 * adjacent pairs on a screen matched, and no single edit could make them,
 * because half the spacing was per-element and half was per-container.
 *
 * So: nothing inside a gapped container sets a margin, and this rule is the
 * backstop rather than the mechanism -- the margins are gone from the rules
 * themselves below, and this only catches the next one. Where two things want
 * to sit closer than the container gap, they get grouped in a .stack rather
 * than clawing a margin back.
 *
 * Descendants, not children, and that is not tidiness. The half of this the
 * per-element rules could not reach was the UA's own margins on text nested
 * one level down -- \`.outcome p\` (a 16px top margin pushing the outcome
 * sentence out of line with the glyph beside it) and \`.dropzone p\` (16px top
 * and bottom inside a box already padded --sp-7, which is a good part of why
 * the choose screen's dropzone is the tallest block in the app). Neither was
 * ever written down anywhere; they came free with <p>.
 */
.card :where(p, h2, ul, ol, pre, figure), .sheet-body > * { margin: 0; }

/*
 * The one deliberate exception to the single gap: a group whose members belong
 * to each other more than to the screen. The copy column at --sp-4 throughout
 * lists everything at one weight, so a code block and the sentence explaining
 * it read as two unrelated paragraphs; grouped at --sp-2 inside a --sp-4
 * column they read as one thing with a caption, which is what they are.
 *
 * Four of them, all named at the call site in view.js: the transfer code and
 * its warning, a filename and its path badge, a progress bar and its
 * percentage line, the beam speed control and its status.
 */
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

/* Every member of a stack is conditional somewhere -- the sender has no
 * \`offer\`, so its filename line is absent, and pathBadge() returns null until
 * classification resolves, which on the verify screen is both of them at once.
 * An empty flex child still consumes one of the parent's gaps, so without this
 * the sender's verify screen carries 16px of nothing between the SAS warning
 * and the action bar for the first second or two and then silently loses it.
 * The same argument as .card-actions:empty above. */
.stack:empty { display: none; }

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
 * The rule this element never had.
 *
 * #verify-status is a plain <div> holding the verify screen's role-dependent
 * controls, and it had no CSS at all -- so it was a block box inside
 * .card-actions' flex row, and \`.card-actions .btn\` above did not reach its
 * children. Accept and Decline therefore laid out as two inline-level boxes
 * with no gap between them and no flex basis, touching edge to edge, on the
 * one screen in the app where the two buttons mean opposite things. Every
 * other action bar in the component has a --sp-3 gap. This is that gap,
 * arriving on the screen that most needed it.
 *
 * Restating .card-actions' own values rather than \`display: contents\`, which
 * is shorter and was rejected: this element carries aria-live="polite" and is
 * how a receiver is told an offer arrived, and dropping a live region's box to
 * save four declarations is not a trade worth making. It also stays a real
 * element for check-layout.mjs, whose strayActions assertion names it by id as
 * the single permitted non-button in the bar.
 *
 * flex: 1 1 auto so the group takes the row and the sibling Cancel stays
 * ghost-sized beside it, exactly as a primary/ghost pair does anywhere else.
 */
#verify-status {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3);
}
#verify-status .btn { flex: 1 1 12rem; }
#verify-status .btn.ghost { flex: 0 1 auto; }

/* The waiting branch: an indeterminate bar and the line explaining it, in the
 * same row the buttons will occupy once the offer lands. The bar has no
 * content width, so without a basis it collapses to nothing in a flex row. */
#verify-status .bar { flex: 1 1 100%; }
#verify-status .status { flex: 1 1 100%; }

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

${sheetCSS()}

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

/* A short rise, not just a fade. Opacity alone reads as a flicker at this
 * duration -- something replacing something -- where a few pixels of travel
 * reads as the new screen arriving. --sp-2 and not more: this runs on every
 * screen change in a flow that is three screens long, so it has to be
 * invisible by the third time you see it. */
@keyframes screen-in {
  from { opacity: 0; transform: translateY(var(--sp-2)); }
  to { opacity: 1; transform: none; }
}

h2 {
  margin: 0;
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
  /* Belt and braces with the padding above, which already computes to ~50px
   * at the default font size -- but the padding is in rem and a user who has
   * turned their base size DOWN would shrink the target along with the text,
   * which is the opposite of what they asked for. */
  min-block-size: var(--tap);
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  /* box-shadow joins the list so .primary's rest/hover/press elevation below
   * animates rather than snapping. */
  transition: border-color var(--dur-base), background var(--dur-base),
    box-shadow var(--dur-base), transform var(--dur-fast);
}

.btn:hover { border-color: var(--muted); background: var(--surface-raised); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.btn:disabled { opacity: 0.5; cursor: default; transform: none; }

/*
 * The primary action is the only thing in the component that sits above the
 * card, and it now looks it. Everything here was one weight -- card, code
 * block, input and button all --surface inside a 1px line -- so the button a
 * screen exists to get someone to press was distinguished by hue alone.
 *
 * The press has somewhere to go: shadow at rest, more on hover, none while
 * held, alongside the 1px nudge that was previously carrying the whole
 * gesture on its own.
 */
.btn.primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
  box-shadow: var(--shadow-1);
}
.btn.primary:hover { background: var(--accent-hover); box-shadow: var(--shadow-2); }
.btn.primary:active { box-shadow: none; }
/* focus-visible's ring must win over both of the above, or a keyboard user
 * tabbing onto the primary button gets an elevation change and no ring. */
.btn.primary:focus-visible { box-shadow: var(--focus-ring); }
.btn.primary:disabled { box-shadow: none; }

${buttonCSS()}

/* Small in type and padding, not in target. This is the Copy chip beside the
 * transfer code and the digest, and at --sp-1/--sp-2 it computed to about
 * 28px -- comfortably missable with a thumb, and never caught, because
 * check-layout.mjs asks whether a button is on the screen rather than whether
 * it can be hit. The label stays --fs--1 so it still reads as subordinate to
 * the action bar; only the box grows. */
.btn.small {
  padding: var(--sp-1) var(--sp-3);
  min-block-size: var(--tap);
  font-size: var(--fs--1);
}

.choices { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
.choices .btn { flex: 1 1 12rem; }

/* .beam-entry used to style the wrapper around the two beam buttons on the
 * choose screen. Those buttons moved into the info sheet several commits ago
 * and the wrapper went with them; the rule stayed, matching nothing. */
.choices.secondary { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
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

/* ---- callout boxes: warn and danger ----
 *
 * A left border rather than a full outline keeps boxed guidance from reading
 * as an error the way a bordered box always would. The tinted background, the
 * coloured border and the colour of the text itself all carry the level; the
 * shape is shared.
 *
 * font-weight 500, down from 600. The longest text in the component is
 * BEAM_WARNING, which is two full sentences and renders in one of these, and
 * at 600 the single most important paragraph in the app was a solid block of
 * bold -- the least readable treatment available, applied to the text that
 * most needs reading. Nothing about the warning is softened by this: the
 * wording is untouched, and it keeps the danger tint, the --bad text colour
 * and the border. It is only being made legible.
 *
 * An .info variant existed here too and was never rendered by view.js; the
 * only levels the UI has are warn and danger.
 */
.callout {
  border-left: 3px solid;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-sm);
  font-weight: 500;
  font-size: var(--fs--1);
}

.callout.warn {
  border-left-color: var(--warn);
  background: var(--warn-soft);
  color: var(--warn);
}

.callout.danger {
  border-left-color: var(--bad);
  background: var(--bad-soft);
  color: var(--bad);
}

/* ---- drop zone: drag-and-drop / paste entry point for a send ---- */
.dropzone {
  border: 2px dashed var(--line-strong);
  border-radius: var(--r-md);
  /* --sp-6, down from --sp-7, and the UA margins inside it are gone (see the
   * margin reset above). Together those were ~112px of vertical space on the
   * landing screen for one sentence and a dashed edge, which is more than the
   * two buttons it sits above are given between them. */
  padding: var(--sp-6) var(--sp-4);
  display: flex;
  align-items: center;
  justify-content: center;
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
/* One rule, not two. A beam frame is read by the exact same class of scanner
 * as the pairing QR -- same quiet zone, same always-light surface, same
 * unscannable floor -- and these were two byte-for-byte identical blocks
 * differing only in a bottom margin that .card-copy's gap now owns anyway.
 * Both media queries below already grouped them in one selector, which is the
 * tell that they were one thing. */
.qr, .beam-stage {
  background: var(--qr-quiet-zone);
  border-radius: var(--r-sm);
  padding: var(--sp-3);
  flex: 0 1 auto;
  block-size: min(16rem, 100%);
  min-block-size: 7rem;
  aspect-ratio: 1;
  max-inline-size: 100%;
  margin-inline: auto;
}
.qr svg { display: block; inline-size: 100%; block-size: 100%; }

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
  gap: var(--sp-3);
}
.beam-controls select {
  font: inherit;
  font-size: var(--fs--1);
  padding: var(--sp-1) var(--sp-3);
  /* The one control on the beam screen, on the one screen that runs for
   * minutes and where changing the rate is the only thing a sender can
   * actually do. It was a ~28px target. */
  min-block-size: var(--tap);
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface-sunken);
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

/* No camera on this device: view.js still fills the media slot, with an empty
 * frame the same size and shape as the live one so the screen keeps its
 * two-column wide-and-short layout instead of collapsing to one column on the
 * screens that have no camera to show. Nothing to aim, so it reads as an inert
 * placeholder -- dashed edge, muted fill -- with its one line centred where the
 * picture would have been. It inherits the box (aspect-ratio, min-block-size,
 * margin) from .scanner-frame above; this rule only restyles the surface. */
.scanner-frame.is-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  border: 2px dashed var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--scan-bg);
  text-align: center;
}
.scanner-frame.is-empty .note { margin: 0; }

/* ---- SAS tiles: emoji above word, so the pair can be read aloud ---- */
/*
 * Two by two, at every size, and it is a grid rather than a wrapping flex row
 * for one reason: a wrapping row of four cannot be stopped from breaking 3 + 1.
 *
 * At a 6rem flex basis the tiles fit four across whenever ~420px is available
 * and three otherwise -- and "otherwise" includes the wide two-column layout,
 * where the media column is 22rem however wide the window is. So on a 1280x620
 * laptop the verification code rendered as three tiles and then one stretched
 * across the full width beneath them, which is not a layout, and no viewport
 * media query can fix it because the viewport is not what is narrow.
 *
 * Four fixed columns would be the other option and is worse on a phone, where
 * it was already being overridden to 2x2. So 2x2 everywhere: it is the shape
 * the smallest screen had already settled on, it never reflows, and four
 * things a person reads aloud in pairs is if anything easier to keep your
 * place in than a row of four.
 */
.sas-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-3);
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
/* Row, at every width. Stacking this to a column on a phone was tried, on the
 * grounds that a --tap-tall Copy button under the code is an easier target
 * than one beside it -- and it cost the send screen 52px on a 390x844 viewport,
 * where the check-layout sweep was already failing. Beside a code block that
 * wraps to four lines the button adds no height at all, which on the tightest
 * screen in the app is worth more than the extra width. */
.code-row {
  display: flex;
  /* Centre, not stretch: stretch makes a "Copy" chip as tall as a four-line
   * code block, which reads as a second panel rather than a button. */
  align-items: center;
  gap: var(--sp-2);
}

.code {
  flex: 1 1 auto;
  display: block;
  font-family: var(--font-mono);
  font-size: var(--fs--1);
  word-break: break-all;
  /* Sunken rather than --bg. The distinction was invisible in light mode (--bg
   * against a white card) and inverted in dark, where --bg is lighter than
   * nothing the card contains. A field that holds a value someone reads out or
   * copies should look like a field. */
  background: var(--surface-sunken);
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
}

/*
 * The transfer screen's media block: a big percentage over the bar.
 *
 * The bar alone was 8px of content in the slot that had held a 256px QR one
 * screen earlier and would hold the outcome banner on the next -- the emptiest
 * moment in the app placed at its longest wait. .card-media's floor now
 * reserves that space whatever fills it, so the choice was between reserving it
 * for nothing and giving the screen a subject. The percentage was already being
 * computed for the bar's width and already being said, in the status line, as
 * part of "Sent 1.2 MB of 2.3 MB"; this is the same number at the size the
 * screen's importance deserves. Both stay: the readout answers "how far", the
 * status line answers "how far in bytes", and they are not the same question
 * when the file is 40 KB.
 *
 * font-variant-numeric: tabular-nums so the digits do not reflow the line as
 * the number climbs -- proportional digits make a percentage counter twitch
 * horizontally on every tick, which is exactly the kind of small constant
 * movement that reads as unfinished.
 */
.transfer-pct {
  font-size: var(--fs-3);
  font-weight: 600;
  line-height: var(--lh-tight);
  font-variant-numeric: tabular-nums;
  color: var(--text);
  text-align: center;
}

/* .card-media is a column flex box whose wide-and-short query sets
 * align-items: center, which on a bar with no content width of its own would
 * shrink it to nothing. align-self: stretch opts this one child back out, so
 * the meter fills the media column at every width. (This used to be
 * \`.card-media > .bar\`, when the bar was the media block itself.) */
.transfer-meter {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  align-self: stretch;
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
/* A .stack in its own right -- the pill, its sentence, and any warning belong
 * to each other more than to the column. Same --sp-2 the .stack helper uses;
 * not the helper itself, because this group is built by pathBadge() rather
 * than named at a call site. */
.path-info {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.path-badge {
  /* align-self, not align-items on the parent: as a flex item the pill would
   * otherwise stretch to the column width, turning a badge into a banner --
   * but the metered warning below it is a .callout and does want the full
   * width, so the opt-out has to be on this child alone. */
  align-self: flex-start;
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


.status { color: var(--muted); font-size: var(--fs--1); }
.note { color: var(--muted); font-size: var(--fs--1); }
.filename { font-weight: 600; word-break: break-all; }

/* The only <summary> left in the component is the done screen's verification
 * digest, which is a real <details>. The receive screen used to carry one
 * outside any <details> -- inert, but styled exactly like this, so it looked
 * like a control that did nothing when pressed. It is a <label> now; see
 * .manual-label below. */
summary {
  cursor: pointer;
  color: var(--muted);
  font-size: var(--fs--1);
  min-block-size: var(--tap);
  display: flex;
  align-items: center;
}

/* ---- manual code entry ----
 * A group: the label, the field, and the error that belongs to the field. This
 * had no rule at all, so its three parts sat at the copy column's --sp-4 and
 * read as three unrelated things, one of which happened to be an input. */
.manual {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.manual-label {
  color: var(--muted);
  font-size: var(--fs--1);
  font-weight: 500;
}

#manual-form { display: flex; gap: var(--sp-2); }

input[type="text"] {
  flex: 1;
  font: inherit;
  font-size: var(--fs--1);
  padding: var(--sp-2) var(--sp-3);
  /* ~36px before this, and it is the fallback every user without a working
   * camera has to hit. */
  min-block-size: var(--tap);
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface-sunken);
  color: var(--text);
  min-width: 0;
}
input[type="text"]:focus-visible { outline: none; box-shadow: var(--focus-ring); }

@media (max-width: 30rem) {
  .card { padding: var(--sp-4); gap: var(--sp-3); }
  .card-body, .card-copy { gap: var(--sp-3); }
  .card-actions { padding-block-start: var(--sp-3); }
  /* .sas-tile { flex: 1 1 40% } used to live here to force 2x2 on a phone.
   * The grid does that at every size now, so only the gap is worth trimming. */
  .sas-grid { gap: var(--sp-2); }
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
@media ${BREAKPOINT_SHORT} {
  .card { padding: var(--sp-4); gap: var(--sp-3); }
  .card-body { gap: var(--sp-3); }
  .card-actions { padding-block-start: var(--sp-3); }
  .outcome { padding: var(--sp-3); }
  .qr, .beam-stage { block-size: min(12rem, 100%); }
  .transfer-pct { font-size: var(--fs-2); }

  /* Callouts keep their colour, border and every word, and give up eight
   * pixels of padding each. The beam send screen carries two of them -- the
   * encryption warning and the keep-it-on-screen instruction, neither of which
   * can be shortened -- and on a 1280x620 laptop that was the last 6px between
   * this screen and a scrollbar. Exactly the trade the card padding above
   * makes, and for the reason written there: the padding is a comfort, the
   * content is the point. */
  .callout { padding: var(--sp-2) var(--sp-3); }

  /* The whole step-rail branch that used to live here is gone with the rail
   * itself -- it collapsed the three labelled pills to bare dots to buy back
   * ~50px of a 258px content box. A 3px hairline has no height to buy back. */

  /* The media floor is the first thing to give when height is the scarce axis.
   * It exists to stop the heading jumping between screens, which is a comfort;
   * a screen that fits is the point. This is the same trade the padding above
   * makes, and the reason that comment is written where it is. */
  .card-media { min-block-size: 0; }
}

/*
 * Wide and short: media beside the words instead of above them.
 *
 * A laptop in landscape is short of height with several hundred horizontal
 * pixels to spare, so a single column scrolls next to an empty margin -- the
 * layout refusing to use the axis it has plenty of. The send screen scrolled
 * 303px internally in exactly that window.
 *
 * The media query is interpolated from src/web/tokens.js at build time,
 * so there is one definition shared with site/styles.css. CSS cannot read
 * a custom property in a media query, so build-time interpolation is the
 * only single-home option.
 */
@media ${BREAKPOINT_WIDE} {
  .card-body.has-media { flex-direction: row; align-items: stretch; gap: var(--sp-5); }
  /* The floor is a stacked-layout concern only: in two columns the media
   * column already stretches to the row's height, so reserving a minimum
   * would be reserving space the layout has given it anyway. */
  .card-media { flex: 0 1 22rem; align-items: center; min-block-size: 0; }
  /* Centred against the media column beside it, which .card-media's own
   * justify-content already is. Top-aligned, three short lines of copy sat
   * against the top of a 600px row with the SAS tiles floating at its middle
   * -- two columns that had visibly not been laid out together. In one column
   * this changes nothing: the copy hugs its content there (grow 0) and there
   * is no slack to centre within. */
  .card-copy { flex: 1 1 20rem; justify-content: center; }

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

  /*
   * h2 used to drop to --fs-0 here, and that inverted the type hierarchy on
   * the smallest screen in the app: the heading became the same size as body
   * text while .filename, at --fs-0 and weight 600, became the heaviest thing
   * on the card. So on a 390px phone the most prominent line on the verify
   * screen was the name of the file, and the sentence saying what to do with
   * it was not.
   *
   * The heading keeps --fs-1. The pixels it costs come from the tiles above
   * and from the copy column's line height instead, neither of which is
   * carrying the screen's meaning.
   */
  .card-copy { line-height: 1.45; }
}

/*
 * One rule, two ways to be short of room. This was declared identically in
 * both blocks above -- once against height and once against width -- which is
 * two places to edit a decision made once.
 *
 * The trade: the path badge keeps its label and loses its explanatory
 * sentence. That sentence is the third time the same fact is stated (the toast
 * announces the route, the badge names it, this explains it) and it was
 * costing 40px that the "if these differ" warning needed. The badge stays --
 * losing the fact would be a different and worse trade.
 */
@media ${BREAKPOINT_SHORT}, (max-width: 26rem) {
  .path-info .note { display: none; }
}

/*
 * A touch device cannot use the dropzone, at all.
 *
 * .dropzone is the choose screen's media block and its --sp-7 padding makes it
 * the tallest thing on the app's landing screen -- and it is the drag-and-drop
 * target and the paste hint, neither of which exists on a phone. There is no
 * drag, and element.js's Ctrl-V listener has no keyboard to hear. So on the
 * device with the least room it was spending the most space on the one
 * affordance guaranteed not to work there, above the two buttons that are the
 * actual entry points.
 *
 * pointer: coarse rather than a width breakpoint, because this is a question
 * about the input device and not about how many pixels it has -- a tablet is
 * wide and still cannot drag a file onto a page.
 */
@media (pointer: coarse) {
  .dropzone { padding: var(--sp-4); }
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
