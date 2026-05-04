/**
 * Copy strings for the Left Sidebar (`apps/web/design/app.pen`, frame
 * `iHBGe`). The strings live here so the sidebar markup stays focused
 * on layout and so future i18n has a single seam to swap.
 *
 * Naming notes:
 *   - `heading` mirrors the design literal `Workflows` (`vMTOu` in the
 *     pen). To avoid colliding with the index page's `<h1>Workflows</h1>`
 *     under Playwright's strict-locator
 *     `getByRole('heading', { name: 'Workflows' })` query
 *     (`apps/web/e2e/create-workflow.spec.ts:529`), the visible string
 *     is rendered through a non-heading element in `SidebarContent`
 *     (a styled `<div>`); the surrounding `<aside>` / dialog uses
 *     `aria-label` rather than `aria-labelledby` so screen readers
 *     still hear "Workflows" as the landmark name without exposing two
 *     heading roles named the same.
 *   - `openLabel` is intentionally NOT `Open` because `WorkflowList`
 *     already labels its rows `Open <name>` and the layout sidebar would
 *     render duplicate accessible names for every workflow on `/`. Using
 *     `Open workflow file` differentiates the sidebar tree row from the
 *     index page list row in screen-reader rotor lists and Playwright's
 *     strict locators.
 */
export const leftSidebarCopy = {
  /** Title of the sidebar header row (mirrors the design's `vMTOu`). */
  heading: 'Workflows',
  /** Filter input placeholder + accessible name. Mirrors `H1mpr`. */
  filterPlaceholder: 'Filter files...',
  filterAria: 'Filter workflow files',
  /** Project folder label rendered above the workflow rows. */
  projectFolder: '.agents/railways',
  /**
   * Secondary "user" folder label (`~/.agents/railways`). Mirrors the
   * design's `userHeader` row (`G0jesD`). The web app today only reads
   * the project-scoped workflow directory, so this folder is rendered
   * truthfully as an empty section — see `userFolderEmptyHint`.
   */
  userFolder: '~/.agents/railways',
  userFolderEmptyHint: 'Not synced from this app',
  /**
   * Tertiary `$RALPH_RAILWAYS_PATH` folder label. Reflects the design's
   * `extraHeader` row (`oB9GO`) which renders the env-var-backed folder
   * collapsed and labelled `empty` because the web app does not surface
   * env-var configured roots today.
   */
  extraFolder: '$RALPH_RAILWAYS_PATH',
  extraFolderNote: 'empty',
  /** "New workflow" icon-button accessible name (links to /workflows/new). */
  newWorkflowAria: 'Create new workflow',
  /**
   * Folder-plus icon button accessible name. The design (`u7HgI` in
   * `K9V4cN.iconRow`) draws three icon affordances — file-plus,
   * folder-plus, refresh — but the web app does not yet support
   * creating workflow directories from the UI. Rather than omit the
   * affordance and shrink the cluster to a 2-button row, we render the
   * folder-plus glyph as a `<button disabled>` with the same
   * "Coming soon" treatment used by the Top Bar's History / Settings /
   * Share affordances (`topBarCopy.comingSoon*`), so the cluster reads
   * at the design's canonical 3-button width without inventing a
   * functional directory-creation flow that the backend cannot honour.
   * Activating this once a future scenario lands is a one-line change:
   * drop the `disabled` flag and assign an `onclick` (or upgrade to
   * an `<a href>`).
   */
  newFolderAria: 'Create new folder',
  /**
   * "Coming soon" copy for the folder-plus button. Spelled out here
   * rather than imported from `topBarCopy` so the sidebar's copy
   * regime stays self-contained (the strings are short enough that
   * cross-module reuse would couple two surfaces for the sake of two
   * literals; future i18n can collapse them via a shared bundle if
   * the duplication grows).
   */
  comingSoonTooltip: 'Coming soon',
  comingSoonAriaSuffix: ' coming soon',
  /** Refresh icon-button accessible name. */
  refreshAria: 'Refresh workflow list',
  /** Empty-state message when no workflows are loaded. */
  emptyMessage: 'No workflows yet',
  /** Empty-state hint pointing the user at the create CTA. */
  emptyHint: 'Use the file-plus icon to create one.',
  /** No-match message when the filter yields zero rows. */
  filterNoMatch: 'No files match the filter.',
  /** Accessible name on each workflow row link (prefixed to the file name). See top-of-file note for collision avoidance. */
  openLabel: 'Open workflow file',
  /** Accessible name on the inner workflow-list nav landmark. */
  fileListAria: 'Workflow file list',
  /** Mobile drawer trigger / dismiss accessible names. */
  mobileTriggerAria: 'Open navigation',
  mobileCloseAria: 'Close navigation',
  /** Accessible label for the mobile drawer dialog (description). */
  mobileDialogAria: 'Workflow navigation',
  /**
   * Visually-hidden title for the mobile drawer dialog. bits-ui Dialog
   * prefers a `<Dialog.Title>` over a description for the dialog's
   * accessible name. Using a distinct, scoped string ("Workflows
   * navigation") avoids colliding with the index page's
   * `<h1>Workflows</h1>` under Playwright's strict-locator
   * `getByRole('heading', { name: 'Workflows', exact: true })`.
   */
  mobileDialogTitle: 'Workflows navigation',
  /**
   * Recent runs footer copy. Mirrors `k3LmuC` "RECENT RUNS" plus the
   * empty / loading / error microcopy used by the compact sidebar
   * variant of the recent-runs panel.
   */
  recentRunsTitle: 'RECENT RUNS',
  recentRunsListAria: 'Recent runs',
  recentRunsEmpty: 'No runs yet',
  recentRunsNoActiveWorkflow: 'Open a workflow to see recent runs.',
  recentRunsLoading: 'Loading…',
  recentRunsError: 'Failed to load runs',
  recentRunsRunningLabel: 'running',
  /** Accessible name describing a folder section's expand/collapse toggle. */
  folderToggleAria: (folder: string, expanded: boolean) =>
    `${expanded ? 'Collapse' : 'Expand'} folder ${folder}`,
  /**
   * Accessible name for a folder's file-count badge. The visible badge text
   * is the integer; the label spells out the unit so screen readers announce
   * e.g. "4 workflows" instead of just "4". Centralised here so the
   * project / user folder badges stay in lock-step under future i18n.
   */
  countAriaLabel: (count: number) =>
    `${count} ${count === 1 ? 'workflow' : 'workflows'}`,
} as const;
