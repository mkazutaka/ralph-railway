/**
 * Copy strings for the Top Bar (`apps/web/design/app.pen`, frame `Ht9Do`).
 *
 * Centralised so the bar's labels, breadcrumb separators, and aria
 * names live in one place — the Top Bar is rendered on every page via
 * `+layout.svelte` and changing a label in markup would otherwise mean
 * touching three or four sites simultaneously.
 */
export const topBarCopy = {
  /** Brand mark next to the train-front logo glyph. */
  brand: 'Ralph Railway',
  /**
   * Accessible name for the brand link. The visible "Ralph Railway"
   * label is fronted by an `aria-hidden` glyph, so without an explicit
   * name the link landed in the screen-reader rotor as "link" only —
   * the design-review's a11y note 6.a flagged this. Naming the link
   * "Ralph Railway home" preserves the visible wordmark while giving
   * the role-and-name pair a destination clue.
   */
  brandAria: 'Ralph Railway home',
  /** Default breadcrumb root when no workflow is open (e.g. on the index). */
  breadcrumbRoot: '.agents/railways',
  /** Visible "/" between breadcrumb segments. */
  breadcrumbSeparator: '/',
  /** Accessible name for the icon-only history button. */
  historyAria: 'Run history',
  /** Accessible name for the icon-only settings button. */
  settingsAria: 'Settings',
  /** Visible label for the share affordance. */
  shareLabel: 'Share',
  /**
   * Tooltip / a11y suffix appended to History / Settings / Share buttons
   * while their backing routes are not yet wired. The design (`Ht9Do`)
   * shows them as enabled chrome, but the review-design feedback flagged
   * "clickable but inert" buttons as a UX hazard — so we render them as
   * native `<button disabled>` and surface "Coming soon" via the title
   * attribute (browser tooltip on hover/focus) plus a screen-reader
   * suffix appended to the accessible name. A future scenario that
   * implements one of these will simply drop the disabled flag and the
   * button activates without any markup churn.
   *
   * The aria suffix is plain prose ("coming soon") rather than wrapped
   * in parentheses because some screen readers literally announce the
   * paren glyphs ("left paren coming soon right paren"), which clutters
   * the rotor (review note frontend L-6).
   */
  comingSoonTooltip: 'Coming soon',
  comingSoonAriaSuffix: ' coming soon',
  /** Accessible name for the persistent landmark. */
  bannerAria: 'Application top bar',
  /**
   * Visible label inside the green save-status pill (`iCDRl` "Status Badge"
   * in `app.pen`). Mirrored from the design's `statusText` content.
   *
   * The pill is the design's canonical surface for save feedback at
   * `>= sm` viewports. On `< sm` the Top Bar collapses the center
   * column entirely (the right-rail Save/Run cluster takes priority on
   * phones) and the in-page `editor-toast` next to the YAML buffer
   * (`workflows/[id]/+page.svelte` ~314-348) carries the same outcome
   * cue. Keeping that mapping documented here so a future rework of
   * either surface keeps the pair in step (review note frontend
   * minor #1).
   */
  savedLabel: 'Saved',
  /** Visible label inside the same pill while a save is in-flight. */
  savingLabel: 'Saving…',
  /** Visible label inside the pill when the last save attempt failed. */
  saveErrorLabel: 'Save failed',
  /**
   * Accessible name for the live region the save-status pill renders into.
   * Mirrors the polite-status policy used elsewhere in the editor (M-3 in
   * `+page.svelte`): the pill is ambient feedback the user does not need to
   * act on, so we keep it on `role="status"` rather than `role="alert"`.
   */
  saveStatusAria: 'Workflow save status',
} as const;
