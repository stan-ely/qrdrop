/**
 * Breakpoint strings used in media queries across the codebase.
 *
 * These are exported so they can be interpolated at build time into both
 * stylesheets' media queries, since CSS cannot read a custom property in
 * a media query itself. This is the single-home solution to the problem of
 * two hardcoded copies that have to agree.
 */
export const BREAKPOINT_WIDE = '(min-width: 60rem) and (max-height: 62rem)'
export const BREAKPOINT_SHORT = '(max-height: 46rem)'

/**
 * The design token set: every colour, space, radius, type, and shadow value
 * the UI uses, in one place.
 *
 * This used to be a `:host { --bg: ...; }` block pasted verbatim into both
 * src/web/element.js (scoped to the shadow root) and site/styles.css (scoped
 * to the document). Two copies of the same list, hand-kept in sync, drift the
 * first time someone edits one and forgets the other -- exactly the footgun
 * scripts/build-site.mjs's `buildCSP` comment already describes for the CSP
 * connect-src list. `tokensCSS(selector)` is the single source: the component
 * calls it with `:host`, the site build calls it with `:root`, and there is
 * now exactly one place a palette edit can happen.
 *
 * This file is imported from src/web/styles.js (browser, shadow DOM) AND
 * from scripts/build-site.mjs (Node, typechecked under tsconfig.node.json).
 * It must therefore stay free of every DOM and Node global -- no `document`,
 * no `window`, no `fs` -- so it stays legal in both places. It returns a
 * plain string; it does not touch a stylesheet, a shadow root, or a file.
 *
 * @param {string} selector Either ':host' (shadow-scoped, for the component)
 *   or ':root' (document-scoped, for the site's page chrome).
 * @returns {string}
 */
export function tokensCSS(selector) {
  return `
${selector} {
  /* ---- space: 4/8/12/16/24/32/48px, as rem ---- */
  --sp-1: 0.25rem;
  --sp-2: 0.5rem;
  --sp-3: 0.75rem;
  --sp-4: 1rem;
  --sp-5: 1.5rem;
  --sp-6: 2rem;
  --sp-7: 3rem;

  /* ---- radius ---- */
  --r-sm: 0.5rem;
  --r-md: 0.75rem;
  --r-lg: 1rem;
  --r-full: 999px;

  /* ---- layout ----
   *
   * The app occupies exactly the viewport and never scrolls the page; overflow
   * lives inside dialogs. These are the two rows that bracket the scrollable
   * middle, and they are tokens rather than literals because the grid
   * definition, the dialog's max height, and the site's page grid all have to
   * agree on them -- three places, which is two too many for a hand-kept
   * number.
   *
   * --col is the reading column, matching the cap site/styles.css puts on
   * main. It
   * moved here when the site began sharing the viewport grid with the
   * component: two files claiming a different idea of "the column" is the same
   * drift this whole file exists to prevent.
   */
  --col: 34rem;
  --bar-h: 4.5rem;
  --head-h: 3rem;

  /* ---- stacking ----
   *
   * A named ladder rather than integers scattered across rules. There was no
   * z-index anywhere in this codebase before the dialog layer, which is the
   * best possible moment to decide the order once: anything competing for the
   * same plane is a bug in one of these two values, not a reason to type 9999.
   *
   * The dialog itself needs no token -- showModal() promotes it to the
   * browser's top layer, which sits above every z-index on the page by
   * definition. --z-dialog is here for the non-modal fallback path only.
   */
  --z-bar: 10;
  --z-dialog: 20;
  --z-toast: 30;

  /* ---- type ---- */
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --fs--1: 0.8125rem;
  --fs-0: 1rem;
  --fs-1: 1.125rem;
  --fs-2: 1.375rem;
  --fs-3: 1.875rem;
  --lh-tight: 1.25;
  --lh-body: 1.55;

  /* ---- colour: light (default) ----
   *
   * --text on --surface is 17.4:1 and on --bg is 16.1:1 -- both nowhere near
   * the 4.5:1 floor, which leaves headroom to keep --text a near-black rather
   * than a pure one.
   *
   * --muted is the one built to a budget rather than to taste: #5f5d57 is the
   * darkest warm gray that still reads as "muted" against #6b6b66 (the old
   * value, which was never checked) while clearing 4.5:1 on both --surface
   * (6.58:1) and --bg (6.09:1). A lighter muted would drift under the floor
   * on --bg specifically, since --bg is the darker of the two.
   *
   * --accent is deepened from the old #b8563a to #a8462d specifically so
   * white text on it (--accent-text, used on .btn.primary) clears 4.5:1
   * (measured 5.87:1) -- the old value sat closer to 4:1 and failed for small
   * button labels. The same #a8462d against --surface is 5.87:1, past the
   * 3:1 floor for the large-text/UI-border uses (the step rail's active dot,
   * the SAS "these differ" note's accent underline).
   */
  --bg: #f7f6f3;
  --surface: #ffffff;
  --surface-raised: #f1efe9;
  --text: #1a1a19;
  --muted: #5f5d57;
  --line: #e3e1db;
  --line-strong: #8f8d85;
  --accent-rgb: 168, 70, 45;
  --accent: rgb(var(--accent-rgb));
  --accent-hover: #8f3a24;
  --accent-text: #ffffff;
  --accent-soft: rgba(var(--accent-rgb), 0.12);
  --ok: #1f6e46;
  --ok-soft: rgba(31, 110, 70, 0.12);
  --bad: #a33328;
  --bad-soft: rgba(163, 51, 40, 0.12);
  --warn: #8a5a00;
  --warn-soft: rgba(138, 90, 0, 0.12);

  /* ---- camera and QR surfaces: deliberately NOT themed ----
   *
   * These three are the only colours here that must stay the same in light
   * and dark, so they sit outside the palette above and are never restated
   * in the dark block below. A QR is read by a camera, not by a person: a
   * scanner binarizes what it sees and needs dark modules on a light quiet
   * zone whatever the page around them is doing, and the viewfinder's
   * brackets have to stay legible over an arbitrary camera image. Wiring
   * any of them to --surface/--text would make dark mode quietly unreadable
   * to a scanner while looking perfectly fine to whoever changed it.
   *
   * They are tokens rather than the literals they replaced in styles.js for
   * the same reason as everything else in this file: --qr-quiet-zone alone
   * had two hand-kept copies (.qr and .beam-stage). */
  --qr-quiet-zone: #ffffff;
  --scan-bg: #000000;
  --scan-line: #ffffff;

  /* ---- elevation ---- */
  --shadow-1: 0 1px 2px rgba(20, 18, 14, 0.06), 0 1px 1px rgba(20, 18, 14, 0.04);
  --shadow-2: 0 8px 24px rgba(20, 18, 14, 0.10), 0 2px 6px rgba(20, 18, 14, 0.06);

  /* ---- motion ----
   *
   * The last axis that was still magic numbers scattered through styles.js.
   * Unlike colour and shadow, motion does not retheme -- a transition is the
   * same length on a dark background as on a light one -- so these are
   * declared once here and never restated in the dark block, which also
   * keeps that block honest about what actually changes with the theme.
   *
   * The reduced-motion query in styles.js overrides all of them at once with
   * transition-duration: 0s, so these are the "motion is wanted" values
   * only; do not try to encode the reduced case here. */
  --dur-fast: 0.05s;    /* .btn:active nudge -- must feel instant */
  --dur-base: 0.15s;    /* border and background on hover */
  --dur-slow: 0.2s;     /* the progress bar's fill, which is being watched */
  --dur-shimmer: 1.4s;  /* one pass of the indeterminate bar */

  /* ---- focus ---- */
  --focus-ring: 0 0 0 3px rgba(var(--accent-rgb), 0.35);
}

@media (prefers-color-scheme: dark) {
  ${selector} {
    /*
     * Every pair below is re-measured against the dark surfaces, not just
     * colour-inverted -- a light-mode ratio says nothing about the same hex
     * pair on a dark background. --muted lightens to #b1b0aa (7.55:1 on
     * --surface, 8.30:1 on --bg); --accent lightens to #e08662 so
     * --accent-text (now dark, #17171a, matching the old scheme of a dark
     * label on a light-ish accent chip) still clears 4.5:1 (6.61:1 measured).
     */
    --bg: #16161a;
    --surface: #1f1f24;
    --surface-raised: #262630;
    --text: #ecebe8;
    --muted: #b1b0aa;
    --line: #33333a;
    --line-strong: #77747c;
    --accent-rgb: 224, 134, 98;
    --accent: rgb(var(--accent-rgb));
    --accent-hover: #e89a7c;
    --accent-text: #17171a;
    --accent-soft: rgba(var(--accent-rgb), 0.18);
    --ok: #7fc39b;
    --ok-soft: rgba(127, 195, 155, 0.16);
    --bad: #f0968a;
    --bad-soft: rgba(240, 150, 138, 0.16);
    --warn: #e3b34d;
    --warn-soft: rgba(227, 179, 77, 0.16);

    /*
     * Black shadows read as mud on a dark surface -- there is no darker tone
     * for them to imply depth against. Elevation here leans on --line-strong
     * borders (already applied by .card etc. in both themes) plus these
     * faint, mostly-flat shadows instead of the pronounced light-mode ones.
     */
    --shadow-1: 0 1px 0 rgba(0, 0, 0, 0.2);
    --shadow-2: 0 4px 16px rgba(0, 0, 0, 0.35);

    --focus-ring: 0 0 0 3px rgba(var(--accent-rgb), 0.45);
  }
}
`
}
