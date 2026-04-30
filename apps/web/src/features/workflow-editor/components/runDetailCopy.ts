// User-visible strings for the run-detail panel. Kept in one module so a
// future i18n migration is a localised search-and-replace; mirrors the
// pattern used by `recentRunsCopy.ts` and `patternPickerCopy.ts`.

export const runDetailCopy = {
  /** Section heading rendered above the panel content. */
  sectionTitle: 'RUN DETAIL',
  /** Accessible name announced by screen readers for the panel region. */
  regionAria: 'Run detail',
  /** Empty state shown when no run has been selected yet. */
  emptyState: 'Select a run to see its details.',
  /** Shown while the detail fetch is in flight. */
  loadingState: 'Loading run detail…',
  /** Generic fallback when the API call fails for an unmapped reason. */
  errorState: 'Failed to load run detail',
  /** Specific message for the 404 ("run does not exist") branch. */
  notFoundState: 'Run not found',
  /** Caption shown above the per-node list. */
  nodesHeading: 'Steps',
  /** Substituted for the duration column when the run is still running. */
  runningLabel: 'running',
  /** Section labels inside each node row. */
  nodeOutputLabel: 'Output',
  nodeErrorLabel: 'Error',
  nodeLogLabel: 'Log excerpt',
  /** Empty state inside a node row when the node has produced no output yet. */
  nodeNoOutput: 'No output produced.',
  nodeNoLogs: 'No log output yet.',
  /** Header captions. */
  startedLabel: 'Started',
  durationLabel: 'Duration',
  closeAria: 'Close run detail',
} as const;

export type RunDetailCopy = typeof runDetailCopy;
