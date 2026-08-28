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
  --accent: #a8462d;
  --accent-hover: #8f3a24;
  --accent-text: #ffffff;
  --accent-soft: rgba(168, 70, 45, 0.12);
  --ok: #1f6e46;
  --ok-soft: rgba(31, 110, 70, 0.12);
  --bad: #a33328;
  --bad-soft: rgba(163, 51, 40, 0.12);
  --warn: #8a5a00;
  --warn-soft: rgba(138, 90, 0, 0.12);

  /* ---- elevation ---- */
  --shadow-1: 0 1px 2px rgba(20, 18, 14, 0.06), 0 1px 1px rgba(20, 18, 14, 0.04);
  --shadow-2: 0 8px 24px rgba(20, 18, 14, 0.10), 0 2px 6px rgba(20, 18, 14, 0.06);

  /* ---- focus ---- */
  --focus-ring: 0 0 0 3px rgba(168, 70, 45, 0.35);
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
    --accent: #e08662;
    --accent-hover: #e89a7c;
    --accent-text: #17171a;
    --accent-soft: rgba(224, 134, 98, 0.18);
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

    --focus-ring: 0 0 0 3px rgba(224, 134, 98, 0.45);
  }
}
`
}
