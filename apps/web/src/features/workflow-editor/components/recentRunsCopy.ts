// User-visible strings for the recent-runs sidebar. Kept in one module so a
// future i18n migration is a localised search-and-replace; mirrors the
// pattern used by `patternPickerCopy.ts`.

export const recentRunsCopy = {
  /** Section heading rendered inside the sidebar. Matches design/app.pen. */
  sectionTitle: 'RECENT RUNS',
  /** Accessible name announced by screen readers for the run list. */
  listAria: 'Recent runs',
  /** Shown in place of the list when the workflow has zero runs. */
  emptyState: 'No runs yet',
  /** Shown while the initial fetch is in flight. */
  loadingState: 'Loading…',
  /** Generic fall-back when the API call fails for an unmapped reason. */
  errorState: 'Failed to load runs',
  /** Replaces the duration column for runs that are still in flight. */
  runningLabel: 'running',
} as const;

export type RecentRunsCopy = typeof recentRunsCopy;
